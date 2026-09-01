'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const { connectorAuthHeaders, requireConnectorToken } = require('../shared/connector-http-auth');

const PREV = process.env.ASMLTR_MANAGER_TOKEN;

function withToken(t, fn) {
  process.env.ASMLTR_MANAGER_TOKEN = t;
  try { return fn(); } finally {
    if (PREV === undefined) delete process.env.ASMLTR_MANAGER_TOKEN;
    else process.env.ASMLTR_MANAGER_TOKEN = PREV;
  }
}

function mockReq(auth) {
  return { get: (h) => (String(h).toLowerCase() === 'authorization' ? auth : '') };
}

test('unauth /out is 401', () => {
  withToken('test-manager-token', () => {
    let status = 0, body = null, nexted = false;
    const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
    requireConnectorToken(mockReq(''), res, () => { nexted = true; });
    assert.equal(status, 401);
    assert.equal(nexted, false);
    assert.equal(body && body.ok, false);
  });
});

test('auth with Bearer is allowed', () => {
  withToken('test-manager-token', () => {
    let nexted = false;
    requireConnectorToken(mockReq('Bearer test-manager-token'), {}, () => { nexted = true; });
    assert.equal(nexted, true);
  });
});

test('manager header builder attaches Authorization', () => {
  const h = connectorAuthHeaders('test-manager-token');
  assert.equal(h.Authorization, 'Bearer test-manager-token');
  assert.equal(h['Content-Type'], 'application/json');
});

test('unset token fails closed', () => {
  withToken('', () => {
    let status = 0, nexted = false;
    const res = { status(s) { status = s; return this; }, json() { return this; } };
    requireConnectorToken(mockReq('Bearer anything'), res, () => { nexted = true; });
    assert.equal(status, 401);
    assert.equal(nexted, false);
    const h = connectorAuthHeaders('');
    assert.equal('Authorization' in h, false);
  });
});

test('discord and telegram /out use requireConnectorToken; manager send attaches headers', () => {
  const discord = readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  const telegram = readFileSync(path.join(__dirname, '../connectors/types/telegram/index.js'), 'utf8');
  const manager = readFileSync(path.join(__dirname, '../connectors/manager/server.js'), 'utf8');
  assert.ok(discord.includes('requireConnectorToken'));
  assert.ok(telegram.includes('requireConnectorToken'));
  assert.match(discord, /app\.post\('\/out',\s*requireConnectorToken/);
  assert.match(discord, /outboundFileAllowed/);
  assert.match(telegram, /outboundFileAllowed/);
  assert.match(discord, /app\.post\('\/send-message',\s*requireConnectorToken/);
  assert.match(telegram, /app\.post\('\/out',\s*requireConnectorToken/);
  assert.match(telegram, /app\.post\('\/send',\s*requireConnectorToken/);
  assert.ok(manager.includes('connectorAuthHeaders'));
});
