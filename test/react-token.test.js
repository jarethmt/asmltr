'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseReact, normalizeEmoji } = require('../shared/react-token');

test('strips a react line and keeps the reply', () => {
  const r = parseReact('that was unhinged\n[[REACT:😂]]');
  assert.equal(r.text, 'that was unhinged');
  assert.equal(r.emoji, '😂');
});

test('react-only leaves empty text', () => {
  const r = parseReact('[[REACT:🤦]]');
  assert.equal(r.text, '');
  assert.equal(r.emoji, '🤦');
});

test('unknown emoji is dropped, text kept', () => {
  const r = parseReact('hello\n[[REACT:flag_xx]]');
  assert.equal(r.text, 'hello');
  assert.equal(r.emoji, null);
});

test('👀 and 🛑 are not in the color palette', () => {
  assert.equal(normalizeEmoji('👀'), null);
  assert.equal(normalizeEmoji('🛑'), null);
});

test('first allowed emoji wins; mention in prose is not a token', () => {
  const r = parseReact('I almost wrote [[REACT:😂]] in the sentence.\n[[REACT:🤯]]\n[[REACT:🔥]]');
  assert.equal(r.emoji, '🤯');
  assert.match(r.text, /almost wrote/);
});
