#!/usr/bin/env node
'use strict';
require('../../shared/loadenv'); // load <repo>/.env before anything reads config
/**
 * asmltr-core — HTTP server + the core handle() pipeline (plan §A4/§A5).
 *
 * Pipeline:  inbound envelope
 *   → resolveIdentity → (deny if revoked)
 *   → buildSystemPrompt → moderate
 *   → resolve conversation_key→session → runTurn (local Agent SDK)
 *   → map result → outbound actions, emit telemetry the whole way.
 *
 * Endpoints:
 *   POST /v2/handle      native: body is an inbound envelope, returns actions[]
 *   POST /query          back-compat shim (exact old shape) for unmigrated channels
 *   GET  /events/stream  SSE feed of telemetry events (dashboard/CLI live view)
 *   GET  /health
 *
 * MUST run on host under PM2 (spawns local claude binary) and bind 127.0.0.1.
 */

// Headless-spawn env hygiene (the known-good recipe): allow
// the SDK to spawn `claude` even when launched from inside a Claude session, and
// keep nested spawning unblocked. Harmless under PM2 (these are usually unset).
// NOTE: deliberately NO ANTHROPIC_API_KEY — execution stays on the Claude subscription.
// We STRIP it from the env so agent execution can never silently go metered, even if an
// Anthropic key is configured for the moderation classifier (which resolves its key from
// the secrets provider, not this env var — see core/src/moderation.js + docs/MODERATION.md).
process.env.IS_SANDBOX = '1'; // MUST be '1' (not 'true') — the modern CLI only accepts '1' to permit
// bypassPermissions as root. With 'true' it refuses (--dangerously-skip-permissions blocked as root).
delete process.env.CLAUDECODE;
delete process.env.CLAUDE_CODE_ENTRYPOINT;
delete process.env.ANTHROPIC_API_KEY;

const express = require('express');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

const env = require('./envelope');
const trust = require('./trust/store'); // unified auth/trust/capability framework (replaces resolver)
const moderation = require('./moderation');
const sessions = require('./sessions');
const drafts = require('./drafts'); // shared hold-for-approval queue (any connector can opt in)
const selfUpdate = require('../../shared/update'); // self-update: detect + run (spawns an agent update session)
const { createSpeaker } = require('../../shared/speech/speaker'); // core speech layer: reply stream → TTS audio
const voice = require('../../shared/speech/voice'); // voice UX: chime + ambient drone + optional spoken ack
const tts = require('../../shared/speech/tts'); // TTS config (voice/model), persisted + GUI/TUI-settable
const stt = require('../../shared/speech/stt'); // STT (transcription) — audio clip → text via a real model
const runtime = require('../../shared/runtime'); // agent runtime: SDK version, model selection, auto-update
const identity = require('../../shared/identity'); // Self identity anchor (Likeness plane) — injected into every turn
const vault = require('../../shared/vault'); // TRUST vault (credential broker + KMS) — hard dependency
const integrations = require('../../integrations/registry'); // third-party service links (storage, …)
const silo = require('../../shared/silo'); // data silos — the Self silo is memory + the default artifact home
// Ensure the Self silo exists (created from the `self` template) — the default home for artifacts.
let SELF_SILO_DIR = null;
try { SELF_SILO_DIR = silo.ensureSelf(identity.name()).dir; } catch (_) { /* non-fatal */ }
// Cheap cached "is the vault locked?" flag, refreshed in the background, so every turn can warn the agent
// WITHOUT awaiting a health check. Configured-but-sealed OR unreachable → locked (credential ops will fail).
let VAULT_LOCKED = false;
async function refreshVaultLocked() {
  if (!(process.env.ASMLTR_VAULT_URL && process.env.ASMLTR_VAULT_AGENT_KEY)) { VAULT_LOCKED = false; return; }
  try { const h = await vault.health(); VAULT_LOCKED = h.ok ? !!h.sealed : true; } catch (_) { VAULT_LOCKED = true; }
}
refreshVaultLocked();
const _vaultTimer = setInterval(refreshVaultLocked, 30000); if (_vaultTimer.unref) _vaultTimer.unref();
const { runTurn, generateTitle, generateStatus, generateSelfAssessment, getLastModel } = require('./runner');
const emitter = require('./emitter');
const { redactSecrets } = require('../../shared/redact'); // public-surface output redaction

const PORT = Number(process.env.ASMLTR_CORE_PORT || 3023);
const HOST = '127.0.0.1';
const MAX_CONCURRENT = Number(process.env.ASMLTR_CORE_CONCURRENCY || 6);

// In-process bus so /events/stream can broadcast what we also persist via emitter.
const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Emit telemetry to the durable sinks AND the live SSE bus. */
function record(partial) {
  const evt = emitter.emit(partial);
  if (evt) bus.emit('event', evt);
  return evt;
}

// --- concurrency: global semaphore + per-conversation_key serialization ------
let active = 0;
const waiters = [];
const keyChains = new Map();

function acquireSlot() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((res) => waiters.push(res));
}
function releaseSlot() {
  active--;
  const next = waiters.shift();
  if (next) { active++; next(); }
}
/** Serialize turns sharing a conversation_key (mirrors Discord's processingChannels guard). */
function withKeyLock(key, fn) {
  const prev = keyChains.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.catch(() => {}); // tail never rejects so the chain keeps flowing
  keyChains.set(key, tail);
  tail.then(() => { if (keyChains.get(key) === tail) keyChains.delete(key); });
  return run;
}

