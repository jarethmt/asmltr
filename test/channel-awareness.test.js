'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.ASSISTANT_NAME = 'FixtureBot';
process.env.ASMLTR_NAME_FILE = '/tmp/asmltr-no-such-name-file';

const { runtimeName, buildChannelAwareness } = require('../core/src/channel-awareness');

after(() => {
  delete process.env.ASSISTANT_NAME;
  delete process.env.ASMLTR_NAME_FILE;
});

const CLAUDE_SENTENCE =
  'Your underlying runtime is Claude Code, but that is an internal implementation detail and is NOT the medium of this conversation.';

test('runtimeName: claude stays Claude Code; others are their harness', () => {
  assert.equal(runtimeName('claude'), 'Claude Code');
  assert.equal(runtimeName('grok'), 'Grok');
  assert.equal(runtimeName('gemini'), 'Gemini CLI');
  assert.equal(runtimeName('codex'), 'Codex');
  assert.equal(runtimeName(''), 'Claude Code');
  assert.equal(runtimeName(undefined), 'Claude Code');
});

test('claude engine prompt is unchanged from the historical Claude Code sentence', () => {
  const text = buildChannelAwareness(
    { channel: 'discord', sender: { raw_username: 'Ada' } },
    { display_name: 'Ada' },
    { engineId: 'claude' },
  );
  assert.ok(text.includes(CLAUDE_SENTENCE), 'claude installs keep the Claude Code runtime line');
  assert.ok(text.includes('do NOT say "Claude Code"'));
  assert.ok(text.includes('Discord'));
  assert.ok(text.includes('FixtureBot'));
  assert.equal(text.includes('Grok'), false);
});

test('grok engine names Grok and does not claim Claude Code', () => {
  const text = buildChannelAwareness(
    { channel: 'email', sender: { raw_username: 'Ada' } },
    { display_name: 'Ada' },
    { engineId: 'grok' },
  );
  assert.ok(text.includes('Your underlying runtime is Grok, but that is an internal implementation detail'));
  assert.ok(text.includes('do NOT say "Grok"'));
  assert.equal(text.includes(CLAUDE_SENTENCE), false);
  assert.ok(text.includes('email'));
});

test('android spoken nudge still appends on that channel', () => {
  const text = buildChannelAwareness(
    { channel: 'android', sender: { raw_username: 'Ada' } },
    { display_name: 'Ada' },
    { engineId: 'claude' },
  );
  assert.ok(text.includes('SPOKEN OUTPUT'));
  assert.ok(text.includes(CLAUDE_SENTENCE));
});
