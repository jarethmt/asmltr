'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const read = require('../connectors/types/discord/read');

// A fake discord.js client. The ops take their deps injected precisely so they can be driven
// against this instead of a live gateway: the shapes below are the only parts of discord.js the
// module touches (guilds.cache, channels.cache, messages.fetch, and a handful of channel fields).
function collection(entries) {
  const m = new Map(entries.map((e) => [String(e.id), e]));
  return { get: (k) => m.get(String(k)), values: () => m.values(), get size() { return m.size; } };
}

function msg(id, author, content, opts = {}) {
  return {
    id: String(id),
    content,
    createdTimestamp: opts.ts || 1757000000000 + Number(id) * 1000,
    editedTimestamp: opts.edited || null,
    author: { id: opts.authorId || 'u-' + author, username: author, bot: !!opts.bot },
    attachments: collection(opts.attachments || []),
    reference: opts.replyTo ? { messageId: String(opts.replyTo) } : null,
    pinned: !!opts.pinned,
    channel: { id: String(opts.channelId || 'c-general') },
  };
}

// A channel whose messages.fetch honors limit + before, so pagination is exercised for real.
function textChannel(id, name, msgs, extra = {}) {
  const ordered = [...msgs].sort((a, b) => Number(b.id) - Number(a.id)); // newest first, like Discord
  return {
    id, name, type: 0, viewable: true, topic: extra.topic || null, parentId: extra.parentId || null,
    fetchCalls: [],
    messages: {
      async fetch(opts = {}) {
        const self = channelsById[id];
        self.fetchCalls.push({ ...opts });
        if (extra.denied) throw new Error('Missing Access');
        let list = ordered;
        if (opts.before) list = list.filter((m) => Number(m.id) < Number(opts.before));
        return collection(list.slice(0, opts.limit || 50));
      },
    },
    ...extra.fields,
  };
}

const general = textChannel('c-general', 'general', [msg(1, 'gianni', 'morning'), msg(2, 'jareth', 'the printer jammed'), msg(3, 'gianni', 'on it')]);
// id 345 is the 5th-newest, so a 100-message scan reaches it and a 3-message one does not.
const shop = textChannel('c-shop', 'shop-floor', Array.from({ length: 250 }, (_, i) => msg(100 + i, 'gianni', i === 245 ? 'BigPAM is down' : 'routine note ' + i)));
const secret = textChannel('c-secret', 'secret', [msg(9, 'jareth', 'disabled channel content')]);
const locked = textChannel('c-locked', 'locked', [msg(8, 'x', 'never')], { denied: true });
const voice = { id: 'c-voice', name: 'General Voice', type: 2, viewable: true };
const category = { id: 'c-cat', name: 'A Category', type: 4, viewable: true };
const hidden = { id: 'c-hidden', name: 'hidden', type: 0, viewable: false };
const dm = { id: 'c-dm', type: 1, viewable: true, recipient: { username: 'gianni' }, messages: { async fetch() { return collection([msg(7, 'gianni', 'private note')]); } } };

const channelsById = {};
for (const c of [general, shop, secret, locked, voice, category, hidden, dm]) channelsById[c.id] = c;

const guildChannels = collection([general, shop, secret, locked, voice, category, hidden]);
const guild = { id: 'g-1', name: 'Shop', memberCount: 12, channels: { cache: guildChannels } };
const guild2 = { id: 'g-2', name: 'Radiator', memberCount: 4, channels: { cache: collection([textChannel('c-rad', 'general', [msg(5, 'moneo', 'hello from radiator')])]) } };

const disabled = new Set(['c-secret']);
function deps(over = {}) {
  return {
    client: { guilds: { cache: collection([guild, guild2]) }, channels: { cache: collection(Object.values(channelsById)) } },
    channelEnabled: (cid) => !disabled.has(String(cid)),
    resolveChannel: (t) => ({ 'TD-TSD-main': 'c-general' }[t] || t),
    ...over,
  };
}

test('guilds lists every server, and q filters by name', () => {
  const all = read.listGuilds(deps(), {});
  assert.deepEqual(all.guilds.map((g) => g.name), ['Radiator', 'Shop']);
  assert.equal(all.guilds[1].member_count, 12);
  assert.deepEqual(read.listGuilds(deps(), { q: 'rad' }).guilds.map((g) => g.id), ['g-2']);
  assert.equal(read.listGuilds(deps(), { q: 'nothing' }).count, 0);
});

test('channels covers voice and threads, not just text and announcement', () => {
  // The existing GET /channels is `[0, 5]` only, which is the gap this op closes.
  const rows = read.listChannels(deps(), {}).channels;
  const types = new Set(rows.map((r) => r.type));
  assert.ok(types.has('text'), 'text');
  assert.ok(types.has('voice'), 'voice channels are findable');
  assert.equal(types.has('category'), false, 'a category holds no messages, so it is not a result');
});

