'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Resolve express from core/, where the module under test resolves it (deps install per package).
const express = require(require.resolve('express', { paths: [path.join(__dirname, '..', 'core', 'src')] }));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-placeroutes-'));
process.env.ASMLTR_TRUST_DB = path.join(TMP, 'trust.db');   // places shares the trust DB, like devices
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

test('the import route ignores a caller-supplied file path', async () => {
  // Flagged by the security review and verified: the core runs as the user, so a path from the body
  // reads anything it can read. JSON.parse also quotes the first ~10 bytes of its input, so even a
  // failed parse would leak ("Unexpected token 's', \"ssh-ed2551\"... is not valid JSON"). The path
  // is server-side config only (ASMLTR_DISCORD_ALIASES_FILE).
  wipe();
  const seen = [];
  const app2 = express();
  app2.use(express.json());
  mountPlaceRoutes(app2, {
    places,
    record: () => {},
    feed: { importAliasFile: (store, o = {}) => { seen.push(o); return { ok: true, file: 'server-side', aliases: 0, channels: 0 }; } },
  });
  const s2 = app2.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${s2.address().port}/v2/places/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: '/home/gianni/.ssh/id_ed25519', surface: 'discord' }),
    });
    assert.equal(r.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].file, undefined, 'the path from the body must never reach the reader');
    assert.equal(seen[0].surface, 'discord', 'but surface still does');
  } finally { s2.close(); }
});

// --- a label's note is the one gated field ---------------------------------------------------
// Names and ids leak nothing a send does not already require, so the reads stay open. A note is
// free text a human wrote about a place, so it rides only on a request presenting the manager token.
const getAuth = (p, tok) => fetch(base() + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const postAuth = (p, body, tok) => fetch(base() + p, {
  method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: 'Bearer ' + tok } : {}),
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const withToken = async (tok, fn) => {
  const had = process.env.ASMLTR_MANAGER_TOKEN;
  if (tok == null) delete process.env.ASMLTR_MANAGER_TOKEN; else process.env.ASMLTR_MANAGER_TOKEN = tok;
  try { await fn(); } finally {
    if (had === undefined) delete process.env.ASMLTR_MANAGER_TOKEN; else process.env.ASMLTR_MANAGER_TOKEN = had;
  }
};

const seedNoted = async () => {
  wipe();
  await post('/v2/places', { surface: 'discord', scope_id: 'c9', kind: 'channel', name: 'escalations', parent_name: 'Shop' });
  await post('/v2/places/label', { surface: 'discord', scope_id: 'c9', label: 'escalate', kind: 'role', note: 'ring Jareth first' });
};

test('with no manager token configured, notes never leave the host', async () => {
  await withToken(null, async () => {
    await seedNoted();
    const l = await get('/v2/places');
    assert.deepEqual(l.body.places[0].notes, undefined);
    assert.equal('note' in l.body.roles[0], false);
    assert.equal(l.body.roles[0].label, 'escalate');          // the binding itself is still public
    const one = await get('/v2/places/discord/c9');
    assert.deepEqual(one.body.notes, undefined);
    const r = await get('/v2/places/resolve?ref=escalate');
    assert.deepEqual(r.body.place.notes, undefined);
  });
});

test('a token configured but not presented is still no access', async () => {
  await withToken('s3cret', async () => {
    await seedNoted();
    assert.deepEqual((await get('/v2/places')).body.places[0].notes, undefined);
    // A wrong token is the same answer as none, and the length mismatch must not throw.
    assert.deepEqual((await getAuth('/v2/places', 'nope')).body.places[0].notes, undefined);
    assert.deepEqual((await getAuth('/v2/places', 's3crez')).body.places[0].notes, undefined);
  });
});

test('the manager token reads notes back', async () => {
  await withToken('s3cret', async () => {
    await seedNoted();
    const l = await getAuth('/v2/places', 's3cret');
    assert.deepEqual(l.body.places[0].notes, ['ring Jareth first']);
    assert.equal(l.body.roles[0].note, 'ring Jareth first');
    assert.deepEqual((await getAuth('/v2/places/discord/c9', 's3cret')).body.notes, ['ring Jareth first']);
    assert.deepEqual((await getAuth('/v2/places/resolve?ref=escalate', 's3cret')).body.place.notes, ['ring Jareth first']);
  });
});

test('a write response is not a note read oracle', async () => {
  // setLabel and upsert both return the whole hydrated row, which carries every note already on the
  // place. Without scrubbing the write response, a caller who can write would read notes by adding
  // one throwaway alias.
  await withToken('s3cret', async () => {
    await seedNoted();
    const unauth = await post('/v2/places/label', { surface: 'discord', scope_id: 'c9', label: 'throwaway' });
    assert.equal(unauth.status, 200);
    assert.deepEqual(unauth.body.place.notes, undefined);
    const up = await post('/v2/places', { surface: 'discord', scope_id: 'c9', topic: 'x' });
    assert.deepEqual(up.body.place.notes, undefined);
    // The operator presenting the token still gets them.
    const authed = await postAuth('/v2/places/label', { surface: 'discord', scope_id: 'c9', label: 'throwaway2' }, 's3cret');
    assert.deepEqual(authed.body.place.notes, ['ring Jareth first']);
  });
});
