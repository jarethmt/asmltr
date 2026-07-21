#!/usr/bin/env node
'use strict';
/**
 * One-time migration: rename the core SQLite DB `eve-core.db` → `asmltr-core.db` (+ its -wal/-shm
 * sidecars) so the shipped filename carries no personal-project name. Idempotent and safe:
 *   - skips (exit 75) when `ASMLTR_CORE_DB` is set (that install picks its own path — nothing to do),
 *   - skips when the legacy file is absent (fresh install, or already migrated),
 *   - never overwrites an existing `asmltr-core.db`.
 * Until this runs, core/src/db-path.js already falls back to the legacy name, so nothing breaks either way.
 */
const fs = require('fs');
const path = require('path');

if (process.env.ASMLTR_CORE_DB) { console.log('ASMLTR_CORE_DB set — core DB path is explicit; skip'); process.exit(75); }

const dir = path.join(__dirname, '..', 'core', 'data');
const from = path.join(dir, 'eve-core.db');
const to = path.join(dir, 'asmltr-core.db');

if (!fs.existsSync(from)) { console.log('no legacy eve-core.db — nothing to migrate'); process.exit(75); }
if (fs.existsSync(to)) { console.log('asmltr-core.db already exists — leaving legacy file in place'); process.exit(75); }

let moved = 0;
for (const suffix of ['', '-wal', '-shm']) {
  const src = from + suffix;
  if (fs.existsSync(src)) { fs.renameSync(src, to + suffix); moved++; }
}
console.log(`renamed eve-core.db → asmltr-core.db (${moved} file(s))`);
process.exit(0);
