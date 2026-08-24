'use strict';
const { sendPolicyFromConfig } = require('./send-policy');
const { parseAuthResults: parseAuthResultsAligned, alignsWithFrom } = require('./auth-align');
const { persistAuthRejectLine } = require('./auth-reject-persist');
/**
 * asmltr connector type: EMAIL (SMTP send + IMAP receive/watch).
 *
 * The assistant's own mailbox becomes a channel: inbound mail is watched over IMAP (IDLE),
 * normalized into an envelope, and answered by the local Agent SDK through the core — with the
 * same trust + moderation + redaction as every other surface. Replies go out over SMTP, threaded
 * (In-Reply-To/References) so they stay in the same conversation. Attachments (in and out) ride
 * the shared upload surface, so a file mailed here is findable from any channel.
 *
 * Sending is gated by the shared DRAFT primitive via `envelope.approval.policy`. The DEFAULT is
 * `always_draft` — a safe "shadow mode": everything the assistant writes is held for approval on
 * the dashboard, nothing leaves the mailbox until you approve it (or set the policy to
 * `auto_send_full_trust` to let it answer the owner directly).
 *
 * Credentials come from the secret store (never a file): user_bws_key + pass_bws_key.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// How often the IMAP watcher proves it's genuinely alive (a NOOP round-trip). Below the manager's
// default 120s stale threshold so a healthy watcher clears it with room to spare.
const IMAP_PROBE_MS = Number(process.env.ASMLTR_EMAIL_IMAP_PROBE_MS) || 60000;

// Liveness probe: a NOOP that round-trips to the server, time-boxed. Resolves when the IMAP link is
// genuinely alive; REJECTS when it's dead or stalled (incl. a half-open TCP that never emits 'close').
// This is what catches the #34 "IMAP IDLE dropped without a close event → deaf but running" case.
// Exported for tests.
async function imapNoopProbe(imap, timeoutMs = 15000) {
  const np = imap.noop();
  if (np && typeof np.catch === 'function') np.catch(() => {}); // never let a late rejection go unhandled
  await Promise.race([np, new Promise((_, rej) => setTimeout(() => rej(new Error('noop timeout')), timeoutMs))]);
}

// Connection-class IMAP errors: the handle is dead; close() so the close handler reconnects.
// Exported for tests.
function isImapConnectionError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return /connection not available|not connected|socket|closed|timeout/.test(msg);
}

// True when the mailbox tip is ahead of lastUid (UIDs we have not fetched yet).
function moreUidsWaiting(mailbox, lastUid) {
  if (!mailbox) return false;
  const uidNext = Number(mailbox.uidNext);
  return Number.isFinite(uidNext) && uidNext > lastUid + 1;
}

// Extra fetchNew pass after busy=false. EXISTS-during-busy is pendingExists; also
// refetch when the first pass advanced and uidNext still has more. Do not loop on a
// failed uid (more UIDs but no progress and no pending EXISTS).
function shouldExtraFetchPass({ stopped, usable, pendingExists, mailbox, lastUid, progressed }) {
  if (stopped || !usable) return false;
  if (pendingExists) return true;
  return !!(progressed && moreUidsWaiting(mailbox, lastUid));
}

const NAME = process.env.ASSISTANT_NAME || 'Assistant';

const meta = {
  type: 'email',
  displayName: 'Email (SMTP/IMAP)',
  outbound: { kinds: ['text', 'file'], target: { required: true, label: 'Recipient email address' } },
  readable: { ops: ['list', 'read', 'search'] }, // the mailbox can be browsed on demand (agent-facing)
  capabilities: { max_message_chars: 100000, supports_markdown: false, supports_attachments_out: true },
  credentialKeys: ['user_bws_key', 'pass_bws_key'],
  configSchema: {
    type: 'object',
    properties: {
      http_port: { type: 'integer', title: 'HTTP port for the outbound /out endpoint', default: 3026 },
      bind_host: { type: 'string', title: 'Bind address', default: '127.0.0.1' },
      imap_host: { type: 'string', title: 'IMAP host', default: '' },
      imap_port: { type: 'integer', title: 'IMAP port (SSL)', default: 993 },
      smtp_host: { type: 'string', title: 'SMTP host', default: '' },
      smtp_port: { type: 'integer', title: 'SMTP port (587 STARTTLS / 465 SSL)', default: 587 },
      user_bws_key: { type: 'string', title: 'Secret key for the mailbox address/username', default: 'eve_email' },
      pass_bws_key: { type: 'string', title: 'Secret key for the mailbox password', default: 'eve_email_password' },
      email_address: { type: 'string', title: 'From address (blank = use the user_bws_key value)', default: '' },
      from_name: { type: 'string', title: 'From display name', default: NAME },
      mailbox: { type: 'string', title: 'IMAP mailbox to watch', default: 'INBOX' },
      approval_policy: { type: 'string', title: 'Send policy', default: 'always_draft', enum: ['always_draft', 'auto_send_full_trust', 'always_send', 'trust_tier:1', 'trust_tier:2', 'trust_tier:3'] },
      signature: { type: 'string', title: 'Signature (blank = auto from from_name)', default: '' },
      process_backlog: { type: 'boolean', title: 'On first connect, process existing unread mail (off = only react to NEW arrivals)', default: false },
      owner_forward_to: { type: 'string', title: 'Forward unknown senders here (blank = do not forward)', default: '' },
      authserv_id: {
        type: 'string',
        title: 'Pointer only — real allowlist is ~/.asmltr/email-authserv.json',
        description: 'Do not put the value here. Write authserv_ids in ~/.asmltr/email-authserv.json (mode 600). Copy the first token of Authentication-Results from a real message delivered to THIS mailbox (the stamp of the server that hosts the bot address, not the sender). Examples: mx.google.com (Google accounts), mx.microsoft.com (Microsoft 365). Not the DNS MX (aspmx.l.google.com, protection.outlook.com). Empty default.',
        default: '',
      },
    },
  },
};

function root32(refs, inReplyTo, messageId) {
  const r = Array.isArray(refs) ? refs[0] : (typeof refs === 'string' ? refs.split(/\s+/)[0] : null);
  return r || inReplyTo || messageId || ('m' + crypto.randomBytes(8).toString('hex'));
}

function isAutomatedSender(addr) {
  return /(^|[._-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce)([._+-]|@)/i.test(String(addr || ''));
}

/**
 * Vacation / out-of-office auto-reply (James 23 Aug 2026).
 * RFC 3834 `auto-replied` only — `auto-generated` is Microsoft alerts and DSNs, not OOO.
 * Subject prefixes cover Exchange/Gmail vacation even when Auto-Submitted is missing.
 */
