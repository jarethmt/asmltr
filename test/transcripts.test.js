'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-transcripts-'));
process.env.ASMLTR_SILOS_ROOT = tmp;

const transcripts = require('../shared/transcripts');
const silo = require('../shared/silo');

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});

test('safeKey hashes the conversation key (sha256 hex)', () => {
  const { createHash } = require('crypto');
  const hex = (s) => createHash('sha256').update(s).digest('hex');
  assert.equal(transcripts.safeKey('assistant-web:local:owner'), hex('assistant-web:local:owner'));
  assert.equal(transcripts.safeKey(''), hex('unknown'));
  assert.equal(transcripts.safeKey('assistant-web:local:owner').length, 64);
});

test('keys that share an 80-char prefix do not collide', () => {
  const a = 'x'.repeat(80) + '-one';
  const b = 'x'.repeat(80) + '-two';
  assert.notEqual(transcripts.safeKey(a), transcripts.safeKey(b));
});

test('appendTurn writes user+assistant into Self silo memory/transcripts and last-topics', () => {
  const ts = Date.UTC(2026, 7, 18, 18, 0, 0);
  const wrote = transcripts.appendTurn({
    conversationKey: 'assistant-web:local:owner',
    channel: 'assistant-web',
    userText: 'I like Laphroaig 10 and a 12-year refill sherry cask.',
    assistantText: 'Islay peat plus sherry is a solid pairing.',
    ts,
  });
  assert.equal(wrote.transcript, 'memory/transcripts/' + transcripts.safeKey('assistant-web:local:owner') + '.md');
  assert.equal(wrote.lastTopics, 'memory/last-topics.md');

  const self = silo.ensureSelf();
  const md = fs.readFileSync(path.join(self.dir, wrote.transcript), 'utf8');
  assert.ok(md.includes('Laphroaig 10'));
  assert.ok(md.includes('Islay peat plus sherry'));
  assert.ok(md.includes('**user:**'));
  assert.ok(md.includes('**assistant:**'));
  assert.ok(md.includes('assistant-web:local:owner'));

  const topics = fs.readFileSync(path.join(self.dir, wrote.lastTopics), 'utf8');
  assert.ok(topics.startsWith('# Last topics'));
  assert.ok(topics.includes('Laphroaig 10'));
  assert.ok(topics.includes('assistant-web:local:owner'));
});

test('appendTurn appends a second turn and keeps newest topic first', () => {
  const ts = Date.UTC(2026, 7, 18, 18, 5, 0);
  transcripts.appendTurn({
    conversationKey: 'assistant-web:local:owner',
    userText: 'Also curious about Caol Ila.',
    assistantText: 'Lighter peat, good contrast.',
    ts,
  });
  const self = silo.ensureSelf();
  const md = fs.readFileSync(path.join(self.dir, 'memory/transcripts/' + transcripts.safeKey('assistant-web:local:owner') + '.md'), 'utf8');
  assert.ok(md.includes('Laphroaig 10'));
  assert.ok(md.includes('Caol Ila'));
  const topics = fs.readFileSync(path.join(self.dir, 'memory/last-topics.md'), 'utf8');
  const lines = topics.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(lines[0].includes('Caol Ila'));
  assert.ok(lines.some((l) => l.includes('Laphroaig')));
});

test('recallForInject returns last-topics plus recent turns for a conversation when opted in', () => {
  const block = transcripts.recallForInject({ conversationKey: 'assistant-web:local:owner', includeLastTopics: true });
  assert.ok(block.includes('LAST TOPICS'));
  assert.ok(block.includes('Caol Ila'));
  assert.ok(block.includes('Laphroaig 10'));
  assert.ok(block.includes('RECENT TURNS FROM THIS CONVERSATION'));
  assert.ok(block.includes('**user:**'));
});

test('recallForInject default omits global last-topics so other principals do not see them', () => {
  const ts = Date.UTC(2026, 7, 18, 18, 10, 0);
  transcripts.appendTurn({
    conversationKey: 'discord:other-user',
    channel: 'discord',
    userText: 'secret discord topic xyz-only-here',
    assistantText: 'noted',
    ts,
  });
  transcripts.appendTurn({
    conversationKey: 'email:customer-thread',
    channel: 'email',
    userText: 'please reset our vpn',
    assistantText: 'working on it',
    ts: ts + 1000,
  });
  const customer = transcripts.recallForInject({ conversationKey: 'email:customer-thread' });
  assert.ok(customer.includes('please reset our vpn'));
  assert.ok(customer.includes('RECENT TURNS FROM THIS CONVERSATION'));
  assert.equal(customer.includes('LAST TOPICS'), false);
  assert.equal(customer.includes('secret discord topic xyz-only-here'), false);
  assert.equal(customer.includes('Laphroaig 10'), false);

  const owner = transcripts.recallForInject({ conversationKey: 'email:customer-thread', includeLastTopics: true });
  assert.ok(owner.includes('LAST TOPICS'));
  assert.ok(owner.includes('secret discord topic xyz-only-here'));
  assert.ok(owner.includes('please reset our vpn'));
});

test('recallForInject is empty when the silo has no transcript for that key', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-transcripts-empty-'));
  const prev = process.env.ASMLTR_SILOS_ROOT;
  process.env.ASMLTR_SILOS_ROOT = other;
  delete require.cache[require.resolve('../shared/silo')];
  delete require.cache[require.resolve('../shared/transcripts')];
  const fresh = require('../shared/transcripts');
  const block = fresh.recallForInject({ conversationKey: 'no-such-key' });
  process.env.ASMLTR_SILOS_ROOT = prev;
  try { fs.rmSync(other, { recursive: true, force: true }); } catch (_) {}
  assert.equal(block, '');
});
