'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const helperUrl = pathToFileURL(
  path.join(__dirname, '../insights/dashboard/src/lib/segment.js')
).href;

test('applySegment: first chunk sets reply', async () => {
  const { applySegment } = await import(helperUrl);
  assert.equal(applySegment('', "I'll"), "I'll");
  assert.equal(applySegment(null, "I'll"), "I'll");
});

test('applySegment: growing snapshot replaces when new starts with old', async () => {
  const { applySegment } = await import(helperUrl);
  let reply = applySegment('', "I'll");
  reply = applySegment(reply, "I'll check");
  assert.equal(reply, "I'll check");
  reply = applySegment(reply, "I'll check the lane");
  assert.equal(reply, "I'll check the lane");
});

test('applySegment: token pieces with leading space append as-is (no invented spaces)', async () => {
  const { applySegment } = await import(helperUrl);
  let reply = applySegment('', 'Here');
  reply = applySegment(reply, ' is');
  reply = applySegment(reply, ' a');
  reply = applySegment(reply, ' summary');
  assert.equal(reply, 'Here is a summary');
  const mashed = ['Here', 'is', 'a', 'summary'].reduce((acc, t) => acc + t, '');
  assert.equal(mashed, 'Hereisasummary');
  assert.notEqual(reply, mashed);
});

test('applySegment: does not invent a space when the piece has none', async () => {
  const { applySegment } = await import(helperUrl);
  assert.equal(applySegment('People', 'bowl'), 'Peoplebowl');
});

test('applySegment: empty chunk is a no-op', async () => {
  const { applySegment } = await import(helperUrl);
  assert.equal(applySegment("I'll", ''), "I'll");
  assert.equal(applySegment("I'll", null), "I'll");
});