function isAutoReply(parsed, subject, body) {
  const autoSub = String(headerLine(parsed, 'auto-submitted') || '').toLowerCase();
  if (/\bauto-replied\b/.test(autoSub)) return true;
  const xar = String(
    headerLine(parsed, 'x-autoreply')
    || headerLine(parsed, 'x-autorespond')
    || headerLine(parsed, 'x-auto-reply')
    || '',
  ).toLowerCase();
  if (xar && !/^(no|false|0)$/.test(xar.trim())) return true;
  const prec = String(headerLine(parsed, 'precedence') || '').toLowerCase().trim();
  if (prec === 'auto_reply' || prec === 'autoreply') return true;
  const subj = String(subject || '');
  if (/^\s*(automatic reply|autoreply|auto-reply|auto reply)\s*:/i.test(subj)) return true;
  if (/^\s*(out of office|out of the office)\b/i.test(subj)) return true;
  if (/^\s*ooo\s*:/i.test(subj)) return true;
  return false;
}

function ownerFromEmail() {
  return String(process.env.ASMLTR_OWNER_FROM_EMAIL || '').trim().toLowerCase();
}

/** Flatten a mailparser header value to text. */
function headerLine(parsed, name) {
  if (!parsed) return '';
  const key = String(name || '').toLowerCase();
  let v;
  if (parsed.headers && typeof parsed.headers.get === 'function') v = parsed.headers.get(key);
  if (v == null && parsed.headers && typeof parsed.headers.get === 'function') v = parsed.headers.get(name);
  if (v == null && parsed.headerLines && Array.isArray(parsed.headerLines)) {
    const lines = parsed.headerLines
      .filter((h) => h && String(h.key || '').toLowerCase() === key)
      .map((h) => h.line || h.value)
      .filter(Boolean);
    if (lines.length) return lines.join('\n');
  }
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (x && x.value != null ? x.value : x)).filter(Boolean).join('\n');
  if (typeof v === 'object' && v.value != null) return String(v.value);
  return String(v);
}

/**
 * Parse DKIM/SPF/DMARC from an Authentication-Results (or ARC) header.
 * First token wins per method. Unknown methods ignored.
 */
function parseAuthResults(headerText) { return parseAuthResultsAligned(headerText); }
function parseAuthResultsLegacy(headerText) {
  const out = { dkim: null, spf: null, dmarc: null };
  const s = String(headerText || '');
  if (!s.trim()) return out;
  const re = /\b(dkim|spf|dmarc)\s*=\s*(pass|fail|softfail|neutral|none|temperror|permerror|bestguesspass|policy)/gi;
  let m;
  while ((m = re.exec(s))) {
    const k = m[1].toLowerCase();
    if (!out[k]) out[k] = m[2].toLowerCase();
  }
  return out;
}


function parseAuthservId(headerText) {
  let s = String(headerText || '').trim().replace(/^authentication-results:\s*/i, '');
  if (!s) return '';
  return s.split(';')[0].trim().split(/\s+/)[0].toLowerCase();
}

function authservAllowlistFile() {
  return process.env.ASMLTR_EMAIL_AUTHSERV_FILE
    || path.join(os.homedir(), '.asmltr', 'email-authserv.json');
}

