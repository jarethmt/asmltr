'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../connectors/types/discord/match');
const read = require('../connectors/types/discord/read');

test('normalize folds the decoration Discord names carry', () => {
  assert.equal(m.normalize('🔧shop-floor'), 'shop floor');
  assert.equal(m.normalize('#Shop_Floor'), 'shop floor');
  assert.equal(m.normalize('ops.alerts'), 'ops alerts');
  assert.equal(m.normalize('・general｜chat'), 'general chat');
  assert.equal(m.normalize('  Shop   Floor  '), 'shop floor');
});

test('the tiers order better matches above worse ones', () => {
  const s = (q, c) => m.scoreString(q, c);
  assert.equal(s('shop-floor', 'shop-floor'), 1, 'exact after normalizing');
  assert.equal(s('Shop Floor', 'shop-floor'), 1, 'separators and case do not count');
  assert.ok(s('shop', 'shop-floor') > s('shop', 'workshop-photos'), 'a prefix beats a mid-word hit');
  assert.ok(s('floor shop', 'shop-floor') >= 0.85, 'word order does not matter');
  assert.ok(s('shp-floor', 'shop-floor') >= 0.45, 'a typo still lands');
  assert.equal(s('plating', 'shop-floor'), 0, 'an unrelated word scores nothing');
});

test('a subsequence of initials still resolves', () => {
  assert.ok(m.scoreString('shpflr', 'shop-floor') >= 0.45);
  assert.equal(m.isSubsequence('shpflr', 'shopfloor'), true);
  assert.equal(m.isSubsequence('xyz', 'shopfloor'), false);
});

test('a topic hit surfaces a channel but never outranks a name hit', () => {
  const byTopic = m.scoreChannel('plating tank', { name: 'bigpam-z', topic: 'nickel plating tank runs' }, null);
  const byName = m.scoreChannel('plating tank', { name: 'plating-tank', topic: null }, null);
  assert.equal(byTopic.matched_on, 'topic');
  assert.ok(byTopic.score >= m.THRESHOLD, 'the topic is searchable');
  assert.ok(byName.score > byTopic.score, 'the channel actually named that wins');
});

test('the guild name alone does not select every channel in the guild', () => {
  // A guild called Shop used to give every channel in it a 0.90 via the guild#name form, which
  // buried the channel actually called shop-floor.
  const guild = { id: 'g', name: 'Shop' };
  const floor = m.scoreChannel('shop', { name: 'shop-floor' }, guild);
  const general = m.scoreChannel('shop', { name: 'general' }, guild);
  assert.ok(floor.score >= 0.9);
  assert.equal(general.score, 0, 'an unrelated channel in a matching guild scores nothing');
});

test('guild#name still disambiguates two channels with the same name', () => {
  const shop = { id: 'g1', name: 'Shop' };
  const rad = { id: 'g2', name: 'Radiator' };
  const a = m.scoreChannel('shop general', { name: 'general' }, shop);
  const b = m.scoreChannel('shop general', { name: 'general' }, rad);
  assert.ok(a.score > b.score, 'naming the guild picks the right #general');
  assert.equal(a.matched_on, 'guild#name');
});

test('pickBest refuses a tie instead of guessing', () => {
  const tie = m.pickBest([{ id: 1, score: 0.85 }, { id: 2, score: 0.85 }]);
  assert.equal(tie.best, null);
  assert.equal(tie.reason, 'tie');
  assert.equal(tie.ranked.length, 2, 'the candidates come back so a caller can report them');

  const clear = m.pickBest([{ id: 1, score: 0.92 }, { id: 2, score: 0.6 }]);
  assert.equal(clear.best.id, 1);
  assert.equal(clear.reason, 'margin');

  const exact = m.pickBest([{ id: 1, score: 1 }, { id: 2, score: 0.95 }]);
  assert.equal(exact.best.id, 1, 'an exact match wins even inside the margin');

  assert.equal(m.pickBest([{ id: 1, score: 0.2 }]).best, null, 'noise is not a match');
});

// --- and the same thing through the read ops, which is what a caller touches ------------------
const coll = (arr) => { const map = new Map(arr.map((e) => [String(e.id), e])); return { get: (k) => map.get(String(k)), values: () => map.values() }; };
const ch = (id, name, topic) => ({ id, name, type: 0, viewable: true, topic: topic || null, messages: { async fetch() { return coll([]); } } });

const floor = ch('c1', '🔧shop-floor', 'big format printer, BigPAM');
const plating = ch('c2', 'plating-tank', 'nickel plating for the Dorna arm');
const generalShop = ch('c3', 'general');
const generalRad = ch('c4', 'general');
const shopGuild = { id: 'g1', name: 'Shop', memberCount: 9, channels: { cache: coll([floor, plating, generalShop]) } };
const radGuild = { id: 'g2', name: 'Radiator', memberCount: 3, channels: { cache: coll([generalRad]) } };
const deps = {
  client: { guilds: { cache: coll([shopGuild, radGuild]) }, channels: { cache: coll([floor, plating, generalShop, generalRad]) } },
  channelEnabled: () => true,
  resolveChannel: (t) => t,
};

test('channels ranks by closeness and reports why each row matched', () => {
  const r = read.listChannels(deps, { q: 'shop floor' });
  assert.equal(r.channels[0].channel_id, 'c1');
  assert.equal(r.channels[0].matched_on, 'name');
  assert.ok(r.channels[0].score >= 0.9);
  assert.equal(r.query, 'shop floor');
});

test('channels finds a channel by what it is for, not only by its name', () => {
  const r = read.listChannels(deps, { q: 'nickel plating' });
  assert.equal(r.channels[0].channel_id, 'c2');
  const byTopicOnly = read.listChannels(deps, { q: 'dorna arm' });
  assert.equal(byTopicOnly.channels[0].channel_id, 'c2', 'the topic is what says Dorna');
  assert.equal(byTopicOnly.channels[0].matched_on, 'topic');
});

test('a target resolves from a loose spelling, an emoji name, and word order', () => {
  for (const q of ['shop floor', 'floor shop', 'shop-floor', 'shpfloor', '#Shop-Floor']) {
    assert.equal(read.resolveChannelRef(deps, q).id, 'c1', `'${q}' should reach shop-floor`);
  }
});

test('two channels called general is still an error, now with scores', () => {
  const err = (() => { try { read.resolveChannelRef(deps, 'general'); } catch (e) { return e; } })();
  assert.equal(err.code, 'AMBIGUOUS');
  assert.match(err.message, /Shop#general/);
  assert.match(err.message, /Radiator#general/);
  // Naming the guild breaks the tie instead of forcing the user to find an id.
  assert.equal(read.resolveChannelRef(deps, 'radiator general').id, 'c4');
  assert.equal(read.resolveChannelRef(deps, 'shop general').id, 'c3');
});

test('guilds match loosely too', () => {
  assert.equal(read.listGuilds(deps, { q: 'radiatr' }).guilds[0].id, 'g2', 'a typo in a server name');
  assert.equal(read.listGuilds(deps, { q: 'the radiator' }).guilds[0].id, 'g2');
  assert.equal(read.listGuilds(deps, { q: 'nonsense' }).count, 0);
  assert.equal(read.listGuilds(deps, {}).count, 2, 'no query still lists everything');
});

test('a fuzzy guild filter scopes a channel listing', () => {
  const r = read.listChannels(deps, { guild: 'radiatr' });
  assert.equal(r.count, 1);
  assert.equal(r.channels[0].guild, 'Radiator');
});
