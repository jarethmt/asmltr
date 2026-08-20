'use strict';
/**
 * Self-silo conversation transcripts — the write path for memory/transcripts (seeded by the
 * `self` template, previously unwired). Every local ask/grok turn appends here so a fresh
 * engine session after idle can rehydrate via `asmltr silo get` / `silo find` without
 * grepping events-*.jsonl or ~/.grok/sessions. recallForInject() is the read
 * path: core injects that block into a fresh session prompt after idle.
 *
 * Layout (silo-relative):
 *   memory/transcripts/<conversation-key>.md   append-only user+assistant turns
 *   memory/last-topics.md                      operator-wide newest-first index (NOT injected)
 *
 * Isolation: recallForInject reads only the per-key transcript (safeKey). The global
 * last-topics index is an operator convenience — injecting it would leak other
 * principals/channels into a fresh session prompt.
 *
 * Writes go through Silo.put / Silo.get (the storage driver), not raw fs, so encrypted
 * and remote silos seal/sync conversation content.
 */
const path = require('path');
const silo = require('./silo');
const { isNoReplySentinel } = require('./silence');

const LAST_TOPICS_REL = 'memory/last-topics.md';
const TRANSCRIPTS_REL = 'memory/transcripts';
const LAST_TOPICS_KEEP = 20;
const USER_CLIP = 16000;
const ASSISTANT_CLIP = 32000;
const TOPIC_CLIP = 160;
const INJECT_TURNS = 6;
const INJECT_CHARS = 8000;
const RECALL_TAIL_CHARS = INJECT_CHARS * 4;
// Encrypted silos re-seal the whole file on every Silo.put. Cap the live transcript so
// write+read cost stays bounded instead of growing with history.
const TRANSCRIPT_KEEP_CHARS = 64 * 1024;

function clip(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '\n…' : s;
}

