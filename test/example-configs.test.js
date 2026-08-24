'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PII = /techdirect|gtwy\.net|james@|@jess|allison park|cheswick|313485478869598208/i;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('example configs exist, parse, and have no personal identifiers', () => {
  const files = [
    '.env.example',
    'env.ivy.example',
    'core/src/trust/seed.example.json',
    'core/src/trust/seed.ivy.example.json',
    'shared/tool-policy.example.json',
  ];
  for (const rel of files) {
    const body = read(rel);
    assert.equal(PII.test(body), false, rel + ' looks like it has personal info');
  }
  const seed = JSON.parse(read('core/src/trust/seed.example.json'));
  const friend = seed.principals.find((p) => p.id === 'friend');
  assert.ok(friend);
  assert.equal(friend.default_tier, 3);
  assert.match(String(friend.identifiers[0].value), /^1+$/);
  const ivy = JSON.parse(read('core/src/trust/seed.ivy.example.json'));
  const ivyFriend = ivy.principals.find((p) => p.id === 'friend');
  assert.ok(ivyFriend);
  assert.equal(ivyFriend.default_tier, 3);
  assert.equal(ivyFriend.identifiers.length, 0);
  const policy = JSON.parse(read('shared/tool-policy.example.json'));
  assert.deepEqual(policy.photoAllow.principals, ['friend']);
  assert.deepEqual(policy.videoAllow.principals, []);
  assert.deepEqual(policy.photoAllow.discordIds, []);
  const envEx = read('.env.example');
  assert.match(envEx, /ASMLTR_IMAGE_GEN_CLASSIFY/);
  assert.match(envEx, /ASMLTR_TOOL_POLICY_FILE/);
  assert.match(envEx, /docs\/security\/moderation\.md/);
  const ivyEnv = read('env.ivy.example');
  assert.match(ivyEnv, /ASMLTR_IMAGE_GEN_CLASSIFY/);
  assert.match(ivyEnv, /gpt-5-nano/);
  assert.equal(/image-gen → xhigh/.test(ivyEnv), false);
});
