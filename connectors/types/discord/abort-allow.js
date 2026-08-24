'use strict';

/** Who may abort an in-flight Discord turn. Owner any; starter their own; third person / steerer no. */
function canAbortTurn({ isOwner, authorId, starterId }) {
  if (isOwner) return true;
  if (starterId == null || starterId === '') return false;
  return String(authorId) === String(starterId);
}

function starterIdFromSlot(slot) {
  if (!slot || slot === true) return null;
  return slot.starterId == null ? null : String(slot.starterId);
}

module.exports = { canAbortTurn, starterIdFromSlot };
