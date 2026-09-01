'use strict';
/**
 * V24: auth-reject log is created 0o600; existing files are chmod 0o600.
 */
const fs = require('fs');
const path = require('path');

const AUTH_REJECT_FILE_MODE = 0o600;

function persistAuthRejectLine(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const line = typeof entry === 'string' ? entry : JSON.stringify(entry) + '\n';
  fs.appendFileSync(filePath, line.endsWith('\n') ? line : line + '\n', { mode: AUTH_REJECT_FILE_MODE });
  fs.chmodSync(filePath, AUTH_REJECT_FILE_MODE);
}

module.exports = { AUTH_REJECT_FILE_MODE, persistAuthRejectLine };
