'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-placefeed-'));
process.env.ASMLTR_TRUST_DB = path.join(TMP, 'trust.db');   // places shares the trust DB, like devices
const places = require('../core/src/places');
const feed = require('../core/src/places-feed');

// A stub connector-manager serving the payload shapes main actually returns:
//   GET /instances                  -> { instances: [{ id, type, name }] }
//   GET /instances/:id/servers      -> { servers: [{ id, name, member_count }] }
//   GET /instances/:id/channels     -> { channels: [{ guild_id, guild, channel_id, name, enabled }] }
const routes = {
  '/instances': { instances: [{ id: 'dc1', type: 'discord', name: 'main' }, { id: 'tg1', type: 'telegram', name: 'tg' }, { id: 'em1', type: 'email', name: 'mail' }] },
  '/instances/dc1/servers': { ok: true, servers: [{ id: 'g1', name: '3D Print Pittsburgh', member_count: 22 }] },
  '/instances/dc1/channels': { ok: true, channels: [
    { guild_id: 'g1', guild: '3D Print Pittsburgh', channel_id: 'c1', name: 'shop-floor', enabled: true },
    { guild_id: 'g1', guild: '3D Print Pittsburgh', channel_id: 'c2', name: 'general', enabled: true },
  ] },
  // A connector that answers but has nothing: contributes nothing, reports why.
  '/instances/tg1/servers': { ok: true },
  '/instances/tg1/channels': { ok: true },
  // em1 is absent from `routes` entirely, so the stub 404s both proxies, which is what the manager
  // does for a connector type that declares no such endpoints (telegram, email, android).
};
let hits = [];
const srv = http.createServer((req, res) => {
  hits.push(req.url);
  const body = routes[req.url];
  res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body || { error: 'nope' }));
});
srv.listen(0);
process.env.ASMLTR_MANAGER_BASE = `http://127.0.0.1:${srv.address().port}`;

