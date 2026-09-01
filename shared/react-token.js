'use strict';
/**
 * Optional Discord reaction: a whole line `[[REACT:😂]]`.
 * Sparse color reactions (funny / d'oh / wild). Not 👀 (steer) or 🛑 (stop).
 */
const LINE_RE = /^\[\[REACT:(.+?)\]\]$/i;

const PALETTE = new Set([
  '😂', '🤣', '💀',
  '🤯', '🫠', '🤡', '😳',
  '🤦', '😬', '😅',
  '🔥', '🫡', '🙌', '💯',
  '🤨', '🙄',
]);

function normalizeEmoji(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 16) return null;
  if (PALETTE.has(s)) return s;
  for (const p of PALETTE) {
    if (s.includes(p)) return p;
  }
  return null;
}

/** Strip every [[REACT:…]] line. First allowed emoji wins. */
function parseReact(text) {
  const lines = String(text == null ? '' : text).split('\n');
  let emoji = null;
  const kept = [];
  for (const line of lines) {
    const m = line.trim().match(LINE_RE);
    if (m) {
      if (!emoji) emoji = normalizeEmoji(m[1]);
      continue;
    }
    kept.push(line);
  }
  let out = kept.join('\n');
  if (!out.trim()) out = '';
  else out = out.replace(/^\n+/, '').replace(/\n+$/, '');
  return { text: out, emoji };
}

module.exports = { parseReact, normalizeEmoji, PALETTE };
