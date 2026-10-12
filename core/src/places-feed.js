'use strict';
/**
 * Filling the places directory, so it is not another file someone has to hand-maintain.
 *
 * Two sources:
 *
 *   refresh — ask a running connector what it can see, through the manager's existing proxies
 *             (`GET /instances/:id/servers` and `GET /instances/:id/channels`, both on main). This
 *             needs nothing from the Discord read ops in PR #165; it uses the control-plane
 *             endpoints that already exist.
 *   import  — read `connectors/types/discord/channel-aliases.json`, including the `channels` block
 *             its own .example documents and no code has ever read. Whatever an operator typed into
 *             that file carries over instead of being retyped.
 *
 * Both are idempotent: upsert COALESCEs, so running refresh after import keeps the descriptions the
 * import carried and only overwrites the names, which is the one thing the platform is authoritative
 * about.
 *
 * Neither throws. A connector that is down, a manager with no token, a missing alias file: each
 * returns a count of zero and a reason, because a directory refresh is not worth failing a command
 * over.
 */

const fs = require('fs');
const path = require('path');

const MANAGER_BASE = () => process.env.ASMLTR_MANAGER_BASE || 'http://127.0.0.1:3024';
const MANAGER_TOKEN = () => process.env.ASMLTR_MANAGER_TOKEN || '';
const TIMEOUT_MS = () => Number(process.env.ASMLTR_PLACES_REFRESH_TIMEOUT_MS) || 8000;

async function managerGet(p) {
  const headers = { Accept: 'application/json' };
  const tok = MANAGER_TOKEN();
  if (tok) headers.Authorization = 'Bearer ' + tok;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS());
  try {
    const r = await fetch(MANAGER_BASE() + p, { headers, signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json: j };
  } catch (e) {
    return { ok: false, status: 0, json: {}, error: e.name === 'AbortError' ? `manager timed out after ${TIMEOUT_MS()}ms` : e.message };
  } finally { clearTimeout(t); }
}

/** Which connector instances to refresh: every enabled one, or just the id asked for. */
async function instancesToRefresh(o = {}) {
  if (o.instance_id) return [{ id: o.instance_id, type: o.surface || null }];
  const r = await managerGet('/instances');
  const list = Array.isArray(r.json) ? r.json : (r.json.instances || []);
  if (!r.ok && !list.length) return { error: r.error || `manager said ${r.status}` };
  return list.filter((i) => !o.surface || i.type === o.surface).map((i) => ({ id: i.id, type: i.type, name: i.name }));
}

/**
 * Pull guilds and channels from one connector instance into the directory.
 *
 * The Discord connector's `/servers` answers `{ servers: [{ id, name, member_count }] }` and its
 * `/channels` answers `{ channels: [{ guild_id, guild, channel_id, name, enabled }] }`. A connector
 * that serves neither contributes nothing rather than erroring: not every type has places.
 */
async function refreshInstance(store, inst) {
  const surface = inst.type || 'discord';
  const out = { instance_id: inst.id, surface, guilds: 0, channels: 0, error: null };

  const sv = await managerGet(`/instances/${encodeURIComponent(inst.id)}/servers`);
  const servers = (sv.json && Array.isArray(sv.json.servers)) ? sv.json.servers : [];
  for (const g of servers) {
    if (!g || !g.id) continue;
    store.upsert({ surface, scope_id: String(g.id), kind: 'guild', name: g.name || null, instance_id: inst.id, source: 'refresh' });
    out.guilds++;
  }

  const ch = await managerGet(`/instances/${encodeURIComponent(inst.id)}/channels`);
  const channels = (ch.json && Array.isArray(ch.json.channels)) ? ch.json.channels : [];
  for (const c of channels) {
    const id = c && (c.channel_id || c.id);
    if (!id) continue;
    store.upsert({
      surface, scope_id: String(id), kind: 'channel', name: c.name || null,
      parent_id: c.guild_id ? String(c.guild_id) : null,
      // `guild` is the name in the Discord payload; keep it denormalized so a row renders alone.
      parent_name: c.guild || null,
      topic: c.topic || null, instance_id: inst.id, source: 'refresh',
    });
    out.channels++;
  }

  if (!servers.length && !channels.length) {
    // A 404 from BOTH proxies means this connector type does not serve /servers or /channels at all,
    // which is most of them: telegram, email, android. That is not a failure and reporting it as
    // "manager said 404" turns an ordinary refresh into a page of noise. Found running a refresh
    // against the live manager, where the telegram instance reported an error for existing.
    const noEndpoint = sv.status === 404 && ch.status === 404;
    out.kind_has_places = !noEndpoint;
    out.error = noEndpoint ? null
      : (sv.error || ch.error || (sv.ok || ch.ok ? 'connector reported no places' : `manager said ${sv.status || ch.status}`));
  } else {
    out.kind_has_places = true;
  }
  return out;
}

