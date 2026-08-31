'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { identifierLookups } = require('../core/src/trust/ident-lookups');
const { sendPolicyFromConfig } = require('../connectors/types/email/send-policy');

test('email resolve lookups skip display name / raw_username', () => {
  const pairs = identifierLookups('email', {
    raw_id: 'attacker@their.example',
    raw_username: 'stored-email-identifier@victim.example',
  });
  const values = pairs.map(([, v]) => v);
  assert.deepEqual(values, ['attacker@their.example']);
  assert.equal(values.includes('stored-email-identifier@victim.example'), false);
});

test('discord and telegram resolve numeric id only, not username', () => {
  assert.deepEqual(identifierLookups('discord', { raw_id: '111', raw_username: 'somehandle' }), [['discord', '111']]);
  assert.deepEqual(identifierLookups('telegram', { raw_id: '222', raw_username: 'tgname' }), [['telegram', '222']]);
});

test('sendPolicy comes from config, default always_draft', () => {
  assert.equal(sendPolicyFromConfig({}), 'always_draft');
  assert.equal(sendPolicyFromConfig({ approval_policy: 'always_draft' }), 'always_draft');
  assert.equal(sendPolicyFromConfig({ approval_policy: 'always_send' }), 'always_send');
});

test('email processMessage uses sendPolicyFromConfig / loaded policy, not a hardcoded always_send', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/email/index.js'), 'utf8');
  assert.match(src, /sendPolicyFromConfig|const sendPolicy = policy/);
  assert.equal(src.includes("const sendPolicy = 'always_send'"), false);
  const store = fs.readFileSync(path.join(__dirname, '../core/src/trust/store.js'), 'utf8');
  assert.match(store, /identifierLookups/);
});

test('processMessage runs auth before log_only persist and attachment save', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/email/index.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function processMessage'), src.indexOf('async function processMessage') + 9000);
  const authAt = fn.indexOf('authDisposition(parsed)');
  const logAt = fn.indexOf('persistLogOnlyAlert');
  const upAt = fn.indexOf('ctx.uploads.save');
  const threadAt = fn.indexOf('threads.set');
  const inboundAt = fn.indexOf("event_type: 'inbound'");
  assert.ok(authAt > 0);
  assert.ok(authAt < logAt);
  assert.ok(authAt < upAt);
  assert.ok(authAt < threadAt);
  assert.ok(authAt < inboundAt);
  assert.match(fn, /Turns: header From only/);
});
