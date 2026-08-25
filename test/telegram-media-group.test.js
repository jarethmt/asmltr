'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MediaGroupCoalescer } = require('../connectors/types/telegram/media-group.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const img = (n) => ({ type: 'image', name: `photo_${n}.jpg` });
const route = { chatId: 7, userId: 'gianni', from: { username: 'gianni' }, message_id: 1 };

test('an album of separate messages flushes as ONE dispatch after the quiet window', async () => {
  const flushes = [];
  const c = new MediaGroupCoalescer({ windowMs: 40, onFlush: (g) => flushes.push(g) });
  for (let i = 0; i < 3; i++) {
    c.add('grp', { attachments: [img(i)], savedNotes: [`- image: photo_${i}.jpg`], caption: i === 0 ? 'my album' : '', route });
    await delay(10); // arrive 10ms apart, inside the window — the timer keeps resetting
  }
  assert.equal(flushes.length, 0, 'nothing dispatches while photos are still arriving');
  await delay(60);
  assert.equal(flushes.length, 1, 'one dispatch for the whole album');
  assert.equal(flushes[0].count, 3);
  assert.equal(flushes[0].attachments.length, 3, 'all three images in one turn');
  assert.equal(flushes[0].savedNotes.length, 3, 'every file saved');
  assert.equal(flushes[0].caption, 'my album', 'the album caption rides through');
  assert.equal(flushes[0].dropped, 0);
});

test('images past maxImages are dropped from the vision payload but counted', async () => {
  const flushes = [];
  const c = new MediaGroupCoalescer({ windowMs: 20, maxImages: 2, onFlush: (g) => flushes.push(g) });
  for (let i = 0; i < 5; i++) c.add('grp', { attachments: [img(i)], savedNotes: [`n${i}`], route });
  await delay(40);
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].attachments.length, 2, 'vision payload capped at maxImages');
  assert.equal(flushes[0].dropped, 3, 'the rest are reported as dropped');
  assert.equal(flushes[0].count, 5);
  assert.equal(flushes[0].savedNotes.length, 5, 'but every file is still saved');
});

test('two interleaved albums flush independently', async () => {
  const flushes = [];
  const c = new MediaGroupCoalescer({ windowMs: 25, onFlush: (g) => flushes.push(g) });
  c.add('A', { attachments: [img('a1')], savedNotes: [], route });
  c.add('B', { attachments: [img('b1')], savedNotes: [], route });
  c.add('A', { attachments: [img('a2')], savedNotes: [], route });
  await delay(50);
  assert.equal(flushes.length, 2, 'one flush per group');
  const byCount = flushes.map((f) => f.attachments.length).sort();
  assert.deepEqual(byCount, [1, 2], 'group A got 2 images, group B got 1');
});

test('manual flush emits early and is idempotent; the timer never double-fires', async () => {
  const flushes = [];
  const c = new MediaGroupCoalescer({ windowMs: 30, onFlush: (g) => flushes.push(g) });
  c.add('grp', { attachments: [img(0)], savedNotes: [], route });
  c.flush('grp');
  assert.equal(flushes.length, 1, 'flush dispatches immediately');
  c.flush('grp'); // already gone
  assert.equal(flushes.length, 1, 'a second flush is a no-op');
  await delay(50);
  assert.equal(flushes.length, 1, 'the pending timer did not fire after the manual flush');
});

test('stop() drops pending groups without dispatching', async () => {
  const flushes = [];
  const c = new MediaGroupCoalescer({ windowMs: 20, onFlush: (g) => flushes.push(g) });
  c.add('grp', { attachments: [img(0)], savedNotes: [], route });
  c.stop();
  await delay(40);
  assert.equal(flushes.length, 0, 'a shutdown mid-album flushes nothing');
});

test('the constructor rejects a missing onFlush', () => {
  assert.throws(() => new MediaGroupCoalescer({}), TypeError);
});
