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
 * in git. Speaker tokens (username / display name) and Access principal
 * ids / display names / mailboxes are passed at runtime and never hardcoded.
 *
 * Thought volume: xhigh uncapped. high and medium → 2 💭 chips (public and DM).
 * Below medium (low) → 0: no chips, just the answer.
 * Tool / Working / Still working chips are xhigh only. medium/high are 💭 only.
 * Image gen is Discord DISPLAY only: one Generating chip even when the engine
 * is xhigh (picture quality). Core classifies (kind-word gate + cheap YES/NO);
 * Discord waits for the effort.imageGen flag and posts no chips during that check.
 */

const { redactSecrets } = require('./redact');

const ACP_TYPE = /^(tool_call|tool_call_update|tool_use|function_call)$/i;
const THINK_HEARTBEAT_MS = 45000;
const WORKING_LINE = '-# Working';
const STILL_WORKING_LINE = '-# Still working';
const GENERATING_LINE = '-# Generating - this takes a while. Please be patient.';
const THOUGHT_CLAMP = 280;
const IMAGE_GEN_TOOL_RE = /^(imagegen|imageedit)$/i;

function looksLikePromptRestatement(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  if (/CURRENT SPEAKER/i.test(s)) return true;
  if (/\bidentity\.md\b/i.test(s)) return true;
  if (/\bCLAUDE\.md\b/i.test(s)) return true;
  if (/\/home\/[A-Za-z0-9._-]+/.test(s)) return true;
  if (/\bThe user is\b/i.test(s)) return true;
  if (/This is a Discord message/i.test(s)) return true;
  if (/I was @-mentioned/i.test(s)) return true;
  if (/\basking me \(/i.test(s)) return true;
  return false;
}

function looksLikePromptLeak(text) {
  const s = String(text || '');
  if (looksLikePromptRestatement(s)) return true;
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(s)) return true;
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

const KIND_RANK = { email: 4, 'last-name': 3, 'first-name': 2, identity: 1 };
/** Public Discord blocks last names and emails only. First names / handles / principal ids post. */
const PUBLIC_BLOCK_KINDS = new Set(['email', 'last-name']);
const KIND_LABEL = {
  email: 'no email',
  'last-name': 'no last name',
};

function nameParts(raw) {
  return String(raw || '').trim().split(/[\s._-]+/).filter((p) => p.length >= 4 && !/^\d+$/.test(p));
}

/** Family name = last long token of a multi-word display (Ada Lovelace → Lovelace even though Ada is < 4). */
function lastNameFromDisplay(raw) {
  const rawParts = String(raw || '').trim().split(/[\s._-]+/).filter(Boolean);
  const parts = nameParts(raw);
  if (rawParts.length >= 2 && parts.length) return parts[parts.length - 1];
  return null;
}

/** Map hint token → kind. Never put the token in a public reply. */
function identityHintKindMap(records) {
  const map = new Map();
  const set = (raw, kind) => {
    const s = String(raw || '').trim();
    if (s.length < 4 || /^\d+$/.test(s)) return;
    const k = s.toLowerCase();
    const prev = map.get(k);
    if (!prev || (KIND_RANK[kind] || 0) > (KIND_RANK[prev] || 0)) map.set(k, kind);
  };
  for (const rec of records || []) {
    if (!rec || rec.id === 'self') continue;
    set(rec.id, 'identity');
    for (const p of String(rec.id || '').split(/[\s._-]+/)) set(p, 'identity');
    const dn = String(rec.display_name || '').trim();
    if (dn) {
      set(dn, 'identity');
      const last = lastNameFromDisplay(dn);
      const parts = nameParts(dn);
      if (last) {
        set(last, 'last-name');
        const given = String(dn).trim().split(/[\s._-]+/).filter(Boolean);
        for (const p of given) {
          if (p.length >= 2 && p.toLowerCase() !== last.toLowerCase()) set(p, 'first-name');
        }
      } else if (parts.length === 1) {
        set(parts[0], 'first-name');
      }
    }
    for (const ident of rec.identifiers || []) {
      const v = ident && ident.value != null ? String(ident.value).trim() : '';
      if (!v || /^\d+$/.test(v)) continue;
      if (/@/.test(v)) set(v, 'email');
      else set(v, 'identity');
    }
  }
  return map;
}

/** Last token of a two-or-more-part speaker display name is a last name even if they are not in Access. */
function mergeSpeakerLastNames(hintKinds, author, member) {
  const map = hintKinds instanceof Map ? new Map(hintKinds) : new Map();
  const bags = [author, member];
  for (const bag of bags) {
    if (!bag || typeof bag !== 'object') continue;
    for (const key of ['globalName', 'displayName', 'nickname']) {
      const last = lastNameFromDisplay(bag[key]);
      if (!last) continue;
      const k = last.toLowerCase();
      const prev = map.get(k);
      if (!prev || (KIND_RANK['last-name'] || 0) > (KIND_RANK[prev] || 0)) map.set(k, 'last-name');
    }
  }
  return map;
}

function kindForHint(hint, hintKinds) {
  if (!hint) return null;
  if (hintKinds && hintKinds.has(String(hint).toLowerCase())) return hintKinds.get(String(hint).toLowerCase());
  if (/@/.test(hint)) return 'email';
  return null;
}

/** Hints that may trigger a public drop. First names, handles, principal ids are omitted. */
function publicBlockHints(hints, hintKinds) {
  return (hints || []).filter((h) => PUBLIC_BLOCK_KINDS.has(kindForHint(h, hintKinds)));
}

const IDENTITY_TALK_RE = /\b(last\s+names?|surnames?|family\s+names?|first\s+names?|given\s+names?|spell(?:ed|ing|s)?|who(?:'s|\s+is|\s+are)|identit(?:y|ies)|customers?|clients?|\bnamed\b|mr\.?|mrs\.?|ms\.?|dr\.?)\b/i;

/** True when every \bhint\b hit is a unit/measure (60 Watt, watt-equivalent, watts). */
function lastNameOnlyUnitUses(text, hint) {
  const h = String(hint || '');
  const s = String(text || '');
  if (!h) return false;
  const re = new RegExp('\\b' + escapeRe(h) + '\\b', 'gi');
  let m;
  let saw = false;
  while ((m = re.exec(s))) {
    saw = true;
    const before = s.slice(Math.max(0, m.index - 20), m.index);
    const after = s.slice(m.index + h.length, m.index + h.length + 24);
    const unit = /\d[\s./-]*$/i.test(before)
      || /^-/.test(after)
      || /^(s|age)\b/i.test(after);
    if (!unit) return false;
  }
  return saw;
}

function textHasFirstName(text, hintKinds) {
  if (!hintKinds || typeof hintKinds.entries !== 'function') return false;
  const s = String(text || '');
  for (const [tok, kind] of hintKinds.entries()) {
    if (kind !== 'first-name' || String(tok).length < 2) continue;
    if (new RegExp('\\b' + escapeRe(tok) + '\\b', 'i').test(s)) return true;
  }
  return false;
}

function textHasFullDisplayName(text, hintKinds) {
  if (!hintKinds || typeof hintKinds.entries !== 'function') return false;
  const s = String(text || '');
  for (const [tok, kind] of hintKinds.entries()) {
    if (kind !== 'identity' || !/\s/.test(tok)) continue;
    if (new RegExp('\\b' + escapeRe(tok) + '\\b', 'i').test(s)) return true;
  }
  return false;
}

/** Skip a last-name token when the message is not about identity. No word list. */
function lastNameIsLanguageUse(text, hint, hintKinds) {
  if (lastNameOnlyUnitUses(text, hint)) return true;
  if (IDENTITY_TALK_RE.test(text)) return false;
  if (textHasFirstName(text, hintKinds)) return false;
  if (textHasFullDisplayName(text, hintKinds)) return false;
  return true;
}

function privacyHitKind(text, hints, hintKinds) {
  const s = String(text || '');
  let best = null;
  let bestRank = 0;
  for (const h of publicBlockHints(hints, hintKinds)) {
    if (!h || String(h).length < 4) continue;
    if (!new RegExp('\\b' + escapeRe(h) + '\\b', 'i').test(s)) continue;
    const kind = kindForHint(h, hintKinds);
    if (kind === 'last-name' && lastNameIsLanguageUse(s, h, hintKinds)) continue;
    const rank = KIND_RANK[kind] || 0;
    if (rank > bestRank) { best = kind; bestRank = rank; }
  }
  return best;
}

/** Public notice. Never includes the matched token. Last name or email only. */
function privacyBlockLine(text, hints, hintKinds) {
  const kind = privacyHitKind(text, hints, hintKinds);
  const reason = KIND_LABEL[kind] || 'no last name';
  return 'response blocked due to privacy rules: ' + reason;
}

/**
 * Access principal tokens at runtime: id (`fixture-person` → also `person`),
 * display name (`Ada Lovelace` → also `Lovelace`), non-numeric identifiers.
 * Emails stay whole (no `.com` split). Skip `self` so "myself" thoughts survive.
 */
function identityHintsFrom(records) {
  const out = [];
  const addName = (raw) => {
    const s = String(raw || '').trim();
    if (s.length < 4 || /^\d+$/.test(s)) return;
    out.push(s);
    for (const p of s.split(/[\s._-]+/)) {
      if (p.length >= 4 && !/^\d+$/.test(p)) out.push(p);
    }
  };
  for (const rec of records || []) {
    if (!rec || rec.id === 'self') continue;
    addName(rec.id);
    addName(rec.display_name);
    for (const ident of rec.identifiers || []) {
      const v = ident && ident.value != null ? String(ident.value).trim() : '';
      if (!v || /^\d+$/.test(v)) continue;
      if (/@/.test(v)) { if (v.length >= 4) out.push(v); continue; }
      addName(v);
    }
  }
  return [...new Set(out)];
}

/**
 * Final Discord reply after streaming. Public guild: never fall back to the
 * raw reply if the held segment was dropped as a leak, and drop answers that
 * contain a last name or Access email. First names and handles post. DMs keep
 * the raw reply. Vendor emails not in Access still post.
 */
function pickPublicReply({ pending, replyText, leakDropped, publicSurface, hints, hintKinds }) {
  const held = String(pending || '').trim();
  const raw = String(replyText || '').trim();
  const blockHints = publicBlockHints(hints, hintKinds);
  const block = (sample) => privacyBlockLine(sample, hints, hintKinds);
  if (held) {
    if (publicSurface && privacyHitKind(held, hints, hintKinds)) return block(held);
    return held;
  }
  if (!raw) return '';
  if (!publicSurface) return raw;
  if (looksLikePromptRestatement(raw) && !privacyHitKind(raw, hints, hintKinds)) return '';
  if (privacyHitKind(raw, hints, hintKinds)) return block(raw);
  if (leakDropped) return '';
  return raw;
}

/** image_gen / image_edit (string name or tool object). */
function isImageGenTool(tool) {
  const raw = typeof tool === 'string'
    ? tool
    : (tool && (tool.name || tool.title || tool.kind)) || '';
  const t = String(raw || '').trim().toLowerCase().replace(/[\s._-]+/g, '');
  return IMAGE_GEN_TOOL_RE.test(t);
}

/** How many 💭 chips to post. Infinity = no cap. 0 = none (go straight to the answer). */
function thoughtBudget(effort, opts) {
  if (opts && opts.imageGen) return 0;
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

/**
 * Email/MCP must never send Discord thought chips or grok thought preambles.
 * Discord keeps 💭 via discordThoughtLine. This is DISPLAY for quiet surfaces.
 */
function stripThoughtChrome(text) {
  let s = String(text || '');
  s = s.split('\n').filter((l) => {
    const t = l.trim();
    if (!t) return true;
    if (/^💭/.test(t)) return false;
    if (/^-#(\s|$)/.test(t)) return false;
    return true;
  }).join('\n').trim();
  const cut = s.match(/I['’]ll answer the thread directly\.?/i);
  if (cut) {
    const after = s.slice(cut.index + cut[0].length).replace(/^\s+/, '');
    if (after.length > 20) s = after;
  }
  const paras = s.split(/\n\n+/);
  if (paras.length >= 2) {
    const head = paras[0];
    if (looksLikePromptLeak(head)
      || /not an ops-desk alert/i.test(head)
      || /^(the user|the owner) asked\b/i.test(head)) {
      s = paras.slice(1).join('\n\n').trim();
    }
  }
  return s;
}

/** Last narration block, with thought chrome removed. Email/MCP reply body. */
function quietReplyFromResult(result) {
  const segs = ((result && result.segments) || [])
    .map((x) => String(x || '').trim()).filter(Boolean);
  const text = segs.length ? segs[segs.length - 1] : String((result && result.text) || '');
  return stripThoughtChrome(text);
}

/** Sanitized Discord thought chip, or '' to drop. Never raw text. Last names and emails drop; first names stay. */
function discordThoughtLine(text, hints, hintKinds) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (looksLikePromptLeak(raw) || privacyHitKind(raw, hints, hintKinds)) return '';
  const cleaned = String(redactSecrets(raw).text || '').trim();
  if (!cleaned || looksLikePromptLeak(cleaned) || privacyHitKind(cleaned, hints, hintKinds)) return '';
  let body = cleaned.replace(/\s+/g, ' ');
  if (body.length > THOUGHT_CLAMP) body = body.slice(0, THOUGHT_CLAMP - 1) + '…';
  return `-# 💭 ${body}`;
}

module.exports = {
  looksLikePromptLeak, looksLikePromptRestatement, toolTitle, humanToolChip, discordToolLine, discordThoughtLine,
  speakerHintsFrom, mentionsSpeaker, identityHintsFrom, identityHintKindMap, mergeSpeakerLastNames,
  publicBlockHints, privacyBlockLine, privacyHitKind, lastNameOnlyUnitUses, lastNameIsLanguageUse, pickPublicReply, thoughtBudget,
  isImageGenTool,
  stripThoughtChrome, quietReplyFromResult,
  THINK_HEARTBEAT_MS, WORKING_LINE, STILL_WORKING_LINE, GENERATING_LINE, THOUGHT_CLAMP,
};
