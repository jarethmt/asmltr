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

test('applySegment: space-only delta after period must produce "time. The"', async () => {
  const { applySegment } = await import(helperUrl);
  let reply = applySegment('', 'time.');
  reply = applySegment(reply, ' ');
  reply = applySegment(reply, 'The');
  assert.equal(reply, 'time. The');
  assert.notEqual(reply, 'time.The');
});

test('applySegment: space-only chunk is not dropped as falsy', async () => {
  const { applySegment } = await import(helperUrl);
  assert.equal(applySegment('time.', ' '), 'time. ');
  assert.equal(applySegment('time. ', 'The'), 'time. The');
});

test('applySegment: next sentence without leading space still gets ". "', async () => {
  const { applySegment } = await import(helperUrl);
  assert.equal(applySegment('time.', 'The'), 'time. The');
  assert.equal(applySegment('work.', "I'll"), "work. I'll");
  assert.equal(applySegment('grow.', "I'll"), "grow. I'll");
});

test('applySegment: narration draft then restated answer is one sentence, not both', async () => {
  const { applySegment } = await import(helperUrl);
  const draft = 'Coconut aminos is already on your card as the soy-sauce stand-in.';
  const answer = 'Coconut aminos is already on your card as the soy-sauce replacement.';
  const reply = applySegment(draft, answer);
  assert.equal(reply, answer);
  assert.ok(!reply.includes('stand-in'));
  assert.ok(!reply.includes(draft + ' ' + answer));
  assert.notEqual(reply, draft + ' ' + answer);
});

test('applySegment: status block then restated answer keeps the answer only', async () => {
  const { applySegment } = await import(helperUrl);
  const status = "Vim is in Preferences, not Story — and it was a bad translation of your house rule, not something I believe about myself. I'll take it out. Coconut aminos is already on your card as the soy-sauce stand-in.";
  const answer = 'Coconut aminos is already on your card as the soy-sauce replacement. That stays.';
  const reply = applySegment(status, answer);
  assert.equal(reply, answer);
  assert.ok(!reply.includes('stand-in'));
  assert.ok(!reply.includes('Vim is in Preferences'));
});

test('applySegment: time. + The is still period-space, not a narration replace', async () => {
  const { applySegment, isCompleteBlock } = await import(helperUrl);
  assert.equal(isCompleteBlock('time.'), false);
  assert.equal(isCompleteBlock('The'), false);
  assert.equal(applySegment('time.', 'The'), 'time. The');
});

test('applySegment: James kettle draft then answer is FINAL only, not on.Yes', async () => {
  const { applySegment, preferLastBlock, isCompleteBlock } = await import(helperUrl);
  const draft = 'TEST-DRAFT: the kettle is on.';
  const mid = 'Yes. I can do it on purpose, and I just did.';
  const fin = 'TEST-FINAL: the tea is poured.';
  const answer = mid + '\n\n' + fin;
  assert.equal(isCompleteBlock(draft), true);
  assert.equal(isCompleteBlock(mid), true);
  assert.equal(isCompleteBlock(fin), true);
  assert.equal(applySegment(draft, answer), answer);
  assert.ok(!applySegment(draft, answer).includes('on.Yes'));
  assert.ok(!applySegment(draft, answer).startsWith('TEST-DRAFT'));
  let reply = applySegment('', draft);
  reply = applySegment(reply, mid);
  reply = applySegment(reply, fin);
  assert.equal(reply, fin);
  assert.ok(!reply.includes('kettle'));
  assert.ok(!reply.includes('on.Yes'));
  const liveMash = draft + mid; // raw onDelta += after a missed tool close
  assert.equal(liveMash, 'TEST-DRAFT: the kettle is on.Yes. I can do it on purpose, and I just did.');
  assert.equal(preferLastBlock(answer, liveMash + '\n\n' + fin), answer);
  assert.equal(preferLastBlock(liveMash + '\n\n' + fin, answer), answer);
  assert.equal(applySegment('time.', 'The'), 'time. The');
});