// In-flight turns by conversation_key → AbortController, for real-time kill.
const inFlight = new Map();
function truncate(v, n = 400) { try { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…' : s; } catch { return ''; } }

// A model that decides a message isn't for it should emit the bare [[NO_REPLY]] token — but it often
// PROSE-refuses instead ("That's addressed to another agent, not me…"), which then gets POSTED as spam. This
// catches that failure mode as a fallback silence: a SHORT reply whose whole content is meta-commentary
// about not being the addressee / having nothing to add. Length-capped + adjacency-specific to avoid
// suppressing a real reply that merely mentions who a message was addressed to. Channel-agnostic.
function looksLikeNonReply(t) {
  const s = (t || '').trim();
  if (!s || s.length > 400) return false;
  return /\b(?:not (?:addressed|meant|directed|intended)\s*(?:to|at|for)?\s*me\b|addressed to \w+[, ]+not me\b|(?:that(?:.s| is)?|this is|it.s) (?:addressed|meant|for|directed|intended) (?:to|for|at) \w+|nothing (?:here )?for me to (?:add|say|respond|do|answer|reply)|not my (?:turn|message|place|call|cue)|i.?ll (?:let|leave|defer to) \w+ (?:take|handle|answer|respond)|no (?:reply|response) (?:needed|required|from me))/i.test(s);
}
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((x) => (x && x.text) || (typeof x === 'string' ? x : '')).join(' ');
  return '';
}

// Channel/medium self-awareness — prepended to every system prompt so the model
// knows the USER's channel (vs its own Claude Code runtime).
const NAME = process.env.ASSISTANT_NAME || 'the assistant';
const CHANNEL_LABELS = {
  discord: 'Discord', telegram: 'Telegram', github: 'GitHub (issue thread)',
  mcp: 'an MCP client', core: 'a direct API call',
  'assistant-web': 'a web assistant app', 'assistant-native': 'a mobile assistant app',
  'eve-assistant-web': 'a web assistant app', 'eve-assistant-native': 'a mobile assistant app', // legacy ids
};
function buildChannelAwareness(e, resolved) {
  const NAME = identity.name(); // live (GUI-editable) — not the module-load env const
  const who = (resolved && resolved.display_name) || (e.sender && e.sender.raw_username) || 'a user';
  const scope = e.context && e.context.scope_name ? ` in "${e.context.scope_name}"` : '';
  const label = CHANNEL_LABELS[e.channel] || e.channel;
  return `MEDIUM AWARENESS — READ FIRST:
This message reached you through the asmltr "${e.channel}" connector. You are talking with ${who} over ${label}${scope}; from their side they are messaging ${NAME} on ${label}, NOT sitting in a terminal with you.
Your underlying runtime is Claude Code, but that is an internal implementation detail and is NOT the medium of this conversation. If asked what app/medium/channel/platform you're on, the truthful answer is ${label} (via the asmltr ${e.channel} connector) — do NOT say "Claude Code", "the terminal", "SSH", or describe session-start hooks / git status / system reminders as if the user sent them. Those are your backstage context, not this conversation.`;
}

// --- observe-only awareness buffer ------------------------------------------
// Messages the assistant should stay AWARE of but not reply to (addressed to another agent in a
// multi-agent channel, or ambient chatter). We don't run a turn for these — the SDK session only
// grows via real turns — so we buffer them per conversation_key and prepend them as context to the
// NEXT real turn. This is what lets the session stay current without a reply. Bounded to avoid bloat.
const observed = new Map(); // conversation_key -> [{ author, text }]
const OBSERVE_MAX = Math.max(5, Number(process.env.ASMLTR_OBSERVE_MAX || 60));
function pushObserved(key, author, text) {
  const t = String(text || '').trim();
  if (!t) return;
  const arr = observed.get(key) || [];
  arr.push({ author: String(author || 'someone'), text: t.slice(0, 800) });
  while (arr.length > OBSERVE_MAX) arr.shift(); // sliding window — keep the most recent
  observed.set(key, arr);
}
// --- self-sent assimilation buffer ------------------------------------------
// When the assistant cross-posts a message INTO this channel from ANOTHER of its sessions (via
// POST /v2/send), the destination session's SDK history never learned it "said" that — it was posted
// by the bot, filtered from the connector's own-message ingest. So it looks foreign on the next read.
// We buffer such messages per destination conversation_key and fold them into the next real turn as
// the session's OWN prior output — assimilating the context so identity stays coherent.
const selfSent = new Map(); // conversation_key -> [{ text, from }]
const SELFSENT_MAX = 20;
function pushSelfSent(key, text, from) {
  const t = String(text || '').trim();
  if (!t || !key) return;
  const arr = selfSent.get(key) || [];
  arr.push({ text: t.slice(0, 1500), from: from || null });
  while (arr.length > SELFSENT_MAX) arr.shift();
  selfSent.set(key, arr);
}
function drainSelfSent(key) {
  const arr = selfSent.get(key);
  if (!arr || !arr.length) return '';
  selfSent.delete(key);
  const lines = arr.map((m) => `- ${m.text}`).join('\n');
  // Framed as a VERIFIABLE CHANNEL EVENT ("this message is visibly in the channel, attributed to you"),
  // NOT a memory claim ("you remember saying this") — a model trusts observable channel facts but rightly
  // rejects unverifiable self-authorship claims (it checks its transcript, finds nothing, and refuses).
  // So this stays a user-turn preamble (believable channel context), not a system assertion.
  return `[Channel event — your OTHER sessions can post here too, and the message(s) below were just ` +
    `posted INTO THIS CHANNEL under YOUR name/handle by one of your parallel sessions. They are now ` +
    `visibly in the channel, on the record as yours — already delivered. You may not have composed them ` +
    `in THIS session, so don't expect them in your memory here; just treat them as your own side of the ` +
    `conversation (don't re-post, don't answer them as if a stranger said them, don't dispute they are yours):\n${lines}\n[End of your cross-posted messages]\n\n`;
}

// Drain the buffer into a context preamble for the next real turn (and clear it).
function drainObserved(key) {
  const arr = observed.get(key);
  if (!arr || !arr.length) return '';
  observed.delete(key);
  const lines = arr.map((m) => `- ${m.author}: ${m.text}`).join('\n');
  return `[Channel activity since you last replied — CONTEXT ONLY, for your awareness. Each line is what ` +
    `ANOTHER participant said, quoted in THEIR OWN voice: any "I", "me", or "my" in these lines refers to ` +
    `that named speaker, NOT to you — do not absorb their words as your own. You were not addressed in these ` +
    `(they were for other people/agents or ambient chatter). Do not reply to them; just factor them into your ` +
    `understanding. Then apply your normal rules to the message that follows — which may or may not itself be ` +
    `for you.]\n${lines}\n[End of catch-up]\n\n`;
}

/**
 * The core. Takes a validated inbound envelope, returns OutboundAction[].
 */
async function handle(envelope, opts = {}) {
  const e = env.inbound(envelope);
  const idlePolicy = e.delivery === 'sync' ? 'infinite' : 'infinite';

  const _cc = e.channel_context || {};
  record({ surface: e.channel, session_id: e.conversation_key, event_type: 'inbound',
    identity: e.sender.raw_username || e.sender.raw_id, source: 'core',
    payload: { text: e.content.text.slice(0, 500), delivery: e.delivery, server: _cc.server || null, channel: _cc.channel || null, observed: e.observe_only || undefined } });

  // Observe-only: ingest for awareness, never reply. Recorded above (backend visibility); buffered
  // here so it reaches the model as context on the next real turn. No trust/moderation/turn.
  if (e.observe_only) {
    pushObserved(e.conversation_key, e.sender.raw_username || e.sender.raw_id, e.content.text);
    return [];
  }

  // 0) takeover guard: if a human has claimed this session in a terminal, pause
  //    channel responses (don't run a turn) until released.
  const claimed = sessions.get(e.conversation_key);
  if (claimed && claimed.claim_state === 'terminal-claimed') {
    record({ surface: e.channel, session_id: e.conversation_key, event_type: 'control',
      identity: claimed.claimed_by, source: 'core', payload: { action: 'paused-by-claim' } });
    return [env.status('This conversation is being handled directly in a terminal right now.')];
  }

  // 1) identity / trust (unified framework — context-scoped, default-deny)
  const resolved = trust.resolve(e);
  e.resolved = resolved;
  record({ surface: e.channel, session_id: e.conversation_key, event_type: 'identity_resolved',
    identity: resolved.user_key, source: 'core',
    payload: { trust_tier: resolved.trust_tier, bypass: resolved.bypass_moderation, revoked: resolved.revoked } });

  if (resolved.revoked) {
    record({ surface: e.channel, session_id: e.conversation_key, event_type: 'moderation_decision',
      identity: resolved.user_key, source: 'core', payload: { decision: 'REVOKED' } });
    return [env.reply('Access has been revoked for this account.')];
  }

  // Cast engagement override (per-scope): 'ignore' → drop entirely (mute this member here); 'observe' →
  // ingest for awareness but never reply; default 'engage' → normal. Retires per-connector bot lists.
  if (resolved.engagement === 'ignore') {
    record({ surface: e.channel, session_id: e.conversation_key, event_type: 'control', identity: resolved.user_key, source: 'core', payload: { action: 'engagement-ignore' } });
    return [];
  }
  if (resolved.engagement === 'observe' && !e.observe_only) {
    pushObserved(e.conversation_key, resolved.display_name || (e.sender && e.sender.raw_username), e.content.text);
    record({ surface: e.channel, session_id: e.conversation_key, event_type: 'control', identity: resolved.user_key, source: 'core', payload: { action: 'engagement-observe' } });
    return [];
  }

  // 2) system prompt + moderation
  // Medium awareness FIRST (applies to every channel) — the model's runtime is
  // Claude Code, but the USER is on this connector's channel. Without this, "what
  // are we talking over?" gets answered as terminal/SSH/CLI instead of the channel.
  // IDENTITY FIRST — the anchor (who you are, asserted not inferred; the anti-drift fix from the peer-drift
  // incident) + the living layer (preferences + story). Applies to every channel.
  let systemPrompt = identity.fullIdentity() + '\n\n' + buildChannelAwareness(e, resolved) + '\n\n' + trust.buildAuthzPrompt(resolved, e.channel);
  // THE CAST: who you're talking to + their cross-channel identity + your relationship + peer agents here.
  const relPrompt = trust.buildRelationshipPrompt(resolved, e);
  if (relPrompt) systemPrompt += '\n\n' + relPrompt;
  if (e.system_prompt_extra) systemPrompt += '\n\n' + e.system_prompt_extra; // connector-supplied context (e.g. Discord)
  if (process.env.ASMLTR_SELF_AWARE !== 'off') { // make the session aware of the asmltr toolbelt
    systemPrompt += '\n\nASMLTR TOOLBELT — you run inside asmltr, a multi-session assistant backend on this machine. ' +
      'You have an `asmltr` CLI (run `asmltr help` for everything). Key cross-session ops (use the Bash tool):\n' +
      '• `asmltr ls` (active sessions) · `asmltr map` (grouped by working dir) · `asmltr who <path>` (who recently touched a file/dir) — check these before duplicating work another session is already doing.\n' +
      '• `asmltr send <channel> <target> "<text>"` — deliver output through ANOTHER connector (discord|telegram|…; target = id/alias). ' +
      'COPY (here + there): run it, then reply normally. REDIRECT (only there): run it, then reply with exactly [[NO_REPLY]] so nothing posts here. ' +
      'To send a FILE/attachment (image, PDF, any file) on a channel that supports it: `asmltr send <channel> <target> --file <abs-path> [--caption "…"]`.\n' +
      '• `asmltr announce "<text>" [--to <target>] [--urgent] [--ttl <sec>]` — post an awareness note delivered into other sessions on their next turn; `asmltr announcements` lists live ones.\n' +
      'Use these when asked to route/coordinate, or to stay aware of the other sessions running alongside you.';
    // Mesh steer is a COERCIVE verb — only advertise it when the operator has enabled it, and always
    // teach the announce-vs-steer distinction so it's used deliberately, not reflexively.
    if (/^(1|on|true|yes)$/i.test(process.env.ASMLTR_MESH_STEER || '')) {
      systemPrompt += '\n• `asmltr steer <session-key> "<guidance>" [--from <you>] [--interrupt]` — push guidance ' +
        'directly into ANOTHER session\'s LIVE turn. This is fundamentally different from `announce`: **announce** ' +
        'is an advisory note the other session sees on its NEXT turn and decides for itself whether to act on; ' +
        '**steer** overrides what that session is doing RIGHT NOW and makes it act on your guidance (`--interrupt` ' +
        'abandons its current turn; without it, your guidance is applied after the current turn finishes). Steer is ' +
        'coercive — it spends the other session\'s turn. Use it sparingly for time-sensitive redirection; prefer ' +
        'announce for everything else. Never steer a session into a loop (don\'t steer one that\'s steering you).';
    }
    if (SELF_SILO_DIR) {
      systemPrompt += `\n\nSELF SILO — your persistent memory + the DEFAULT home for anything you create is a data silo at \`${SELF_SILO_DIR}\`. ` +
        'When you produce an artifact (a document, image, app, export) and the task doesn\'t specify where, create it UNDER the Self silo — ' +
        'don\'t scatter files in random system paths (you can still work in a git repo or elsewhere when the task requires it). Browse/recall it with the Bash tool:\n' +
        '• `asmltr silo overview` (map: zones + counts) · `asmltr silo ls [path]` · `asmltr silo tree [path]`\n' +
        '• `asmltr silo find <query> [--content] [--type <ext>] [--since <date>]` — recall past work (filename + full-text search)\n' +
        '• `asmltr silo get <path>` · `asmltr silo put <path> <file>`. Zones: `artifacts/` (finished outputs), `workspaces/` (builds in progress), `memory/` (identity, transcripts, dreams).';
    }
    if (VAULT_LOCKED) {
      systemPrompt += '\n\n⚠️ VAULT LOCKED — the TRUST vault is sealed or unreachable, so credential-backed operations ' +
        '(fetching API keys/secrets, encrypted-storage keys) will FAIL right now. If a task needs a credential, tell the ' +
        'user the vault is locked and ask them to unlock it (`asmltr vault unseal` or the dashboard Vault page) — do NOT ' +
        'guess, hardcode, or work around a missing secret.';
    }
    // If THIS channel supports attachments, tell the agent exactly how — so it never claims it can't.
    if (e.capabilities && e.capabilities.supports_attachments_out) {
      const chTarget = (e.channel_context && (e.channel_context.channelId || e.channel_context.chatId || e.channel_context.target)) || '<this channel id>';
      systemPrompt += `\n\nATTACHMENTS: THIS channel supports sending files. To attach a file HERE, write/produce it to a path, then run \`asmltr send ${e.channel} ${chTarget} --file <abs-path> [--caption "…"]\`. Do NOT tell the user you can't attach files here or fall back to another channel — you can.`;
    }
  }
  // Cross-channel file uploads: every file a user sends on ANY channel is saved to one shared
  // area (see shared/uploads.js), so "find the thing I sent" works even when it arrived on a
  // different channel/app. Trust-gated: only full-trust (owner) sessions are told about the
  // upload area + shown the recent file list — don't leak the owner's files to lesser callers.
  if (resolved.bypass_moderation) {
    systemPrompt += '\n\nFILE UPLOADS (shared across ALL channels): every file a user sends on any channel ' +
      '(Telegram, Discord, …) is saved to ONE shared upload area, tagged with its origin channel. When the user ' +
      'refers to a file they sent/uploaded/shared — even "on Telegram" or from another app — DO NOT claim you ' +
      'can\'t find it before checking here: run `asmltr uploads` (newest first; also `asmltr uploads <search>`, ' +
      '`--channel <name>`, `--since <2h|1d>`), then Read the file at the path it prints.';
    try {
      const recent = require('../../shared/uploads').recentSummary(6);
      if (recent) systemPrompt += `\n\nRecent uploads (newest first):\n${recent}`;
    } catch (_) {}
  }

  // Cross-session announcements: drain any this session hasn't seen into its context (with
  // timestamps) — awareness from other sessions on this machine, delivered on this next turn.
  try {
    const anns = sessions.drainAnnouncements(e.conversation_key, e.channel, resolved.user_key);
    if (anns.length) {
      const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      const lines = anns.map((a) => `• [${fmt(a.created_at)}${a.priority === 'urgent' ? ' · URGENT' : ''}${a.from_session ? ' · from ' + a.from_session : ''}] ${a.text}`);
      systemPrompt += `\n\n📢 ANNOUNCEMENTS from other sessions on this machine (awareness only — act on them just if relevant to what you're doing):\n${lines.join('\n')}`;
      record({ surface: e.channel, session_id: e.conversation_key, event_type: 'control', identity: resolved.user_key, source: 'core', payload: { action: 'announcements-received', count: anns.length } });
    }
  } catch (_) {}
  const mod = await moderation.moderate(e.content.text, resolved, { platform: e.channel });
  record({ surface: e.channel, session_id: e.conversation_key, event_type: 'moderation_decision',
    identity: resolved.user_key, source: 'core',
    payload: { decision: mod.allowed ? 'ALLOW' : 'BLOCK', riskLevel: mod.riskLevel, monitored: !!mod.monitored, bypassed: !!mod.bypassed } });

  if (!mod.allowed) {
    if (mod.riskLevel >= 7) await moderation.notifyBlock(resolved, e.content.text, mod, e.channel);
    return [env.reply('This request has been flagged by the security system and was not processed.')];
  }

  // 3) session resolution + run
  const isNew = !sessions.get(e.conversation_key)?.engine_session_id;
  const { resume } = sessions.resolveForTurn(e.conversation_key, e.channel, idlePolicy, e.working_dir || undefined);
  const sessionRow = sessions.get(e.conversation_key);
  const cwd = sessionRow?.working_dir || undefined; // spawn/resume cwd (neutral /root by default)
  if (isNew) {
    record({ surface: e.channel, session_id: e.conversation_key, event_type: 'session-start',
      identity: resolved.user_key, source: 'core', payload: { channel: e.channel } });
  }

  // Remember where an out-of-band operator inject should reply (via the manager's /send):
  // instance id = 2nd segment of the conversation_key; target = the channel/chat id.
  try {
    const outInstance = String(e.conversation_key).split(':')[1] || null;
    const outTarget = (e.channel_context && (e.channel_context.channelId || e.channel_context.chatId || e.channel_context.target)) || null;
    if (outInstance && outTarget) sessions.setOutboundRoute(e.conversation_key, outInstance, outTarget);
  } catch (_) {}

  // Redaction applies on public surfaces or for any non-full-trust recipient. Computed NOW (not
  // just at the output stage) so STREAMED deltas can be masked in-flight — a secret is never shipped.
  const mustRedact = !!e.public || !resolved.bypass_moderation;
  // Streaming (opts.onText): emit assistant text as the SDK produces it. When redacting, only ship up
  // to the last WHITESPACE boundary — so a secret is a complete token (redactSecrets masks it) before
  // it goes out, and we never emit a still-forming token. Full-trust recipients stream raw (no lag).
  let _streamRaw = '', _emitted = 0;
  const _pushDelta = (raw) => {
    _streamRaw += raw;
    const red = mustRedact ? redactSecrets(_streamRaw).text : _streamRaw;
    let end = red.length;
    if (mustRedact) { const b = Math.max(red.lastIndexOf(' '), red.lastIndexOf('\n')); end = b >= 0 ? b + 1 : _emitted; }
    if (end > _emitted) { try { opts.onText(red.slice(_emitted, end)); } catch (_) {} _emitted = end; }
  };
  const _flushStream = () => {
    if (!opts.onText) return;
    const red = mustRedact ? redactSecrets(_streamRaw).text : _streamRaw;
    if (/\[\[NO_REPLY\]\]/i.test(red)) return; // don't ship the silence sentinel
    if (red.length > _emitted) { try { opts.onText(red.slice(_emitted)); } catch (_) {} _emitted = red.length; }
  };
  // Step streaming (opts.onSegment/onTool/onThinking): a step consumer (e.g. Discord) posts each
  // COMPLETED narration block / tool call as it lands — not token-by-token. Segments and thinking
  // are complete blocks, so we redact each whole (no boundary dance) before it leaves the core.
  const _pushSegment = (seg) => { try { opts.onSegment(mustRedact ? redactSecrets(seg).text : seg); } catch (_) {} };
  const _pushThinking = (t) => { try { opts.onThinking(mustRedact ? redactSecrets(t).text : t); } catch (_) {} };

  const abortController = new AbortController();
  inFlight.set(e.conversation_key, abortController);
  let result;
  try {
    // image attachments → vision (runner builds SDK image content blocks)
    const images = (e.content.attachments || [])
      .filter((a) => a && a.type === 'image' && a.data && a.media_type)
      .map((a) => ({ media_type: a.media_type, data: a.data }));
    // User-turn preamble, in channel-chronology framing the model trusts: (1) messages this session
    // cross-posted here from elsewhere (a verifiable channel event under its own name), then (2)
    // observed-but-not-replied activity from others. Both buffers are drained + cleared each turn.
    const catchUp = drainSelfSent(e.conversation_key) + drainObserved(e.conversation_key);
    result = await runTurn({
      prompt: catchUp + e.content.text,
      systemPrompt,
      resume,
      cwd,
      abortController,
      images,
      onDelta: opts.onText ? _pushDelta : undefined,
      onSegment: opts.onSegment ? _pushSegment : undefined,
      onTool: opts.onTool ? ((t) => { try { opts.onTool(t); } catch (_) {} }) : undefined,
      onThinking: opts.onThinking ? _pushThinking : undefined,
      onEvent: (sdkEvt) => {
        const base = { surface: e.channel, session_id: e.conversation_key, identity: resolved.user_key, source: 'core' };
        if (sdkEvt.type === 'assistant') {
          for (const c of sdkEvt.message?.content || []) {
            if (c.type === 'tool_use') record({ ...base, event_type: 'tool', payload: { tool: c.name, input: truncate(c.input, 4000) } });
            else if (c.type === 'thinking') record({ ...base, event_type: 'thinking', payload: { text: truncate(c.thinking || c.text, 2000) } });
          }
        } else if (sdkEvt.type === 'user') {
          for (const c of sdkEvt.message?.content || []) {
            // store generous tool output so the TUI watch view can show it in full (cap guards DB bloat)
            if (c.type === 'tool_result') record({ ...base, event_type: 'tool_result', payload: { output: truncate(toolResultText(c.content), 16000), is_error: !!c.is_error } });
          }
        }
      },
    });
  } catch (err) {
    // If the operator stopped or steered this turn (Stop button / a steer with interrupt),
    // its AbortController fires and the SDK throws. That's not a failure — stay SILENT so the
    // connector posts nothing (the steer, if any, delivers the real reply). Re-throw anything else.
    if (abortController.signal.aborted) {
      record({ surface: e.channel, session_id: e.conversation_key, event_type: 'control',
        identity: resolved.user_key, source: 'core', payload: { action: 'aborted', silent: true } });
      return []; // no actions → connector drops it (no "I hit an error")
    }
    throw err;
  } finally {
    inFlight.delete(e.conversation_key);
  }
  _flushStream(); // ship any redacted tail held back during streaming

  if (result.engineSessionId) sessions.recordEngineId(e.conversation_key, result.engineSessionId);
  sessions.touch(e.conversation_key);

  record({ surface: e.channel, session_id: e.conversation_key, event_type: 'token-usage',
    identity: resolved.user_key, source: 'core',
    tokens_in: result.usage.tokens_in, tokens_out: result.usage.tokens_out, cost_usd: result.usage.cost_usd,
    payload: { tools: result.tools.length, isError: result.isError } });

  // Universal silence sentinel: if the turn ends with [[NO_REPLY]] (e.g. the agent rerouted its
  // answer to another channel via `asmltr send` and doesn't want to post here), emit no action so
  // EVERY connector stays quiet — not just Discord. Enables cross-channel "redirect".
  if (/\[\[NO_REPLY\]\]/i.test(result.text || '')) {
    record({ surface: e.channel, session_id: e.conversation_key, event_type: 'control',
      identity: resolved.user_key, source: 'core', payload: { action: 'no-reply' } });
    return [];
  }

  // Fallback silence: the model decided this wasn't for it but prose-refused instead of emitting
  // [[NO_REPLY]] (a common multi-agent-channel slip). Treat that meta-refusal as a no-reply so it
  // doesn't get posted. Logged so we can see when it fires.
  if (looksLikeNonReply(result.text)) {
    record({ surface: e.channel, session_id: e.conversation_key, event_type: 'control',
      identity: resolved.user_key, source: 'core', payload: { action: 'no-reply', via: 'refusal-prose', text: truncate(result.text, 200) } });
    return [];
  }

  // Empty turn (interrupted mid-reply, tool-only, or the agent chose not to speak) → post NOTHING.
  // NEVER emit a canned greeting: on a busy multi-agent channel a content-free "I'm here — what would
  // you like to know?" is noise the other agents dutifully answer, spiralling into a loop.
  if (!(result.text || '').trim()) {
    record({ surface: e.channel, session_id: e.conversation_key, event_type: 'control',
      identity: resolved.user_key, source: 'core', payload: { action: 'empty-no-reply' } });
    return [];
  }

  const actions = [env.reply(result.text, { segments: result.segments || [] })];
  record({ surface: e.channel, session_id: e.conversation_key, event_type: 'outbound',
    identity: resolved.user_key, source: 'core', payload: { text: truncate(result.text, 500), chars: (result.text || '').length } });

  // --- REDACTION LAYER (output stage, mirrors the trust/auth input stage) -----
  // Scrub secrets from outbound text on any surface that ISN'T a private channel with
  // a full-trust user: public surfaces (github comments, discord channels) always
  // redact; private 1:1 surfaces redact unless the recipient is full-trust (the owner).
  // Telemetry above stays RAW — the operator TUI is a private, full-trust surface.
  // (mustRedact was computed up-front so streaming deltas could be masked in-flight too.)
  if (mustRedact) {
    let masked = 0;
    for (const a of actions) {
      if (a.type !== 'reply') continue;
      const r = redactSecrets(a.text); a.text = r.text; masked += r.count;
      if (Array.isArray(a.segments)) a.segments = a.segments.map((s) => { const x = redactSecrets(s); masked += x.count; return x.text; });
    }
    if (masked) record({ surface: e.channel, session_id: e.conversation_key, event_type: 'control',
      identity: resolved.user_key, source: 'core', payload: { action: 'redacted', count: masked, public: !!e.public } });
  }

  // --- DRAFT / APPROVAL GATE ---------------------------------------------------
  // If the connector attached an approval policy and it says HOLD for this recipient, divert the
  // (already-redacted) reply into the shared draft store instead of returning it. The connector
  // then sends nothing; the draft surfaces on the dashboard + `asmltr drafts` for approve/discard.
  // Generic — any connector opts in by setting e.approval = { policy, recipient, subject, attachments }.
  if (e.approval && drafts.shouldHold(e.approval.policy, resolved)) {
    const replyAction = actions.find((a) => a.type === 'reply');
    const bodyText = replyAction ? replyAction.text : '';
    if (bodyText.trim()) {
      const d = drafts.create({
        channel: e.channel, instanceId: String(e.conversation_key).split(':')[1] || null,
        conversationKey: e.conversation_key, recipient: e.approval.recipient || null,
        subject: e.approval.subject || null, body: bodyText, attachments: e.approval.attachments || [],
        reason: `policy=${e.approval.policy} tier=${resolved.trust_tier}`,
      });
      record({ surface: e.channel, session_id: e.conversation_key, event_type: 'notification',
        identity: resolved.user_key, source: 'core',
        payload: { kind: 'draft', draft_id: d.id, recipient: d.recipient, subject: d.subject, preview: truncate(bodyText, 280) } });
      return [{ type: 'drafted', draft_id: d.id }]; // connector delivers nothing to the recipient
    }
  }
  return actions;
}

/** Deliver text (+ optional files) OUT through a connector instance, via the manager's unified /send. */
async function deliverOut({ instanceId, target, text, files, subject, ref }) {
  const mgr = (process.env.ASMLTR_MANAGER_URL || 'http://127.0.0.1:3024').replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.ASMLTR_MANAGER_TOKEN) headers.Authorization = 'Bearer ' + process.env.ASMLTR_MANAGER_TOKEN;
  const post = (body) => fetch(`${mgr}/send`, { method: 'POST', headers, body: JSON.stringify(body) });
  // subject/ref are email-threading hints; other connectors ignore them.
  if (text && text.trim()) { const r = await post({ instance_id: instanceId, target, kind: 'text', text, subject, ref }); if (!r.ok) throw new Error(`send ${r.status}`); }
  for (const p of files || []) { const r = await post({ instance_id: instanceId, target, kind: 'file', path: p, subject, ref }); if (!r.ok) throw new Error(`send file ${r.status}`); }
}

