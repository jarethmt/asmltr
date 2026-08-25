'use strict';
/**
 * Where plugin types live, and what they are (docs/INTEGRATIONS.md).
 *
 * Two directories, one contract. Both export `{ meta, start(ctx) }` and both are supervised by the
 * same machinery — the split is about WHAT a plugin is, not how it runs:
 *
 *   connectors/types/<type>    role 'channel' — the world reaches IN to converse with the agent
 *   integrations/types/<type>  role 'service' — the agent reaches OUT for an optional capability
 *
 * Supervision was always the right mechanism for a long-running service; being a *channel* never
 * was. Before this split, anything needing a supervisor had to live under connectors and declare
 * itself not-a-channel to avoid being offered as a send target. Now it declares `role: 'service'`
 * and lives where it belongs.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = [
  { dir: path.join(ROOT, 'connectors', 'types'), role: 'channel' },
  { dir: path.join(ROOT, 'integrations', 'types'), role: 'service' },
];

/** Absolute path of a type, searching both trees. Null when the type does not exist. */
function resolveType(type) {
  if (!type || /[\\/]/.test(type)) return null; // no traversal — types are bare directory names
  for (const { dir, role } of DIRS) {
    const p = path.join(dir, type);
    try { if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return { path: p, role }; } catch (_) {}
  }
  return null;
}

/** Every loadable type -> its meta, with `role` filled in from where it was found. */
function loadAllMeta(onError) {
  const out = {};
  for (const { dir, role } of DIRS) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (_) { continue; } // an absent tree is not an error
    for (const t of entries) {
      try {
        const mod = require(path.join(dir, t));
        // meta.role wins if a plugin states it; otherwise it is implied by which tree it sits in.
        if (mod && mod.meta) out[mod.meta.type] = { ...mod.meta, role: mod.meta.role || role };
      } catch (e) { if (onError) onError(t, e); }
    }
  }
  return out;
}

/** Is this type a conversation channel (vs an outward-facing service)? */
const isChannel = (meta) => !meta || (meta.role || 'channel') === 'channel';

module.exports = { resolveType, loadAllMeta, isChannel, DIRS };
