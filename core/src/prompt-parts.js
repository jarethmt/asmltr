'use strict';
/**
 * Prompt composition + the inject-once decision — the pure, testable core of the token optimization.
 *
 * The pipeline builds the system prompt as named PARTS (identity, current-speaker, channel, authz, …).
 * This module folds them two ways:
 *   • `full`     — every part, in the historical order → what claude gets every turn (cached system
 *                  channel) and what any engine gets on a first / changed injection. Byte-identical to
 *                  the pre-optimization concatenation, so the claude path never regresses.
 *   • `stable` / `volatile` — the split a history-retaining engine uses. STABLE = the parts that change
 *                  only when a store/state changes (identity, channel, toolbelt, uploads instruction);
 *                  VOLATILE = the per-turn tail (who's speaking, their authz, relationship, connector
 *                  extra, the live uploads list, cross-session announcements).
 *   • `stableHash` — sha256 of the stable block; the key for "has it changed since we last sent it?".
 *
 * A part is a string or '' (absent). Order matters: `full` MUST list parts in the exact order the old
 * inline build appended them.
 */
const { createHash } = require('crypto');

/**
 * @param {object} p named parts — each a string ('' when absent):
 *   identity, speaker, channel, authz, rel, extra, toolbelt, uploadsInstr, uploadsList, announce
 * @returns {{full:string, stable:string, volatile:string, stableHash:string}}
 */
function composeSystemPrompts(p) {
  const g = (k) => (typeof p[k] === 'string' ? p[k] : '');
  // FULL — historical order (identity → speaker → channel → authz → rel → extra → toolbelt →
  // uploads-instruction → uploads-list → announce). Do not reorder: this is the claude/no-regression path.
  const full = [g('identity'), g('speaker'), g('channel'), g('authz'), g('rel'), g('extra'),
    g('toolbelt'), g('uploadsInstr'), g('uploadsList'), g('announce')].filter(Boolean).join('\n\n');
  const stable = [g('identity'), g('channel'), g('toolbelt'), g('uploadsInstr')].filter(Boolean).join('\n\n');
  const volatile = [g('speaker'), g('authz'), g('rel'), g('extra'), g('uploadsList'), g('announce')].filter(Boolean).join('\n\n');
  const stableHash = createHash('sha256').update(stable).digest('hex');
  return { full, stable, volatile, stableHash };
}

/**
 * Decide whether this turn may send ONLY the volatile tail (the stable block is already in the engine's
 * replayed history). True only when: the engine retains history (its resume replays prior turns), the
 * session isn't new, and the stable block is unchanged AND was last delivered for THIS same engine.
 * A null/absent prior hash (fresh session, or a turn that never sent the stable block — e.g. an operator
 * steer) → false → the full prompt is sent. Safe by construction.
 */
function shouldReuseStable({ canInjectOnce, isNew, row, engineId, stableHash }) {
  return !!(canInjectOnce && !isNew && row
    && row.last_stable_engine === engineId && row.last_stable_hash === stableHash);
}

module.exports = { composeSystemPrompts, shouldReuseStable };
