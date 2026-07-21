'use strict';
/**
 * asmltr shared DRAFT / APPROVAL store.
 *
 * A generic hold-for-approval queue ANY connector can opt into: when a turn produces an outbound
 * reply but the connector's approval policy says "don't send to this recipient," the core diverts
 * the (already-redacted) reply here instead of returning it. The draft surfaces on the dashboard
 * (via a `notification` event) and through `asmltr drafts`; on approval the core delivers it out
 * the originating connector — the same path `asmltr send` uses. Email is the first consumer
 * (auto-send full-trust / draft everyone else), but Discord/Telegram/etc. can enable it too.
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = require('./db-path').coreDbPath();
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS drafts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  channel          TEXT NOT NULL,               -- origin surface (discord|telegram|email|…)
  instance_id      TEXT,                        -- connector instance to deliver through
  conversation_key TEXT,
  recipient        TEXT,                        -- delivery target (email address / chat id / channel id)
  subject          TEXT,                        -- optional (email)
  body             TEXT NOT NULL,               -- the redacted reply text
  attachments      TEXT,                        -- JSON array of absolute file paths
  reason           TEXT,                        -- why it was held (policy + trust tier)
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | discarded
  created_at       INTEGER NOT NULL,
  resolved_at      INTEGER
)`);

const _ins = db.prepare(`INSERT INTO drafts
  (channel, instance_id, conversation_key, recipient, subject, body, attachments, reason, status, created_at)
  VALUES (@channel, @instance_id, @conversation_key, @recipient, @subject, @body, @attachments, @reason, 'pending', @created_at)`);
const _get = db.prepare('SELECT * FROM drafts WHERE id = ?');
const _setStatus = db.prepare("UPDATE drafts SET status=@status, resolved_at=@resolved_at WHERE id=@id AND status='pending'");
const _list = db.prepare(`SELECT * FROM drafts
  WHERE (@status IS NULL OR status=@status) AND (@channel IS NULL OR channel=@channel)
  ORDER BY id DESC LIMIT @limit`);
const _count = db.prepare("SELECT COUNT(*) AS c FROM drafts WHERE status='pending' AND (@channel IS NULL OR channel=@channel)");

function _hydrate(r) { if (r && typeof r.attachments === 'string') { try { r.attachments = JSON.parse(r.attachments); } catch { r.attachments = []; } } return r || null; }

function create({ channel, instanceId, conversationKey, recipient, subject, body, attachments, reason }) {
  const info = _ins.run({
    channel, instance_id: instanceId || null, conversation_key: conversationKey || null,
    recipient: recipient || null, subject: subject || null, body: String(body || ''),
    attachments: JSON.stringify(attachments || []), reason: reason || null, created_at: Date.now(),
  });
  return _hydrate(_get.get(info.lastInsertRowid));
}
function get(id) { return _hydrate(_get.get(id)); }
function list({ status = 'pending', channel = null, limit = 50 } = {}) {
  return _list.all({ status: status || null, channel, limit }).map(_hydrate);
}
function setStatus(id, status) { return _setStatus.run({ id, status, resolved_at: Date.now() }).changes > 0; }
function pendingCount(channel = null) { return _count.get({ channel }).c; }

/**
 * Should this reply be HELD (drafted) rather than sent, for this recipient?
 * @param {string} policy  'always_send'(default) | 'always_draft' | 'auto_send_full_trust' | 'trust_tier:<N>'
 * @param {object} resolved  trust resolution ({ bypass_moderation, trust_tier })
 */
function shouldHold(policy, resolved) {
  if (!policy || policy === 'always_send') return false;
  if (policy === 'always_draft') return true;
  if (policy === 'auto_send_full_trust') return !(resolved && resolved.bypass_moderation);
  const m = /^trust_tier:(\d+)$/.exec(policy);
  if (m) return (Number(resolved && resolved.trust_tier) || 0) < Number(m[1]);
  return false; // unknown policy → fail open to send (never silently swallow a reply)
}

module.exports = { create, get, list, setStatus, pendingCount, shouldHold };