function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** Filesystem-safe conversation_key (colons etc. → dashes). */
function safeKey(key) {
  return String(key || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unknown';
}

function formatTurn({ ts, conversationKey, channel, userText, assistantText, drafted }) {
  const iso = new Date(Number.isFinite(ts) ? ts : Date.now()).toISOString();
  const key = String(conversationKey || 'unknown');
  const ch = channel ? `  channel=${channel}` : '';
  const asst = drafted ? '**assistant (unsent draft):**' : '**assistant:**';
  return `## ${iso}  ${key}${ch}\n\n` +
    `**user:** ${clip(userText, USER_CLIP)}\n\n` +
    `${asst} ${clip(assistantText, ASSISTANT_CLIP)}\n\n`;
}

/** Absolute path on the local driver. Encrypted/remote silos: use Silo.get, not this. */
function lastTopicsPath() {
  return path.join(silo.ensureSelf().dir, LAST_TOPICS_REL);
}

function transcriptAbs(conversationKey) {
  return path.join(silo.ensureSelf().dir, TRANSCRIPTS_REL, safeKey(conversationKey) + '.md');
}

function transcriptRel(conversationKey) {
  return `${TRANSCRIPTS_REL}/${safeKey(conversationKey)}.md`;
}

function textOf(buf) {
  if (buf == null) return '';
  return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
}

async function siloGetText(rel) {
  try {
    return textOf(await silo.ensureSelf().get(rel));
  } catch (_) {
    return '';
  }
}

async function siloPutText(rel, text) {
  return silo.ensureSelf().put(rel, text);
}

// Serialize last-topics read-modify-write. Same-key transcript appends are serialized by
// core's per-conversation withKeyLock; this index is shared across keys. Required now that
// appendTurn is async (Silo.put) — a naive RMW would drop concurrent updates.
let lastTopicsLock = Promise.resolve();
function withLastTopicsLock(fn) {
  const run = lastTopicsLock.then(fn, fn);
  lastTopicsLock = run.then(() => {}, () => {});
  return run;
}

async function updateLastTopics({ ts, conversationKey, userText }) {
  const iso = new Date(Number.isFinite(ts) ? ts : Date.now()).toISOString();
  const key = String(conversationKey || 'unknown');
  const line = `- ${iso.slice(0, 16)}Z [${key}] ${oneLine(userText).slice(0, TOPIC_CLIP)}`;
  return withLastTopicsLock(async () => {
    let existing = [];
    const prev = await siloGetText(LAST_TOPICS_REL);
    if (prev) existing = prev.split('\n').filter((l) => l.startsWith('- '));
    existing.unshift(line);
    const body = '# Last topics\n\n' +
      'Newest first. Full turns live under `memory/transcripts/`.\n\n' +
      existing.slice(0, LAST_TOPICS_KEEP).join('\n') + '\n';
    await siloPutText(LAST_TOPICS_REL, body);
    return LAST_TOPICS_REL;
  });
}

/**
 * Append one user+assistant turn to the Self silo. Returns silo-relative paths
 * (no secrets). `ts` is caller-supplied so tests stay free of wall-clock coupling.
 * `drafted` tags an unsent hold-for-approval reply so memory does not claim it was delivered.
 * Live file is size-capped (oldest turns roll off) so encrypted-silo re-seal stays O(cap).
 */
async function appendTurn({ conversationKey, channel, userText, assistantText, ts, drafted, keepChars } = {}) {
  const t = Number.isFinite(ts) ? ts : Date.now();
  const key = conversationKey || 'unknown';
  const rel = transcriptRel(key);
  const keep = Number.isFinite(keepChars) && keepChars > 0 ? keepChars : TRANSCRIPT_KEEP_CHARS;
  const prev = await siloGetText(rel);
  const next = formatTurn({ ts: t, conversationKey: key, channel, userText, assistantText, drafted });
  await siloPutText(rel, tailTranscript(prev + next, keep));
  await updateLastTopics({ ts: t, conversationKey: key, userText });
  return {
    transcript: rel,
    lastTopics: LAST_TOPICS_REL,
  };
}

/**
 * Persist a completed handle() turn. `assistantText` is what the connector would
 * actually send (redacted reply, or draft body). Missing/empty/`[[NO_REPLY]]` means
 * nothing was delivered — do NOT fall back to result.text (that recorded silence
 * as a spoken `**assistant:**` turn).
 */
async function persistFromHandle(e, result, assistantText, { drafted = false } = {}) {
  if (!e || !result || result.isError) return null;
  const userText = String((e.content && e.content.text) || '');
  if (!drafted) {
    if (assistantText == null) return null;
    const delivered = String(assistantText);
    if (!delivered.trim()) return null;
    if (isNoReplySentinel(delivered)) return null;
  }
  const text = assistantText != null ? String(assistantText) : '';
  if (!userText && !text) return null;
  return appendTurn({
    conversationKey: e.conversation_key,
    channel: e.channel,
    userText,
    assistantText: text,
    drafted: !!drafted,
  });
}

/** Cheap tail so recall does not split a multi-MB transcript in full. Driver has no range get. */
function tailTranscript(transcript, maxChars = RECALL_TAIL_CHARS) {
  if (!transcript) return '';
  if (transcript.length <= maxChars) return transcript;
  let slice = transcript.slice(transcript.length - maxChars);
  const cut = slice.indexOf('\n## ');
  if (cut >= 0) slice = slice.slice(cut + 1);
  return slice;
}

/**
 * Read durable memory for a fresh engine session and return a block to inject
 * into the system prompt. Empty string if nothing has been written yet.
 * This is the retrieve path: write-only is a fail.
 *
 * Injects ONLY this conversation_key's transcript — never the global last-topics
 * index, which is cross-principal by design.
 */
async function recallForInject({ conversationKey, maxTurns = INJECT_TURNS, maxChars = INJECT_CHARS } = {}) {
  const transcript = tailTranscript(await siloGetText(transcriptRel(conversationKey || 'unknown')));
  const chunks = transcript.split(/^## /m).filter(Boolean);
  const recent = chunks.slice(-maxTurns).map((c) => '## ' + c).join('');
  if (!recent.trim()) return '';
  let body = 'RECENT TURNS FROM THIS CONVERSATION:\n' + recent.trim();
  if (body.length > maxChars) body = '…\n' + body.slice(body.length - maxChars);
  return body;
}

module.exports = {
  appendTurn, persistFromHandle, formatTurn, safeKey, lastTopicsPath, transcriptAbs, transcriptRel, recallForInject,
  LAST_TOPICS_REL, TRANSCRIPTS_REL, LAST_TOPICS_KEEP, INJECT_TURNS, INJECT_CHARS, TRANSCRIPT_KEEP_CHARS,
};
