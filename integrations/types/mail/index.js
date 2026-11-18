'use strict';
/**
 * MAIL integration — an authenticated link to a mailbox, as a `tools` capability.
 *
 * This is the base record for every mailbox asmltr holds (see docs/INTEGRATIONS.md, T4). It is
 * `passive`: NOTHING RUNS until something opens it. Opening connects, the caller works, the
 * handle closes. A mailbox that must also answer mail unprompted gets a separate `email`
 * connector instance that references this integration by `integration_id` — the channel is the
 * optional extra, not the other way round.
 *
 * Deliberately not an indexer. The previous shape ran an IMAP IDLE loop per mailbox and did work
 * on every inbound message whether or not anyone had asked about that mailbox. On-demand is the
 * default; a listener is only justified when something must happen without being asked.
 *
 * config: {
 *   imap_host, imap_port = 993, smtp_host, smtp_port = 587,
 *   user_ref, password_ref,     // *_ref = VAULT KEY NAMES (resolved upstream by registry.resolveConfig)
 *   email_address,              // defaults to the resolved `user`
 *   from_name,
 *   auth = 'password' | 'oauth2',
 *   // oauth2 (Gmail): the long-lived refresh token is the stored secret; an access token is
 *   // minted per open. One Google grant covers mail + calendar + contacts + tasks.
 *   refresh_token_ref, oauth_client_id_ref, oauth_client_secret_ref,
 * }
 */
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');

function need(cfg, k) { if (!cfg[k]) throw new Error(`mail integration: ${k} required`); return cfg[k]; }

/**
 * Google access tokens live an hour, so one is never stored. With auth=oauth2 the config carries
 * the long-lived REFRESH token as a vault ref and a fresh access token is minted here, at open
 * time — so a token expiring between sessions is a non-event.
 */
async function resolveAccessToken(cfg) {
  if (cfg.access_token) return cfg.access_token;           // caller supplied one explicitly
  if (!cfg.refresh_token) throw new Error('mail integration: refresh_token (or access_token) required for auth=oauth2');
  const google = require('../../../shared/google-oauth');
  const { access_token } = await google.accessToken({
    client_id: need(cfg, 'oauth_client_id'),
    client_secret: need(cfg, 'oauth_client_secret'),
    refresh_token: cfg.refresh_token,
  });
  return access_token;
}

function imapAuth(cfg, token) {
  const user = need(cfg, 'user');
  if (cfg.auth === 'oauth2') return { user, accessToken: token };
  return { user, pass: need(cfg, 'password') };
}

