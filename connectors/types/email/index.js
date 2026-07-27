'use strict';
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
    },
  },
};

function root32(refs, inReplyTo, messageId) {
  const r = Array.isArray(refs) ? refs[0] : (typeof refs === 'string' ? refs.split(/\s+/)[0] : null);
  return r || inReplyTo || messageId || ('m' + crypto.randomBytes(8).toString('hex'));
}

async function start(ctx) {
  const cfg = ctx.config || {};
  const PORT = cfg.http_port || 3026;
  const BIND = cfg.bind_host || '127.0.0.1';
  const MAILBOX = cfg.mailbox || 'INBOX';
  const fromName = cfg.from_name || NAME;
  const policy = cfg.approval_policy || 'always_draft';
  const signature = cfg.signature || `\n\n—\n${fromName}`;

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

  async function sendMail({ to, subject, text, inReplyTo, references, attachments }) {
    const info = await smtp.sendMail({
      from: `"${fromName}" <${address}>`, to,
      subject: subject || `Message from ${fromName}`,
      text: (text || '') + signature,
      inReplyTo: inReplyTo || undefined,
      references: references && references.length ? references.join(' ') : undefined,
      attachments: attachments || undefined,
    });
    ctx.emit({ event_type: 'outbound', session_id: `email:${ctx.instanceId}:to:${to}`, identity: address, payload: { to, subject } });
    return info;
  }

  async function processMessage(parsed) {
    const fromAddr = (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || '';
    const fromName2 = (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].name) || fromAddr;
    if (!fromAddr) return;
    // Loop / automation guards — never answer ourselves or noreply/daemon senders.
    if (fromAddr.toLowerCase() === selfAddr) return;
    if (/(^|[._-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce)([._+-]|@)/i.test(fromAddr)) { ctx.log(`skip automated sender ${fromAddr}`); return; }

    const subject = parsed.subject || '(no subject)';
    const body = (parsed.text || parsed.html || '').toString().trim();
    const messageId = parsed.messageId || null;
    const refs = parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : [];
    const inReplyTo = parsed.inReplyTo || null;
    const rootId = root32(parsed.references, inReplyTo, messageId);
    const convKey = `email:${ctx.instanceId}:thread:${crypto.createHash('sha1').update(String(rootId)).digest('hex').slice(0, 16)}`;
    const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;

    // Attachments → shared upload surface (findable from any channel), noted for the model.
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

    // Remember thread context for threaded replies (inline auto-send AND later draft approval).
    threads.set(convKey, { subject: replySubject, messageId, references: [...refs, messageId].filter(Boolean) });

    let text = `From: ${fromName2} <${fromAddr}>\nSubject: ${subject}\n\n${body}`;
    if (savedNotes.length) text += `\n\n[Attachments saved to the shared asmltr upload area (findable via \`asmltr uploads\`):\n${savedNotes.join('\n')}]`;

    ctx.emit({ event_type: 'inbound', session_id: convKey, identity: fromAddr, payload: { text: `${subject} — ${body.slice(0, 160)}` } });

    const actions = await ctx.core.handle({
      channel: 'email',
      conversation_key: convKey,
      message_id: messageId || String(Date.now()),
      sender: { raw_id: fromAddr, raw_username: fromName2 },
      content: { text },
      delivery: 'sync',
      capabilities: meta.capabilities,
      public: false, // 1:1 mail; redaction still applies unless the sender is full-trust
      channel_context: { from: fromAddr, subject },
      approval: { policy, recipient: fromAddr, subject: replySubject }, // → draft gate in the core
      system_prompt_extra:
        `You are answering an EMAIL as ${fromName}. Write a clean email reply body only (no "Subject:" line, no headers). ` +
        `Sign off as ${fromName} — NEVER sign as the operator/owner or impersonate a human. A signature is appended automatically. ` +
        `Keep it appropriate for email. If this message is not something you should answer, reply with exactly [[NO_REPLY]].`,
    });

    for (const a of actions || []) {
      if (a.type === 'reply' && a.text && a.text.trim()) {
        // Shadow mode (always_draft) = ZERO outbound. Legit replies already come back as {drafted};
        // a stray {reply} here is a core early-return (e.g. access-revoked / moderation notice), which
        // we must NOT email out in shadow. Under a sending policy, deliver it.
        if (policy === 'always_draft') { ctx.log(`shadow: suppressed inline reply to ${fromAddr}`); continue; }
        const tc = threads.get(convKey) || {};
        await sendMail({ to: fromAddr, subject: replySubject, text: a.text, inReplyTo: messageId, references: tc.references });
        ctx.log(`replied to ${fromAddr} (${replySubject})`);
      } // 'drafted' → held for approval (dashboard); 'status'/others → nothing to mail
    }
  }

  // --- IMAP watch (IDLE) -----------------------------------------------------
  // A UID high-water mark (not read/unread flags) decides what's "new": on first connect the
  // baseline is the mailbox tip, so we only react to mail that arrives AFTER we start watching
  // (unless process_backlog). The cursor survives reconnects, so mail during a blip isn't missed.
  let imap = null, stopped = false, lastUid = -1, busy = false;
  async function fetchNew() {
    if (!imap || !imap.usable || busy) return;
    busy = true;
    const lock = await imap.getMailboxLock(MAILBOX);
    try {
      for await (const msg of imap.fetch({ uid: `${lastUid + 1}:*` }, { source: true, uid: true })) {
        if (msg.uid <= lastUid) continue; // `n:*` returns the tip even when empty — guard reprocessing
        try { await processMessage(await simpleParser(msg.source)); }
        catch (e) { ctx.log(`process failed uid ${msg.uid}: ${e.message}`); }
        lastUid = Math.max(lastUid, msg.uid);
      }
    } finally { lock.release(); busy = false; }
  }
  async function connectImap() {
    if (stopped) return;
    imap = new ImapFlow({ host: cfg.imap_host, port: cfg.imap_port || 993, secure: true, auth: { user: address, pass: password }, logger: false });
    imap.on('exists', () => fetchNew().catch((e) => ctx.log(`fetchNew: ${e.message}`)));
    imap.on('error', (e) => ctx.log(`imap error: ${e.message}`));
    imap.on('close', () => { if (!stopped) { ctx.log('imap closed — reconnecting in 10s'); setTimeout(connectImap, 10000); } });
    await imap.connect();
    const mb = await imap.mailboxOpen(MAILBOX);
    if (lastUid < 0) lastUid = cfg.process_backlog ? 0 : ((mb.uidNext || 1) - 1); // baseline once, keep across reconnects
    ctx.log(`watching ${address} · ${MAILBOX} · policy=${policy} · from uid>${lastUid}`);
    try { ctx.heartbeat(); } catch (_) {} // connected + mailbox open → the watcher's I/O path is alive
    await fetchNew().catch((e) => ctx.log(`initial fetch: ${e.message}`));
  }
  connectImap().catch((e) => ctx.log(`imap connect failed: ${e.message}`));

  // Liveness watchdog: IDLE can silently die (a half-open connection that never emits 'close'), leaving
  // the watcher deaf while the process stays up. A periodic NOOP proves the link end-to-end: success →
  // heartbeat (the manager sees it healthy); failure/stall → force a reconnect (close() → the 'close'
  // handler above reconnects). This closes the email half of #34.
  let probing = false;
  const probeTimer = setInterval(async () => {
    if (stopped || probing || !imap || !imap.usable) return; // not connected → connect/close flow owns recovery
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
      if (markSeen) { try { await c.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true }); } catch (_) {} }
      return {
        uid, from: parsed.from && parsed.from.text, to: parsed.to && parsed.to.text,
        subject: parsed.subject || '(no subject)', date: parsed.date || null, messageId: parsed.messageId || null,
        text: (parsed.text || '').trim(), attachments,
      };
    } finally { lock.release(); }
  }

  // --- outbound HTTP (/out — the manager's unified send calls this) ----------
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.get('/health', (req, res) => res.json({ status: 'ok', type: 'email', instance: ctx.instanceId, address, imap: !!(imap && imap.usable) }));
  app.post('/out', async (req, res) => {
    try {
      const { kind = 'text', target, text, subject, ref, path: filePath, caption } = req.body || {};
      if (!target) return res.status(400).json({ ok: false, error: 'target (recipient) required' });
      const tc = (ref && threads.get(ref)) || {};
      const subj = subject || tc.subject || `Message from ${fromName}`;
      const attachments = kind === 'file' && filePath ? [{ path: filePath, filename: path.basename(filePath) }] : undefined;
      await sendMail({ to: target, subject: subj, text: text || caption || '', inReplyTo: tc.messageId, references: tc.references, attachments });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // Mailbox browse (the manager's /read proxies here; op = list | read | search).
  app.post('/read', async (req, res) => {
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
    async stop() { stopped = true; clearInterval(probeTimer); try { if (imap) await imap.logout(); } catch (_) {} try { if (readImap) await readImap.logout(); } catch (_) {} try { smtp.close(); } catch (_) {} await new Promise((r) => httpServer.close(() => r())); },
    health() { return { address, mailbox: MAILBOX, policy, imap: !!(imap && imap.usable) }; },
  };
}

module.exports = { meta, start, imapNoopProbe };
