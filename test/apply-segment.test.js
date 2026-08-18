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

test('applySegment: growing prefix replaces, tail fragment appends', async () => {
  const { applySegment } = await import(helperUrl);
  let reply = applySegment('', "I'll");
  reply = applySegment(reply, "I'll check");
  assert.equal(reply, "I'll check");
  reply = applySegment(reply, ' what');
  assert.equal(reply, "I'll check what");
});

test('applySegment: empty chunk is a no-op', async () => {
  const { applySegment } = await import(helperUrl);
  assert.equal(applySegment("I'll", ''), "I'll");
  assert.equal(applySegment("I'll", null), "I'll");
});
