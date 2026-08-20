'use strict';
/**
 * Public Discord live-step helpers (stream_steps).
 *
 * Not Grok-gated. Discord posts whatever the core forwards as onThinking /
 * onTool. Claude already emits thinking blocks; Grok/Gemini/Codex do too when
 * they think. If the engine sends no thinking, onThinking never fires and
 * these helpers stay idle — a Claude-only install is unchanged except that
 * extended-thinking turns may get sanitized 💭 chips (same shape as narration
 * -# steps this connector already posts).
 *
 * Sanitize/drop is Discord DISPLAY only. Core, collector, and Live keep
 * full-fidelity thoughts. Email does not get thought chips.
 * Leaky bubbles are dropped whole. Generic patterns only — no name denylist
 * in git. Speaker tokens (username / display name) are passed at runtime
 * from the Discord message and never hardcoded.
 *
 * Thought volume: xhigh uncapped. high and medium → 2 💭 chips (public and DM).
 * Below medium (low) → 0: no chips, just the answer.
 * Tool / Working / Still working chips are xhigh only. medium/high are 💭 only.
 */

const { redactSecrets } = require('./redact');

const ACP_TYPE = /^(tool_call|tool_call_update|tool_use|function_call)$/i;
const THINK_HEARTBEAT_MS = 45000;
const WORKING_LINE = '-# Working';
const STILL_WORKING_LINE = '-# Still working';
const THOUGHT_CLAMP = 280;

function looksLikePromptLeak(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  if (/CURRENT SPEAKER/i.test(s)) return true;
  if (/\bidentity\.md\b/i.test(s)) return true;
  if (/\bCLAUDE\.md\b/i.test(s)) return true;
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(s)) return true;
  if (/\/home\/[A-Za-z0-9._-]+/.test(s)) return true;
  if (/\bThe user is\b/i.test(s)) return true;
  if (/This is a Discord message/i.test(s)) return true;
  if (/I was @-mentioned/i.test(s)) return true;
  if (/\basking me \(/i.test(s)) return true;
  return false;
}

function escapeRe(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Username / display-name tokens from the live message. Skip tiny tokens. */
function speakerHintsFrom(author, member) {
  const out = [];
  const add = (raw) => {
    const s = String(raw || '').trim();
    if (s.length >= 4 && !/^\d+$/.test(s)) out.push(s);
    for (const p of s.split(/[\s._-]+/)) {
      if (p.length >= 4 && !/^\d+$/.test(p)) out.push(p);
    }
  };
  if (author && typeof author === 'object') {
    add(author.username);
    add(author.globalName);
    add(author.displayName);
    add(author.raw_username);
  } else if (typeof author === 'string') {
    add(author);
  }
  if (member && typeof member === 'object') {
    add(member.displayName);
    add(member.nickname);
  }
  return [...new Set(out)];
}

function mentionsSpeaker(text, hints) {
  const s = String(text || '');
  for (const h of hints || []) {
    if (!h || String(h).length < 4) continue;
    if (new RegExp('\\b' + escapeRe(h) + '\\b', 'i').test(s)) return true;
  }
  return false;
}

/** How many 💭 chips to post. Infinity = no cap. 0 = none (go straight to the answer). */
function thoughtBudget(effort) {
  const e = String(effort || 'medium').toLowerCase();
  if (e === 'xhigh') return Infinity;
  if (e === 'high' || e === 'medium') return 2;
  return 0;
}

function toolTitle(tool) {
  const raw = typeof tool === 'string'
    ? tool
    : (tool && (tool.name || tool.title || tool.kind)) || '';
  const s = String(raw || '').trim();
  if (!s || ACP_TYPE.test(s)) return '';
  if (/[\\/]/.test(s)) return '';
  const first = s.split(/[\s.:]+/)[0];
  return first.slice(0, 40);
}

function humanToolChip(tool) {
  const t = toolTitle(tool).toLowerCase();
  if (/^(read|read_file|readfile|cat|open)$/.test(t)) return 'Reading a file';
  if (/^(bash|shell|run|exec|command|sh)$/.test(t)) return 'Running a command';
  if (/(web|lookup|browse|fetch|http)/.test(t)) return 'Looking something up';
  if (/^(search|grep|glob|find|rg)$/.test(t)) return 'Searching';
  return 'Working';
}

function discordToolLine(streamTools, tool) {
  if (streamTools) {
    const title = toolTitle(tool);
    return `-# 🔧 \`${title || 'Working'}\``;
  }
  return `-# ${humanToolChip(tool)}`;
}

/** Sanitized Discord thought chip, or '' to drop. Never raw text. */
function discordThoughtLine(text, hints) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (looksLikePromptLeak(raw) || mentionsSpeaker(raw, hints)) return '';
  const cleaned = String(redactSecrets(raw).text || '').trim();
  if (!cleaned || looksLikePromptLeak(cleaned) || mentionsSpeaker(cleaned, hints)) return '';
  let body = cleaned.replace(/\s+/g, ' ');
  if (body.length > THOUGHT_CLAMP) body = body.slice(0, THOUGHT_CLAMP - 1) + '…';
  return `-# 💭 ${body}`;
}

module.exports = {
  looksLikePromptLeak, toolTitle, humanToolChip, discordToolLine, discordThoughtLine,
  speakerHintsFrom, mentionsSpeaker, thoughtBudget,
  THINK_HEARTBEAT_MS, WORKING_LINE, STILL_WORKING_LINE, THOUGHT_CLAMP,
};
