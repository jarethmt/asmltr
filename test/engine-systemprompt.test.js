'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { composePrompt } = require('../shared/prompt-compose');

test('composePrompt folds system + user into the framed block', () => {
  const out = composePrompt('IDENTITY+TRUST', 'do it');
  assert.ok(out.includes('IDENTITY+TRUST'), 'system text present');
  assert.ok(out.includes('do it'), 'user text present');
  assert.ok(out.includes('<system-instructions>'), 'open tag present');
  assert.ok(out.includes('</system-instructions>'), 'close tag present');
});

test('composePrompt with no system prompt returns the user prompt unchanged', () => {
  assert.strictEqual(composePrompt('', 'hi'), 'hi');
  assert.strictEqual(composePrompt(null, 'hi'), 'hi');
  assert.strictEqual(composePrompt('   ', 'hi'), 'hi');
});

test('composePrompt keeps the system text when the user prompt is empty', () => {
  assert.ok(composePrompt('SYS', '').includes('SYS'));
});

// Contract guard (the #43 "startup assertion" follow-up, done as a test): every engine adapter
// runner.js dispatches to must accept the systemPrompt key server.js composes, or the identity +
// trust-authz block is silently dropped. Reading the source text keeps this robust with no
// module-load or engine-dependency requirements.
for (const engineId of ['claude', 'codex', 'gemini']) {
  test(`${engineId} runTurn accepts a systemPrompt param`, () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'core', 'src', 'engines', `${engineId}.js`), 'utf8');
    const m = src.match(/async function runTurn\(\{([\s\S]*?)\}\)/);
    assert.ok(m, `${engineId}.js has a destructured runTurn signature`);
    const params = m[1].split(',').map((s) => s.trim().split(/[=:\s]/)[0]);
    assert.ok(params.includes('systemPrompt'),
      `${engineId} runTurn must destructure systemPrompt (found: ${params.join(', ')})`);
  });
}
