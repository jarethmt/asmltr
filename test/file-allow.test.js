'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { hasDotDot, filePathAllowed } = require('../core/src/file-allow');

const roots = ['/allowed/silos', '/allowed/uploads'];
const rp = (p) => path.resolve(p);

test('path outside the allowlist is denied', () => {
  assert.equal(filePathAllowed('/etc/passwd', roots, { realpathSync: rp, homedir: () => '/home/user' }), false);
  assert.equal(filePathAllowed('/home/user/.ssh/id_ed25519', roots, { realpathSync: rp, homedir: () => '/home/user' }), false);
});

test('silo and upload paths are allowed', () => {
  assert.equal(filePathAllowed('/allowed/silos/self/artifacts/out.txt', roots, { realpathSync: rp, homedir: () => '/home/user' }), true);
  assert.equal(filePathAllowed('/allowed/uploads/x.bin', roots, { realpathSync: rp, homedir: () => '/home/user' }), true);
});

test('dot-dot and home root are rejected', () => {
  assert.equal(hasDotDot('/allowed/silos/../etc/passwd'), true);
  assert.equal(filePathAllowed('/allowed/silos/../etc/passwd', roots, { realpathSync: rp, homedir: () => '/home/user' }), false);
  assert.equal(filePathAllowed('/home/user', roots, { realpathSync: rp, homedir: () => '/home/user' }), false);
});
