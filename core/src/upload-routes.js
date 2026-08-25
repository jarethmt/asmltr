'use strict';
/**
 * Chunked upload routes for the shared upload surface.
 *
 * The one-shot `/v2/upload` posts the whole file as base64 inside the JSON body, so the largest file
 * anyone can send is set by the smallest body limit on the path (nginx's 1 MiB default) minus base64's
 * 33% overhead. These routes make the wire unit a fixed-size chunk instead of the file, so file size
 * stops being a limit: a proxy only ever sees one chunk, memory only ever holds one chunk, and an
 * interrupted transfer resumes from what already landed.
 *
 *   POST   /v2/upload/init        { filename, mime, size, sha256?, conversation_key? }
 *                                 → { ok, upload_id, chunk_size, chunks, received }
 *   PUT    /v2/upload/:id/:index  raw application/octet-stream chunk bytes
 *                                 → { ok, received_count, chunks }
 *   GET    /v2/upload/:id         → { upload_id, size, chunk_size, chunks, received }   (resume)
 *   POST   /v2/upload/:id/finish  { sha256? } → { ok, file }   same `file` shape /v2/upload returns
 *   DELETE /v2/upload/:id         → { ok }
 *
 * `/v2/upload` is left in place: connectors and any older client keep working unchanged.
 */

const express = require('express');
const uploads = require('../../shared/uploads');

// Safety bound on ONE chunk body, deliberately independent of the advertised chunk_size: the server
// can raise or lower its recommendation without a client hitting a body-parser wall on a chunk in flight.
// A typo here used to be silent: bytes.parse('64 mib') returns null and body-parser then applies NO
// limit at all, quietly removing the bound this is here to set.
function maxChunkBody() {
  const raw = process.env.ASMLTR_UPLOAD_MAX_CHUNK;
  if (!raw) return '64mb';
  if (require('bytes').parse(raw) == null) {
    console.error(`[core] ASMLTR_UPLOAD_MAX_CHUNK="${raw}" is not a valid size, falling back to 64mb`);
    return '64mb';
  }
  return raw;
}