/** Refresh every instance (or one). Always resolves; per-instance failures are reported, not thrown. */
async function refresh(store, o = {}) {
  const insts = await instancesToRefresh(o);
  if (!Array.isArray(insts)) return { ok: false, error: insts.error, instances: [], guilds: 0, channels: 0 };
  const all = [];
  for (const inst of insts) all.push(await refreshInstance(store, inst));
  // Keep the ones that either contributed or failed for a real reason. A type with no places
  // endpoint is dropped rather than printed as a zero with an error beside it.
  const results = all.filter((r) => r.kind_has_places !== false);
  const skipped = all.length - results.length;
  return {
    ok: results.some((r) => r.guilds || r.channels),
    instances: results,
    skipped,
    guilds: results.reduce((n, r) => n + r.guilds, 0),
    channels: results.reduce((n, r) => n + r.channels, 0),
  };
}

const ALIAS_FILE = () => process.env.ASMLTR_DISCORD_ALIASES_FILE ||
  path.join(__dirname, '..', '..', 'connectors', 'types', 'discord', 'channel-aliases.json');

/**
 * Import the alias file. Both halves of it:
 *
 *   aliases  { "TD-shop": "<id>" }                       -> a place plus an alias label
 *   channels { "<id>": { server, channel, description } } -> the name/parent/topic nobody ever read
 *
 * The `channels` block is why this exists: an operator already wrote down what these channels are,
 * in the shape the example file told them to, and no code has ever looked at it.
 */
function importAliasFile(store, o = {}) {
  const file = o.file || ALIAS_FILE();
  const surface = o.surface || 'discord';
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    // Never the parser's message: JSON.parse quotes the first ~10 bytes of its input, so echoing it
    // turns any read failure into a disclosure of whatever was read. The caller needs to know WHICH
    // of the two things went wrong, and nothing about the contents.
    const why = e.code === 'ENOENT' ? `no alias file at ${file}`
      : e.code === 'EACCES' ? `alias file is not readable (${file})`
      : `alias file is not valid JSON (${file})`;
    return { ok: false, file, aliases: 0, channels: 0, error: why };
  }
  const out = { ok: true, file, aliases: 0, channels: 0, error: null };

  const meta = (raw && typeof raw.channels === 'object' && raw.channels) || {};
  for (const [id, m] of Object.entries(meta)) {
    if (!id || id.startsWith('_')) continue;
    store.upsert({
      surface, scope_id: String(id), kind: 'channel',
      name: (m && m.channel) || null, parent_name: (m && m.server) || null,
      topic: (m && m.description) || null, source: 'import',
    });
    out.channels++;
  }

  const aliases = (raw && typeof raw.aliases === 'object' && raw.aliases) || {};
  for (const [alias, id] of Object.entries(aliases)) {
    if (!alias || alias.startsWith('_') || !id) continue;
    // Upsert first: an alias pointing at an id the `channels` block never described still deserves a
    // row, otherwise the label would dangle and resolve to nothing.
    store.upsert({ surface, scope_id: String(id), kind: 'channel', source: 'import' });
    store.setLabel({ surface, scope_id: String(id), label: alias, kind: 'alias', note: 'imported from channel-aliases.json', set_by: 'import' });
    out.aliases++;
  }
  return out;
}

module.exports = { refresh, refreshInstance, importAliasFile, ALIAS_FILE, managerGet };
