#!/usr/bin/env node
'use strict';
/**
 * Turn-only PATH shim. When an engine child runs `systemctl`/`pm2` against the
 * asmltr stack, rewrite it to `asmltr bounce` so the restart waits until the
 * turn (and its Discord/email reply) finishes.
 */
const path = require('path');
const { spawnSync } = require('child_process');
const bounce = require('../../shared/bounce');

const tool = process.argv[2] || path.basename(process.argv[1]);
const args = process.argv.slice(3);

if (bounce.looksLikeAsmltrRestart(tool, args)) {
  const cli = path.join(__dirname, '..', '..', 'cli', 'asmltr.js');
  const r = spawnSync(process.execPath, [cli, 'bounce', '--from-guard'], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(r.status == null ? 1 : r.status);
}

const real = bounce.resolveRealBin(tool, process.env);
if (!real) {
  process.stderr.write(tool + ': not found\n');
  process.exit(127);
}
const r = spawnSync(real, args, { stdio: 'inherit', env: process.env });
process.exit(r.status == null ? 1 : r.status);
