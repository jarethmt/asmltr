'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { settleDelivery } = require('../shared/send-result');

// The bug this guards: a delivered message (connector body ok:true + messageId) coming back with a
// non-2xx HTTP status, so a caller checking the HTTP status reports a false failure (and may double-send).

test('a delivered body (ok:true + messageId) forces 2xx even when the upstream fetch status was not ok', () => {
  const r = settleDelivery(false, { ok: true, messageId: 2082 }, { via: 'telegram:jareth' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.messageId, 2082);
  assert.strictEqual(r.via, 'telegram:jareth');
});

test('a failure body (ok:false) forces non-2xx even when the fetch status was ok', () => {
  const r = settleDelivery(true, { ok: false, error: 'boom' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 502);
});

test('falls back to the transport ok when the body carries no boolean ok', () => {
  assert.strictEqual(settleDelivery(true, {}).status, 200);
  assert.strictEqual(settleDelivery(true, {}).ok, true);
  assert.strictEqual(settleDelivery(false, {}).status, 502);
  assert.strictEqual(settleDelivery(false, {}).ok, false);
  assert.strictEqual(settleDelivery(false, null).status, 502);
});

test('status and ok can NEVER disagree, for every fetchOk × body combination', () => {
  const bodies = [{ ok: true }, { ok: false }, {}, { ok: true, messageId: 1 }, { ok: false, error: 'x' }];
  for (const fetchOk of [true, false]) {
    for (const b of bodies) {
      const r = settleDelivery(fetchOk, b);
      assert.strictEqual(r.status === 200, r.ok,
        `status/ok disagree for fetchOk=${fetchOk} body=${JSON.stringify(b)}`);
    }
  }
});

test('extra fields are preserved but never override the resolved ok/status', () => {
  const r = settleDelivery(true, { ok: false }, { ok: true, status: 200, via: 'x' });
  assert.strictEqual(r.ok, false);   // body ok wins over extra
  assert.strictEqual(r.status, 502); // status follows resolved ok, not the extra
  assert.strictEqual(r.via, 'x');
});
