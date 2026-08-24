'use strict';
/**
 * asmltr shared UPLOAD SURFACE — one channel-agnostic place for every inbound file.
 *
 * The problem this solves: a file the user sends on Telegram used to be invisible to a
 * session running on Discord (or anywhere else) — each connector handled (or dropped)
 * attachments on its own, and sessions are isolated per conversation_key. So "find the
 * recording I sent you" failed across channels.
 *
 * The model: connectors don't invent their own file handling. They call ONE primitive —
 * `save()` (exposed to connectors as `ctx.uploads.save`) — which writes the bytes into a
 * single shared area (`ASMLTR_UPLOADS_DIR`, default `~/.asmltr/uploads`), TAGGED with the
 * origin channel, and appends a record to a shared append-only manifest. Any session, on any
 * channel, then finds files the same way: `list()` / the `asmltr uploads` CLI / the manifest.
 *
 * v1 is direct-filesystem: all connectors run as host child processes of the manager, so they
 * share this home dir. (If a connector is ever containerized, add a core `/uploads` POST proxy
 * that calls this module — the manifest format stays the same.)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function baseDir() {
  if (process.env.ASMLTR_UPLOADS_DIR) return process.env.ASMLTR_UPLOADS_DIR;
  // Default home is the Self silo (so uploads are managed + backed up, not scattered in a random folder)
  // — fall back to the legacy path only if the silo can't be resolved.
  try { return require('./silo').selfSub('uploads'); } catch (_) { return path.join(os.homedir(), '.asmltr', 'uploads'); }
}
function manifestPath() { return path.join(baseDir(), 'manifest.jsonl'); }

function sanitize(name) {
  return String(name || 'file').replace(/[^\w.\-]+/g, '_').replace(/_{2,}/g, '_').slice(-120) || 'file';
}
function humanSize(n) {
  if (!n && n !== 0) return '?';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Persist one inbound file into the shared area + register it in the manifest.
 * @param {object} a
 * @param {string} a.channel          origin surface: 'telegram' | 'discord' | ...
 * @param {Buffer} a.buffer           the file bytes
 * @param {string} [a.filename]       original name (as the user sent it)
 * @param {string} [a.mime]           content type
 * @param {string} [a.caption]        any accompanying text/caption
 * @param {string} [a.sender]         human-readable sender (username)
 * @param {string} [a.senderId]       raw sender id
 * @param {string} [a.instance]       connector instance id
 * @param {string} [a.conversationKey] the session it arrived in
 * @param {string} [a.kind]           semantic hint: 'image'|'audio'|'video'|'document'|'voice'
 * @returns {object} the manifest record (includes absolute `path`)
 */
function save({ channel, buffer, filename, mime, caption, sender, senderId, instance, conversationKey, kind }) {
  if (!channel) throw new Error('uploads.save: channel required');
  if (!Buffer.isBuffer(buffer)) throw new Error('uploads.save: buffer required');
  const ts = Date.now();
  const dir = path.join(baseDir(), channel);
  fs.mkdirSync(dir, { recursive: true });
  const id = ts.toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const stored = `${ts}-${sanitize(filename)}`;
  const abs = path.join(dir, stored);
  fs.writeFileSync(abs, buffer);
  const rec = {
    id, ts, iso: new Date(ts).toISOString(),
    channel, instance: instance || null,
    sender: sender || null, sender_id: senderId != null ? String(senderId) : null,
    conversation_key: conversationKey || null,
    filename: filename || stored, stored_name: stored, path: abs,
    mime: mime || 'application/octet-stream', size: buffer.length,
    kind: kind || null, caption: caption || null,
  };
  try { fs.appendFileSync(manifestPath(), JSON.stringify(rec) + '\n'); } catch (_) {}
  return rec;
}

/** Read + parse the manifest (newest last on disk). Returns [] if none. */
function readManifest() {
  let raw;
  try { raw = fs.readFileSync(manifestPath(), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch (_) {} }
  return out;
}

/**
 * Query uploads, newest first.
 * @param {object} [o]
 * @param {number} [o.limit=20]
 * @param {string} [o.channel]   filter by origin channel
 * @param {string} [o.sender]    substring match on sender/sender_id
 * @param {number} [o.sinceMs]   only entries at/after this epoch-ms
 * @param {string} [o.query]     substring match on filename/caption/channel
 */
function list(o = {}) {
  let items = readManifest();
  if (o.channel) items = items.filter((r) => r.channel === o.channel);
  if (o.conversationKey) items = items.filter((r) => r.conversation_key === o.conversationKey);
  if (o.sinceMs) items = items.filter((r) => r.ts >= o.sinceMs);
  if (o.sender) { const s = o.sender.toLowerCase(); items = items.filter((r) => `${r.sender || ''} ${r.sender_id || ''}`.toLowerCase().includes(s)); }
  if (o.query) { const q = o.query.toLowerCase(); items = items.filter((r) => `${r.filename} ${r.caption || ''} ${r.channel}`.toLowerCase().includes(q)); }
  items.sort((a, b) => b.ts - a.ts);
  return o.limit === 0 ? items : items.slice(0, o.limit || 20);
}

function get(id) { return readManifest().find((r) => r.id === id) || null; }

/** Compact newest-first summary for injecting into a session's context. */
function recentSummary(n = 8, o = {}) {
  const items = list({
    limit: n,
    conversationKey: o.conversationKey || undefined,
    channel: o.channel || undefined,
  });
  if (!items.length) return '';
  return items.map((r) => {
    const when = r.iso.replace('T', ' ').slice(0, 16) + ' UTC';
    const cap = r.caption ? ` "${r.caption.slice(0, 60)}"` : '';
    return `- [${r.channel}] ${when} · ${r.sender || '?'} · ${r.filename} (${r.mime}, ${humanSize(r.size)})${cap} → ${r.path}`;
  }).join('\n');
}

module.exports = { save, list, get, recentSummary, readManifest, baseDir, manifestPath, humanSize };