function loadAuthservAllowlist(file) {
  const p = file || authservAllowlistFile();
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const ids = j && j.authserv_ids;
    if (!Array.isArray(ids)) return [];
    return ids.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

function listAuthenticationResults(parsed) {
  const out = [];
  if (parsed && Array.isArray(parsed.headerLines)) {
    for (const h of parsed.headerLines) {
      if (String(h.key || '').toLowerCase() !== 'authentication-results') continue;
      let body = '';
      if (h.line) body = String(h.line).replace(/^authentication-results:\s*/i, '');
      else if (h.value != null) body = String(h.value);
      if (body.trim()) out.push(body);
    }
    if (out.length) return out;
  }
  if (!parsed || !parsed.headers || typeof parsed.headers.get !== 'function') return out;
  const v = parsed.headers.get('authentication-results');
  if (v == null) return out;
  const parts = Array.isArray(v) ? v : [v];
  for (const x of parts) {
    const s = (x && typeof x === 'object' && x.value != null) ? String(x.value) : String(x);
    for (const line of s.split(/\n+/)) {
      const body = line.replace(/^authentication-results:\s*/i, '').trim();
      if (body) out.push(body);
    }
  }
  return out;
}

function hasArcAuthenticationResults(parsed) {
  return !!String(headerLine(parsed, 'arc-authentication-results') || '').trim();
}

/**
 * Authentication-Results only. Never ARC. Pick the header whose authserv-id
 * is in the host allowlist (~/.asmltr/email-authserv.json). Do not join headers.
 */
function authHeaderText(parsed, allow) {
  const ids = allow || loadAuthservAllowlist();
  if (!ids.length) return '';
  const headers = listAuthenticationResults(parsed);
  const hit = headers.find((h) => ids.includes(parseAuthservId(h)));
  return hit || '';
}

/**
 * Disposition of inbound auth headers.
 * Fail closed: authserv unset / missing AR / authserv mismatch / ARC-only.
 * Then DKIM, SPF, and DMARC must each be pass. No turn or reply on fail.
 */
function authDisposition(parsed, opts) {
  const allow = (opts && opts.authservIds) || loadAuthservAllowlist();
  const empty = parseAuthResults('');
  if (!allow.length) {
    return { present: false, results: empty, passed: false, failed: true, raw: '', reason: 'authserv unset' };
  }
  const headers = listAuthenticationResults(parsed);
  if (!headers.length) {
    const reason = hasArcAuthenticationResults(parsed) ? 'ARC-only' : 'missing AR';
    return { present: false, results: empty, passed: false, failed: true, raw: '', reason };
  }
  const raw = headers.find((h) => allow.includes(parseAuthservId(h))) || '';
  if (!raw) {
    return { present: true, results: empty, passed: false, failed: true, raw: '', reason: 'authserv mismatch' };
  }
  const results = parseAuthResults(raw);
  const present = true;
  const parts = [
    ['DKIM', results.dkim],
    ['SPF', results.spf],
    ['DMARC', results.dmarc],
  ];
  const failedParts = parts.filter(([, v]) => v !== 'pass').map(([k, v]) => k + '=' + (v || 'missing'));
  const fromRaw = (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || '';
  const aligned = alignsWithFrom(fromRaw, results);
  const passed = failedParts.length === 0 && aligned;
  let reason;
  if (failedParts.length) reason = failedParts.join(' ');
  else if (!aligned) reason = 'From does not align with DKIM d= / SPF mailfrom / header.from';
  else reason = 'DKIM=pass SPF=pass DMARC=pass aligned';
  return { present, results, passed, failed: !passed, raw, reason, aligned };
}

function formatAuthSummary(auth) {
  if (!auth || !auth.present) {
    return 'Inbound Authentication-Results: none (treated as fail).';
  }
  const r = auth.results || {};
  const verdict = auth.failed ? 'FAIL' : 'PASS';
  return `Inbound Authentication-Results: DKIM=${r.dkim || 'missing'} SPF=${r.spf || 'missing'} DMARC=${r.dmarc || 'missing'} — ${verdict}.`;
}

/** True when the message must not get a turn or a reply. */
function authRejected(auth) {
  return !auth || !!auth.failed;
}

function authRejectLogPath() {
  return process.env.ASMLTR_EMAIL_AUTH_REJECT_LOG
    || path.join(os.homedir(), '.asmltr', 'email-auth-reject.jsonl');
}

function persistAuthReject(entry) {
  try {
    persistAuthRejectLine(authRejectLogPath(), entry);
  } catch (_) {}
}

function loadAuthRejectLog(filePath) {
  const f = filePath || authRejectLogPath();
  let raw = '';
  try { raw = fs.readFileSync(f, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) {}
  }
  return out;
}

function filterAuthRejectsSince(entries, sinceMs) {
  const since = Number(sinceMs);
  return (entries || []).filter((e) => {
    const t = Date.parse(e && e.ts);
    return Number.isFinite(t) && Number.isFinite(since) && t >= since;
  });
}

/** Sender and subject only. Empty string when there is nothing to report. */
function formatAuthJournal(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return '';
  const lines = ['Blocked inbound mail in the last 24 hours. Sender and subject only.', ''];
  for (const e of list) {
    const from = String((e && e.from) || '(unknown)');
    const subject = String((e && e.subject) || '(no subject)');
    lines.push(from + ' — ' + subject);
  }
  return lines.join('\n');
}

function defaultOpsAllowthroughPath() {
  return process.env.ASMLTR_OPS_ALLOWTHROUGH
    || path.join(os.homedir(), '.asmltr', 'silos', 'self', 'memory', 'ops', 'allowthrough.json');
}

// Per-instance IMAP UID cursor. Survives worker restart so a hang-up does not skip the failed uid.
// Override with ASMLTR_EMAIL_LASTUID_FILE (tests / single-file installs).
function lastUidFile(instanceId) {
  if (process.env.ASMLTR_EMAIL_LASTUID_FILE) return process.env.ASMLTR_EMAIL_LASTUID_FILE;
  return path.join(os.homedir(), '.asmltr', `email-lastuid-${instanceId}.json`);
}

function readLastUid(instanceId) {
  try {
    const raw = JSON.parse(fs.readFileSync(lastUidFile(instanceId), 'utf8'));
    const n = Number(raw && raw.lastUid);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  } catch (_) {}
  return null;
}

function persistLastUid(instanceId, uid) {
  const f = lastUidFile(instanceId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ lastUid: uid }) + '\n', { mode: 0o600 });
}

function loadMatchers(filePath) {
  const p = filePath || defaultOpsAllowthroughPath();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw && raw.matchers);
    return Array.isArray(list) ? list : [];
  } catch (_) { return []; }
}

function domainMatches(addr, domain) {
  const a = String(addr || '').toLowerCase();
  const d = String(domain || '').toLowerCase().replace(/^@/, '');
  if (!a || !d) return false;
  return a.endsWith('@' + d) || a.endsWith('.' + d);
}

