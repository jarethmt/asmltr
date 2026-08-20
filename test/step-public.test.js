'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  looksLikePromptLeak, toolTitle, humanToolChip, discordToolLine, discordThoughtLine,
} = require('../shared/step-public');

test('looksLikePromptLeak: generic prompt-restatement patterns only', () => {
  assert.equal(looksLikePromptLeak('CURRENT SPEAKER — READ FIRST'), true);
  assert.equal(looksLikePromptLeak('see identity.md for the rest'), true);
  assert.equal(looksLikePromptLeak('CLAUDE.md says hello'), true);
  assert.equal(looksLikePromptLeak('write owner@example.com a note'), true);
  assert.equal(looksLikePromptLeak('path is /home/someone/.asmltr'), true);
  assert.equal(looksLikePromptLeak('Reading a file'), false);
  assert.equal(looksLikePromptLeak('the answer is 42'), false);
});

test('human chips: start only, no paths or ACP type names', () => {
  assert.equal(humanToolChip({ name: 'Read' }), 'Reading a file');
  assert.equal(humanToolChip({ name: 'read_file' }), 'Reading a file');
  assert.equal(humanToolChip({ name: 'Bash' }), 'Running a command');
  assert.equal(humanToolChip({ name: 'Grep' }), 'Searching');
  assert.equal(humanToolChip({ name: 'WebSearch' }), 'Looking something up');
  assert.equal(humanToolChip({ name: 'tool_call' }), 'Working');
  assert.equal(humanToolChip({ name: 'tool_call_update' }), 'Working');
  assert.equal(humanToolChip({}), 'Working');
  assert.equal(toolTitle({ name: '/tmp/secret' }), '');
  assert.equal(discordToolLine(false, { name: 'Read' }), '-# Reading a file');
  assert.equal(discordToolLine(true, { name: 'Read' }), '-# 🔧 `Read`');
  assert.equal(discordToolLine(true, { name: 'tool_call' }), '-# 🔧 `Working`');
  assert.ok(!discordToolLine(false, { name: 'Read', input: { path: '/home/someone/x' } }).includes('/home'));
});

test('discordThoughtLine: leaky bubbles dropped whole; safe intent becomes 💭 chip', () => {
  assert.equal(discordThoughtLine('CURRENT SPEAKER — READ FIRST, TRUST THIS'), '');
  assert.equal(discordThoughtLine('I should open identity.md next'), '');
  assert.equal(discordThoughtLine('see CLAUDE.md'), '');
  assert.equal(discordThoughtLine('email owner@example.com about this'), '');
  assert.equal(discordThoughtLine('check /home/someone/.asmltr'), '');
  assert.equal(discordThoughtLine(''), '');
  const safe = discordThoughtLine('Checking the mailbox before I answer.');
  assert.equal(safe, '-# 💭 Checking the mailbox before I answer.');
  const long = 'x'.repeat(400);
  const clamped = discordThoughtLine(long);
  assert.ok(clamped.startsWith('-# 💭 '));
  assert.ok(clamped.length <= '-# 💭 '.length + 280);
  assert.ok(clamped.endsWith('…'));
});

test('Discord never renderSteps raw thought text', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.equal(src.includes("renderStep('💭 '"), false);
  assert.match(src, /discordThoughtLine/);
  assert.match(src, /onThinking:/);
});