/** Run handle() under the concurrency slot + per-key lock. */
function dispatch(envelope, opts) {
  const key = envelope.conversation_key || 'anon';
  return withKeyLock(key, async () => {
    await acquireSlot();
    try { return await handle(envelope, opts); }
    finally { releaseSlot(); }
  });
}

// --- HTTP --------------------------------------------------------------------
const app = express();

// OIDC provider (roadmap P1 phase F) — MOUNTED BEFORE express.json so oidc-provider owns its own body
// parsing (the token endpoint needs the raw stream). OFF unless ASMLTR_OIDC=on. Login/consent reuse the
// asmltr session via the interaction handler below; everything else is the standard provider.
const oidc = require('./oidc');
if (oidc.enabled()) {
  try {
    const authLib = require('../../shared/auth');
    const provider = oidc.getProvider();
    // Interaction: auto-login from the asmltr session, auto-consent (clients are admin-registered → trusted).
    app.get('/oidc/interaction/:uid', async (req, res, next) => {
      try {
        const details = await provider.interactionDetails(req, res);
        const { prompt, params } = details;
        const s = authLib.verifySession(authLib.tokenFromReq(req));
        if (!s) return res.redirect('/?next=' + encodeURIComponent(req.originalUrl)); // → SPA login, returns here
        if (prompt.name === 'login') {
          return await provider.interactionFinished(req, res, { login: { accountId: s.sub } }, { mergeWithLastSubmission: false });
        }
        if (prompt.name === 'consent') {
          let grant = details.grantId ? await provider.Grant.find(details.grantId) : new provider.Grant({ accountId: s.sub, clientId: params.client_id });
          if (prompt.details.missingOIDCScope) grant.addOIDCScope(prompt.details.missingOIDCScope.join(' '));
          if (prompt.details.missingOIDCClaims) grant.addOIDCClaims(prompt.details.missingOIDCClaims);
          if (prompt.details.missingResourceScopes) for (const [r, scopes] of Object.entries(prompt.details.missingResourceScopes)) grant.addResourceScope(r, scopes.join(' '));
          const grantId = await grant.save();
          return await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
        }
        return next();
      } catch (e) { next(e); }
    });
    app.use('/oidc', provider.callback());
    console.log('OIDC provider mounted at ' + oidc.issuer());
  } catch (e) { console.log('[oidc] failed to mount: ' + e.message); }
}

app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'asmltr-core', active }));
// Build identity — the code sha this process is running + when it started. An updater checks this
// (not just /health, which returns 200 even on stale code) to confirm the restart actually landed.
const BUILD_SHA = (() => { try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch (_) { return 'unknown'; } })();
const STARTED_AT = new Date().toISOString();
app.get('/version', (req, res) => res.json({ service: 'asmltr-core', ...require('../../shared/version').info(), sha: BUILD_SHA, started_at: STARTED_AT, pid: process.pid }));

