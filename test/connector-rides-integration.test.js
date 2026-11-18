'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-conn-'));
process.env.ASMLTR_CONNECTORS_DB = path.join(TMP, 'connectors.db');
const reg = require('../connectors/manager/registry');

test('a connector can reference the integration it rides on', () => {
  const c = reg.create({ type: 'email', name: 'answers', config: { approval_policy: 'always_draft' },
                         integration_id: 'int_abc123' });
  assert.equal(reg.get(c.id).integration_id, 'int_abc123');
});

test('a connector with no integration still works — this is what makes the migration safe', () => {
  const c = reg.create({ type: 'discord', name: 'legacy', config: { token_ref: 'k' } });
  assert.equal(reg.get(c.id).integration_id, null);
});

test('integration_id survives an unrelated update, and null means detach', () => {
  const c = reg.create({ type: 'email', name: 'x', config: {}, integration_id: 'int_keep' });
  // updating something else must not silently drop the link
  reg.update(c.id, { name: 'renamed' });
  assert.equal(reg.get(c.id).integration_id, 'int_keep');
  // but an explicit null detaches
  reg.update(c.id, { integration_id: null });
  assert.equal(reg.get(c.id).integration_id, null);
});
