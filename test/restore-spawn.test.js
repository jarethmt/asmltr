'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { restoreSpawnPlan } = require('../core/src/restore-spawn');

test('restore spawn is an argument array, not a shell string', () => {
  const plan = restoreSpawnPlan({
    execPath: '/usr/bin/node',
    scriptPath: '/opt/asmltr/scripts/backup.js',
    file: '/tmp/evil"; rm -rf /; echo ".asmltrbk',
    force: true,
  });
  assert.equal(plan.command, '/usr/bin/node');
  assert.deepEqual(plan.args, [
    '/opt/asmltr/scripts/backup.js', 'restore',
    '/tmp/evil"; rm -rf /; echo ".asmltrbk', '--activate', '--force',
  ]);
  assert.equal(plan.args.some((a) => a.includes('bash')), false);
});
