'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Resolve express from core/, where the module under test resolves it (deps install per package).
const express = require(require.resolve('express', { paths: [path.join(__dirname, '..', 'core', 'src')] }));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-placeroutes-'));
process.env.ASMLTR_CORE_DB = path.join(TMP, 'core.db');
const places = require('../core/src/places');
const { mountPlaceRoutes } = require('../core/src/places-routes');

const events = [];
const app = express();
app.use(express.json());
mountPlaceRoutes(app, { places, record: (e) => events.push(e) });
const srv = app.listen(0);
const base = () => `http://127.0.0.1:${srv.address().port}`;

test.after(() => {
  srv.close();
  try { places.db.close(); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

const wipe = () => { places.db.exec('DELETE FROM place_labels; DELETE FROM places;'); events.length = 0; };
const get = (p) => fetch(base() + p).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const post = (p, body) => fetch(base() + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const del = (p) => fetch(base() + p, { method: 'DELETE' }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test('POST upserts a place and GET lists it with its roles', async () => {
  wipe();
  const up = await post('/v2/places', { surface: 'discord', scope_id: 'c1', kind: 'channel', name: 'shop-floor', parent_name: 'Shop', by: 'thor' });
  assert.equal(up.status, 200);
  assert.equal(up.body.place.display, 'Shop#shop-floor');

  await post('/v2/places/label', { surface: 'discord', scope_id: 'c1', label: 'shift-log', kind: 'role', note: 'end of shift', by: 'thor' });
  const l = await get('/v2/places');
  assert.equal(l.status, 200);
  assert.equal(l.body.count, 1);
  assert.deepEqual(l.body.places[0].roles, ['shift-log']);
  assert.equal(l.body.roles[0].label, 'shift-log');
});

test('a write emits a control event naming the session that did it', async () => {
  wipe();
  await post('/v2/places', { surface: 'discord', scope_id: 'c1', name: 'general', by: 'thor' });
  await post('/v2/places/label', { surface: 'discord', scope_id: 'c1', label: 'td-shop', by: 'eve' });
  // The audit trail is what stands in for a permission model while cross-channel access is ungated.
  assert.deepEqual(events.map((e) => e.payload.action), ['place-upsert', 'place-label']);
  assert.equal(events[0].event_type, 'control');
  assert.equal(events[0].identity, 'thor');
  assert.equal(events[1].identity, 'eve');
  assert.equal(events[1].payload.label, 'td-shop');
});

test('resolve answers with the place and how it matched', async () => {
  wipe();
  await post('/v2/places', { surface: 'discord', scope_id: 'c1', name: 'work-log', parent_name: 'Shop' });
  await post('/v2/places/label', { surface: 'discord', scope_id: 'c1', label: 'shift-log', kind: 'role' });
  const byRole = await get('/v2/places/resolve?ref=shift-log');
  assert.equal(byRole.status, 200);
  assert.equal(byRole.body.place.scope_id, 'c1');
  assert.equal(byRole.body.matched_on, 'label');
  const byId = await get('/v2/places/resolve?ref=c1&surface=discord');
  assert.equal(byId.body.matched_on, 'id');
});

test('an ambiguous resolve is 409 and carries the candidates', async () => {
  wipe();
  await post('/v2/places', { surface: 'discord', scope_id: 'c1', name: 'general', parent_name: 'Shop' });
  await post('/v2/places', { surface: 'discord', scope_id: 'c2', name: 'general', parent_name: 'Radiator' });
  const r = await get('/v2/places/resolve?ref=general&surface=discord');
  assert.equal(r.status, 409, 'the caller has to choose');
  assert.equal(r.body.code, 'AMBIGUOUS');
  assert.equal(r.body.candidates.length, 2, 'and needs the list to choose from');
});

test('resolve maps its other failures to real status codes', async () => {
  wipe();
  assert.equal((await get('/v2/places/resolve?ref=nothing-here')).status, 404);
  assert.equal((await get('/v2/places/resolve')).status, 400, 'no ref at all');
});

test('GET one place answers 404 for an unknown id', async () => {
  wipe();
  await post('/v2/places', { surface: 'discord', scope_id: 'c1', name: 'general' });
  assert.equal((await get('/v2/places/discord/c1')).body.name, 'general');
  assert.equal((await get('/v2/places/discord/nope')).status, 404);
});

test('a bad upsert is 400, not 500', async () => {
  wipe();
  assert.equal((await post('/v2/places', { scope_id: 'c1' })).status, 400);
  assert.equal((await post('/v2/places', { surface: 'discord', scope_id: 'c1', kind: 'wormhole' })).status, 400);
  assert.equal((await post('/v2/places/label', { surface: 'discord', label: 'x' })).status, 400);
});

test('filters reach the store', async () => {
  wipe();
  await post('/v2/places', { surface: 'discord', scope_id: 'g1', kind: 'guild', name: '3DPP' });
  await post('/v2/places', { surface: 'discord', scope_id: 'c1', kind: 'channel', name: 'shop-floor', parent_name: '3DPP' });
  await post('/v2/places', { surface: 'telegram', scope_id: 't1', kind: 'chat', name: 'Gianni' });
  await post('/v2/places/label', { surface: 'discord', scope_id: 'c1', label: 'shift-log', kind: 'role' });

  assert.equal((await get('/v2/places?surface=telegram')).body.places.length, 1);
  assert.equal((await get('/v2/places?kind=guild')).body.places.length, 1);
  assert.equal((await get('/v2/places?role=shift-log')).body.places[0].scope_id, 'c1');
  assert.equal((await get('/v2/places?q=shop')).body.places.length, 1);
});

test('DELETE removes a label and a place, and 404s when there is nothing to remove', async () => {
  wipe();
  await post('/v2/places', { surface: 'discord', scope_id: 'c1', name: 'doomed' });
  await post('/v2/places/label', { surface: 'discord', scope_id: 'c1', label: 'gone' });
  assert.equal((await del('/v2/places/discord/label/gone')).status, 200);
  assert.equal((await del('/v2/places/discord/label/gone')).status, 404);
  assert.equal((await del('/v2/places/discord/c1')).status, 200);
  assert.equal((await del('/v2/places/discord/c1')).status, 404);
  assert.equal((await get('/v2/places')).body.count, 0);
});