// TRUST vault status — the hard dependency's health for the degraded-but-loud GUI. `configured`
// false = no ASMLTR_VAULT_* wired; `reachable`/`sealed` come from the live vault.
app.get('/v2/vault/status', async (req, res) => {
  const configured = !!(process.env.ASMLTR_VAULT_URL && process.env.ASMLTR_VAULT_AGENT_KEY);
  if (!configured) return res.json({ configured: false, reachable: false, sealed: null });
  const h = await vault.health();
  res.json({ configured: true, reachable: h.ok, sealed: h.sealed, url: process.env.ASMLTR_VAULT_URL });
});
// Unseal the vault with the master passphrase (never persisted — held only in the vault's memory).
app.post('/v2/vault/unseal', async (req, res) => {
  const pw = (req.body || {}).password;
  if (!pw) return res.status(400).json({ error: 'password required' });
  try { const r = await vault.unseal(pw); res.json({ ok: true, ...r }); } catch (e) { res.status(400).json({ error: e.message }); }
});

// Auth — the session-gate foundation (roadmap P1 phase A; docs/AUTH.md). ADDITIVE + enforcement OFF:
// requireAuth is a no-op unless ASMLTR_AUTH=on, so these endpoints exist without gating anything yet.
const auth = require('../../shared/auth');
const authSecureCookie = () => process.env.ASMLTR_AUTH_INSECURE_COOKIE !== '1'; // Secure cookie by default (https)
app.get('/v2/auth/status', (req, res) => {
  const s = auth.verifySession(auth.tokenFromReq(req));
  res.json({ enabled: auth.enabled(), configured: auth.hasAccount(), user: s ? s.sub : null, totp: s ? auth.totpEnabledFor(s.sub) : false });
});
app.post('/v2/auth/setup', (req, res) => { // first-run only: create the initial account
  if (auth.hasAccount()) return res.status(403).json({ error: 'an account already exists' });
  const b = req.body || {};
  try { auth.createAccount(b.username, b.password); res.status(201).json({ ok: true, username: b.username }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/v2/auth/login', (req, res) => {
  const b = req.body || {};
  const key = (b.username || '') + '|' + (req.ip || (req.socket && req.socket.remoteAddress) || '');
  if (auth.isLockedOut(key)) return res.status(429).json({ error: 'too many attempts — locked out, try again later' });
  if (!b.username || !b.password || !auth.verifyPassword(b.username, b.password)) { auth.recordFail(key); return res.status(401).json({ error: 'invalid credentials' }); }
  // password OK — second factor if the account has TOTP enabled (accepts a TOTP code or a recovery code)
  if (auth.totpEnabledFor(b.username)) {
    if (!b.totp) return res.status(401).json({ error: 'second factor required', totp_required: true });
    if (!auth.verifySecondFactor(b.username, b.totp)) { auth.recordFail(key); return res.status(401).json({ error: 'invalid code', totp_required: true }); }
  }
  auth.recordSuccess(key);
  res.setHeader('Set-Cookie', auth.sessionCookie(auth.issueSession(b.username), { secure: authSecureCookie() }));
  res.json({ ok: true, user: b.username });
});
app.post('/v2/auth/logout', (req, res) => { res.setHeader('Set-Cookie', auth.clearCookie()); res.json({ ok: true }); });
app.get('/v2/auth/session', (req, res) => {
  const s = auth.verifySession(auth.tokenFromReq(req));
  if (!s) return res.status(401).json({ error: 'no session' });
  res.json({ user: s.sub, totp: auth.totpEnabledFor(s.sub) });
});
// TOTP 2FA enrollment (requires a live session). setup → scan QR → enable with a code → recovery codes.
function requireSession(req, res, next) { const s = auth.verifySession(auth.tokenFromReq(req)); if (!s) return res.status(401).json({ error: 'authentication required' }); req.authUser = s.sub; next(); }
app.post('/v2/auth/totp/setup', requireSession, (req, res) => { try { res.json(auth.totpBeginEnroll(req.authUser)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/v2/auth/totp/enable', requireSession, (req, res) => { try { res.json(auth.totpConfirmEnroll(req.authUser, (req.body || {}).code)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/v2/auth/totp/disable', requireSession, (req, res) => {
  const b = req.body || {};
  if (!auth.verifyPassword(req.authUser, b.password)) return res.status(401).json({ error: 'password required to disable 2FA' });
  auth.totpDisable(req.authUser); res.json({ ok: true });
});

// External login (OIDC client, phase D) — GitHub/Google → a LINKED local account. OFF unless a provider's
// id+secret are configured. Endpoints live under the public /v2/auth/ path (login must be reachable).
const oidcClient = require('./oidc-client');
app.get('/v2/auth/external', (req, res) => {
  const s = auth.verifySession(auth.tokenFromReq(req));
  res.json({ providers: oidcClient.enabledProviders(), linked: s ? auth.listExternal(s.sub) : [] });
});
app.get('/v2/auth/external/:provider/start', (req, res) => {
  try { res.redirect(oidcClient.authorizeUrl(req.params.provider)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/v2/auth/external/:provider/callback', async (req, res) => {
  const provider = req.params.provider;
  if (!oidcClient.checkState(req.query.state)) return res.status(400).send('invalid or expired sign-in state — please try again.');
  try {
    const ident = await oidcClient.exchange(provider, req.query.code);
    if (!ident.subject) return res.status(400).send('could not resolve your ' + provider + ' identity.');
    const sess = auth.verifySession(auth.tokenFromReq(req));
    if (sess) { auth.linkExternal(sess.sub, provider, ident.subject, ident.email); return res.redirect('/settings?linked=' + provider); } // linking (already logged in)
    const username = auth.findByExternal(provider, ident.subject); // login
    if (!username) return res.status(403).send('No asmltr account is linked to this ' + provider + ' identity. Sign in with your password first, then connect ' + provider + ' under Settings → Security.');
    res.setHeader('Set-Cookie', auth.sessionCookie(auth.issueSession(username), { secure: authSecureCookie() }));
    res.redirect('/');
  } catch (e) { res.status(400).send('sign-in failed: ' + e.message); }
});
app.delete('/v2/auth/external/:provider', requireSession, (req, res) => res.json({ ok: auth.unlinkExternal(req.authUser, req.params.provider) }));

// WebAuthn passkeys — passwordless login + a strong factor (core/src/passkey.js).
const passkey = require('./passkey');
app.get('/v2/auth/passkeys', requireSession, (req, res) => res.json({ passkeys: auth.listPasskeys(req.authUser).map((c) => ({ id: c.id, name: c.name, added_at: c.added_at, last_used: c.last_used })) }));
app.post('/v2/auth/passkey/register/options', requireSession, async (req, res) => { try { res.json(await passkey.registerOptions(req.authUser, req.headers.origin)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/v2/auth/passkey/register/verify', requireSession, async (req, res) => { const b = req.body || {}; try { res.json(await passkey.registerVerify(req.authUser, b.response, req.headers.origin, b.label)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.delete('/v2/auth/passkey/:id', requireSession, (req, res) => res.json({ ok: auth.removePasskey(req.authUser, req.params.id) }));
// Passwordless login: options (by username) → the browser signs → verify → session.
app.post('/v2/auth/passkey/login/options', async (req, res) => {
  const b = req.body || {};
  const key = (b.username || '') + '|' + (req.ip || '');
  if (auth.isLockedOut(key)) return res.status(429).json({ error: 'too many attempts — locked out' });
  try { res.json(await passkey.loginOptions(b.username, req.headers.origin)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/v2/auth/passkey/login/verify', async (req, res) => {
  const b = req.body || {};
  const key = 'passkey|' + (req.ip || ''); // usernameless — the account is resolved from the credential
  if (auth.isLockedOut(key)) return res.status(429).json({ error: 'too many attempts — locked out' });
  try {
    const r = await passkey.loginVerify(b.response, req.headers.origin);
    auth.recordSuccess(key);
    res.setHeader('Set-Cookie', auth.sessionCookie(auth.issueSession(r.username), { secure: authSecureCookie() }));
    res.json({ ok: true, user: r.username });
  } catch (e) { auth.recordFail(key); res.status(401).json({ error: e.message }); }
});

// OIDC provider status + client registry (session-gated). New clients apply on the next core restart.
app.get('/v2/oidc/status', (req, res) => res.json({ enabled: oidc.enabled(), issuer: oidc.enabled() ? oidc.issuer() : null }));
app.get('/v2/oidc/clients', requireSession, (req, res) => res.json({ clients: oidc.listClients(), issuer: oidc.issuer() }));
app.post('/v2/oidc/clients', requireSession, (req, res) => { try { res.status(201).json(oidc.addClient(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); } });
app.delete('/v2/oidc/clients/:id', requireSession, (req, res) => res.json({ ok: oidc.removeClient(req.params.id) }));
// Forward-auth check for the reverse proxy (nginx auth_request). 200 = allow, 401 = redirect to login.
// When auth is DISABLED this returns 200 (break-glass: flip ASMLTR_AUTH=off + restart to unlock instantly).
app.get('/v2/auth/verify', (req, res) => {
  if (!auth.enabled()) return res.status(200).end();
  const s = auth.verifySession(auth.tokenFromReq(req));
  if (!s) return res.status(401).json({ error: 'authentication required' });
  // Optional per-resource allowlist for forward-auth (phase E): ASMLTR_AUTH_ALLOW = comma-sep usernames.
  // Empty = any authenticated session passes. Set per protected service via its own middleware if needed.
  const allow = (process.env.ASMLTR_AUTH_ALLOW || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (allow.length && !allow.includes(s.sub)) return res.status(403).json({ error: 'not authorized for this resource' });
  res.setHeader('Remote-User', s.sub); // identity header for the proxied service (forward-auth)
  res.status(200).end();
});

// Integrations — third-party service links (storage today). Secret fields are *_ref (vault key names),
// resolved from the vault only at open/test time, never returned here.
app.get('/v2/integrations', (req, res) => res.json({ integrations: integrations.list() }));
app.post('/v2/integrations', (req, res) => { try { res.status(201).json(integrations.create(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); } });
app.patch('/v2/integrations/:id', (req, res) => { const r = integrations.update(req.params.id, req.body || {}); r ? res.json(r) : res.status(404).json({ error: 'not found' }); });
app.delete('/v2/integrations/:id', (req, res) => res.json({ ok: integrations.remove(req.params.id) }));
app.post('/v2/integrations/:id/test', async (req, res) => res.json(await integrations.test(req.params.id)));

// Vault key management — metadata only (names/tiers/access counts), NEVER values. Store/delete a
// credential. Values are write-only from the GUI; retrieval is the SACRED core's job, not the UI's.
app.get('/v2/vault/secrets', async (req, res) => {
  try { res.json({ secrets: (await vault.listSecrets()) || [] }); } catch (e) { res.status(502).json({ error: e.message, secrets: [] }); }
});
app.post('/v2/vault/secrets', async (req, res) => {
  const b = req.body || {};
  if (!b.name || b.value == null) return res.status(400).json({ error: 'name + value required' });
  try { await vault.storeSecret(String(b.name), { value: String(b.value) }, { minTrust: b.min_trust || 'SACRED' }); res.json({ ok: true, name: b.name }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.delete('/v2/vault/secrets/:name', async (req, res) => {
  try { await vault.deleteSecret(req.params.name); res.json({ ok: true }); } catch (e) { res.status(502).json({ error: e.message }); }
});

// Reasoning engines — the pluggable agentic backends (claude/gemini/codex). Registry + default + per-engine
// config (shared/engines.js). Changing the default re-points the `<agent-name>` terminal alias.
const engines = require('../../shared/engines');
app.get('/v2/engines', (req, res) => res.json({ engines: engines.list(), default: engines.getDefault() }));
app.post('/v2/engines/default', (req, res) => {
  const id = (req.body || {}).id;
  try {
    engines.setDefault(id);
    try { require('../../shared/alias').provisionAlias({}); } catch (_) { /* alias refresh best-effort */ }
    res.json({ ok: true, default: engines.getDefault() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/v2/engines/:id', (req, res) => { try { res.json({ ok: true, config: engines.setConfig(req.params.id, req.body || {}) }); } catch (e) { res.status(400).json({ error: e.message }); } });
// Check for a harness update (npm view) — network call, on demand.
app.get('/v2/engines/:id/check', (req, res) => {
  const id = req.params.id; if (!engines.known(id)) return res.status(404).json({ error: 'unknown engine' });
  const installed = engines.cleanVersion(id); const latest = engines.latestVersion(id);
  res.json({ id, installed, latest, updateAvailable: engines.updateAvailable(installed, latest) });
});
// Install / update a harness from the GUI (npm i -g <pkg>@latest). Fixed package per engine (no injection).
app.post('/v2/engines/:id/install', (req, res) => {
  const id = req.params.id; const e = engines.known(id) && engines.ENGINES[id];
  if (!e || !e.pkg) return res.status(404).json({ error: 'unknown engine' });
  const r = engines.installLatest(id);
  if (r.ok) return res.json({ ok: true, id, version: r.version });
  res.status(500).json({ error: 'install failed', detail: (r.error || 'unknown').slice(-800) });
});
// Per-engine auto-update: check npm on a cadence + upgrade in place (so the harness never goes stale).
app.post('/v2/engines/:id/auto-update', (req, res) => { try { res.json({ ok: true, autoUpdate: engines.setAutoUpdate(req.params.id, !!(req.body && req.body.enabled)) }); } catch (e) { res.status(400).json({ error: e.message }); } });
// Background sweep: every 6h, update installed engines that have auto-update on + a newer version.
const _engTimer = setInterval(() => { try { const d = engines.autoUpdateAll(); if (d.length) console.log('[engines] auto-updated:', JSON.stringify(d)); } catch (_) {} }, 6 * 3600 * 1000);
if (_engTimer.unref) _engTimer.unref();
// Connection / auth per engine — subscription (OAuth, owned by the CLI) vs API-key billing.
// The key value is stored ONLY in the TRUST vault (SACRED); engines.json keeps a boolean flag.
app.post('/v2/engines/:id/auth', (req, res) => { try { res.json({ ok: true, auth: engines.setAuthMode(req.params.id, (req.body || {}).mode) }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.put('/v2/engines/:id/apikey', async (req, res) => { try { res.json({ ok: true, auth: await engines.setApiKey(req.params.id, (req.body || {}).value) }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.delete('/v2/engines/:id/apikey', async (req, res) => { try { res.json({ ok: true, auth: await engines.clearApiKey(req.params.id) }); } catch (e) { res.status(400).json({ error: e.message }); } });
// Custom (self-hosted / alternate-provider) OpenAI-compatible endpoint for a base_url-capable engine.
app.post('/v2/engines/:id/base-url', (req, res) => { try { res.json({ ok: true, baseUrl: engines.setBaseUrl(req.params.id, (req.body || {}).url) }); } catch (e) { res.status(400).json({ error: e.message }); } });

// MCP registry — declare once, provisioned into every engine (Claude SDK / Codex -c / Gemini config).
const mcpReg = require('../../shared/mcp-registry');
function resyncGeminiMcp() { try { const b = engines.resolveBin('gemini'); if (b) mcpReg.syncGemini(b); } catch (_) {} }
app.get('/v2/mcp', (req, res) => res.json({ servers: mcpReg.list() }));
app.post('/v2/mcp', (req, res) => { try { const l = mcpReg.add((req.body || {}).name, req.body || {}); resyncGeminiMcp(); res.status(201).json({ ok: true, servers: l }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.delete('/v2/mcp/:name', (req, res) => { try { res.json({ ok: true, servers: mcpReg.remove(req.params.name) }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/v2/mcp/:name/toggle', (req, res) => { try { const l = mcpReg.setDisabled(req.params.name, !!(req.body && req.body.disabled)); resyncGeminiMcp(); res.json({ ok: true, servers: l }); } catch (e) { res.status(400).json({ error: e.message }); } });

// Data silos — the file-explorer surface over shared/silo.js (`:id` = silo id; `self`/omitted → the Self silo).
// Read verbs (list/overview/ls/tree/find/file) + safe writes (mkdir/put/mv/rm/new). Paths are silo-relative.
function openSilo(id) { return (!id || id === 'self') ? silo.ensureSelf(identity.name()) : silo.open(id); }
app.get('/v2/silos', (req, res) => res.json({
  silos: silo.list(),
  templates: Object.entries(silo.TEMPLATES).map(([id, t]) => ({ id, desc: t.desc, folders: t.folders })),
}));
app.post('/v2/silos', (req, res) => {
  const b = req.body || {};
  try { const s = silo.create({ id: b.id, name: b.name, type: b.type || 'generic' }); res.status(201).json({ ok: true, id: b.id, dir: s.dir }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/v2/silos/:id', (req, res) => { try { res.json({ ok: true, manifest: openSilo(req.params.id).setManifest(req.body || {}) }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.delete('/v2/silos/:id', (req, res) => {
  if (req.params.id === 'self') return res.status(400).json({ error: 'the Self silo cannot be deleted' });
  try { res.json({ ok: silo.remove(req.params.id) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/v2/silos/:id/overview', async (req, res) => { try { res.json(await openSilo(req.params.id).overview()); } catch (e) { res.status(404).json({ error: e.message }); } });
app.get('/v2/silos/:id/ls', async (req, res) => { try { res.json({ entries: await openSilo(req.params.id).ls(req.query.path || '') }); } catch (e) { res.status(404).json({ error: e.message }); } });
app.get('/v2/silos/:id/tree', async (req, res) => { try { res.json({ entries: await openSilo(req.params.id).tree(req.query.path || '', req.query.depth ? +req.query.depth : Infinity) }); } catch (e) { res.status(404).json({ error: e.message }); } });
app.get('/v2/silos/:id/find', async (req, res) => {
  try { const q = req.query; res.json({ results: await openSilo(req.params.id).find(q.q || '', { in: q.in, type: q.type, since: q.since, content: q.content === '1' || q.content === 'true' }) }); }
  catch (e) { res.status(404).json({ error: e.message }); }
});
app.get('/v2/silos/:id/file', async (req, res) => {
  try {
    const s = openSilo(req.params.id); const p = req.query.path;
    if (!p) return res.status(400).json({ error: 'path required' });
    const st = await s.stat(p); const buf = await s.get(p);
    const isText = !buf.includes(0) && buf.length <= (512 << 10); // no NUL byte + ≤512KB → previewable text
    res.json({ path: p, size: st ? st.size : buf.length, mtime: st && st.mtime, binary: !isText, content: isText ? buf.toString('utf8') : null });
  } catch (e) { res.status(404).json({ error: e.message }); }
});
app.post('/v2/silos/:id/file', async (req, res) => { // write/upload: { path, content? | data_base64? }
  try { const b = req.body || {}; if (!b.path) return res.status(400).json({ error: 'path required' });
    const data = b.data_base64 ? Buffer.from(b.data_base64, 'base64') : Buffer.from(b.content || '', 'utf8');
    res.json({ ok: true, ...(await openSilo(req.params.id).put(b.path, data)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/v2/silos/:id/mkdir', async (req, res) => { try { await openSilo(req.params.id).mkdir((req.body || {}).path); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/v2/silos/:id/mv', async (req, res) => { try { const b = req.body || {}; await openSilo(req.params.id).mv(b.from, b.to); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.delete('/v2/silos/:id/file', async (req, res) => { try { await openSilo(req.params.id).rm(req.query.path); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });

// Backups — encrypted, restorable snapshots (scripts/backup.js). Passphrase comes from the request or the
// core env (ASMLTR_BACKUP_PASSPHRASE / vault password); restore stays CLI-only (a deliberate footgun guard).
const backup = require('../../scripts/backup');
app.get('/v2/backups', async (req, res) => {
  try {
    const out = { backups: backup.listBackups(), dir: backup.BACKUP_DIR, schedule: backup.getSchedule() };
    if (req.query.destination && req.query.destination !== 'local') out.remote = await backup.listRemoteBackups(req.query.destination).catch((e) => ({ error: e.message }));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/v2/backups', async (req, res) => {
  const b = req.body || {};
  try { const r = await backup.createBackup({ label: b.label || 'manual', passphrase: b.passphrase, destination: b.destination }); res.status(201).json({ ok: true, file: r.file, bytes: r.bytes, remote: r.remote, manifest: r.manifest }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/v2/backups/verify', async (req, res) => {
  const b = req.body || {};
  try { const r = await backup.verifyBackup(b.file, { passphrase: b.passphrase }); res.json(r); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/v2/backups/schedule', (req, res) => res.json(backup.getSchedule()));
app.put('/v2/backups/schedule', (req, res) => {
  const b = req.body || {};
  const clean = {};
  for (const k of ['enabled', 'every_hours', 'destination', 'max_count', 'max_age_days']) if (k in b) clean[k] = b[k];
  try { res.json(backup.setSchedule(clean)); } catch (e) { res.status(400).json({ error: e.message }); }
});
// In-process scheduler — fires runScheduled() when the interval elapses (needs a configured passphrase).
try { backup.startScheduler({ log: (m) => console.log('[backup] ' + m) }); } catch (e) { console.log('[backup] scheduler not started: ' + e.message); }

// ── Guarded GUI restore (destructive → preview first, then a DETACHED runner that survives the core
//    restart the restore triggers). The footgun guard is procedural: a mandatory dry-run preview + an
//    explicit confirm flag (the GUI additionally makes the operator type the backup name).
const _bkpath = require('path');
const RESTORE_LOG = () => _bkpath.join(backup.BACKUP_DIR, 'restore.log');
// Preview: decrypt + verify checksums + list what WOULD be restored. No writes (dryRun). Safe.
app.post('/v2/backups/restore/preview', async (req, res) => {
  const b = req.body || {};
  if (!b.file) return res.status(400).json({ error: 'file required' });
  const logs = [];
  try { const r = await backup.restoreBackup(b.file, { dryRun: true, passphrase: b.passphrase, log: (m) => logs.push(m) });
    res.json({ ok: true, manifest: r.manifest, plan: r.plan, logs }); }
  catch (e) { res.status(400).json({ error: e.message, logs }); }
});
// Restore: spawn a DETACHED node process (survives `pm2 restart asmltr-core` in --activate). Passphrase
// goes via env (never argv/ps). Requires confirm:true. Progress streams to BACKUP_DIR/restore.log.
app.post('/v2/backups/restore', (req, res) => {
  const b = req.body || {};
  if (!b.file) return res.status(400).json({ error: 'file required' });
  if (b.confirm !== true) return res.status(400).json({ error: 'confirm:true required (restore overwrites config + databases)' });
  try { require('fs').accessSync(b.file); } catch (_) { return res.status(404).json({ error: 'backup file not found: ' + b.file }); }
  const { spawn } = require('child_process');
  const log = RESTORE_LOG();
  const args = [_bkpath.join(__dirname, '..', '..', 'scripts', 'backup.js'), 'restore', b.file, '--activate'];
  if (b.force) args.push('--force');
  const env = { ...process.env };
  if (b.passphrase) env.ASMLTR_BACKUP_PASSPHRASE = String(b.passphrase);
  try { require('fs').writeFileSync(log, `[${new Date().toISOString()}] restore starting: ${b.file}\n`); } catch (_) {}
  const child = spawn('setsid', ['bash', '-c', `sleep 1; { "${process.execPath}" ${args.map((a) => `"${a}"`).join(' ')}; echo "[$(date)] restore-runner exited $?"; } >> "${log}" 2>&1`], { detached: true, stdio: 'ignore', env });
  child.unref();
  res.json({ started: true, pid: child.pid || null, log });
});
// Poll the restore log (GUI progress). Returns the tail of BACKUP_DIR/restore.log.
app.get('/v2/backups/restore/log', (req, res) => {
  try { const txt = require('fs').readFileSync(RESTORE_LOG(), 'utf8'); res.json({ log: txt.slice(-8000) }); }
  catch (_) { res.json({ log: '' }); }
});
// Import a backup file uploaded from the browser (raw octet-stream → bypasses the 10mb JSON cap). The
// filename comes via a header; we sanitize it and drop it into BACKUP_DIR so it shows up in the list.
app.post('/v2/backups/import', express.raw({ type: 'application/octet-stream', limit: '1024mb' }), (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty body' });
    let name = (req.get('X-Backup-Filename') || 'imported.asmltrbk').replace(/[^A-Za-z0-9._-]/g, '_');
    if (!name.endsWith('.asmltrbk')) name += '.asmltrbk';
    require('fs').mkdirSync(backup.BACKUP_DIR, { recursive: true });
    const dest = _bkpath.join(backup.BACKUP_DIR, name);
    require('fs').writeFileSync(dest, req.body);
    res.json({ ok: true, file: dest, name, bytes: req.body.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The dashboard is a browser CONNECTOR: it posts `assistant-web` envelopes but must not
// hardcode who the operator is (the repo is generic). Resolve the sender identity server-side
// from config or the reverse proxy's resolved user, so the same build works anywhere.
// The browser sends a placeholder sender; we overwrite raw_id with the real owner here.
function normalizeWebSender(req) {
  const b = req.body;
  if (!b || (b.channel !== 'assistant-web' && b.channel !== 'eve-assistant-web')) return; // accept legacy id
  const owner = process.env.ASMLTR_WEB_OWNER_ID || req.get('X-Remote-User');
  if (owner) b.sender = { ...(b.sender || {}), raw_id: String(owner), raw_username: (b.sender && b.sender.raw_username) || 'dashboard' };
}

// Attach a browser-uploaded file to the shared upload surface (Phase B of the web chat). Body is
// JSON { channel, filename, mime, conversation_key?, data_base64 } — base64 keeps it within the
// existing express.json body (no multipart dep). Returns the manifest record incl. absolute path,
// which the chat composer then references in the next message so the agent can Read it.
app.post('/v2/upload', (req, res) => {
  try {
    const { filename, mime, conversation_key, data_base64 } = req.body || {};
    if (!data_base64 || typeof data_base64 !== 'string') return res.status(400).json({ error: 'data_base64 required' });
    const buffer = Buffer.from(data_base64, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'empty file' });
    const owner = process.env.ASMLTR_WEB_OWNER_ID || req.get('X-Remote-User') || 'dashboard';
    const rec = require('../../shared/uploads').save({
      channel: 'assistant-web', buffer, filename, mime,
      sender: 'dashboard', senderId: String(owner), conversationKey: conversation_key || null,
      kind: /^image\//.test(mime || '') ? 'image' : 'document',
    });
    record({ surface: 'assistant-web', session_id: conversation_key || null, event_type: 'control',
      identity: String(owner), source: 'core', payload: { action: 'upload', name: rec.filename, path: rec.path, bytes: buffer.length } });
    res.json({ ok: true, file: { path: rec.path, name: rec.filename, mime: rec.mime || mime || null, kind: rec.kind, bytes: buffer.length } });
  } catch (err) {
    console.error('[core] /v2/upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Streaming turn: same pipeline as /v2/handle, but assistant text is streamed as it's produced.
// SSE frames: {type:'delta', text} … then {type:'done', actions}. Deltas are redacted in-flight.
app.post('/v2/stream', async (req, res) => {
  normalizeWebSender(req);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const frame = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (_) {} };
  try {
    const actions = await dispatch(req.body, {
      onText: (text) => { if (text) frame({ type: 'delta', text }); },            // token stream (voice/openai)
      onSegment: (text) => { if (text) frame({ type: 'segment', text }); },        // completed narration block (step consumers)
      onTool: (t) => { if (t && t.name) frame({ type: 'tool', name: t.name }); },  // a tool call as it happens
      onThinking: (text) => { if (text) frame({ type: 'thinking', text }); },      // a completed thinking block
    });
    frame({ type: 'done', actions });
  } catch (err) {
    console.error('[core] /v2/stream error:', err.message);
    frame({ type: 'error', error: err.message });
  }
  res.end();
});

// Streaming VOICE turn: same pipeline as /v2/stream, but the reply is spoken. The core speech layer
// (shared/speech) buffers the live token stream to sentence boundaries and runs each through TTS as
// it completes, so audio starts on the FIRST sentence — including the agent's intermediary narration
// (it rides the same token stream). SSE frames interleave transcript + ordered audio clips:
//   {type:'text', seq, text}        a sentence, as it's queued for speech (for a live transcript)
//   {type:'audio', seq, mime, b64}  that sentence's audio clip, emitted in order (play sequentially)
//   {type:'done', actions}          turn complete (sent only after all audio has been flushed)
app.post('/v2/speak', async (req, res) => {
  normalizeWebSender(req);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const frame = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (_) {} };
  const wantAck = req.body && req.body.voice && req.body.voice.ack != null ? !!req.body.voice.ack : voice.isAckEnabled();

  // Immediate feedback so the agent's think-time isn't dead air: chime (instant), then the ambient
  // drone loops until the first real sentence lands. The client plays the cue assets it fetches.
  frame({ type: 'cue', cue: 'chime' });
  frame({ type: 'cue', cue: 'drone-start' });
  if (wantAck) { try { const a = await voice.getAckClip(); frame({ type: 'audio', role: 'ack', mime: a.mime, b64: a.audio.toString('base64'), text: a.phrase }); } catch (e) { console.error('[core] ack tts:', e.message); } }

  let droneStopped = false;
  const stopDrone = () => { if (!droneStopped) { droneStopped = true; frame({ type: 'cue', cue: 'drone-stop' }); } };
  const speaker = createSpeaker({
    onText: (p) => frame({ type: 'text', seq: p.seq, text: p.text }),
    onAudio: (clip) => {
      stopDrone(); // first real reply audio → cut the ambient bed
      if (clip.error) frame({ type: 'audio-error', seq: clip.seq, error: clip.error, text: clip.text });
      else frame({ type: 'audio', seq: clip.seq, role: 'reply', mime: clip.mime, b64: clip.audio.toString('base64') });
    },
  });
  try {
    const actions = await dispatch(req.body, { onText: (text) => { if (text) speaker.pushDelta(text); } });
    await speaker.finish();               // wait for every sentence's audio to be emitted, in order
    stopDrone();                          // no-audio replies (e.g. NO_REPLY) still end the drone
    frame({ type: 'done', actions });
  } catch (err) {
    console.error('[core] /v2/speak error:', err.message);
    try { await speaker.finish(); } catch (_) {}
    stopDrone();
    frame({ type: 'error', error: err.message });
  }
  res.end();
});

// Voice settings + cue assets (chime/drone) for any voice client. The spoken-ack toggle persists
// in the asmltr state dir; the dashboard flips it here.
app.get('/v2/voice/ack', (req, res) => res.json({ enabled: voice.isAckEnabled() }));
app.post('/v2/voice/ack', (req, res) => res.json({ enabled: voice.setAckEnabled(!!(req.body && req.body.enabled)) }));
app.get('/v2/voice/asset/:name', (req, res) => {
  const a = voice.asset(req.params.name);
  if (!a) return res.status(404).json({ error: 'unknown asset' });
  res.set('Content-Type', a.mime); res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(a.path);
});

// TTS + STT model/voice config (persisted; applies to the next clip, no restart). The key names are
// intentionally NOT returned. POST body: { tts?: {voice,model,provider,format}, stt?: {model,language} }.
app.get('/v2/voice/config', (req, res) => {
  const { keyName: _t, ...ttsCfg } = tts.config();
  const { keyName: _s, ...sttCfg } = stt.config();
  res.json({ tts: ttsCfg, stt: sttCfg });
});
app.post('/v2/voice/config', (req, res) => {
  const b = req.body || {};
  const ttsCfg = b.tts ? tts.setConfig(b.tts) : tts.config();
  const sttCfg = b.stt ? stt.setConfig(b.stt) : stt.config();
  const { keyName: _t, ...t } = ttsCfg; const { keyName: _s, ...s } = sttCfg;
  res.json({ tts: t, stt: s });
});

// Synthesize arbitrary text → one audio clip, WITHOUT running an agent turn (that's what /v2/speak
// does). This is the "read this reply aloud" primitive for the chat's TTS toggle. Uses the configured
// voice/model (overridable per call). Returns base64 so the browser can decode+play. Body: { text, voice?, model? }.
app.post('/v2/tts', async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'no text' });
    const overrides = {};
    if (req.body.voice) overrides.voice = String(req.body.voice);
    if (req.body.model) overrides.model = String(req.body.model);
    const { audio, mime } = await tts.synthesize(text.slice(0, 4000), overrides);
    res.json({ mime, b64: audio.toString('base64') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve a local artifact the agent created, for download through the dashboard chat. Guarded by
// a reverse proxy (owner-only auth) in front of the /v2 proxy + localhost-only core. `?stat=1` returns metadata
// (the chat uses it to decide whether to show a download chip); otherwise streams as an attachment.
app.get('/v2/file', (req, res) => {
  const fs = require('fs'), path = require('path'), os = require('os');
  const isStat = !!req.query.stat;
  const miss = (code, err) => (isStat ? res.json({ exists: false }) : res.status(code).json({ error: err }));
  try {
    let p = String(req.query.path || '');
    if (!p) return res.status(400).json({ error: 'path required' });
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    if (!path.isAbsolute(p)) return miss(400, 'path must be absolute');
    let real, st;
    try { real = fs.realpathSync(p); st = fs.statSync(real); } catch (_) { return miss(404, 'not found'); }
    if (!st.isFile()) return miss(400, 'not a file');
    const name = path.basename(real);
    if (isStat) return res.json({ exists: true, name, size: st.size });
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/["\\]/g, '')}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(st.size));
    fs.createReadStream(real).on('error', () => { try { res.destroy(); } catch (_) {} }).pipe(res);
  } catch (e) { return miss(500, e.message); }
});

// Realtime STT — mint a short-lived ephemeral token for a streaming transcription session with
// server-side VAD. The browser connects to OpenAI directly (WebRTC) with this token; the real key
// never leaves the host. Body: { model? }.
app.post('/v2/realtime/transcribe-token', async (req, res) => {
  try { res.json(await stt.realtimeToken({ model: req.body && req.body.model })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Transcription — audio clip → text via a real STT model (default OpenAI gpt-4o-transcribe). Body is
// JSON base64 (no multipart dep, mirrors /v2/upload): { data_base64, mime?, filename?, model?, language? }.
app.post('/v2/transcribe', async (req, res) => {
  try {
    const { data_base64, mime, filename, model, language } = req.body || {};
    if (!data_base64) return res.status(400).json({ error: 'no audio (data_base64 required)' });
    const buf = Buffer.from(data_base64, 'base64');
    if (!buf.length) return res.status(400).json({ error: 'empty audio' });
    const out = await stt.transcribe(buf, { filename: filename || 'audio.webm', mime: mime || 'audio/webm', model, language });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Agent runtime settings — the SDK version (installed vs latest-on-npm) that gates model availability,
// the model selection (applies next turn, no restart), the last-resolved model id, and SDK auto-update.
app.get('/v2/runtime', async (req, res) => {
  const s = await runtime.status({ fetch: req.query.fetch !== '0' });
  s.model.resolved = getLastModel();
  res.json(s);
});
app.post('/v2/runtime/model', (req, res) => res.json({ model: runtime.setModel(req.body && req.body.model) }));
app.post('/v2/runtime/auto-update', (req, res) => res.json({ autoUpdate: runtime.setSdkAutoUpdate(!!(req.body && req.body.enabled)) }));
// Permission mode for interactive `asmltr claude` sessions. Body: { enabled } (toggle → bypassPermissions|default)
// or { mode } (explicit: default|acceptEdits|bypassPermissions|plan). Applies to the NEXT `asmltr claude` launch.
app.post('/v2/runtime/cli-permission-mode', (req, res) => {
  const b = req.body || {};
  const m = runtime.setCliPermissionMode(b.mode || (b.enabled ? 'bypassPermissions' : 'default'));
  res.json({ cliPermissionMode: m, cliBypass: m === 'bypassPermissions' });
});
app.post('/v2/runtime/update', (req, res) => {
  const r = runtime.updateSdk();
  record({ surface: 'core', session_id: null, event_type: 'control', identity: (req.body && req.body.by) || 'operator', source: 'core', payload: { action: 'sdk-update-started', pid: r.pid } });
  res.json({ ok: true, ...r });
});

// Identity (the Likeness "Self"): the name (ASSISTANT_NAME) + editable self-description, and a live
// preview of the anchor injected into EVERY session's system prompt. The GUI edits it here.
function identitySnapshot() {
  return { name: identity.name(), self_description: identity.identityFile(), preferences: identity.getFacet('preferences'), story: identity.getFacet('story'), aesthetic: identity.getFacet('aesthetic'), palette: identity.getFacet('palette'), preamble: identity.fullIdentity() };
}
app.get('/v2/identity', (req, res) => res.json(identitySnapshot()));
app.post('/v2/identity', (req, res) => {
  const b = req.body || {};
  if (b.name != null && !identity.setName(b.name)) return res.status(500).json({ error: 'could not write name' });
  if (b.self_description != null && !identity.setIdentity(b.self_description)) return res.status(500).json({ error: 'could not write identity file' });
  if (b.preferences != null && !identity.setFacet('preferences', b.preferences)) return res.status(500).json({ error: 'could not write preferences' });
  if (b.story != null && !identity.setFacet('story', b.story)) return res.status(500).json({ error: 'could not write story' });
  if (b.aesthetic != null && !identity.setFacet('aesthetic', b.aesthetic)) return res.status(500).json({ error: 'could not write aesthetic' });
  if (b.palette != null && !identity.setFacet('palette', b.palette)) return res.status(500).json({ error: 'could not write palette' });
  res.json({ ok: true, ...identitySnapshot() });
});

// Periodic SDK freshness check — an old SDK silently caps the model, so watch for a newer one.
// Auto-update + restart if enabled; otherwise emit a one-time notification so the dashboard can nudge.
let _lastSdkNotified = null;
async function checkSdkFreshness() {
  try {
    const s = await runtime.status({ fetch: true });
    if (!s.sdk.updateAvailable) return;
    if (runtime.isSdkAutoUpdate()) {
      record({ surface: 'core', session_id: null, event_type: 'control', identity: 'system', source: 'core', payload: { action: 'sdk-auto-update', from: s.sdk.installed, to: s.sdk.latest } });
      runtime.updateSdk();
    } else if (_lastSdkNotified !== s.sdk.latest) {
      _lastSdkNotified = s.sdk.latest;
      record({ surface: 'core', session_id: null, event_type: 'notification', identity: 'system', source: 'core',
        payload: { kind: 'sdk-update', title: 'Agent SDK update available', body: `${s.sdk.installed} → ${s.sdk.latest} — update to keep the model current.` } });
    }
  } catch (_) {}
}
setTimeout(checkSdkFreshness, 30000); // once shortly after boot
setInterval(checkSdkFreshness, 6 * 3600 * 1000); // every 6h

// --- DRAFTS (hold-for-approval queue, any connector) -------------------------
app.get('/v2/drafts', (req, res) => {
  const status = req.query.status || 'pending';
  res.json({ drafts: drafts.list({ status: status === 'all' ? null : status, channel: req.query.channel || null, limit: Number(req.query.limit) || 50 }), pending: drafts.pendingCount() });
});
app.get('/v2/drafts/:id', (req, res) => {
  const d = drafts.get(Number(req.params.id));
  return d ? res.json(d) : res.status(404).json({ error: 'unknown draft' });
});
app.post('/v2/drafts/:id/approve', async (req, res) => {
  const d = drafts.get(Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'unknown draft' });
  if (d.status !== 'pending') return res.status(409).json({ error: `draft is already ${d.status}` });
  if (!d.instance_id || !d.recipient) return res.status(422).json({ error: 'draft has no delivery route (instance_id/recipient)' });
  try {
    await deliverOut({ instanceId: d.instance_id, target: d.recipient, text: d.body, files: d.attachments, subject: d.subject, ref: d.conversation_key });
    drafts.setStatus(d.id, 'sent');
    record({ surface: d.channel, session_id: d.conversation_key, event_type: 'outbound', identity: 'operator', source: 'core', payload: { text: truncate(d.body, 500), approved_draft: d.id } });
    res.json({ ok: true, sent: d.id });
  } catch (e) { res.status(502).json({ error: 'delivery failed: ' + e.message }); }
});
app.post('/v2/drafts/:id/discard', (req, res) => {
  const ok = drafts.setStatus(Number(req.params.id), 'discarded');
  return ok ? res.json({ ok: true, discarded: Number(req.params.id) }) : res.status(409).json({ error: 'draft not pending or unknown' });
});

app.post('/v2/handle', async (req, res) => {
  try {
    const actions = await dispatch(req.body);
    res.json({ actions });
  } catch (err) {
    console.error('[core] /v2/handle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Back-compat shim — accepts the legacy /query request shape so unmigrated
// clients keep working. Maps the old sessionId to a conversation_key.
// NOTE (Phase 1): parity vs the old proxy (incl. system-prompt-wrapped messages)
// is verified by replaying recorded query-logs before any channel cuts over.
app.post('/query', async (req, res) => {
  const { message, sessionId, userId, username, platform, apiKey } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message required' });
  const conversation_key = sessionId || `shim:${platform || 'core'}:${randomUUID()}`;
  try {
    const actions = await dispatch({
      channel: platform || 'core',
      conversation_key,
      sender: { raw_id: userId || username || 'unknown', raw_username: username, api_key: apiKey },
      content: { text: message },
      delivery: 'sync',
    });
    const reply = actions.find((a) => a.type === 'reply');
    res.json({ response: reply ? reply.text : '', sessionId: conversation_key });
  } catch (err) {
    console.error('[core] /query error:', err.message);
    res.status(500).json({ error: 'asmltr-core error', details: err.message, sessionId: conversation_key });
  }
});

// Live telemetry feed (dashboard + asmltr CLI).
app.get('/events/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(`data: ${JSON.stringify({ type: 'connected', ts: Date.now() })}\n\n`);
  const onEvent = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
  bus.on('event', onEvent);
  req.on('close', () => bus.off('event', onEvent));
});

// --- takeover primitive (plan §B6): claim/release a conversation session so the
//     terminal (or dashboard) can resume it in tmux while the channel pauses. ---
app.get('/v2/session/:key', (req, res) => {
  const row = sessions.get(req.params.key);
  if (!row) return res.status(404).json({ error: 'unknown session' });
  res.json(row);
});

app.post('/v2/claim', (req, res) => {
  const { conversation_key, by } = req.body || {};
  const row = sessions.get(conversation_key);
  if (!row) return res.status(404).json({ error: 'unknown session' });
  if (!row.engine_session_id) return res.status(409).json({ error: 'session has no engine id yet (no turns run)' });
  // Mark claimed; the per-key lock means no NEW channel turn starts while claimed.
  sessions.setClaim(conversation_key, 'terminal-claimed', by || 'terminal');
  record({ surface: row.channel, session_id: conversation_key, event_type: 'control',
    identity: by || 'terminal', source: 'core', payload: { action: 'claim', by } });
  res.json({ conversation_key, engine_session_id: row.engine_session_id, working_dir: row.working_dir || process.cwd(), claim_state: 'terminal-claimed' });
});

// Real-time stop: abort the in-flight turn (the session survives + is resumable).
// Generate a short session title from conversation text (cheap, fast, no-tools SDK call).
// Serialized behind a small limiter by the caller (the collector); one at a time here is fine.
let _titleBusy = false;
app.post('/v2/title', async (req, res) => {
  const text = req.body && req.body.text;
  if (!text) return res.status(400).json({ error: 'need text' });
  if (_titleBusy) return res.status(429).json({ error: 'busy' });
  _titleBusy = true;
  try {
    const title = await generateTitle(text);
    res.json({ ok: true, title });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { _titleBusy = false; }
});

// Live "what is this session doing right now" rollup — the rolling counterpart to /v2/title.
let _statusBusy = false;
app.post('/v2/status', async (req, res) => {
  const text = req.body && req.body.text;
  if (!text) return res.status(400).json({ error: 'need text' });
  if (_statusBusy) return res.status(429).json({ error: 'busy' });
  _statusBusy = true;
  try {
    const status = await generateStatus(text);
    res.json({ ok: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { _statusBusy = false; }
});

// Proprioception's considered voice (Phase 1b) — the collector sends a digest of the current body
// (all parts + structural links, enumerated [n]); this deduces the goal/threads/flags/relations and
// returns them. Non-influential: a mirror, never instructs a part. Serialized like title/status.
let _assessBusy = false;
app.post('/v2/self-assessment', async (req, res) => {
  const digest = req.body && req.body.digest;
  if (!digest) return res.status(400).json({ error: 'need digest' });
  if (_assessBusy) return res.status(429).json({ error: 'busy' });
  _assessBusy = true;
  try {
    const assessment = await generateSelfAssessment(digest);
    res.json({ ok: true, assessment });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { _assessBusy = false; }
});

// Forget a session — delete its engine mapping so the NEXT inbound on this conversation_key starts
// a FRESH session (new history), abort any in-flight turn, and drop its buffered observed context.
// The dashboard "delete session" button calls this (the collector purges its own row + events).
app.post('/v2/session/forget', (req, res) => {
  const key = req.body && req.body.conversation_key;
  if (!key) return res.status(400).json({ error: 'conversation_key required' });
  const ac = inFlight.get(key); if (ac) { try { ac.abort(); } catch (_) {} }
  observed.delete(key);
  const existed = sessions.remove(key);
  record({ surface: String(key).split(':')[0] || 'core', session_id: key, event_type: 'control',
    source: 'core', payload: { action: 'forgotten', by: (req.body && req.body.by) || 'dashboard' } });
  res.json({ ok: true, existed });
});

// --- self-update ------------------------------------------------------------
app.get('/v2/update/status', async (req, res) => res.json(await selfUpdate.getUpdateStatus({ fetch: req.query.fetch !== '0', channel: req.query.channel })));
app.get('/v2/update/auto', (req, res) => res.json({ auto: selfUpdate.isAutoUpdate() }));
app.post('/v2/update/auto', (req, res) => res.json({ auto: selfUpdate.setAutoUpdate(!!(req.body && req.body.enabled)) }));
// Release channel: stable (newest release tag) vs edge (origin/main).
// Live progress of a running/last update — read from the status FILE the updater writes, so it
// survives the mid-update service restart that drops the event stream. The GUI polls this; the TUI
// reads the file directly. { state: idle|running|success|rolled-back|up-to-date|managed|failed, phase, log[], … }.
app.get('/v2/update/progress', (req, res) => {
  try {
    const fsm = require('fs'), osm = require('os'), pth = require('path');
    const f = process.env.ASMLTR_UPDATE_STATUS || pth.join(osm.homedir(), '.asmltr', 'update-status.json');
    const s = JSON.parse(fsm.readFileSync(f, 'utf8'));
    // A 'running' status that hasn't updated in >6 min (and whose pid is gone) is stale — the updater died.
    if (s.state === 'running' && Date.now() - (s.updated_at || 0) > 6 * 60 * 1000) s.stale = true;
    res.json(s);
  } catch (_) { res.json({ state: 'idle' }); }
});
app.get('/v2/update/channel', (req, res) => res.json({ channel: selfUpdate.getChannel() }));
app.post('/v2/update/channel', (req, res) => { try { res.json({ channel: selfUpdate.setChannel(req.body && req.body.channel) }); } catch (e) { res.status(400).json({ error: e.message }); } });
// Kick off a self-update: spawns the DETACHED DETERMINISTIC updater (scripts/update.js) — scripted,
// verified, auto-rollback. `?mode=agent` runs the LLM update session instead (escape hatch). Returns
// immediately; progress streams to the dashboard under the self-update session.
app.post('/v2/update/run', (req, res) => {
  try {
    const mode = (req.query.mode === 'agent') ? 'agent' : 'deterministic';
    const r = selfUpdate.spawnUpdateSession({ by: (req.body && req.body.by) || 'operator', mode });
    if (r.managed) return res.json({ ok: false, managed: true, manager: r.manager, message: `updates are managed by ${r.manager}; not updating in place` });
    record({ surface: 'core', session_id: 'self-update', event_type: 'control', identity: (req.body && req.body.by) || 'operator', source: 'core', payload: { action: 'self-update-started', pid: r.pid, mode } });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cross-session announcement mailbox: post an awareness note delivered into other sessions'
// context on their next turn. { text, target?, priority?, from?, ttl? (seconds) }
app.post('/v2/announce', (req, res) => {
  const { text, target, priority, from, ttl } = req.body || {};
  if (!text) return res.status(400).json({ error: 'need text' });
  const r = sessions.addAnnouncement({ text: String(text), target: target || '*', priority, from_session: from || null, ttlSec: ttl ? Number(ttl) : null });
  record({ surface: 'core', session_id: null, event_type: 'control', identity: from || 'operator', source: 'core',
    payload: { action: 'announce', id: r.id, target: target || '*', priority: priority || 'normal', text: truncate(text, 200) } });
  res.json({ ok: true, id: r.id, created_at: r.created_at, target: target || '*' });
});
app.get('/v2/announcements', (req, res) => res.json({ announcements: sessions.listAnnouncements() }));

// Cross-channel SEND with ASSIMILATION. An agent working in ANY session posts a message into another
// channel, AND the destination session folds it into its own context as its OWN prior output — so it
// doesn't look foreign on the next read there (the multi-session identity fix). Delivers via the
// manager's unified /send (which returns the destination conversation_key from the connector).
// Body: { channel|instance_id, target, text, kind?, path?, caption?, subject?, from_session? }.
app.post('/v2/send', async (req, res) => {
  try {
    const b = req.body || {};
    if ((!b.channel && !b.instance_id) || !b.target) return res.status(400).json({ error: 'need channel|instance_id + target' });
    const mgr = (process.env.ASMLTR_MANAGER_URL || 'http://127.0.0.1:3024').replace(/\/$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.ASMLTR_MANAGER_TOKEN) headers.Authorization = 'Bearer ' + process.env.ASMLTR_MANAGER_TOKEN;
    const r = await fetch(`${mgr}/send`, { method: 'POST', headers, body: JSON.stringify(b) });
    const j = await r.json().catch(() => ({}));
    const key = j && j.conversation_key;
    // Assimilate a TEXT post into the destination session (skip if it IS the sending session).
    let assimilated = false;
    if (r.ok && b.text && String(b.text).trim() && key && key !== b.from_session) {
      pushSelfSent(key, b.text, b.from_session || null);
      assimilated = true;
      record({ surface: 'core', session_id: key, event_type: 'control', identity: 'assistant', source: 'core',
        payload: { action: 'self-sent-assimilated', from: b.from_session || null, chars: String(b.text).length } });
    }
    res.status(r.ok ? 200 : 502).json({ ...j, assimilated });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/v2/abort', (req, res) => {
  const key = req.body && req.body.conversation_key;
  // The self-update session is a SEPARATE process (not core inFlight) — stop it via its kill file,
  // which it polls between steps. Lets the existing overlay Stop button abort the update too.
  if (typeof key === 'string' && key.startsWith('self-update')) {
    try {
      const os = require('os'), fsm = require('fs'), pth = require('path');
      const f = pth.join(os.homedir(), '.asmltr', 'self-update.kill');
      fsm.mkdirSync(pth.dirname(f), { recursive: true }); fsm.writeFileSync(f, 'kill ' + Date.now());
    } catch (_) {}
    record({ surface: 'core', session_id: key, event_type: 'control', identity: 'operator', source: 'core', payload: { action: 'abort-self-update' } });
    return res.json({ ok: true, aborted: key, via: 'kill-file' });
  }
  const ctrl = inFlight.get(key);
  if (!ctrl) return res.status(404).json({ ok: false, error: 'no in-flight turn for that conversation' });
  ctrl.abort();
  record({ surface: 'core', session_id: key, event_type: 'control', identity: 'operator', source: 'core', payload: { action: 'abort' } });
  res.json({ ok: true, aborted: key });
});

// Operator STEER: inject a message into a live session — resume it with the operator's text, then
// route the reply back to the origin channel via the manager's /send (works for ANY connector,
// since /send is unified). Stops any in-flight turn first (steer replaces the current generation).
// Bypasses moderation (the operator is trusted). Redacts on the way out like any public reply.
app.post('/v2/inject', (req, res) => {
  const { conversation_key: key, text, by, interrupt } = req.body || {};
  if (!key || !text) return res.status(400).json({ error: 'need conversation_key + text' });
  // MESH STEER (`by: "mesh:<label>"`) = one SESSION steering another. Unlike the advisory `announce`
  // mailbox (a note the peer sees next turn and decides whether to act on), a steer is COERCIVE — it
  // pushes into a live turn. It's OFF by default; the operator opts in per instance with
  // ASMLTR_MESH_STEER=on. Operator/dashboard steers (any other `by`) are always allowed.
  const meshSteer = typeof by === 'string' && by.startsWith('mesh:');
  if (meshSteer && !/^(1|on|true|yes)$/i.test(process.env.ASMLTR_MESH_STEER || '')) {
    return res.status(403).json({ error: 'mesh steer is disabled on this instance (set ASMLTR_MESH_STEER=on to allow session-to-session steering)' });
  }
  const row = sessions.get(key);
  if (!row) return res.status(404).json({ error: 'unknown session' });
  // A steer QUEUES behind any in-flight turn (withKeyLock serializes per key) so the current
  // work finishes and the steer CONTINUES it — you don't lose in-progress research and the model
  // treats the text as guidance, not a fresh question. `interrupt:true` aborts the running turn
  // first (redirect immediately, abandoning the current turn).
  const wasRunning = inFlight.has(key);
  if (interrupt && wasRunning) { try { inFlight.get(key).abort(); } catch (_) {} }

  withKeyLock(key, async () => {
    record({ surface: row.channel, session_id: key, event_type: 'control', identity: by || 'operator', source: 'core', payload: { action: 'inject', text: truncate(text, 500), interrupt: !!interrupt } });
    const { resume } = sessions.resolveForTurn(key, row.channel);
    // Mid-task steer → frame the text so the model continues its current work with this guidance
    // rather than answering it in isolation. Idle session → deliver it as a normal message.
    const steerer = meshSteer ? `Peer session "${by.slice(5)}"` : 'Operator';
    const prompt = (wasRunning || interrupt)
      ? `[${steerer} steering — you are mid-task. Incorporate the following guidance into the work you are ALREADY doing and continue it. Do NOT restart from scratch, and do NOT treat it as a standalone question to answer in isolation.]\n\n${text}`
      : text;
    const ac = new AbortController(); inFlight.set(key, ac);
    let result;
    try {
      result = await runTurn({ prompt, resume, cwd: row.working_dir || undefined, abortController: ac,
        onEvent: (sdkEvt) => {
          const base = { surface: row.channel, session_id: key, identity: by || 'operator', source: 'core' };
          if (sdkEvt.type === 'assistant') for (const c of sdkEvt.message?.content || []) {
            if (c.type === 'tool_use') record({ ...base, event_type: 'tool', payload: { tool: c.name, input: truncate(c.input, 4000) } });
            else if (c.type === 'thinking') record({ ...base, event_type: 'thinking', payload: { text: truncate(c.thinking || c.text, 2000) } });
          } else if (sdkEvt.type === 'user') for (const c of sdkEvt.message?.content || []) {
            if (c.type === 'tool_result') record({ ...base, event_type: 'tool_result', payload: { output: truncate(toolResultText(c.content), 16000), is_error: !!c.is_error } });
          }
        } });
    } finally { inFlight.delete(key); }
    if (result.engineSessionId) sessions.recordEngineId(key, result.engineSessionId);
    sessions.touch(key);
    const reply = redactSecrets((result.text || '').trim()).text;
    record({ surface: row.channel, session_id: key, event_type: 'outbound', identity: by || 'operator', source: 'core', payload: { text: truncate(reply, 500), injected: true } });

    let delivered = false, deliverErr = null;
    if (reply && row.outbound_instance_id && row.outbound_target) {
      try {
        const mgr = (process.env.ASMLTR_MANAGER_URL || 'http://127.0.0.1:3024').replace(/\/$/, '');
        const headers = { 'Content-Type': 'application/json' };
        if (process.env.ASMLTR_MANAGER_TOKEN) headers.Authorization = 'Bearer ' + process.env.ASMLTR_MANAGER_TOKEN;
        const r = await fetch(`${mgr}/send`, { method: 'POST', headers, body: JSON.stringify({ instance_id: row.outbound_instance_id, target: row.outbound_target, text: reply }) });
        delivered = r.ok; if (!r.ok) deliverErr = `send ${r.status}`;
      } catch (e) { deliverErr = e.message; }
    } else if (reply) { deliverErr = 'no stored outbound route for this session'; }
    if (!res.headersSent) res.json({ ok: true, reply, delivered, deliverErr, route: { instance_id: row.outbound_instance_id, target: row.outbound_target } });
  }).catch((e) => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
});

app.post('/v2/release', (req, res) => {
  const { conversation_key } = req.body || {};
  const row = sessions.get(conversation_key);
  if (!row) return res.status(404).json({ error: 'unknown session' });
  sessions.setClaim(conversation_key, 'free', null);
  record({ surface: row.channel, session_id: conversation_key, event_type: 'control',
    identity: 'terminal', source: 'core', payload: { action: 'release' } });
  res.json({ conversation_key, claim_state: 'free' });
});

// --- trust framework CRUD (the dashboard Access page drives these) -----------
// Read-only identity resolution (connectors use this to authorize owner-only actions).
// Body: an envelope-shaped { channel, sender:{raw_id,raw_username,api_key}, context:{scope_id} }.
app.post('/trust/resolve', (req, res) => { try { res.json(trust.resolve(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/trust/principals', (req, res) => res.json({ principals: trust.principals.list() }));
app.get('/trust/principals/:id', (req, res) => { const p = trust.principals.get(req.params.id); return p ? res.json(p) : res.status(404).json({ error: 'not found' }); });
app.post('/trust/principals', (req, res) => res.json(trust.principals.create(req.body)));
app.patch('/trust/principals/:id', (req, res) => { const p = trust.principals.update(req.params.id, req.body); return p ? res.json(p) : res.status(404).json({ error: 'not found' }); });
app.delete('/trust/principals/:id', (req, res) => res.json({ ok: trust.principals.remove(req.params.id) }));
// merge principal :id (the one being absorbed) INTO body.into (the survivor)
app.post('/trust/principals/:id/merge', (req, res) => {
  const merged = trust.principals.merge(req.params.id, req.body && req.body.into);
  return merged ? res.json(merged) : res.status(400).json({ error: 'merge failed — unknown or identical principals' });
});
app.post('/trust/principals/:id/identifiers', (req, res) => res.json(trust.identifiers.add(req.params.id, req.body.surface, String(req.body.value))));
app.delete('/trust/identifiers/:iid', (req, res) => res.json({ ok: trust.identifiers.remove(Number(req.params.iid)) }));
app.get('/trust/roles', (req, res) => res.json({ roles: trust.roles.list() }));
app.post('/trust/roles', (req, res) => res.json(trust.roles.upsert(req.body)));
app.delete('/trust/roles/:id', (req, res) => res.json({ ok: trust.roles.remove(req.params.id) }));
app.post('/trust/principals/:id/grants', (req, res) => res.json({ id: trust.grants.create({ ...req.body, principal_id: req.params.id }) }));
app.delete('/trust/grants/:gid', (req, res) => res.json({ ok: trust.grants.remove(Number(req.params.gid)) }));
// resolve preview (debugging "what can this person do here?")
app.post('/trust/resolve', (req, res) => res.json(trust.resolve(req.body)));

// --- THE CAST: profiles, relationships, engagement (Access-evolution Phase 0) ----------------
app.get('/trust/profiles/:id', (req, res) => res.json(trust.profiles.get(req.params.id) || {}));
app.post('/trust/profiles/:id', (req, res) => res.json(trust.profiles.upsert(req.params.id, req.body || {})));
app.get('/trust/relationships', (req, res) => res.json({ relationships: trust.relationships.list() }));
app.post('/trust/relationships', (req, res) => res.json({ id: trust.relationships.upsert(req.body || {}) }));
app.delete('/trust/relationships/:id', (req, res) => res.json({ ok: trust.relationships.remove(Number(req.params.id)) }));
app.get('/trust/engagement', (req, res) => res.json({ engagement: trust.engagement.list() }));
app.post('/trust/engagement', (req, res) => res.json({ id: trust.engagement.set(req.body || {}) }));
app.delete('/trust/engagement/:id', (req, res) => res.json({ ok: trust.engagement.remove(Number(req.params.id)) }));

if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    console.log(`asmltr-core listening on http://${HOST}:${PORT} (concurrency ${MAX_CONCURRENT})`);
    console.log('substrate: local Agent SDK on Max subscription (NO ANTHROPIC_API_KEY path)');
  });
  // Agent turns (research, tool loops) can run many minutes. Node's default 5-min
  // server.requestTimeout would cut the connector→core call mid-turn (surfacing as
  // "I hit an error processing that" on the channel), so we lift it. Localhost-only,
  // and /v2/abort still allows a manual kill. Configurable via ASMLTR_CORE_REQUEST_TIMEOUT_MS
  // (0 = unlimited, the default).
  server.requestTimeout = Number(process.env.ASMLTR_CORE_REQUEST_TIMEOUT_MS || 0);
  server.headersTimeout = 0;
  server.timeout = 0;
}

module.exports = { app, handle, dispatch, bus };
