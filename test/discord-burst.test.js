'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BurstCoalescer, burstText } = require('../connectors/types/discord/burst.js');

const msg = (id, author, content, cid = 'c1') => ({
  id, content, cleanContent: content, channel: { id: cid },
  author: { id: 'u-' + author, username: author },
  attachments: new Map(),
});
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('a run of messages flushes once, carrying every part oldest first', async () => {
  const flushes = [];
  const b = new BurstCoalescer({ windowMs: 20, onFlush: (f) => flushes.push(f) });
  b.add('c1', msg('1', 'gianni', 'can you look at the slicer queue'));
  await tick(5);
  b.add('c1', msg('2', 'gianni', 'specifically the 502s'));
  await tick(5);
  b.add('c1', msg('3', 'gianni', 'and whether D2 is still blocked'));
  await tick(60);

  // This is the defect in #174: before the coalescer, each add() cleared the previous timer and
  // REPLACED the pending entry, so parts 1 and 2 reached neither handleMessage nor observe() and
  // the model answered a question about D2 having never seen the other two lines.
  assert.equal(flushes.length, 1, 'one turn, not three');
  assert.equal(flushes[0].count, 3);
  assert.deepEqual(flushes[0].parts.map((m) => m.id), ['1', '2', '3'], 'oldest first');
  assert.equal(flushes[0].trigger.id, '3', 'the last message stays the one being answered');
});

test('each new part resets the window, so the turn waits for the run to finish', async () => {
  const flushes = [];
  const b = new BurstCoalescer({ windowMs: 40, onFlush: (f) => flushes.push(f) });
  b.add('c1', msg('1', 'gianni', 'one'));
  await tick(25);
  assert.equal(flushes.length, 0, 'still inside the window');
  b.add('c1', msg('2', 'gianni', 'two'));
  await tick(25);
  assert.equal(flushes.length, 0, 'the second part pushed the deadline out');
  await tick(30);
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].count, 2);
});

test('channels are independent', async () => {
  const flushes = [];
  const b = new BurstCoalescer({ windowMs: 20, onFlush: (f) => flushes.push(f) });
  b.add('c1', msg('1', 'gianni', 'a', 'c1'));
  b.add('c2', msg('2', 'nikk', 'b', 'c2'));
  await tick(60);
  assert.equal(flushes.length, 2, 'one flush per channel, not one shared window');
});

test('forced is sticky across the run', async () => {
  const flushes = [];
  const b = new BurstCoalescer({ windowMs: 20, onFlush: (f) => flushes.push(f) });
  b.add('c1', msg('1', 'gianni', 'hey'), false);
  b.add('c1', msg('2', 'gianni', 'thor can you check this'), true);  // the @mention lands mid-run
  b.add('c1', msg('3', 'gianni', 'whenever'), false);
  await tick(60);
  assert.equal(flushes[0].forced, true, 'one mention inside the run makes the whole run answerable');
});

test('a long run is bounded, and says how much it dropped', async () => {
  const flushes = [];
  const b = new BurstCoalescer({ windowMs: 20, maxParts: 3, onFlush: (f) => flushes.push(f) });
  for (const id of ['1', '2', '3', '4', '5']) b.add('c1', msg(id, 'gianni', 'm' + id));
  await tick(60);
  // The newest is the message being answered, so a bounded run loses its beginning, and the count
  // is reported rather than the loss being silent.
  assert.deepEqual(flushes[0].parts.map((m) => m.id), ['3', '4', '5']);
  assert.equal(flushes[0].dropped, 2);
  assert.equal(flushes[0].count, 3);
});

test('stop() drops pending runs without firing a turn into a destroyed client', async () => {
  const flushes = [];
  const b = new BurstCoalescer({ windowMs: 20, onFlush: (f) => flushes.push(f) });
  b.add('c1', msg('1', 'gianni', 'mid-thought'));
  b.stop();
  await tick(60);
  assert.equal(flushes.length, 0);
});

test('flush() on an unknown or already-flushed channel is a no-op', async () => {
  const flushes = [];
  const b = new BurstCoalescer({ windowMs: 20, onFlush: (f) => flushes.push(f) });
  b.flush('nope');
  b.add('c1', msg('1', 'gianni', 'x'));
  b.flush('c1');
  b.flush('c1');
  await tick(60);
  assert.equal(flushes.length, 1, 'flushed once, and the timer did not fire a second one');
});

test('onFlush is required', () => {
  assert.throws(() => new BurstCoalescer({}), TypeError);
});

// --- burstText -----------------------------------------------------------------------------
test('one author reads as the lines they sent, in order, unattributed', () => {
  const parts = [msg('1', 'gianni', 'first'), msg('2', 'gianni', 'second')];
  assert.equal(burstText(parts, (m) => m.cleanContent), 'first\nsecond');
});

test('more than one author attributes every line', () => {
  // Collapsing two people into one unattributed block would put words in someone's mouth.
  const parts = [msg('1', 'gianni', 'is the arm free'), msg('2', 'nikk', 'yes since noon')];
  assert.equal(burstText(parts, (m) => m.cleanContent), 'gianni: is the arm free\nnikk: yes since noon');
});

test('empty parts are left out rather than producing blank lines', () => {
  const parts = [msg('1', 'gianni', 'text'), msg('2', 'gianni', ''), msg('3', 'gianni', 'more')];
  assert.equal(burstText(parts, (m) => m.cleanContent), 'text\nmore');
});

test('the per-message render is what gets joined, so a reply reference survives', () => {
  const parts = [msg('1', 'gianni', 'and this'), msg('2', 'gianni', 'too')];
  const out = burstText(parts, (m) => (m.id === '1' ? '[replying to X] ' : '') + m.cleanContent);
  assert.equal(out, '[replying to X] and this\ntoo');
});
