'use strict';
/**
 * [[NO_REPLY]] is the universal silence sentinel (core handle(), Discord, persist).
 *
 * True only when the whole trimmed text is the token, or the last non-empty line
 * is the token (cross-channel redirect: work on another connector, then silence
 * here). A real reply that *mentions* the token must still send — a substring
 * match swallowed those.
 */

const SENTINEL_RE = /^\[\[NO_REPLY\]\]$/i;

function isNoReplySentinel(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (SENTINEL_RE.test(t)) return true;
  const lines = t.split(/\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    return SENTINEL_RE.test(line);
  }
  return false;
}

module.exports = { isNoReplySentinel };