test('channels filters by name, guild and type', () => {
  assert.deepEqual(read.listChannels(deps(), { q: 'shop' }).channels.map((c) => c.channel_id), ['c-shop']);
  assert.deepEqual(read.listChannels(deps(), { guild: 'radiator' }).channels.map((c) => c.guild), ['Radiator']);
  const voices = read.listChannels(deps(), { type: 'voice' }).channels;
  assert.equal(voices.length, 1);
  assert.equal(voices[0].name, 'General Voice');
});

test('channels hides disabled and unviewable ones, and says how many', () => {
  const r = read.listChannels(deps(), {});
  assert.equal(r.channels.some((c) => c.channel_id === 'c-secret'), false, 'operator-disabled stays out');
  assert.equal(r.channels.some((c) => c.channel_id === 'c-hidden'), false, 'no View Channel means no row');
  assert.equal(r.skipped.disabled, 1);
  assert.equal(r.skipped.unviewable, 1);
  const withDisabled = read.listChannels(deps(), { include_disabled: true });
  assert.ok(withDisabled.channels.some((c) => c.channel_id === 'c-secret'));
});

test('DMs stay out of the channel list until asked for by name', () => {
  const plain = read.listChannels(deps(), {});
  assert.equal(plain.channels.some((c) => c.type === 'dm'), false);
  assert.equal(plain.skipped.dm > 0, true);
  const withDms = read.listChannels(deps(), { include_dms: true });
  assert.ok(withDms.channels.some((c) => c.type === 'dm' && c.name === 'gianni'));
});

test('a channel resolves by id, by alias, and by name', () => {
  assert.equal(read.resolveChannelRef(deps(), 'c-shop').id, 'c-shop');
  assert.equal(read.resolveChannelRef(deps(), 'TD-TSD-main').id, 'c-general', 'channel-aliases.json entry');
  assert.equal(read.resolveChannelRef(deps(), 'shop-floor').id, 'c-shop');
  assert.equal(read.resolveChannelRef(deps(), '#shop-floor').id, 'c-shop', 'a leading # is tolerated');
});

