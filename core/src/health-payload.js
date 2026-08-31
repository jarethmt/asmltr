'use strict';
/**
 * /health payload. No sqlite keep-list (that helper is gone).
 */

function healthPayload({ active }) {
  return {
    status: 'ok',
    service: 'asmltr-core',
    active,
  };
}

module.exports = { healthPayload };
