'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildOpenAIParams, parseReasoningEffort } = require('../core/src/moderation');

test('parseReasoningEffort defaults to omit when unset', () => {
  assert.equal(parseReasoningEffort(undefined), '');
  assert.equal(parseReasoningEffort(null), '');
});

test('parseReasoningEffort treats empty / off / none as omit', () => {
  assert.equal(parseReasoningEffort(''), '');
  assert.equal(parseReasoningEffort('off'), '');
  assert.equal(parseReasoningEffort('NONE'), '');
  assert.equal(parseReasoningEffort('0'), '');
});

test('parseReasoningEffort passes through an explicit level', () => {
  assert.equal(parseReasoningEffort('minimal'), 'minimal');
  assert.equal(parseReasoningEffort('low'), 'low');
  assert.equal(parseReasoningEffort('HIGH'), 'high');
});

test('openai moderation params omit reasoning_effort by default', () => {
  const p = buildOpenAIParams('sys', 'user', { jsonMode: true, model: 'gpt-5-nano' });
  assert.equal('reasoning_effort' in p, false);
  assert.deepEqual(p.response_format, { type: 'json_object' });
  assert.equal(p.messages.length, 2);
  assert.equal(p.messages[0].role, 'system');
  assert.equal(p.messages[1].content, 'user');
});

test('empty reasoning effort omits the field (non-reasoning models)', () => {
  const p = buildOpenAIParams('sys', 'user', { jsonMode: false, reasoningEffort: '' });
  assert.equal('reasoning_effort' in p, false);
  assert.equal('response_format' in p, false);
});

test('env=minimal still sends reasoning_effort', () => {
  const p = buildOpenAIParams('sys', 'user', { reasoningEffort: 'minimal', model: 'gpt-5-nano' });
  assert.equal(p.reasoning_effort, 'minimal');
  assert.equal(p.model, 'gpt-5-nano');
});

test('explicit effort and model are passed through', () => {
  const p = buildOpenAIParams('sys', 'user', { reasoningEffort: 'low', model: 'gpt-5-mini' });
  assert.equal(p.reasoning_effort, 'low');
  assert.equal(p.model, 'gpt-5-mini');
});

test('reasoning_effort is omitted for non-gpt-5 OpenAI models', () => {
  const p = buildOpenAIParams('sys', 'user', { reasoningEffort: 'minimal', model: 'gpt-4o-mini' });
  assert.equal('reasoning_effort' in p, false);
  assert.equal(p.model, 'gpt-4o-mini');
});

test('classifyRaw is a separate helper; moderate() is unchanged', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../core/src/moderation.js'), 'utf8');
  const { classifyRaw, moderate, pictureIntentOffLog } = require('../core/src/moderation');
  assert.equal(typeof classifyRaw, 'function');
  assert.equal(typeof moderate, 'function');
  assert.match(src, /async function classifyRaw/);
  assert.match(src, /Do not fold intent into moderate/);
  assert.match(src, /jsonMode = MOD_PROVIDER !== 'anthropic'/);
  assert.match(src, /skipped: true/);
  const log = pictureIntentOffLog('openai_api_key');
  assert.match(log, /picture-intent classify OFF/);
  assert.match(log, /openai_api_key/);
  assert.match(log, /image_gen tools still work/);
});
