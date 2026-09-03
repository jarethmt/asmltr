'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  workingPlaceholder, finalIssueComment, issueCommentBodies, looksLikeEngineTrace,
} = require('../connectors/types/github/issue-comment');

test('final comment is last segment only — no thinking, no tool chrome', () => {
  const actions = [{
    type: 'reply',
    text: 'I will grep the repo.\n\nThe timeout is 15s.',
    segments: [
      'Let me read clone-auth.js and the collector events.',
      'The timeout is 15s.',
    ],
  }];
  const body = finalIssueComment(actions);
  assert.equal(body, 'The timeout is 15s.');
  assert.equal(looksLikeEngineTrace(body), false);
  assert.equal(issueCommentBodies(actions).length, 1);
});

test('empty reply still posts one placeholder line, never a trace dump', () => {
  assert.equal(finalIssueComment([]), '_(no response generated)_');
  assert.equal(issueCommentBodies(null).length, 1);
  assert.equal(looksLikeEngineTrace(workingPlaceholder('Gaia')), false);
  assert.match(workingPlaceholder('Gaia'), /Gaia is on it/);
});

test('secrets in the answer are redacted before post', () => {
  const actions = [{ type: 'reply', text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leftover' }];
  const body = finalIssueComment(actions);
  assert.match(body, /REDACTED:github-pat/);
  assert.equal(body.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), false);
});

test('old live-trace layout is detected; final helper never produces it', () => {
  const leaked = '<details><summary>🧠 Thinking (2)</summary>\n\n💭 _plan_\n\n</details>\n\n### 💬 Response\n\nok\n\n<details><summary>🔍 Trace (1 step)</summary>\n\n🔧 **Bash** `cat ~/.asmltr/vault.pass`\n\n<details><summary>📥 output</summary>\n\n```\nsecret\n```\n\n</details>\n\n</details>';
  assert.equal(looksLikeEngineTrace(leaked), true);
  const body = finalIssueComment([{ type: 'reply', text: 'ok', segments: [leaked, 'ok'] }]);
  assert.equal(body, 'ok');
  assert.equal(looksLikeEngineTrace(body), false);
});

test('github connector no longer fetches collector events or packs a tool trace', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/github/index.js'), 'utf8');
  assert.equal(src.includes('/api/events'), false, 'must not pull collector events to post');
  assert.equal(src.includes('COLLECTOR_BASE'), false);
  assert.equal(src.includes('liveBody'), false);
  assert.equal(src.includes('packComments'), false);
  assert.equal(src.includes('renderTrace'), false);
  assert.equal(src.includes('fetchSessionEvents'), false);
  assert.match(src, /finalIssueComment/);
});