/** Open a live handle. Caller MUST call close(). */
async function open(cfg = {}) {
  const address = cfg.email_address || cfg.user;
  const token = cfg.auth === 'oauth2' ? await resolveAccessToken(cfg) : null;
  const imapOpts = {
    host: need(cfg, 'imap_host'), port: Number(cfg.imap_port) || 993, secure: true,
    auth: imapAuth(cfg, token), logger: false,
  };
  let client = null;
  async function imap() {
    if (client && client.usable) return client;
    client = new ImapFlow(imapOpts);
    await client.connect();
    return client;
  }
  function smtp() {
    const port = Number(cfg.smtp_port) || 587;
    const auth = cfg.auth === 'oauth2'
      ? { type: 'OAuth2', user: cfg.user, accessToken: token }
      : { user: cfg.user, pass: cfg.password };
    return nodemailer.createTransport({ host: need(cfg, 'smtp_host'), port, secure: port === 465, auth });
  }

  return {
    address,
    /** Folder names, so a caller can see Archive/Sent/Junk without guessing. */
    async mailboxes() {
      const c = await imap();
      return (await c.list()).map((m) => ({ path: m.path, name: m.name, specialUse: m.specialUse || null }));
    },
    /** Newest-first envelope list. Headers only — never pulls bodies you did not ask for. */
    async list({ mailbox = 'INBOX', limit = 50, since = null } = {}) {
      const c = await imap();
      const lock = await c.getMailboxLock(mailbox, { readOnly: true });
      try {
        const crit = since ? { since: new Date(since) } : { all: true };
        const uids = await c.search(crit, { uid: true });
        const take = uids.slice(-Math.max(1, limit));
        const out = [];
        if (take.length) {
          for await (const m of c.fetch({ uid: take.join(',') }, { uid: true, envelope: true, flags: true, size: true }, { uid: true })) {
            out.push({
              uid: m.uid, size: m.size,
              subject: (m.envelope && m.envelope.subject) || '',
              from: (m.envelope && m.envelope.from || []).map((a) => a.address).join(', '),
              to: (m.envelope && m.envelope.to || []).map((a) => a.address).join(', '),
              date: m.envelope && m.envelope.date ? new Date(m.envelope.date).toISOString() : null,
              seen: !!(m.flags && m.flags.has && m.flags.has('\\Seen')),
            });
          }
        }
        return out.reverse();
      } finally { lock.release(); }
    },
    /** Full parsed message by uid, attachments included. */
    async read({ mailbox = 'INBOX', uid } = {}) {
      if (!uid) throw new Error('mail integration: uid required');
      const c = await imap();
      const lock = await c.getMailboxLock(mailbox, { readOnly: true });
      try {
        const msg = await c.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg) return null;
        const p = await simpleParser(msg.source);
        return {
          uid: Number(uid), subject: p.subject || '',
          from: (p.from && p.from.text) || '', to: (p.to && p.to.text) || '',
          date: p.date ? p.date.toISOString() : null,
          messageId: p.messageId || null,
          inReplyTo: p.inReplyTo || null,
          references: p.references || null,
          text: p.text || '', html: p.html || null,
          attachments: (p.attachments || []).map((a) => ({ filename: a.filename, type: a.contentType, size: a.size })),
        };
      } finally { lock.release(); }
    },
    /** Server-side IMAP SEARCH — the server filters, not us. */
    async search({ mailbox = 'INBOX', from = null, subject = null, since = null, limit = 50 } = {}) {
      const c = await imap();
      const lock = await c.getMailboxLock(mailbox, { readOnly: true });
      try {
        const crit = {};
        if (from) crit.from = from;
        if (subject) crit.subject = subject;
        if (since) crit.since = new Date(since);
        if (!Object.keys(crit).length) crit.all = true;
        const uids = await c.search(crit, { uid: true });
        return uids.slice(-Math.max(1, limit)).reverse();
      } finally { lock.release(); }
    },
    /** Move messages to a folder (archive/file). Explicit, never implicit. */
    async move({ mailbox = 'INBOX', uids = [], to } = {}) {
      if (!to) throw new Error('mail integration: destination folder required');
      if (!uids.length) return { moved: 0 };
      const c = await imap();
      const lock = await c.getMailboxLock(mailbox);
      try { await c.messageMove(uids.join(','), to, { uid: true }); return { moved: uids.length }; }
      finally { lock.release(); }
    },
    /** Send. Threads when inReplyTo/references are supplied; appends to Sent so it shows in a client. */
    async send({ to, cc, subject, text, html, inReplyTo, references, attachments, appendToSent = 'Sent' } = {}) {
      const t = smtp();
      const msg = {
        from: cfg.from_name ? `${cfg.from_name} <${address}>` : address,
        to, cc, subject, text, html, attachments,
      };
      if (inReplyTo) msg.inReplyTo = inReplyTo;
      if (references) msg.references = references;
      const info = await t.sendMail(msg);
      if (appendToSent && info && info.message === undefined) { /* nodemailer gives no raw by default */ }
      return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
    },
    async close() { try { if (client && client.usable) await client.logout(); } catch (_) {} client = null; },
  };
}

/** Cheap connectivity probe used by registry.test(). */
async function probe(cfg = {}) {
  const h = await open(cfg);
  try { const mb = await h.mailboxes(); return { ok: true, address: h.address, mailboxes: mb.length }; }
  finally { await h.close(); }
}

module.exports = { open, probe, kind: 'tools', lifecycle: 'passive' };
