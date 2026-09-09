'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { queueOutboundMail } = require('../connectors/types/email');

test('queueOutboundMail returns before sendMail finishes', async () => {
  let finished = false;
  let started = false;
  const sendMail = () => {
    started = true;
    return new Promise((resolve) => setTimeout(() => { finished = true; resolve({ messageId: 'x' }); }, 80));
  };
  const r = queueOutboundMail(sendMail, { to: 'a@example.com', subject: 't', text: 'b' }, () => {});
  assert.deepEqual(r, { ok: true, queued: true });
  assert.equal(finished, false);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(started, true);
  assert.equal(finished, true);
});

test('queueOutboundMail swallows send failures', async () => {
  const logs = [];
  const sendMail = async () => { throw new Error('smtp down'); };
  const r = queueOutboundMail(sendMail, { to: 'a@example.com', text: 'b' }, (m) => logs.push(m));
  assert.equal(r.queued, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(logs.join('\n'), /queued outbound mail failed/);
});