test.after(() => {
  srv.close();
  try { places.db.close(); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

const wipe = () => { places.db.exec('DELETE FROM place_labels; DELETE FROM places;'); hits = []; };

test('refresh pulls guilds and channels in through the manager proxies', async () => {
  wipe();
  const r = await feed.refresh(places);
  assert.equal(r.ok, true);
  assert.equal(r.guilds, 1);
  assert.equal(r.channels, 2);

  const guild = places.get('discord', 'g1');
  assert.equal(guild.kind, 'guild');
  assert.equal(guild.name, '3D Print Pittsburgh');
  const ch = places.get('discord', 'c1');
  assert.equal(ch.kind, 'channel');
  assert.equal(ch.display, '3D Print Pittsburgh#shop-floor', 'the guild NAME is denormalized onto the channel row');
  assert.equal(ch.parent_id, 'g1');
  assert.equal(ch.source, 'refresh');
  assert.equal(ch.instance_id, 'dc1');
});

test('a connector with no places contributes nothing and is reported, not thrown', async () => {
  wipe();
  const r = await feed.refresh(places);
  const tg = r.instances.find((i) => i.instance_id === 'tg1');
  assert.equal(tg.guilds, 0);
  assert.equal(tg.channels, 0);
  assert.match(tg.error, /no places/);
  assert.equal(r.ok, true, 'one empty connector does not make the whole refresh a failure');
});

test('refresh can be scoped to one instance or one surface', async () => {
  wipe();
  await feed.refresh(places, { instance_id: 'dc1', surface: 'discord' });
  assert.equal(places.count(), 3);
  assert.equal(hits.includes('/instances'), false, 'a named instance skips the listing call');

  wipe();
  await feed.refresh(places, { surface: 'telegram' });
  assert.equal(places.count(), 0, 'only the telegram instance was asked, and it has none');
  assert.equal(hits.some((h) => h.startsWith('/instances/dc1')), false);
});

test('an unreachable manager is a reason, not an exception', async () => {
  wipe();
  const saved = process.env.ASMLTR_MANAGER_BASE;
  process.env.ASMLTR_MANAGER_BASE = 'http://127.0.0.1:1';   // nothing listens
  try {
    const r = await feed.refresh(places);
    assert.equal(r.ok, false);
    assert.ok(r.error, 'says why');
    assert.equal(places.count(), 0);
  } finally { process.env.ASMLTR_MANAGER_BASE = saved; }
});

test('refresh is idempotent and does not multiply rows', async () => {
  wipe();
  await feed.refresh(places);
  const first = places.count();
  await feed.refresh(places);
  assert.equal(places.count(), first);
});

// --- import ------------------------------------------------------------------------------------
function aliasFile(obj) {
  const f = path.join(TMP, `aliases-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

test('import reads the `channels` block that no code has ever read', async () => {
  wipe();
  const f = aliasFile({
    _comment: 'ignored',
    aliases: { 'TD-shop': 'c1', _skip: 'nope' },
    channels: { c1: { server: 'Shop', channel: 'shop-floor', description: 'BigPAM and large format' } },
  });
  const r = feed.importAliasFile(places, { file: f });
  assert.equal(r.ok, true);
  assert.equal(r.channels, 1);
  assert.equal(r.aliases, 1, 'the _skip key is not an alias');

  const p = places.get('discord', 'c1');
  assert.equal(p.name, 'shop-floor');
  assert.equal(p.parent_name, 'Shop');
  assert.equal(p.topic, 'BigPAM and large format', 'the description an operator wrote down, finally stored');
  assert.deepEqual(p.aliases, ['td-shop']);
  assert.equal(places.resolve('TD-shop', 'discord').place.scope_id, 'c1');
});

test('an alias with no description still gets a row, so the label cannot dangle', () => {
  wipe();
  const f = aliasFile({ aliases: { lonely: 'c9' } });
  feed.importAliasFile(places, { file: f });
  assert.equal(places.resolve('lonely', 'discord').place.scope_id, 'c9');
  assert.equal(places.get('discord', 'c9').name, null, 'no name yet; a refresh will fill it');
});

test('a refresh after an import keeps the description and updates the name', async () => {
  wipe();
  const f = aliasFile({ channels: { c1: { server: 'Old Name', channel: 'old-channel', description: 'why it matters' } } });
  feed.importAliasFile(places, { file: f });
  await feed.refresh(places, { instance_id: 'dc1', surface: 'discord' });
  const p = places.get('discord', 'c1');
  // The platform is authoritative about the name. It is not authoritative about why the channel
  // matters, and a refresh that wiped the description would make people stop running refresh.
  assert.equal(p.name, 'shop-floor');
  assert.equal(p.parent_name, '3D Print Pittsburgh');
  assert.equal(p.topic, 'why it matters');
});

test('import is idempotent', () => {
  wipe();
  const f = aliasFile({ aliases: { a: 'c1' }, channels: { c1: { channel: 'x' } } });
  feed.importAliasFile(places, { file: f });
  feed.importAliasFile(places, { file: f });
  assert.equal(places.count(), 1);
  assert.deepEqual(places.get('discord', 'c1').aliases, ['a']);
});

test('a missing or broken alias file is a reason, not a throw', () => {
  wipe();
  const missing = feed.importAliasFile(places, { file: path.join(TMP, 'nope.json') });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no alias file/);

  const bad = path.join(TMP, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  assert.equal(feed.importAliasFile(places, { file: bad }).ok, false);
  assert.equal(places.count(), 0);
});

test('a connector type with no places endpoint is dropped, not listed as an error', async () => {
  wipe();
  // Found running a refresh against the live manager: the telegram instance reported
  // "manager said 404" simply for not serving /servers or /channels, turning an ordinary refresh
  // into a page of noise. A type that cannot have places has nothing to report.
  const r = await feed.refresh(places);
  const ids = (r.instances || []).map((i) => i.instance_id);
  assert.equal(ids.includes('em1'), false, 'the 404-on-both type is not in the report');
  assert.equal(r.skipped, 1, 'but it is counted, so the number of instances still adds up');
  assert.equal(r.ok, true);

  // A connector that DOES serve the endpoint and simply has nothing is still reported, because that
  // is a state worth seeing (an empty guild list can mean the bot was removed).
  const tg = (r.instances || []).find((i) => i.instance_id === 'tg1');
  assert.ok(tg, 'answered-but-empty is still listed');
  assert.match(tg.error, /no places/);
});

test('a parse failure never echoes what was read', () => {
  wipe();
  // JSON.parse quotes the first ~10 bytes of its input, so returning e.message made the import a
  // read oracle: one request per 10 bytes of any file the core user can open.
  const secret = path.join(TMP, 'not-json.txt');
  fs.writeFileSync(secret, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5SECRET gianni@thor');
  const r = feed.importAliasFile(places, { file: secret });
  assert.equal(r.ok, false);
  assert.match(r.error, /not valid JSON/);
  assert.equal(/ssh-ed25519|AAAAC3|SECRET/.test(r.error), false, `error leaked content: ${r.error}`);
  // And the two failure modes stay distinguishable, which is what the caller actually needs.
  assert.match(feed.importAliasFile(places, { file: path.join(TMP, 'absent.json') }).error, /no alias file/);
});
