'use strict';

function safeBranchName(branch) {
  const b = String(branch || '').trim();
  if (!b || b === 'HEAD') return null;
  if (b.startsWith('-') || b.includes('..')) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(b)) return null;
  return b;
}

/** git reset argv pinned to origin/<current-or-configured branch>. Never a hardcoded main. */
function updateResetArgv(branch) {
  const b = safeBranchName(branch);
  if (!b) throw new Error('refusing git reset: no current branch');
  return ['reset', '--hard', `origin/${b}`];
}

function resolveEdgeTarget({ ref, branch } = {}) {
  if (ref) return { target: String(ref), label: String(ref) };
  const b = safeBranchName(branch);
  if (!b) throw new Error('refusing edge target: no branch to pin');
  const target = `origin/${b}`;
  return { target, label: target };
}

function fetchOriginArgv(branch) {
  const b = safeBranchName(branch);
  if (!b) return ['fetch', '--quiet', '--tags', '--force', 'origin'];
  return ['fetch', '--quiet', '--tags', '--force', 'origin', b];
}

module.exports = { safeBranchName, updateResetArgv, resolveEdgeTarget, fetchOriginArgv };