const kindOf = (mime) => (/^image\//.test(mime || '') ? 'image' : 'document');

// shared/uploads tags its failures with a stable `code`; map those to what the client should DO.
// 409 = send the rest. 422 = the bytes are wrong, start over. 404 = this upload is gone.
// Matching on message prose instead would couple the HTTP contract to strings that interpolate
// client-supplied input, and would break on any reword.
const STATUS_BY_CODE = {
  UNKNOWN_UPLOAD: 404,
  MISSING_CHUNKS: 409,
  INTEGRITY: 422,
  BAD_INDEX: 400,
  BAD_REQUEST: 400,
  BROKEN_UPLOAD: 500,
};

// Everything at 500 is OUR fault (ENOSPC, EACCES, EIO). Log it with the id so the operator has a
// trail, and send the browser a message that says what to do instead of an absolute host path.
function fail(res, e, where, id) {
  const status = STATUS_BY_CODE[e.code] || 500;
  if (status >= 500) {
    console.error(`[core] ${where} failed${id ? ` (${id})` : ''}:`, e.stack || e.message);
    return res.status(status).json({ error: 'the upload failed on the server, see the core logs' });
  }
  res.status(status).json({ error: e.message });
}

/**
 * @param {import('express').Express} app
 * @param {object} [opts]
 * @param {Function} [opts.record]  event-stream recorder, same signature server.js uses
 */
function mountUploadRoutes(app, opts = {}) {
  const record = typeof opts.record === 'function' ? opts.record : () => {};
  const ownerOf = (req) => process.env.ASMLTR_WEB_OWNER_ID || req.get('X-Remote-User') || 'dashboard';

  app.post('/v2/upload/init', (req, res) => {
    try {
      const { filename, mime, size, sha256, conversation_key } = req.body || {};
      const n = Number(size);
      if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: 'size (integer bytes) required' });
      const s = uploads.beginChunked({
        channel: 'assistant-web', filename, mime, size: n, sha256,
        sender: 'dashboard', senderId: String(ownerOf(req)),
        conversationKey: conversation_key || null, kind: kindOf(mime),
      });
      res.json({ ok: true, ...s });
    } catch (e) { fail(res, e, 'upload init'); }   // mkdir/write failures here are 500s, not bad requests
  });

  // Raw bytes, so a chunk costs exactly its own size on the wire (no base64 inflation).
  // X-Chunk-Sha256 (optional) is verified against the bytes before they are staged.
  app.put('/v2/upload/:id/:index', express.raw({ type: () => true, limit: maxChunkBody() }), (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'empty chunk' });
      res.json(uploads.putChunk(req.params.id, req.params.index, req.body, req.get('X-Chunk-Sha256')));
    } catch (e) { fail(res, e, 'upload chunk', req.params.id); }
  });

  app.get('/v2/upload/:id', (req, res) => {
    try {
      const st = uploads.chunkStatus(req.params.id);
      if (!st) return res.status(404).json({ error: `unknown upload ${req.params.id}` });
      res.json(st);
    } catch (e) { fail(res, e, 'upload status', req.params.id); }
  });

  app.post('/v2/upload/:id/finish', (req, res) => {
    try {
      const rec = uploads.finishChunked(req.params.id, { sha256: (req.body || {}).sha256 });
      record({
        surface: 'assistant-web', session_id: rec.conversation_key || null, event_type: 'control',
        identity: String(ownerOf(req)), source: 'core',
        payload: { action: 'upload', name: rec.filename, path: rec.path, bytes: rec.size, chunked: true },
      });
      res.json({
        ok: true,
        file: { path: rec.path, name: rec.filename, mime: rec.mime, kind: rec.kind, bytes: rec.size, sha256: rec.sha256 },
      });
    } catch (e) { fail(res, e, 'upload finish', req.params.id); }
  });

  app.delete('/v2/upload/:id', (req, res) => {
    try { res.json({ ok: uploads.abortChunked(req.params.id) }); }
    catch (e) { fail(res, e, 'upload abort', req.params.id); }
  });

  // body-parser rejects an oversized chunk INSIDE the middleware, before any handler runs, so a route
  // try/catch cannot see it. Without this, express's default handler answers with HTML (and, when
  // NODE_ENV is not production, a stack trace carrying host paths) where every other route on this
  // surface returns { error }. The 413 is also the single most likely misconfiguration for this
  // feature, so it names the cause instead of just the number.
  //
  // Matched on method + path rather than mounted at '/v2/upload': a prefix mount also catches
  // express.json's error for the legacy one-shot POST /v2/upload, whose limit has nothing to do with
  // ASMLTR_UPLOAD_MAX_CHUNK, and would send an operator to raise the wrong knob.
  app.use((err, req, res, next) => {
    if (!IS_CHUNK_PUT(req) || res.headersSent) return next(err);
    if (err && err.type === 'entity.too.large') {
      console.error('[core] upload chunk rejected as too large:', req.path, err.message);
      return res.status(413).json({
        error: `chunk larger than the server's limit of ${maxChunkBody()} (raise ASMLTR_UPLOAD_MAX_CHUNK, and the proxy's client_max_body_size with it)`,
      });
    }
    console.error('[core] upload chunk request failed:', req.path, err && (err.stack || err.message));
    res.status(err && err.status >= 400 && err.status < 500 ? err.status : 500)
      .json({ error: 'the upload request could not be read' });
  });
}

// PUT /v2/upload/<id>/<index> only: the one route that carries a large raw body.
const IS_CHUNK_PUT = (req) => req.method === 'PUT' && /^\/v2\/upload\/[^/]+\/[^/]+\/?$/.test(req.path);

/**
 * Drop staging dirs left behind by uploads that were never finished. Unref'd so it never holds the
 * process open. Returns the timer for callers that want to stop it.
 */
function startPartialSweeper({ everyMs = 3600 * 1000, maxAgeMs = 24 * 3600 * 1000 } = {}) {
  const tick = () => {
    try {
      const { removed, failed } = uploads.sweepPartials(maxAgeMs);
      if (removed) console.log(`[core] swept ${removed} abandoned partial upload${removed > 1 ? 's' : ''}`);
      // A sweep that fails on everything must not read like a sweep with nothing to do.
      if (failed) console.error(`[core] partial upload sweep could not remove ${failed} staging dir(s)`);
    } catch (e) { console.error('[core] partial upload sweep:', e.message); }
  };
  tick();
  const t = setInterval(tick, everyMs);
  if (t.unref) t.unref();
  return t;
}

module.exports = { mountUploadRoutes, startPartialSweeper };
