'use strict';

/** Build the restore runner argv. No shell interpolation. Do not spawn here. */
function restoreSpawnPlan({ execPath, scriptPath, file, force }) {
  if (!execPath || !scriptPath || !file) throw new Error('execPath, scriptPath, and file required');
  const args = [scriptPath, 'restore', String(file), '--activate'];
  if (force) args.push('--force');
  return { command: execPath, args };
}

module.exports = { restoreSpawnPlan };