function collectOriginalAddrs(parsed, fromAddr, body) {
  const addrs = new Set();
  const add = (v) => {
    String(v || '').toLowerCase().replace(/[<>"'()]/g, ' ').split(/[\s,;]+/).forEach((t) => {
      if (/^[^@\s]+@[^@\s]+\.[a-z0-9.-]+$/.test(t)) addrs.add(t);
    });
  };
  add(fromAddr);
  const fromVals = parsed && parsed.from && parsed.from.value;
  if (Array.isArray(fromVals)) for (const x of fromVals) add(x && x.address);
  const rt = parsed && parsed.replyTo && parsed.replyTo.value;
  if (Array.isArray(rt)) for (const x of rt) add(x && x.address);
  for (const h of ['x-original-sender', 'resent-from', 'return-path', 'x-forwarded-from', 'x-original-from']) {
    add(headerLine(parsed, h));
  }
  const text = String(body || '');
  for (const m of text.matchAll(/(?:^|\n)From:\s*(?:[^<\n]*<)?([^\s<>]+@[^\s<>]+)>?/gi)) add(m[1]);
  return [...addrs];
}

function matchOpsAllowThrough(fromAddr, subject, body, matchers, extraAddrs) {
  const list = Array.isArray(matchers) ? matchers : loadMatchers();
  const addr = String(fromAddr || '').toLowerCase();
  const blob = `${subject || ''}\n${body || ''}`;
  const blobLc = blob.toLowerCase();
  const extra = (extraAddrs || []).map((a) => String(a || '').toLowerCase()).filter(Boolean);
  const pool = new Set([addr, ...extra]);
  for (const m of list) {
    if (!m || m.enabled === false) continue;
    const fromAddrs = (m.from_addrs || []).map((a) => String(a).toLowerCase()).filter(Boolean);
    const domains = m.from_domains || [];
    let fromOk;
    if (fromAddrs.length) {
      fromOk = fromAddrs.some((a) => pool.has(a));
    } else {
      fromOk = !domains.length || domains.some((d) => domainMatches(addr, d) || extra.some((e) => domainMatches(e, d)));
    }
    const allKw = m.all_keywords || [];
    const keysOk = allKw.every((k) => blobLc.includes(String(k).toLowerCase()));
    if (fromOk && keysOk) return m;
  }
  return null;
}

function logOnlyDir(matcherId) {
  const id = String(matcherId || 'log-only').replace(/[^a-z0-9._-]+/gi, '_');
  return process.env.ASMLTR_OPS_LOGONLY_DIR
    || path.join(os.homedir(), '.asmltr', 'silos', 'self', 'memory', 'ops', id);
}

