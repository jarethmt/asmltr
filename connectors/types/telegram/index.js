'use strict';
/**
 * asmltr connector type: TELEGRAM (thin adapter over the Bot API).
 *
 * Transport stays here (it's HOW Telegram works): polling, photo download,
 * sendMessage/Photo/Document, and the :3008 HTTP endpoints that outbound helper scripts and
 * asmltr-core's block-alert depend on. Everything else
 * (sessions, identity, moderation, system prompt) is the core's job: we just
 * build an envelope and render the reply.
 *
 * conversation_key = telegram:<instanceId>:user:<userId>
 *
 * NOTE: only ONE poller may hold a bot token at a time — register this DISABLED
 * and enable it only after stopping any other poller on the same token (the cutover).
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { isImage } = require('../../../shared/mimeguess');
const { MediaGroupCoalescer } = require('./media-group'); // batch album photos into one turn

const meta = {
  type: 'telegram',
  displayName: 'Telegram',
  supportsMultiple: true,
  capabilities: { max_message_chars: 4000, supports_markdown: true, supports_code_blocks: true, supports_attachments_out: true },
  credentialKeys: ['bot_token_bws_key'],
  identifierFormats: [{ surface: 'telegram', label: 'Telegram username', placeholder: 'username' }],
  // Unified outbound capability (manager /send → this instance /out). 'file' is the standard attachment
  // kind (routed by MIME to sendPhoto/sendDocument); 'photo'/'document' kept for explicit callers.
  outbound: { kinds: ['text', 'file', 'photo', 'document'], target: { required: false, label: 'Chat id (default: configured chat)' } },
  configSchema: {
    type: 'object',
    required: ['bot_token_bws_key'],
    properties: {
      bot_token_bws_key: { type: 'string', title: 'Bot token (Bitwarden secret key)' },
      allowed_chat_ids: { type: 'array', title: 'Allowed chat IDs', items: { type: 'integer' },
        description: 'Empty = learn the first chat that messages (single-user bots)' },
      http_port: { type: 'integer', title: 'Outbound HTTP port', default: 3008 },
      photo_dir: { type: 'string', title: 'Photo save dir', default: '', description: 'Where incoming photos are saved. Empty = ~/.asmltr/telegram-photos' },
      media_group_window_ms: { type: 'integer', title: 'Album coalesce window (ms)', default: 1500, description: 'Photos of one album (shared media_group_id) are batched into a single vision turn once no new photo arrives for this long.' },
      max_vision_images: { type: 'integer', title: 'Max images per album turn', default: 10, description: 'Images past this are still saved but left out of the vision payload, so a large album can\'t balloon one turn.' },
    },
  },
};

async function start(ctx) {
  const cfg = ctx.config;
  const token = (await ctx.secrets.get(cfg.bot_token_bws_key)) || cfg.bot_token;
  if (!token) throw new Error(`no bot token (bws key '${cfg.bot_token_bws_key}')`);
  const photoDir = cfg.photo_dir || path.join(require('os').homedir(), '.asmltr', 'telegram-photos');
  const allowed = new Set(cfg.allowed_chat_ids || []);
  let learnedChat = null;

  const bot = new TelegramBot(token, { polling: true });

  function authorized(chatId) {
    if (allowed.size === 0) { if (!learnedChat) learnedChat = chatId; return chatId === learnedChat; }
    return allowed.has(chatId);
  }

  // Album coalescing: Telegram delivers a multi-photo album as separate messages sharing a
  // media_group_id, and running one vision turn per photo pins the box (the 2026-08-18 24-photo
  // thrash). Buffer a group until it goes quiet, then dispatch it as ONE turn. GROUP_WINDOW_MS is the
  // debounce; MAX_VISION_IMAGES caps how many images ride the vision payload (the rest are still saved).
  const GROUP_WINDOW_MS = Number(cfg.media_group_window_ms) || 1500;
  const MAX_VISION_IMAGES = Number.isFinite(cfg.max_vision_images) ? cfg.max_vision_images : 10;
  const albums = new MediaGroupCoalescer({
    windowMs: GROUP_WINDOW_MS,
    maxImages: MAX_VISION_IMAGES,
    onFlush: (grp) => {
      let text = grp.caption || '';
      if (grp.dropped > 0) {
        text += `\n\n[${grp.count} photos received as one album; ${grp.attachments.length} attached to this turn, ${grp.dropped} saved only (read them from the paths below if needed).]`;
      }
      dispatch({ ...grp.route, text, attachments: grp.attachments, savedNotes: grp.savedNotes });
    },
  });

  // Run one normalized envelope through the core and deliver its actions. Shared by the single-message
  // path and the album-flush path so both build the ctx.core.handle call identically.
  async function dispatch({ chatId, userId, from, message_id, text, attachments, savedNotes }) {
    if (savedNotes.length) {
      text += `\n\n[Files received on Telegram, saved to the shared asmltr upload area (findable from any channel via \`asmltr uploads\`):\n${savedNotes.join('\n')}\nRead a file at its path if the user wants you to work with it.]`;
    }
    if (!text.trim() && !attachments.length) return;
    try {
      bot.sendChatAction(chatId, 'typing').catch(() => {});
      const actions = await ctx.core.handle({
        channel: 'telegram',
        conversation_key: `telegram:${ctx.instanceId}:user:${userId}`,
        message_id: String(message_id),
        sender: { raw_id: String(userId), raw_username: from && from.username },
        content: { text, attachments },
        delivery: 'sync',
        capabilities: meta.capabilities,
        public: false, // 1:1 DM with the authorized user; redaction still applies if they're not full-trust
        channel_context: { chatId },
      });
      for (const a of actions) {
        if (a.type === 'reply') await sendChunked(bot, chatId, a.text);
        else if (a.type === 'status') await bot.sendMessage(chatId, `_${a.text}_`, { parse_mode: 'Markdown' }).catch(() => {});
        // notify/suppress: not surfaced to the user
      }
    } catch (e) {
      ctx.log(`handle failed: ${e.message}`);
      bot.sendMessage(chatId, `⚠️ ${e.message}`).catch(() => {});
    }
  }

  bot.on('message', async (msg) => {
    ctx.heartbeat(); // an inbound update proves the poll loop delivered I/O
    if (msg.from && msg.from.is_bot) return;
    const chatId = msg.chat.id;
    const userId = (msg.from && (msg.from.username || msg.from.id)) || String(chatId);
    if (!authorized(chatId)) { bot.sendMessage(chatId, '🔒 Access denied.'); return; }

    const attachments = [];
    const caption = msg.text || msg.caption || '';
    const savedNotes = []; // "saved at <path>" lines handed to the model for any non-inline file

    // Download a Telegram file by file_id → Buffer. (Bot API can only fetch files up to ~20MB.)
    const dl = async (fileId) => {
      const file = await bot.getFile(fileId);
      return Buffer.from(await (await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`)).arrayBuffer());
    };
    // Register ANY inbound file on the shared, channel-agnostic upload surface (tagged
    // channel=telegram) so a session on ANY channel can find it later, then note its path.
    const register = (buf, { filename, mime, kind }) => {
      const rec = ctx.uploads.save({
        channel: 'telegram', instance: ctx.instanceId, buffer: buf,
        filename, mime, kind, caption: msg.caption || '',
        sender: (msg.from && msg.from.username) || String(userId), senderId: userId,
        conversationKey: `telegram:${ctx.instanceId}:user:${userId}`,
      });
      savedNotes.push(`- ${kind || 'file'}: ${rec.filename} (${rec.mime}, ${ctx.uploads.humanSize(rec.size)}) → ${rec.path}`);
      return rec;
    };

    // Handle EVERY attachment kind Telegram sends — not just photos (the old code silently
    // dropped documents/audio/video, which is why "find the recording I sent" failed).
    try {
      if (msg.photo && msg.photo.length) { // Telegram re-encodes photos to JPEG; largest = last
        const buf = await dl(msg.photo[msg.photo.length - 1].file_id);
        const rec = register(buf, { filename: `photo_${Date.now()}.jpg`, mime: 'image/jpeg', kind: 'image' });
        try { fs.mkdirSync(photoDir, { recursive: true }); fs.writeFileSync(path.join(photoDir, rec.stored_name), buf); } catch (_) {} // legacy copy some tools reference
        if (buf.length <= 5 * 1024 * 1024) attachments.push({ type: 'image', media_type: 'image/jpeg', data: buf.toString('base64'), name: rec.filename, path: rec.path });
        ctx.log(`photo: ${buf.length}b -> vision + ${rec.path}`);
      }
      if (msg.document) { const d = msg.document; const buf = await dl(d.file_id);
        const rec = register(buf, { filename: d.file_name || `document_${Date.now()}`, mime: d.mime_type, kind: 'document' });
        if ((d.mime_type || '').startsWith('image/') && buf.length <= 5 * 1024 * 1024) attachments.push({ type: 'image', media_type: d.mime_type, data: buf.toString('base64'), name: rec.filename, path: rec.path });
        ctx.log(`document: ${rec.filename} -> ${rec.path}`);
      }
      if (msg.audio) { const a = msg.audio; register(await dl(a.file_id), { filename: a.file_name || `audio_${Date.now()}.mp3`, mime: a.mime_type || 'audio/mpeg', kind: 'audio' }); }
      if (msg.voice) { const v = msg.voice; register(await dl(v.file_id), { filename: `voice_${Date.now()}.ogg`, mime: v.mime_type || 'audio/ogg', kind: 'voice' }); }
      if (msg.video) { const v = msg.video; register(await dl(v.file_id), { filename: v.file_name || `video_${Date.now()}.mp4`, mime: v.mime_type || 'video/mp4', kind: 'video' }); }
      if (msg.video_note) { register(await dl(msg.video_note.file_id), { filename: `videonote_${Date.now()}.mp4`, mime: 'video/mp4', kind: 'video' }); }
      if (msg.animation) { const v = msg.animation; register(await dl(v.file_id), { filename: v.file_name || `animation_${Date.now()}.mp4`, mime: v.mime_type || 'video/mp4', kind: 'video' }); }
    } catch (e) {
      const big = /too big|file is too big/i.test(e.message || '');
      ctx.log(`attachment download failed: ${e.message}`);
      savedNotes.push(`- ⚠️ an attachment couldn't be downloaded: ${e.message}${big ? ' (Telegram bots can only fetch files up to 20MB)' : ''}`);
    }

    const route = { chatId, userId, from: msg.from, message_id: msg.message_id };
    // An album (media_group_id) is buffered and dispatched as one turn once the group goes quiet; a
    // standalone message dispatches immediately.
    if (msg.media_group_id) {
      albums.add(String(msg.media_group_id), { attachments, savedNotes, caption, route });
      return;
    }
    await dispatch({ ...route, text: caption, attachments, savedNotes });
  });

  bot.on('polling_error', (e) => {
    ctx.log(`polling_error: ${e.code || e.message}`);
    if (isFatalPollingError(e)) {
      // node-telegram-bot-api marks unrecoverable failures with code EFATAL; when it fires the
      // internal poll loop has stopped and never resumes, so the process stays alive but deaf. Exit
      // so the manager's supervisor respawns a fresh poller (backoff, gives up after its max).
      ctx.log('fatal polling error, exiting so the manager respawns the connector');
      setTimeout(() => process.exit(1), 500); // let the log line flush first
    }
  });

  // Poll-cycle heartbeat: node-telegram-bot-api stamps bot._polling._lastUpdate on every successful
  // getUpdates, message or not. We heartbeat only when that timestamp ADVANCES, so a healthy-but-quiet
  // bot stays alive & an EFATAL-dead loop (the 2026-07-16 case: _lastUpdate froze while the pid lived)
  // stops heartbeating and goes stale. This is the liveness signal, not a timer that fires regardless.
  const { HEARTBEAT_INTERVAL_MS } = require('../../manager/health');
  let lastSeenUpdate = 0;
  const hbTimer = setInterval(() => {
    const at = bot._polling && bot._polling._lastUpdate;
    if (at && at !== lastSeenUpdate) { lastSeenUpdate = at; ctx.heartbeat(); }
  }, HEARTBEAT_INTERVAL_MS);
  hbTimer.unref();

  // --- outbound HTTP endpoints (transport other tools depend on) -------------
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const target = () => (allowed.size ? [...allowed][0] : learnedChat);
  app.get('/health', (req, res) => res.json({ status: 'healthy', type: 'telegram', instance: ctx.instanceId }));
  app.post('/send', async (req, res) => {
    try { const m = await bot.sendMessage(target(), req.body.message, req.body.options || {}); res.json({ ok: true, messageId: m.message_id }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/send-photo', async (req, res) => {
    try { const m = await bot.sendPhoto(target(), req.body.photoPath, { caption: req.body.caption || '' }); res.json({ ok: true, messageId: m.message_id }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/send-document', async (req, res) => {
    try { const m = await bot.sendDocument(target(), req.body.documentPath, { caption: req.body.caption || '' }); res.json({ ok: true, messageId: m.message_id }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // Unified outbound endpoint (the manager /send router calls this).
  app.post('/out', async (req, res) => {
    try {
      const { kind = 'text', target: tg, text, path: filePath, caption } = req.body || {};
      const to = tg || target();
      let m;
      // 'file' is the standard attachment kind: route by MIME — an image/* goes as a Telegram photo
      // (inline preview), anything else as a document. Previously 'file' fell through to sendMessage
      // with an undefined body → "message text is empty". 'photo'/'document' force a specific send.
      if (kind === 'file') {
        m = isImage(filePath)
          ? await bot.sendPhoto(to, filePath, { caption: caption || '' })
          : await bot.sendDocument(to, filePath, { caption: caption || '' });
      } else if (kind === 'photo') m = await bot.sendPhoto(to, filePath, { caption: caption || '' });
      else if (kind === 'document') m = await bot.sendDocument(to, filePath, { caption: caption || '' });
      else m = await bot.sendMessage(to, text);
      // Report the destination conversation_key (matches an inbound from the same chat) so a
      // core-mediated send can assimilate a cross-posted message into that session — channel-agnostic.
      res.json({ ok: true, messageId: m.message_id, conversation_key: `telegram:${ctx.instanceId}:user:${to}` });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  const httpServer = app.listen(cfg.http_port || 3008, '127.0.0.1', () => ctx.log(`outbound HTTP on :${cfg.http_port || 3008}`));

  ctx.log('telegram connector started (polling)');
  return {
    async stop() { clearInterval(hbTimer); albums.stop(); try { await bot.stopPolling(); } catch (_) {} try { httpServer.close(); } catch (_) {} },
    health() { return { polling: true, http_port: cfg.http_port || 3008 }; },
  };
}

async function sendChunked(bot, chatId, textRaw) {
  const text = String(textRaw || '');
  const MAX = 3900;
  if (text.length <= MAX) { await bot.sendMessage(chatId, text).catch(async () => { await bot.sendMessage(chatId, text, {}); }); return; }
  for (let i = 0; i < text.length; i += MAX) await bot.sendMessage(chatId, text.slice(i, i + MAX)).catch(() => {});
}

// node-telegram-bot-api sets e.code === 'EFATAL' on an unrecoverable polling failure (the loop has
// stopped and won't resume). Recoverable errors (ETELEGRAM, ETIMEDOUT, network blips) keep polling.
function isFatalPollingError(e) { return !!e && e.code === 'EFATAL'; }

module.exports = { meta, start, isFatalPollingError };
