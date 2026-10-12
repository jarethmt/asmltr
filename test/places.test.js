'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the store at a throwaway DB before requiring it (it opens on import, like every other core
// store). Closed in test.after: a better-sqlite3 Statement whose destructor runs after the worker's
// environment is gone aborts the process on node >= 24.19 (see reference: bs3 must be >= 13 / N-API).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-places-'));
process.env.ASMLTR_CORE_DB = path.join(TMP, 'core.db');
const places = require('../core/src/places');

test.after(() => {
  try { places.db.close(); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

const wipe = () => { places.db.exec('DELETE FROM place_labels; DELETE FROM places;'); };

test('upsert records a place and renders a display name a human recognizes', () => {
  wipe();
  const p = places.upsert({
    surface: 'discord', scope_id: '1534195903924146250', kind: 'channel',
    name: 'general', parent_id: '999', parent_name: '3D Print Pittsburgh', source: 'refresh',
  });
  assert.equal(p.surface, 'discord');
  assert.equal(p.display, '3D Print Pittsburgh#general');
  assert.equal(p.source, 'refresh');
  assert.deepEqual(p.aliases, []);
  assert.equal(places.count(), 1);
});

test('upsert is idempotent and a partial update cannot blank a filled field', () => {
  wipe();
  places.upsert({ surface: 'discord', scope_id: 'c1', kind: 'channel', name: 'shop-floor', topic: 'BigPAM', parent_name: 'Shop' });
  // A refresh that carries no topic must not erase the topic a previous source filled. This is the
  // COALESCE in the ON CONFLICT clause; without it every refresh would strip hand-entered detail.
  const after = places.upsert({ surface: 'discord', scope_id: 'c1', name: 'shop-floor-renamed', source: 'refresh' });
  assert.equal(after.topic, 'BigPAM', 'topic survives a partial update');
  assert.equal(after.name, 'shop-floor-renamed', 'the name is what a refresh is for');
  assert.equal(after.parent_name, 'Shop');
  assert.equal(places.count(), 1, 'same key, same row');
});

test('upsert refuses a missing key or an unknown kind', () => {
  wipe();
  for (const bad of [{}, { surface: 'discord' }, { scope_id: 'x' }]) {
    assert.throws(() => places.upsert(bad), (e) => e.code === 'BAD_REQUEST');
  }
  assert.throws(() => places.upsert({ surface: 'discord', scope_id: 'x', kind: 'wormhole' }),
    (e) => e.code === 'BAD_REQUEST' && /guild \| channel/.test(e.message));
});

test('a role survives a rename, which is why labels are a separate table', () => {
  wipe();
  places.upsert({ surface: 'discord', scope_id: 'c9', kind: 'channel', name: 'gianni-remote-work-log', parent_name: 'Shop' });
  places.setLabel({ surface: 'discord', scope_id: 'c9', label: 'shift-log', kind: 'role', note: 'end-of-shift logs go here' });
  places.upsert({ surface: 'discord', scope_id: 'c9', name: 'work-log-2026', source: 'refresh' });
  const p = places.get('discord', 'c9');
  assert.deepEqual(p.roles, ['shift-log'], 'the role outlives the platform rename');
  assert.equal(p.name, 'work-log-2026');
  assert.equal(places.resolve('shift-log').place.scope_id, 'c9');
});

test('a label is unique per surface, so re-pointing it moves it', () => {
  wipe();
  places.upsert({ surface: 'discord', scope_id: 'old', name: 'old-log' });
  places.upsert({ surface: 'discord', scope_id: 'new', name: 'new-log' });
  places.setLabel({ surface: 'discord', scope_id: 'old', label: 'shift-log', kind: 'role' });
  places.setLabel({ surface: 'discord', scope_id: 'new', label: 'shift-log', kind: 'role' });
  // An operator correcting a mistake expects the role to MOVE, not to end up claimed twice.
  assert.deepEqual(places.get('discord', 'old').roles, []);
  assert.deepEqual(places.get('discord', 'new').roles, ['shift-log']);
  assert.equal(places.resolve('shift-log').place.scope_id, 'new');
});

test('labels are case-insensitive and keep their note', () => {
  wipe();
  places.upsert({ surface: 'discord', scope_id: 'c1', name: 'general' });
  places.setLabel({ surface: 'discord', scope_id: 'c1', label: 'TD-Shop', note: 'legacy alias' });
  assert.equal(places.resolve('td-shop', 'discord').place.scope_id, 'c1');
  assert.equal(places.resolve('TD-SHOP', 'discord').place.scope_id, 'c1');
  assert.deepEqual(places.get('discord', 'c1').notes, ['legacy alias']);
  assert.equal(places.unsetLabel('discord', 'TD-shop'), true);
  assert.equal(places.unsetLabel('discord', 'TD-shop'), false, 'removing twice is not an error, just false');
});

test('resolve prefers id, then label, then exact name, then loose', () => {
  wipe();
  places.upsert({ surface: 'discord', scope_id: 'c-general', kind: 'channel', name: 'general', parent_name: 'Shop' });
  places.upsert({ surface: 'discord', scope_id: 'c-notes', kind: 'channel', name: 'general-notes', parent_name: 'Shop' });
  places.setLabel({ surface: 'discord', scope_id: 'c-notes', label: 'notes', kind: 'alias' });

  assert.equal(places.resolve('c-general', 'discord').matched_on, 'id');
  assert.equal(places.resolve('notes', 'discord').matched_on, 'label');
  // "general" matches both loosely; exact-name-first is what stops general-notes winning.
  const byName = places.resolve('general', 'discord');
  assert.equal(byName.matched_on, 'name');
  assert.equal(byName.place.scope_id, 'c-general');
  // A loose case has to actually be a substring of one name and not the other: "general-not" is
  // inside general-notes and nowhere else. ("notes-" is in neither, and correctly resolves to nothing.)
  const loose = places.resolve('general-not', 'discord');
  assert.equal(loose.matched_on, 'loose');
  assert.equal(loose.place.scope_id, 'c-notes');
  assert.equal(places.resolve('#general', 'discord').place.scope_id, 'c-general', 'a leading # is tolerated');
});

test('resolve finds a place by its topic when the name says nothing', () => {
  wipe();
  places.upsert({ surface: 'discord', scope_id: 'c-pam', kind: 'channel', name: 'bigpam-z', topic: 'nickel plating tank runs' });
  const r = places.resolve('plating tank', 'discord');
  assert.equal(r.place.scope_id, 'c-pam');
  assert.equal(r.matched_on, 'loose');
});

test('an ambiguous reference is an error carrying the candidates, not a pick', () => {
  wipe();
  places.upsert({ surface: 'discord', scope_id: 'c1', name: 'general', parent_name: 'Shop' });
  places.upsert({ surface: 'discord', scope_id: 'c2', name: 'general', parent_name: 'Radiator' });
  const err = (() => { try { places.resolve('general', 'discord'); } catch (e) { return e; } })();
  assert.equal(err.code, 'AMBIGUOUS');
  assert.equal(err.candidates.length, 2);
  assert.match(err.message, /Shop#general/);
  assert.match(err.message, /Radiator#general/);
  assert.match(err.message, /Pass the id/);
});

test('resolve works across surfaces when a label is unique, and refuses when it is not', () => {
  wipe();
  places.upsert({ surface: 'discord', scope_id: 'd1', name: 'work-log' });
  places.upsert({ surface: 'telegram', scope_id: 't1', name: 'Gianni DM', kind: 'chat' });
  places.setLabel({ surface: 'discord', scope_id: 'd1', label: 'shift-log', kind: 'role' });
  // No surface given: a unique label still resolves, which is what lets a caller say "shift-log"
  // without knowing which connector owns it.
  assert.equal(places.resolve('shift-log').place.surface, 'discord');

  places.setLabel({ surface: 'telegram', scope_id: 't1', label: 'shift-log', kind: 'role' });
  const err = (() => { try { places.resolve('shift-log'); } catch (e) { return e; } })();
  assert.equal(err.code, 'AMBIGUOUS');
  assert.match(err.message, /more than one surface/);
  // Naming the surface disambiguates rather than forcing an id.
  assert.equal(places.resolve('shift-log', 'telegram').place.scope_id, 't1');
});

test('resolve says what to run next when nothing matches', () => {
  wipe();
  const err = (() => { try { places.resolve('nothing-like-this', 'discord'); } catch (e) { return e; } })();
  assert.equal(err.code, 'NOT_FOUND');
  assert.match(err.message, /asmltr places -q/);
  assert.throws(() => places.resolve(''), (e) => e.code === 'BAD_REQUEST');
});

test('list filters by surface, kind, role and free text', () => {
  wipe();
  places.upsert({ surface: 'discord', scope_id: 'g1', kind: 'guild', name: '3D Print Pittsburgh' });
  places.upsert({ surface: 'discord', scope_id: 'c1', kind: 'channel', name: 'shop-floor', parent_name: '3D Print Pittsburgh' });
  places.upsert({ surface: 'telegram', scope_id: 't1', kind: 'chat', name: 'Gianni' });
  places.setLabel({ surface: 'discord', scope_id: 'c1', label: 'shift-log', kind: 'role' });

  assert.equal(places.list().length, 3);
  assert.equal(places.list({ surface: 'discord' }).length, 2);
  assert.equal(places.list({ kind: 'guild' }).length, 1);
  assert.deepEqual(places.list({ role: 'shift-log' }).map((p) => p.scope_id), ['c1']);
  assert.deepEqual(places.list({ q: 'shop' }).map((p) => p.scope_id), ['c1']);
  assert.equal(places.list({ q: 'nothing' }).length, 0);
});

test('roles() returns every binding with the place it points at', () => {
  wipe();
  places.upsert({ surface: 'discord', scope_id: 'c1', name: 'work-log', parent_name: 'Shop' });
  places.setLabel({ surface: 'discord', scope_id: 'c1', label: 'shift-log', kind: 'role', note: 'end of shift' });
  places.setLabel({ surface: 'discord', scope_id: 'c1', label: 'td-shop', kind: 'alias' });
  const r = places.roles();
  assert.equal(r.length, 1, 'aliases are not roles');
  assert.equal(r[0].label, 'shift-log');
  assert.equal(r[0].name, 'work-log');
  assert.equal(r[0].note, 'end of shift');
});

test('remove drops the place and its labels together', () => {
  wipe();
  places.upsert({ surface: 'discord', scope_id: 'c1', name: 'doomed' });
  places.setLabel({ surface: 'discord', scope_id: 'c1', label: 'gone', kind: 'alias' });
  assert.equal(places.remove('discord', 'c1'), true);
  assert.equal(places.get('discord', 'c1'), null);
  // A label left pointing at a deleted place would resolve to nothing and look like corruption.
  assert.throws(() => places.resolve('gone', 'discord'), (e) => e.code === 'NOT_FOUND');
  assert.equal(places.remove('discord', 'c1'), false);
});

test('a read of an unknown place is null, not a throw', () => {
  wipe();
  assert.equal(places.get('discord', 'no-such'), null);
  assert.equal(places.get('nonsense-surface', 'x'), null);
  assert.deepEqual(places.list({ surface: 'nonsense' }), []);
  assert.equal(places.count(), 0);
});
