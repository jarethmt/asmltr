'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const meta = require('../connectors/types/email').meta;
const SRC = fs.readFileSync(require.resolve('../connectors/types/email'), 'utf8');

test('ingest_only is in the schema and defaults to on', () => {
  const p = meta.configSchema.properties.ingest_only;
  assert.ok(p, 'ingest_only missing');
  assert.equal(p.type, 'boolean');
  assert.equal(p.default, true, 'a new mailbox must be mute until opted in');
});

test('it is a separate axis — approval_policy is untouched', () => {
  assert.deepEqual(meta.configSchema.properties.approval_policy.enum,
    ['always_draft', 'auto_send_full_trust', 'always_send', 'trust_tier:1', 'trust_tier:2', 'trust_tier:3']);
});

test('absent key means off, so existing instances are not silenced', () => {
  assert.match(SRC, /const ingestOnly = cfg\.ingest_only === true;/,
    'must be strict === true so undefined reads as off');
});

test('the engine call is skipped, not merely suppressed after the fact', () => {
  const handleIdx = SRC.indexOf('await ctx.core.handle(');
  assert.ok(handleIdx > -1);
  const gate = SRC.lastIndexOf('if (ingestOnly)', handleIdx);
  assert.ok(gate > -1 && gate < handleIdx, 'must return before ctx.core.handle()');
});

test('explicit sending is NOT blocked — ingest-only mutes the mailbox, it does not gag it', () => {
  // The operator asks for mail from these addresses, so sendMail/smtpSend must stay reachable.
  const sendIdx = SRC.indexOf('async function sendMail');
  const smtpIdx = SRC.indexOf('async function smtpSend');
  const bodyStart = Math.min(sendIdx, smtpIdx);
  const bodyEnd = Math.max(sendIdx, smtpIdx) + 600;
  const body = SRC.slice(bodyStart, bodyEnd);
  assert.ok(!/ingestOnly/.test(body),
    'the send path must not consult ingestOnly — explicit sends are allowed');
});
