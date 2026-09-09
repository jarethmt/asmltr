'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PII = /techdirect|gtwy\.net|james@|ivy@|@jess|clientary|888-?261-?2258|50\.226\.|2001:559/i;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('example configs exist, parse, and have no personal identifiers', () => {
  const files = [
    '.env.example',
    'env.gaia.example',
    'core/src/trust/seed.example.json',
    'core/src/trust/seed.gaia.example.json',
    'shared/media-allow.example.json',
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
  const gaia = JSON.parse(read('core/src/trust/seed.gaia.example.json'));
  const gaiaFriend = gaia.principals.find((p) => p.id === 'friend');
  assert.ok(gaiaFriend);
  assert.equal(gaiaFriend.default_tier, 3);
  assert.equal(gaiaFriend.identifiers.length, 0);
  const policy = JSON.parse(read('shared/media-allow.example.json'));
  assert.deepEqual(policy.photoAllow.principals, ['friend']);
  assert.deepEqual(policy.videoAllow.principals, []);
  assert.deepEqual(policy.photoAllow.discordIds, []);
  const envEx = read('.env.example');
  assert.match(envEx, /ASMLTR_IMAGE_GEN_CLASSIFY/);
  assert.match(envEx, /ASMLTR_MEDIA_ALLOW_FILE/);
  assert.match(envEx, /docs\/security\/moderation\.md/);
  const gaiaEnv = read('env.gaia.example');
  assert.match(gaiaEnv, /ASMLTR_IMAGE_GEN_CLASSIFY/);
  assert.match(gaiaEnv, /gpt-5-nano/);
  assert.equal(/image-gen → xhigh/.test(gaiaEnv), false);
});