function persistLogOnlyAlert(hit, rec) {
  const dir = logOnlyDir(hit && hit.id);
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const dayDir = path.join(dir, 'messages', day);
  fs.mkdirSync(dayDir, { recursive: true });
  const idSrc = String((rec && (rec.message_id || rec.from + rec.subject + rec.ts)) || Date.now());
  const id = crypto.createHash('sha1').update(idSrc).digest('hex').slice(0, 16);
  const row = { id, matcher: (hit && hit.id) || 'log-only', ...rec };
  fs.appendFileSync(path.join(dir, 'alerts.jsonl'), JSON.stringify(row) + '\n');
  const body = String((rec && rec.body) || '');
  const header = [
    `From: ${row.from || ''}`,
    `Original-From: ${row.original_from || ''}`,
    `Subject: ${row.subject || ''}`,
    `Date: ${row.ts || ''}`,
    `Message-ID: ${row.message_id || ''}`,
    `Matcher: ${row.matcher}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dayDir, id + '.txt'), header + body + (body.endsWith('\n') ? '' : '\n'));
  const countsPath = path.join(dir, 'counts.json');
  let counts = { total: 0, by_from: {} };
  try { counts = JSON.parse(fs.readFileSync(countsPath, 'utf8')); } catch (_) {}
  counts.total = (Number(counts.total) || 0) + 1;
  counts.last_ts = row.ts;
  counts.first_ts = counts.first_ts || row.ts;
  const fk = String(row.original_from || row.from || 'unknown').toLowerCase();
  counts.by_from = counts.by_from || {};
  counts.by_from[fk] = (counts.by_from[fk] || 0) + 1;
  fs.writeFileSync(countsPath, JSON.stringify(counts, null, 2) + '\n');
  return { dir, id };
}


/** Kick SMTP and return immediately. Errors are logged; the HTTP /send caller is already done. */
function queueOutboundMail(sendMail, payload, log) {
  Promise.resolve()
    .then(() => sendMail(payload))
    .catch((e) => { try { (log || console.error)(`queued outbound mail failed: ${e && e.message || e}`); } catch (_) {} });
  return { ok: true, queued: true };
}

async function start(ctx) {
  const cfg = ctx.config || {};
  const PORT = cfg.http_port || 3026;
  const BIND = cfg.bind_host || '127.0.0.1';
  const MAILBOX = cfg.mailbox || 'INBOX';
  const fromName = cfg.from_name || NAME;
  const policy = sendPolicyFromConfig(cfg);
  const ownerForward = String(cfg.owner_forward_to || '').trim().toLowerCase();
  const signature = cfg.signature || `\n\n—\n${fromName}`;
  const coreBase = String(process.env.ASMLTR_CORE_URL || 'http://127.0.0.1:3023/v2/handle').replace(/\/v2\/handle\/?$/i, '');

  async function resolveSender(addr, name) {
    try {
      const r = await fetch(coreBase + '/trust/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'email', sender: { raw_id: addr, raw_username: name } }),
      });
      return await r.json();
    } catch (e) { ctx.log('trust resolve failed: ' + e.message); return { is_default: true }; }
  }

  const address = cfg.email_address || (await ctx.secrets.get(cfg.user_bws_key));
  const password = await ctx.secrets.get(cfg.pass_bws_key);
  if (!address || !password) throw new Error(`missing mailbox creds (keys '${cfg.user_bws_key}'/'${cfg.pass_bws_key}')`);
  if (!cfg.imap_host || !cfg.smtp_host) throw new Error('imap_host and smtp_host are required');

  const smtp = nodemailer.createTransport({
    host: cfg.smtp_host, port: cfg.smtp_port || 587,
    secure: (cfg.smtp_port || 587) === 465, requireTLS: (cfg.smtp_port || 587) === 587,
    auth: { user: address, pass: password },
  });

  // conversation_key -> { subject, messageId, references[] } so replies (inline OR later draft
  // approval via /out) thread correctly. In-memory: best-effort across a connector restart.
  const threads = new Map();
  const selfAddr = String(address).toLowerCase();

  async function sendMail({ to, cc, subject, text, inReplyTo, references, attachments }) {
    const info = await smtp.sendMail({
      from: `"${fromName}" <${address}>`, to,
      cc: cc || undefined,
      subject: subject || `Message from ${fromName}`,
      text: (text || '') + signature,
      inReplyTo: inReplyTo || undefined,
      references: references && references.length ? references.join(' ') : undefined,
      attachments: attachments || undefined,
    });
    ctx.emit({ event_type: 'outbound', session_id: `email:${ctx.instanceId}:to:${to}`, identity: address, payload: { to, cc: cc || undefined, subject } });
    return info;
  }

  async function processMessage(parsed) {
    const fromRaw = (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || '';
    const fromAddr = String(fromRaw).trim().toLowerCase();
    const fromName2 = (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].name) || fromAddr;
    if (!fromAddr) return { handled: false };
    // Loop / automation guards — never answer ourselves or noreply/daemon senders,
    // unless an ops matcher (Self silo memory/ops/allowthrough.json) says this
    // alert is allowed through (e.g. Microsoft Entra sync noreply).
    if (fromAddr === selfAddr) return { handled: false };
    const subject = parsed.subject || '(no subject)';
    const body = (parsed.text || parsed.html || '').toString().trim();

    // Auth-Results before persist/uploads/thread/telemetry. Reject: no attachments, no log_only.
    const auth = authDisposition(parsed);
    if (authRejected(auth)) {
      const summary = formatAuthSummary(auth);
      const reason = (auth && auth.reason) || 'auth failed';
      ctx.log(`auth reject from=${fromAddr} subject=${subject} ${summary} reason=${reason}`);
      ctx.emit({
        event_type: 'auth_reject',
        session_id: `email:${ctx.instanceId}:auth-reject`,
        identity: fromAddr,
        payload: {
          from: fromAddr, subject, reason,
          dkim: auth.results.dkim, spf: auth.results.spf, dmarc: auth.results.dmarc,
          present: auth.present,
        },
      });
      persistAuthReject({
        ts: new Date().toISOString(), from: fromAddr, subject, reason,
        dkim: auth.results.dkim, spf: auth.results.spf, dmarc: auth.results.dmarc,
        present: auth.present,
      });
      if (ownerFromEmail() && fromAddr === ownerFromEmail()) {
        ctx.log(`auth reject OWNER mail — ${reason} — not treated as a trusted turn`);
      }
      return { handled: true };
    }

    const extraAddrs = collectOriginalAddrs(parsed, fromAddr, body);
    const opsHitLog = matchOpsAllowThrough(fromAddr, subject, body, undefined, extraAddrs);
    if (opsHitLog && opsHitLog.log_only) {
      const original = extraAddrs.find((a) => a && a !== fromAddr) || fromAddr;
      persistLogOnlyAlert(opsHitLog, {
        ts: new Date().toISOString(),
        from: fromAddr,
        original_from: original,
        extra_addrs: extraAddrs,
        subject,
        message_id: parsed.messageId || null,
        body: body.slice(0, 200000),
        attachments: (parsed.attachments || []).map((a) => a && a.filename).filter(Boolean),
      });
      ctx.log(`log-only ${opsHitLog.id} from=${fromAddr} subject=${subject}`);
      return { handled: true };
    }
    // Turns: header From only. Extra/body addresses are log_only (V6).
    const opsHit = matchOpsAllowThrough(fromAddr, subject, body, undefined, []);
    if (isAutomatedSender(fromAddr) && !(opsHit && opsHit.noreply_ok !== false)) {
      ctx.log(`skip automated sender ${fromAddr}`);
      return { handled: false };
    }
    // Vendor matchers still win. OOO is an intercept: turn (even unknown), never owner-forward, never SMTP-reply.
    const hit = opsHit || (isAutoReply(parsed, subject, body)
      ? { id: 'out-of-office', noreply_ok: true, reply_to_sender: false }
      : null);
    if (hit && hit.id === 'out-of-office') ctx.log(`out-of-office from=${fromAddr} subject=${subject}`);
    const messageId = parsed.messageId || null;
    const refs = parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : [];
    const inReplyTo = parsed.inReplyTo || null;
    const rootId = root32(parsed.references, inReplyTo, messageId);
    const convKey = `email:${ctx.instanceId}:thread:${crypto.createHash('sha1').update(String(rootId)).digest('hex').slice(0, 16)}`;
    const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;

    // Attachments after auth pass only.
    const savedNotes = [];
    for (const a of parsed.attachments || []) {
      if (!a || !a.content) continue;
      try {
        const rec = ctx.uploads.save({
          channel: 'email', instance: ctx.instanceId, buffer: a.content,
          filename: a.filename || `attachment-${Date.now()}`, mime: a.contentType, kind: 'document',
          caption: subject, sender: fromAddr, senderId: fromAddr, conversationKey: convKey,
        });
        savedNotes.push(`- ${rec.filename} (${rec.mime}, ${ctx.uploads.humanSize(rec.size)}) → ${rec.path}`);
      } catch (e) { ctx.log(`attachment save failed: ${e.message}`); }
    }

    threads.set(convKey, { subject: replySubject, messageId, references: [...refs, messageId].filter(Boolean) });

    let text = `From: ${fromName2} <${fromAddr}>\nSubject: ${subject}\n\n${body}`;
    if (savedNotes.length) text += `\n\n[Attachments saved to the shared asmltr upload area (findable via \`asmltr uploads\`):\n${savedNotes.join('\n')}]`;

    ctx.emit({ event_type: 'inbound', session_id: convKey, identity: fromAddr, payload: { text: `${subject} — ${body.slice(0, 160)}` } });

    const resolved = await resolveSender(fromAddr, fromName2);
    const known = !!(resolved && !resolved.is_default && !resolved.revoked);
    // Known people (in the trust store): reply immediately. Strangers: forward to the owner, no reply.
    // Ops allow-through (Microsoft Entra alerts, etc.) creates a turn even if unknown.
    if (!known && !hit) {
      if (ownerForward && ownerForward !== fromAddr) {
        const fwd = `${NAME} forwarded this — I don't know the sender, so I didn't reply.\n\nFrom: ${fromName2} <${fromAddr}>\nSubject: ${subject}\n\n${body}`;
        await sendMail({ to: ownerForward, subject: `Fwd: ${subject}`, text: fwd });
        ctx.log(`forwarded unknown ${fromAddr} → ${ownerForward}`);
      } else {
        ctx.log(`unknown sender ${fromAddr} — no owner_forward_to, skipped`);
      }
      return { handled: true };
    }

    const sendPolicy = policy;
    const suppressReply = isAutomatedSender(fromAddr) || !!(hit && hit.reply_to_sender === false);
    let extra =
      `You are answering an EMAIL as ${fromName}. Write a clean email reply body only (no "Subject:" line, no headers). ` +
      `Do not type a name or signature block — "${fromName}" and the rest of the signature are appended automatically. NEVER sign as the operator/owner or impersonate a human. ` +
      `When a company name is used, write the full legal name from the Self silo — never a shortened nickname. ` +
      `Keep it appropriate for email. If this message is not something you should answer, reply with exactly [[NO_REPLY]]. ` +
      `Ops desk: inbound company alerts live in the Self silo at memory/ops/README.md. If this mail matches an enabled workflow there, follow that flowchart (ticket + outreach). Do not invent a new alert type. ` +
      formatAuthSummary(auth);
    if (hit) {
      extra += ` This message matched ops matcher '${hit.id || 'unnamed'}'. Do the workflow work via tools. Do not reply to this automated sender — end with [[NO_REPLY]] after handling.`;
      if (hit.id === 'out-of-office') {
        extra += ' This is an out-of-office / automatic reply. Follow memory/ops/workflows/out-of-office.md. Never reply to the auto-reply. Never owner-forward it. @techdirect.io is always silent. Customer we already emailed on an open ticket: one notice to Tech Direct Services staff only.';
      }
    }
    const actions = await ctx.core.handle({
      channel: 'email',
      conversation_key: convKey,
      message_id: messageId || String(Date.now()),
      sender: { raw_id: fromAddr, raw_username: fromName2 },
      content: { text },
      delivery: 'sync',
      capabilities: meta.capabilities,
      public: false, // 1:1 mail; redaction still applies unless the sender is full-trust
      channel_context: {
        from: fromAddr, subject, ops_matcher: hit ? (hit.id || true) : undefined,
        auth: { present: auth.present, passed: auth.passed, failed: auth.failed, dkim: auth.results.dkim, spf: auth.results.spf, dmarc: auth.results.dmarc },
      },
      approval: { policy: sendPolicy, recipient: fromAddr, subject: replySubject },
      system_prompt_extra: extra,
    });

    for (const a of actions || []) {
      if (a.type === 'reply' && a.text && a.text.trim()) {
        // Shadow mode (always_draft) = ZERO outbound. Legit replies already come back as {drafted};
        // a stray {reply} here is a core early-return (e.g. access-revoked / moderation notice), which
        // we must NOT email out in shadow. Under a sending policy, deliver it.
        if (sendPolicy === 'always_draft') { ctx.log(`shadow: suppressed inline reply to ${fromAddr}`); continue; }
        if (suppressReply) { ctx.log(`suppressed reply to automated/ops sender ${fromAddr}`); continue; }
        const tc = threads.get(convKey) || {};
        await sendMail({ to: fromAddr, subject: replySubject, text: a.text, inReplyTo: messageId, references: tc.references });
        ctx.log(`replied to ${fromAddr} (${replySubject})`);
      } // 'drafted' → held for approval (dashboard); 'status'/others → nothing to mail
    }
    return { handled: true };
  }

  // --- IMAP watch (IDLE) -----------------------------------------------------
  // A UID high-water mark (not read/unread flags) decides what's "new": on first connect the
  // baseline is the mailbox tip, so we only react to mail that arrives AFTER we start watching
  // (unless process_backlog). The cursor survives reconnects, so mail during a blip isn't missed.
  const persistedUid = readLastUid(ctx.instanceId);
  let imap = null, stopped = false, lastUid = persistedUid != null ? persistedUid : -1, busy = false;
  let connecting = false, pendingExists = false, reconnectTimer = null;
  function scheduleReconnect() {
    if (stopped || connecting || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connectImap(); }, 10000);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }
  async function fetchNew() {
    if (!imap || !imap.usable) return;
    if (busy) { pendingExists = true; return; } // EXISTS during busy — extra pass after we clear busy
    busy = true;
    let progressed = false;
    let lock = null;
    try {
      lock = await imap.getMailboxLock(MAILBOX);
      try {
        for await (const msg of imap.fetch({ uid: `${lastUid + 1}:*` }, { source: true, uid: true })) {
          if (msg.uid <= lastUid) continue; // `n:*` returns the tip even when empty — guard reprocessing
          try {
            const result = await processMessage(await simpleParser(msg.source));
            // Gmail/IMAP unread is \Seen, not our UID cursor. Mark mail we actually handled
            // so the inbox matches what the assistant has already seen. Skip noreply/self.
            if (result && result.handled) {
              try { await imap.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true }); }
              catch (e) { ctx.log(`mark seen uid ${msg.uid}: ${e.message}`); }
              // Advance + persist only on handled. Hang-up / parse failure must leave
              // lastUid so the next start or exists re-fetches this uid.
              if (msg.uid > lastUid) {
                lastUid = msg.uid;
                progressed = true;
                try { persistLastUid(ctx.instanceId, lastUid); }
                catch (e) { ctx.log(`persist lastUid ${lastUid}: ${e.message}`); }
              }
            }
          } catch (e) {
            ctx.log(`process failed uid ${msg.uid}: ${e.message}`);
            break; // do not walk past a failed uid; retry it next fetch
          }
        }
      } finally { lock.release(); }
    } catch (e) {
      ctx.log(`fetchNew: ${e.message}`);
      if (isImapConnectionError(e)) {
        try { imap.close(); } catch (_) {}
      }
    } finally { busy = false; }
    const again = shouldExtraFetchPass({
      stopped, usable: !!(imap && imap.usable), pendingExists,
      mailbox: imap && imap.mailbox, lastUid, progressed,
    });
    pendingExists = false;
    if (again) return fetchNew();
  }
  async function connectImap() {
    if (stopped || connecting) return;
    connecting = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const prev = imap;
    const client = new ImapFlow({ host: cfg.imap_host, port: cfg.imap_port || 993, secure: true, auth: { user: address, pass: password }, logger: false });
    imap = client;
    client.on('exists', () => fetchNew().catch((e) => ctx.log(`fetchNew: ${e.message}`)));
    client.on('error', (e) => ctx.log(`imap error: ${e.message}`));
    client.on('close', () => {
      if (imap !== client) return; // stale handle after a newer connect
      if (!stopped) { ctx.log('imap closed — reconnecting in 10s'); scheduleReconnect(); }
    });
    if (prev && prev !== client) { try { prev.close(); } catch (_) {} }
    try {
      await client.connect();
      const mb = await client.mailboxOpen(MAILBOX);
      if (lastUid < 0) lastUid = cfg.process_backlog ? 0 : ((mb.uidNext || 1) - 1); // baseline once, keep across reconnects
      ctx.log(`watching ${address} · ${MAILBOX} · policy=${policy} · from uid>${lastUid}`);
      try { ctx.heartbeat(); } catch (_) {} // connected + mailbox open → the watcher's I/O path is alive
      await fetchNew().catch((e) => ctx.log(`initial fetch: ${e.message}`));
    } catch (e) {
      ctx.log(`imap connect failed: ${e.message}`);
      try { if (imap === client) client.close(); } catch (_) {}
      if (imap === client) imap = null;
      if (!stopped) scheduleReconnect();
    } finally { connecting = false; }
  }
  connectImap();

  // Liveness watchdog: IDLE can silently die (a half-open connection that never emits 'close'), leaving
  // the watcher deaf while the process stays up. A periodic NOOP proves the link end-to-end: success →
  // heartbeat (the manager sees it healthy); failure/stall → force a reconnect (close() → the 'close'
  // handler above reconnects). If the handle is already gone (!imap / !usable), do not no-op — schedule
  // connectImap (connecting flag + 10s backoff so retries do not stack). This closes the email half of #34.
  let probing = false;
  const probeTimer = setInterval(async () => {
    if (stopped) return;
    if (!imap || !imap.usable) { connectImap(); return; } // dead handle → heal; do not return as a no-op
    if (probing) return;
    probing = true;
    try { await imapNoopProbe(imap); ctx.heartbeat(); }
    catch (e) { ctx.log(`imap probe failed (${e.message}) — forcing reconnect`); try { imap.close(); } catch (_) {} }
    finally { probing = false; }
  }, IMAP_PROBE_MS);
  if (probeTimer.unref) probeTimer.unref();

  // --- mailbox READ/BROWSE (agent-facing) ------------------------------------
  // A SEPARATE IMAP connection so browsing never perturbs the IDLE watcher's selected-mailbox
  // state / UID cursor. Lazily connected, reused, reconnected on failure.
  let readImap = null;
  async function getReadImap() {
    if (readImap && readImap.usable) return readImap;
    const c = new ImapFlow({ host: cfg.imap_host, port: cfg.imap_port || 993, secure: true, auth: { user: address, pass: password }, logger: false });
    c.on('error', () => {}); c.on('close', () => { if (readImap === c) readImap = null; });
    await c.connect();
    readImap = c; return c;
  }
  const summarize = (m) => {
    const e = m.envelope || {};
    const f = (e.from && e.from[0]) || {};
    return { uid: m.uid, seq: m.seq, from: f.name || f.address || '?', address: f.address || '', subject: e.subject || '(no subject)', date: e.date || null, seen: m.flags ? m.flags.has('\\Seen') : true };
  };
  async function mailList({ mailbox, limit = 20, unseen }) {
    const c = await getReadImap();
    const lock = await c.getMailboxLock(mailbox || MAILBOX);
    try {
      const total = (c.mailbox && c.mailbox.exists) || 0;
      if (!total) return [];
      const items = [];
      if (unseen) {
        const uids = (await c.search({ seen: false }, { uid: true })) || [];
        const pick = uids.slice(-limit);
        if (pick.length) for await (const m of c.fetch({ uid: pick }, { envelope: true, flags: true, uid: true })) items.push(summarize(m));
      } else {
        const start = Math.max(1, total - limit + 1);
        for await (const m of c.fetch(`${start}:*`, { envelope: true, flags: true, uid: true })) items.push(summarize(m));
      }
      return items.reverse(); // newest first
    } finally { lock.release(); }
  }
  async function mailSearch({ query, mailbox, limit = 20 }) {
    const c = await getReadImap();
    const lock = await c.getMailboxLock(mailbox || MAILBOX);
    try {
      const uids = (await c.search({ or: [{ subject: query }, { from: query }, { body: query }] }, { uid: true })) || [];
      const pick = uids.slice(-limit);
      const items = [];
      if (pick.length) for await (const m of c.fetch({ uid: pick }, { envelope: true, flags: true, uid: true })) items.push(summarize(m));
      return items.reverse();
    } finally { lock.release(); }
  }
  async function mailRead({ uid, mailbox, markSeen }) {
    if (uid == null) throw new Error('uid required');
    const c = await getReadImap();
    const lock = await c.getMailboxLock(mailbox || MAILBOX);
    try {
      const msg = await c.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
      if (!msg) throw new Error(`no message with uid ${uid}`);
      const parsed = await simpleParser(msg.source);
      const attachments = [];
      for (const a of parsed.attachments || []) {
        if (!a.content) continue;
        try {
          const rec = ctx.uploads.save({ channel: 'email', instance: ctx.instanceId, buffer: a.content, filename: a.filename || `attachment-${Date.now()}`, mime: a.contentType, kind: 'document', caption: parsed.subject || '', sender: (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || '', conversationKey: `email:${ctx.instanceId}:read` });
          attachments.push({ name: rec.filename, path: rec.path, mime: rec.mime, size: rec.size });
        } catch (_) {}
      }
      if (markSeen !== false) { try { await c.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true }); } catch (_) {} }
      return {
        uid, from: parsed.from && parsed.from.text, to: parsed.to && parsed.to.text,
        subject: parsed.subject || '(no subject)', date: parsed.date || null, messageId: parsed.messageId || null,
        text: (parsed.text || '').trim(), attachments,
      };
    } finally { lock.release(); }
  }

  // --- outbound HTTP (/out — the manager's unified send calls this) ----------
  const { requireConnectorToken } = require('../../../shared/connector-http-auth');
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.get('/health', (req, res) => res.json({ status: 'ok', type: 'email', instance: ctx.instanceId, address, imap: !!(imap && imap.usable) }));
  app.post('/out', requireConnectorToken, async (req, res) => {
    try {
      const { kind = 'text', target, text, subject, ref, path: filePath, caption, cc, inReplyTo, references } = req.body || {};
      if (!target) return res.status(400).json({ ok: false, error: 'target (recipient) required' });
      const tc = (ref && threads.get(ref)) || {};
      const subj = subject || tc.subject || `Message from ${fromName}`;
      const attachments = kind === 'file' && filePath ? [{ path: filePath, filename: path.basename(filePath) }] : undefined;
      const refsIn = references == null ? null : (Array.isArray(references) ? references : String(references).split(/\s+/).filter(Boolean));
      const payload = {
        to: target, cc, subject: subj, text: text || caption || '',
        inReplyTo: inReplyTo || tc.messageId,
        references: refsIn || tc.references,
        attachments,
      };
      // Fire-and-forget: Discord (and any /send caller) must not block the turn on SMTP.
      res.json(queueOutboundMail(sendMail, payload, ctx.log));
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // Mailbox browse (the manager's /read proxies here; op = list | read | search).
  app.post('/read', requireConnectorToken, async (req, res) => {
    try {
      const b = req.body || {};
      if (b.op === 'list') return res.json({ ok: true, messages: await mailList(b) });
      if (b.op === 'search') return res.json({ ok: true, messages: await mailSearch(b) });
      if (b.op === 'read') return res.json({ ok: true, message: await mailRead(b) });
      return res.status(400).json({ ok: false, error: `unknown read op '${b.op}'` });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  const httpServer = app.listen(PORT, BIND, () => ctx.log(`email outbound on ${BIND}:${PORT} (from ${address})`));

  return {
    async stop() { stopped = true; clearInterval(probeTimer); if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } try { if (imap) await imap.logout(); } catch (_) {} try { if (readImap) await readImap.logout(); } catch (_) {} try { smtp.close(); } catch (_) {} await new Promise((r) => httpServer.close(() => r())); },
    health() { return { address, mailbox: MAILBOX, policy, imap: !!(imap && imap.usable) }; },
  };
}

module.exports = { meta, start, queueOutboundMail, imapNoopProbe, isImapConnectionError, moreUidsWaiting, shouldExtraFetchPass, isAutomatedSender, isAutoReply, matchOpsAllowThrough, collectOriginalAddrs, loadMatchers, domainMatches, lastUidFile, readLastUid, persistLastUid, parseAuthResults, parseAuthservId, loadAuthservAllowlist, listAuthenticationResults, authDisposition, formatAuthSummary, authRejected, persistAuthReject, authRejectLogPath, loadAuthRejectLog, filterAuthRejectsSince, formatAuthJournal, headerLine, persistLogOnlyAlert, logOnlyDir };
