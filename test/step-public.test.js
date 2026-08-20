'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  looksLikePromptLeak, toolTitle, humanToolChip, discordToolLine, discordThoughtLine,
  speakerHintsFrom, mentionsSpeaker, thoughtBudget,
} = require('../shared/step-public');

test('looksLikePromptLeak: generic prompt-restatement patterns only', () => {
  assert.equal(looksLikePromptLeak('CURRENT SPEAKER — READ FIRST'), true);
  assert.equal(looksLikePromptLeak('see identity.md for the rest'), true);
  assert.equal(looksLikePromptLeak('CLAUDE.md says hello'), true);
  assert.equal(looksLikePromptLeak('write owner@example.com a note'), true);
  assert.equal(looksLikePromptLeak('path is /home/someone/.asmltr'), true);
  assert.equal(looksLikePromptLeak('Reading a file'), false);
  assert.equal(looksLikePromptLeak('the answer is 42'), false);
  assert.equal(looksLikePromptLeak('The user is Ada (ada-id) asking me (Ivy) in #room'), true);
  assert.equal(looksLikePromptLeak('This is a Discord message in #food'), true);
  assert.equal(looksLikePromptLeak('I was @-mentioned, so I should reply'), true);
  assert.equal(looksLikePromptLeak('Let me search the recipe board'), false);
});

test('speaker hints are runtime-only; thoughts mentioning them are dropped', () => {
  const hints = speakerHintsFrom({ username: 'wx412', globalName: 'Ada Lovelace' });
  assert.ok(hints.includes('wx412'));
  assert.ok(hints.includes('Ada Lovelace'));
  assert.ok(hints.includes('Lovelace'));
  assert.equal(hints.includes('Ada'), false); // tokens under 4 chars are skipped
  assert.equal(mentionsSpeaker('Ada Lovelace asked for ingredients', hints), true);
  assert.equal(mentionsSpeaker('wx412 is waiting', hints), true);
  assert.equal(mentionsSpeaker('Checking the recipe board', hints), false);
  assert.equal(discordThoughtLine('The user is Ada Lovelace (wx412) asking in #food', hints), '');
  assert.equal(discordThoughtLine('Let me search more thoroughly', hints), '-# 💭 Let me search more thoroughly');
});

test('thoughtBudget: xhigh uncapped; high/medium 2; below medium 0', () => {
  assert.equal(thoughtBudget('xhigh'), Infinity);
  assert.equal(thoughtBudget('high'), 2);
  assert.equal(thoughtBudget('medium'), 2);
  assert.equal(thoughtBudget('low'), 0);
  assert.equal(thoughtBudget(''), 2); // default before onEffort = medium
  assert.equal(thoughtBudget('high', { publicChannel: true }), 2);
  assert.equal(thoughtBudget('high', { publicChannel: false }), 2);
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
  assert.match(src, /if \(maxThoughts <= 0\) return;/);
  assert.match(src, /not xhigh: 💭 only, no tooling/);
  assert.match(src, /no Working filler on medium\/high/);
});
