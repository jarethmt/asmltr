'use strict';
/**
 * Split Discord outbound text so each chunk fits Discord's 2000-char limit.
 *
 * Fenced ``` blocks stay as fences (copyable). The old rewrite to 4-space
 * indent existed so a mid-fence split could not leave an unclosed opener
 * (which paints the rest of the message — or the next one — as code).
 * We keep the fences and close/reopen them across chunks instead.
 */

const DEFAULT_MAX = 1900;

function isFenceLine(line) {
  if (!String(line).startsWith('```')) return false;
  return !String(line).slice(3).includes('```');
}

function fenceLang(line) {
  return String(line).slice(3).trim();
}

function splitResponse(text, max = DEFAULT_MAX) {
  const src = String(text || '');
  if (!src) return [];
  const lines = src.split('\n');
  const chunks = [];
  let cur = '';
  let lang = null;

  const flush = () => {
    const t = cur.replace(/\s+$/, '');
    if (t) chunks.push(t);
    cur = '';
  };

  function appendLine(line, { closing } = {}) {
    const next = cur ? cur + '\n' + line : line;
    const reserve = lang !== null && !closing ? 4 : 0; // room to close with \n```
    if (next.length + reserve <= max) {
      cur = next;
      return true;
    }
    return false;
  }

  function rolloverFence() {
    const saved = lang;
    if (cur) cur += '\n```';
    flush();
    cur = '```' + saved;
    lang = saved;
  }

  function hardSplitLine(line) {
    let rest = line;
    while (rest.length) {
      if (lang !== null && cur.length + 5 >= max) rolloverFence();
      else if (lang === null && cur && cur.length >= max) flush();
      const prefix = cur ? 1 : 0;
      const close = lang !== null ? 4 : 0; // \n```
      const budget = Math.max(1, max - cur.length - prefix - close);
      const piece = rest.slice(0, budget);
      rest = rest.slice(budget);
      if (!appendLine(piece)) {
        if (lang !== null) rolloverFence();
        else flush();
        if (!appendLine(piece)) {
          cur = (lang !== null ? '```' + lang + '\n' : '') + piece;
        }
      }
    }
  }

  for (const line of lines) {
    if (isFenceLine(line)) {
      if (lang === null) {
        const l = fenceLang(line);
        if (!appendLine('```' + l)) {
          flush();
          cur = '```' + l;
        }
        lang = l;
      } else if (!appendLine('```', { closing: true })) {
        rolloverFence();
        appendLine('```', { closing: true });
        lang = null;
      } else {
        lang = null;
      }
      continue;
    }

    if (appendLine(line)) continue;
    if (lang !== null) {
      rolloverFence();
      if (!appendLine(line)) hardSplitLine(line);
    } else {
      flush();
      if (!appendLine(line)) hardSplitLine(line);
    }
  }

  if (lang !== null && cur && !cur.endsWith('\n```')) cur += '\n```';
  flush();
  return chunks;
}

module.exports = { splitResponse, isFenceLine, fenceLang, DEFAULT_MAX };
