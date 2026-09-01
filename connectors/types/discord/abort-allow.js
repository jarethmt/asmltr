'use strict';

/** Public: anyone may abort an in-flight turn (humans always win). Host overlay wraps core /v2/abort. */
function canAbortTurn(_opts) {
  return true;
}

function starterIdFromSlot(slot) {
  if (!slot || slot === true) return null;
  return slot.starterId == null ? null : String(slot.starterId);
}

module.exports = { canAbortTurn, starterIdFromSlot };
