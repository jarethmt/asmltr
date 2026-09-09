'use strict';
/**
 * Text-only log of media we posted (no binary). Survives staged-file delete
 * so later turns can talk about what went out.
 */
const fs = require('fs');
const path = require('path');
const silo = require('./silo');
const { safeKey } = require('./transcripts');

const REL = 'memory/media-out';
const LINE_CLIP = 200;
const KEEP = 40;

function clip(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, LINE_CLIP);
}

function ensureDir() {
  return silo.selfSub(REL);
}

function convPath(conversationKey) {
  return path.join(ensureDir(), safeKey(conversationKey || 'unknown') + '.md');
}

function appendPosted({
  conversationKey, channel, target, name, caption, kind, bytes, messageId, ts,
} = {}) {
  const t = Number.isFinite(ts) ? ts : Date.now();
  const iso = new Date(t).toISOString();
  const line = `- ${iso} ${clip(channel)} ${clip(name)} ${clip(kind) || 'file'} ${bytes != null ? bytes + 'b' : ''} caption=${JSON.stringify(clip(caption))} msg=${clip(messageId)}`.replace(/\s+/g, ' ').trim();
  const abs = convPath(conversationKey);
  let existing = [];
  try {
    existing = fs.readFileSync(abs, 'utf8').split('\n').filter((l) => l.startsWith('- '));
  } catch (_) {}
  existing.unshift(line);
  const body = '# Posted media (this conversation)\n\n'
    + 'Text log only — files are deleted after Discord confirms. Newest first.\n\n'
    + existing.slice(0, KEEP).join('\n') + '\n';
  fs.writeFileSync(abs, body);
  return { rel: `${REL}/${safeKey(conversationKey || 'unknown')}.md`, line };
}

function recall(conversationKey, maxLines = 8) {
  let raw = '';
  try { raw = fs.readFileSync(convPath(conversationKey), 'utf8'); } catch (_) { return ''; }
  const lines = raw.split('\n').filter((l) => l.startsWith('- ')).slice(0, maxLines);
  if (!lines.length) return '';
  return 'MEDIA YOU POSTED IN THIS CONVERSATION (files may already be gone; this is the log):\n' + lines.join('\n') + '\n';
}

module.exports = { appendPosted, recall, convPath, ensureDir, REL };
