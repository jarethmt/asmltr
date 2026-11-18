'use strict';
/**
 * Integrations registry — OPTIONAL, per-install capabilities the agent reaches outward to use.
 * See docs/INTEGRATIONS.md for the boundary: if asmltr requires it to function, it is core, not an
 * integration, no matter which direction it points.
 *
 * Two orthogonal axes (conflating them is what once forced a supervised service to masquerade as a
 * chat connector):
 *   kind      storage | tools | transport   — WHAT capability it yields
 *   lifecycle passive  | supervised         — WHO runs it
 *
 * `passive` is the historical behaviour: config plus a driver loaded on demand, nothing running
 * until something opens it. `supervised` entries are long-running processes and are run by the same
 * supervisor that runs channel connectors — supervision was always the right mechanism; only the
 * taxonomy was wrong.
 * Unlike connectors, integrations are NOT supervised processes — just config + a driver loaded on
 * demand. Config is stored as JSON; secret-bearing fields are stored as *_ref (a vault key name) and
 * resolved from the TRUST vault (via shared/secrets.js) only at open time — never persisted in the clear.
 *
 * Convention: any config field ending in `_ref` holds a vault key name; on open it resolves to the
 * field without the suffix (e.g. `password_ref: "nextcloud_eve_account"` → `password: <secret>`).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const secrets = require('../shared/secrets');
const storage = require('../shared/storage');

function file() { return process.env.ASMLTR_INTEGRATIONS_FILE || path.join(os.homedir(), '.asmltr', 'integrations.json'); }
function load() { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (_) { return {}; } }
function save(d) { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(d, null, 2)); }
function id() { return 'int_' + Math.random().toString(36).slice(2, 10); }

// configs only — *_ref are key names, not secrets. Older entries predate kind/lifecycle, so they are
// defaulted on read rather than migrated on disk: every one of them is a passive storage link.
function shape(it) { return { kind: 'storage', lifecycle: 'passive', ...it }; }
function list({ kind, lifecycle } = {}) {
  return Object.values(load()).map(shape)
    .filter((i) => (!kind || i.kind === kind) && (!lifecycle || i.lifecycle === lifecycle));
}
function get(iid) { const it = load()[iid]; return it ? shape(it) : null; }
const KINDS = ['storage', 'tools', 'transport'];
const LIFECYCLES = ['passive', 'supervised'];

/**
 * A driver KNOWS what it yields and who runs it, so those are read from the driver rather than
 * trusted from the caller. Defaulting them to `storage`/`passive` instead meant any client that
 * omitted `kind` — the dashboard did — created mail/caldav/carddav links as STORAGE, which then
 * failed with "unknown storage driver 'mail'" at open time. The caller may still pass them
 * explicitly (for a driver that predates the fields), but the driver wins when it declares them.
 */
function kindFromDriver(type) {
  if (type === 'local') return { kind: 'storage', lifecycle: 'passive' };
  try {
    const d = require('./types/' + type);
    return { kind: d && d.kind, lifecycle: d && d.lifecycle };
  } catch (_) { return {}; }
}

function create({ type, name, config = {}, kind, lifecycle }) {
  if (!type) throw new Error('type is required');
  const declared = kindFromDriver(type);
  const k = declared.kind || kind || 'storage';
  const lc = declared.lifecycle || lifecycle || 'passive';
  if (!KINDS.includes(k)) throw new Error(`kind must be one of: ${KINDS.join(', ')}`);
  if (!LIFECYCLES.includes(lc)) throw new Error(`lifecycle must be one of: ${LIFECYCLES.join(', ')}`);
  const d = load();
  const it = { id: id(), type, name, kind: k, lifecycle: lc, config, created_at: Date.now() };
  d[it.id] = it; save(d); return it;
}
function update(iid, patch) { const d = load(); if (!d[iid]) return null; d[iid] = { ...d[iid], ...patch, id: iid, updated_at: Date.now() }; save(d); return d[iid]; }
function remove(iid) { const d = load(); if (!d[iid]) return false; delete d[iid]; save(d); return true; }

// require the driver module so it self-registers with shared/storage
function loadDriver(type) { if (type === 'local') return; try { require('./types/' + type); } catch (e) { throw new Error(`no driver for integration type '${type}': ${e.message}`); } }

async function resolveConfig(config) {
  const out = {};
  for (const [k, v] of Object.entries(config || {})) {
    if (k.endsWith('_ref') && typeof v === 'string') out[k.slice(0, -4)] = await secrets.get(v); // vault → value
    else out[k] = v;
  }
  return out;
}

/** Open a live storage handle for a storage integration (driver loaded, creds resolved from the vault). */
async function openStorage(iid) {
  const it = get(iid);
  if (!it) throw new Error('integration not found: ' + iid);
  loadDriver(it.type);
  return storage.getStorage({ type: it.type, config: await resolveConfig(it.config) });
}

/**
 * Open a non-storage integration (`tools` / `transport`) — the driver's own handle rather than the
 * storage contract. Storage drivers self-register with shared/storage and are opened by
 * openStorage(); everything else exports its own `open(config)`.
 *
 * The caller owns the handle and MUST close() it. Passive means nothing is running until this is
 * called and nothing stays running after it is closed.
 */
async function openTool(iid) {
  const it = get(iid);
  if (!it) throw new Error('integration not found: ' + iid);
  if (it.kind === 'storage') throw new Error(`integration ${iid} is storage — use openStorage()`);
  let driver;
  try { driver = require('./types/' + it.type); }
  catch (e) { throw new Error(`no driver for integration type '${it.type}': ${e.message}`); }
  if (typeof driver.open !== 'function') throw new Error(`driver '${it.type}' exports no open()`);
  return driver.open(await resolveConfig(it.config));
}

/** Open whichever kind this integration is. */
async function open(iid) {
  const it = get(iid);
  if (!it) throw new Error('integration not found: ' + iid);
  return it.kind === 'storage' ? openStorage(iid) : openTool(iid);
}

/**
 * Connectivity test. { ok } or { ok:false, error }.
 * Storage: open + a cheap list. Others: the driver's own probe() if it has one, else just open/close
 * — so a driver without a probe still gets a real connect attempt rather than a false pass.
 */
async function test(iid) {
  const it = get(iid);
  if (!it) return { ok: false, error: 'integration not found: ' + iid };
  try {
    if (it.kind === 'storage') { const s = await openStorage(iid); await s.list('', { recursive: false }); return { ok: true }; }
    const driver = require('./types/' + it.type);
    if (typeof driver.probe === 'function') return { ok: true, ...(await driver.probe(await resolveConfig(it.config))) };
    const h = await openTool(iid);
    try { return { ok: true }; } finally { if (h && typeof h.close === 'function') await h.close(); }
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { KINDS, LIFECYCLES, list, get, create, update, remove, openStorage, openTool, open, test, resolveConfig };
