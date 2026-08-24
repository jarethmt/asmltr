'use strict';
/**
 * V23: /health payload. Size-only sqlite keep-list — never dump SQL strings.
 */

function healthPayload({ active, sqliteKeepSize }) {
  return {
    status: 'ok',
    service: 'asmltr-core',
    active,
    sqlite_keep: { size: sqliteKeepSize },
  };
}

module.exports = { healthPayload };
