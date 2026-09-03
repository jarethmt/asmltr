'use strict';

/** Fail if (surface,value) is already bound to a different principal. Same principal is ok. */
function identAddDecision({ existingPrincipalId, targetPrincipalId }) {
  if (existingPrincipalId && existingPrincipalId !== targetPrincipalId) {
    return { ok: false, status: 409, error: 'identifier already bound' };
  }
  return { ok: true, same: !!(existingPrincipalId && existingPrincipalId === targetPrincipalId) };
}

module.exports = { identAddDecision };
