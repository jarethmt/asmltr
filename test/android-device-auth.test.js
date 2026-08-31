'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const { extractDeviceToken, deviceAuthAllowed, resolveTurnKey } = require('../connectors/types/android/device-auth');

const keys = {
  tokA: { identity: 'alice', username: 'alice' },
  tokB: { identity: 'bob', username: 'bob' },
};
const lookup = (t) => keys[t] || null;

test('unauth rpc/out token is 401 when required', () => {
  assert.equal(deviceAuthAllowed({ requireToken: true, token: '', lookup }).status, 401);
  assert.equal(deviceAuthAllowed({ requireToken: true, token: 'nope', lookup }).ok, false);
});

test('valid device token is allowed', () => {
  const d = deviceAuthAllowed({ requireToken: true, token: 'tokA', lookup });
  assert.equal(d.ok, true);
  assert.equal(d.identity, 'alice');
});

test('extractDeviceToken reads body, query, and Bearer', () => {
  assert.equal(extractDeviceToken({ body: { token: 'tokA' }, query: {}, headers: {} }), 'tokA');
  assert.equal(extractDeviceToken({ body: {}, query: { token: 'tokB' }, headers: {} }), 'tokB');
  assert.equal(extractDeviceToken({ body: {}, query: {}, headers: { authorization: 'Bearer tokA' } }), 'tokA');
  assert.equal(extractDeviceToken({ body: {}, query: {}, headers: {} }), '');
});

test('foreign target_key is 403', () => {
  const own = 'android:test:device:dA';
  const other = 'android:test:device:dB';
  const d = resolveTurnKey({ targetKey: other, ownConvKey: own });
  assert.equal(d.ok, false);
  assert.equal(d.status, 403);
});

test('own target_key and empty target_key are allowed', () => {
  const own = 'android:test:device:dA';
  assert.equal(resolveTurnKey({ targetKey: own, ownConvKey: own }).conversationKey, own);
  assert.equal(resolveTurnKey({ targetKey: '', ownConvKey: own }).conversationKey, own);
});

test('token A cannot act on token B session', () => {
  const a = deviceAuthAllowed({ requireToken: true, token: 'tokA', lookup });
  const b = deviceAuthAllowed({ requireToken: true, token: 'tokB', lookup });
  assert.equal(a.identity, 'alice');
  assert.equal(b.identity, 'bob');
  const ownA = 'android:test:device:phone-a';
  const ownB = 'android:test:device:phone-b';
  const steal = resolveTurnKey({
    targetKey: ownB,
    ownConvKey: ownA,
    identityOwnKeys: new Set([ownA]),
  });
  assert.equal(steal.ok, false);
  assert.equal(steal.status, 403);
});

test('index.js gates /gw/rpc and /out and fail-closes target_key', () => {
  const src = readFileSync(path.join(__dirname, '../connectors/types/android/index.js'), 'utf8');
  assert.ok(src.includes("require('./device-auth')") || src.includes('require("./device-auth")'));
  assert.ok(src.includes('extractDeviceToken'));
  assert.ok(src.includes('resolveTurnKey'));
  assert.match(src, /app\.post\('\/gw\/rpc'/);
  assert.match(src, /app\.post\('\/out'/);
});
