'use strict';
/**
 * Resolve the core SQLite DB path. Prefers the current name (`asmltr-core.db`) but transparently
 * falls back to the legacy `eve-core.db` if only that exists yet — so an install that predates the
 * rename keeps working until the setup.d migration (040-rename-core-db) moves the file. An explicit
 * `ASMLTR_CORE_DB` override always wins.
 */
const fs = require('fs');
const path = require('path');

function coreDbPath() {
  if (process.env.ASMLTR_CORE_DB) return process.env.ASMLTR_CORE_DB;
  const dir = path.join(__dirname, '..', 'data');
  const current = path.join(dir, 'asmltr-core.db');
  const legacy = path.join(dir, 'eve-core.db');
  if (!fs.existsSync(current) && fs.existsSync(legacy)) return legacy; // not migrated yet
  return current;
}

module.exports = { coreDbPath };