test('an ambiguous channel name is an error naming the candidates, not a guess', () => {
  // "general" exists in both guilds. Picking one silently would read the wrong room.
  const err = (() => { try { read.resolveChannelRef(deps(), 'general'); } catch (e) { return e; } })();
  assert.equal(err.code, 'AMBIGUOUS');
  assert.match(err.message, /Shop#general/);
  assert.match(err.message, /Radiator#general/);
  assert.match(err.message, /Pass the channel id/);
});

test('an unknown channel points at the lookup op', () => {
  const err = (() => { try { read.resolveChannelRef(deps(), 'no-such'); } catch (e) { return e; } })();
  assert.equal(err.code, 'NOT_FOUND');
  assert.match(err.message, /asmltr discord channels/);
});

test('history returns newest-first messages with author, timestamp and reply target', async () => {
  const r = await read.fetchHistory(deps(), { target: 'c-general' });
  assert.equal(r.channel.name, 'general');
  assert.deepEqual(r.messages.map((m) => m.content), ['on it', 'the printer jammed', 'morning']);
  const first = r.messages[0];
  assert.equal(first.author, 'gianni');
  assert.equal(first.author_id, 'u-gianni');
  assert.equal(first.bot, false);
  assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('history paginates past the 100-message fetch cap', async () => {
  shop.fetchCalls.length = 0;
  const r = await read.fetchHistory(deps(), { target: 'c-shop', limit: 250 });
  assert.equal(r.count, 250);
  assert.ok(shop.fetchCalls.length >= 3, `expected pagination, got ${shop.fetchCalls.length} fetch(es)`);
  assert.equal(shop.fetchCalls[0].limit, 100, 'never asks Discord for more than 100 at once');
  assert.ok(shop.fetchCalls[1].before, 'later pages carry a before cursor');
  const ids = r.messages.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'pagination must not repeat a message');
});

test('history caps an absurd limit instead of walking the whole channel', async () => {
  const r = await read.fetchHistory(deps(), { target: 'c-shop', limit: 1e9 });
  assert.equal(r.count, read.HISTORY_CAP > 250 ? 250 : read.HISTORY_CAP, 'bounded by what exists or the cap');
  assert.ok(r.count <= read.HISTORY_CAP);
});

test('history refuses a disabled channel until told explicitly', async () => {
  const err = await read.fetchHistory(deps(), { target: 'c-secret' }).then(() => null, (e) => e);
  assert.equal(err.code, 'FORBIDDEN');
  assert.match(err.message, /include_disabled/);
  const ok = await read.fetchHistory(deps(), { target: 'c-secret', include_disabled: true });
  assert.equal(ok.messages[0].content, 'disabled channel content');
});

test('history refuses a DM until told explicitly', async () => {
  const err = await read.fetchHistory(deps(), { target: 'c-dm' }).then(() => null, (e) => e);
  assert.equal(err.code, 'FORBIDDEN');
  assert.match(err.message, /include_dms/);
});

test('history on a channel without messages says so rather than throwing a type error', async () => {
  const err = await read.fetchHistory(deps(), { target: 'c-voice' }).then(() => null, (e) => e);
  assert.equal(err.code, 'BAD_REQUEST');
  assert.match(err.message, /holds no messages/);
});

test('a permission failure on the first page is reported as forbidden', async () => {
  const err = await read.fetchHistory(deps(), { target: 'c-locked' }).then(() => null, (e) => e);
  assert.equal(err.code, 'FORBIDDEN');
  assert.match(err.message, /Missing Access/);
});

test('search finds a match and reports how much it actually scanned', async () => {
  const r = await read.searchMessages(deps(), { q: 'bigpam', target: 'c-shop', scan: 100 });
  assert.equal(r.count, 1);
  assert.equal(r.matches[0].content, 'BigPAM is down');
  assert.equal(r.matches[0].channel, 'shop-floor');
  assert.equal(r.scanned[0].messages_scanned, 100, 'the bound is reported, so "no match" is readable');
  assert.match(r.note, /bounded scan/);
});

test('search matches case-insensitively', async () => {
  const plain = await read.searchMessages(deps(), { q: 'PRINTER', target: 'c-general' });
  assert.equal(plain.count, 1, 'plain text is case-insensitive');
});

test('a /regex/ needle is refused, not compiled and not silently taken as literal text', async () => {
  // The pattern would otherwise be a caller-supplied program on this connector's event loop, and no
  // input cap bounds catastrophic backtracking: `(a+)+$` is six characters. Refusing with a reason
  // beats returning zero matches, which reads as a broken search.
  await assert.rejects(
    () => read.searchMessages(deps(), { q: '/jam+ed/', target: 'c-general' }),
    (e) => e.code === 'BAD_REQUEST' && /plain text/.test(e.message),
  );
  await assert.rejects(
    () => read.searchMessages(deps(), { q: '/(a+)+$/i', target: 'c-general' }),
    (e) => e.code === 'BAD_REQUEST',
  );
  // The text inside a refused pattern still searches fine as plain text.
  const ok = await read.searchMessages(deps(), { q: 'jammed', target: 'c-general' });
  assert.equal(ok.count, 1);
});

test('search across channels skips the ones it cannot read instead of failing', async () => {
  const r = await read.searchMessages(deps(), { q: 'note' });
  const ids = r.scanned.map((s) => s.channel_id);
  assert.equal(ids.includes('c-secret'), false, 'disabled channels are not scanned');
  assert.ok(ids.includes('c-locked'), 'a denied channel is still reported');
  assert.equal(r.scanned.find((s) => s.channel_id === 'c-locked').denied, 'Missing Access');
});

test('search needs a query', async () => {
  const err = await read.searchMessages(deps(), {}).then(() => null, (e) => e);
  assert.equal(err.code, 'BAD_REQUEST');
});

test('handleRead rejects an unknown op and names the valid ones', async () => {
  const err = await read.handleRead(deps(), { op: 'delete-everything' }).then(() => null, (e) => e);
  assert.equal(err.code, 'BAD_REQUEST');
  for (const op of read.OPS) assert.match(err.message, new RegExp(op));
});

test('handleRead audits the call with the arguments, never the message content', async () => {
  const events = [];
  const r = await read.handleRead(deps({ emit: (e) => events.push(e) }), { op: 'history', target: 'c-general', limit: 2 });
  assert.equal(r.count, 2);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.event_type, 'control');
  assert.equal(e.payload.action, 'discord-read');
  assert.equal(e.payload.op, 'history');
  assert.equal(e.payload.target, 'c-general');
  assert.equal(e.payload.returned, 2);
  // The audit trail says what was asked for. Copying the messages into telemetry would put the
  // content it is auditing into a second store.
  assert.equal(JSON.stringify(e).includes('the printer jammed'), false, 'message content must not ride along');
});

test('a failing emit does not fail the read', async () => {
  const logged = [];
  const r = await read.handleRead(deps({ emit: () => { throw new Error('collector down'); }, log: (m) => logged.push(m) }), { op: 'guilds' });
  assert.equal(r.count, 2);
  assert.match(logged.join(' '), /audit emit failed/);
});
