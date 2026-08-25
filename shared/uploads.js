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
function save(a) {
  if (!a || !a.channel) throw new Error('uploads.save: channel required');
  if (!Buffer.isBuffer(a.buffer)) throw new Error('uploads.save: buffer required');
  const slot = place(a.channel, a.filename);
  fs.writeFileSync(slot.abs, a.buffer);
  return register(slot, a, a.buffer.length);
}

/** Allocate the on-disk destination for one inbound file: <uploads>/<channel>/<ts>-<sanitized name>. */
function place(channel, filename) {
  const ts = Date.now();
  const dir = path.join(baseDir(), channel);
  fs.mkdirSync(dir, { recursive: true });
  const stored = `${ts}-${sanitize(filename)}`;
  return { ts, id: ts.toString(36) + '-' + crypto.randomBytes(3).toString('hex'), stored, abs: path.join(dir, stored) };
}

/**
 * Build the manifest record for a file ALREADY sitting at `slot.abs`, and append it. Single writer
 * for every entry point (save / saveFrom / finishChunked) so the record shape can't drift between them.
 */
function register(slot, a, size, sha256) {
  const rec = {
    id: slot.id, ts: slot.ts, iso: new Date(slot.ts).toISOString(),
    channel: a.channel, instance: a.instance || null,
    sender: a.sender || null, sender_id: a.senderId != null ? String(a.senderId) : null,
    conversation_key: a.conversationKey || null,
    filename: a.filename || slot.stored, stored_name: slot.stored, path: slot.abs,
    mime: a.mime || 'application/octet-stream', size,
    kind: a.kind || null, caption: a.caption || null,
  };
  if (sha256) rec.sha256 = sha256;
  // Best-effort, but never silent: a file that lands on disk without a manifest line is invisible to
  // list()/get()/recentSummary(), so "find the recording I sent you" fails on every other channel with
  // nothing anywhere to explain why. Matches core/src/emitter.js, which logs its JSONL append failures.
  try { fs.appendFileSync(manifestPath(), JSON.stringify(rec) + '\n'); }
  catch (err) {
    console.error(`[uploads] manifest append failed for ${rec.id} (${rec.path}):`, err.message);
    rec.unindexed = true;
  }
  return rec;
}

/**
 * Register a file that is ALREADY on disk, by moving it into the shared area. Same result as `save()`
 * without ever holding the bytes in a Buffer, so file size stops being bounded by process memory.
 * @param {object} a  same fields as save(), except `tempPath` replaces `buffer`
 * @returns {object} the manifest record
 */
function saveFrom(a) {
  if (!a || !a.channel) throw new Error('uploads.saveFrom: channel required');
  if (!a.tempPath) throw new Error('uploads.saveFrom: tempPath required');
  const size = fs.statSync(a.tempPath).size;
  const slot = place(a.channel, a.filename);
  try {
    fs.renameSync(a.tempPath, slot.abs);          // atomic within one filesystem: no half-written file is ever visible
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    // Staging lives on another filesystem. Load-bearing, not defensive: baseDir() is the Self silo and
    // stagingDir() is outside it, so an operator who relocates either one puts a mount boundary here.
    fs.copyFileSync(a.tempPath, slot.abs); fs.unlinkSync(a.tempPath);
  }
  return register(slot, a, size, a.sha256);
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
  if (o.sinceMs) items = items.filter((r) => r.ts >= o.sinceMs);
  if (o.sender) { const s = o.sender.toLowerCase(); items = items.filter((r) => `${r.sender || ''} ${r.sender_id || ''}`.toLowerCase().includes(s)); }
  if (o.query) { const q = o.query.toLowerCase(); items = items.filter((r) => `${r.filename} ${r.caption || ''} ${r.channel}`.toLowerCase().includes(q)); }
  items.sort((a, b) => b.ts - a.ts);
  return o.limit === 0 ? items : items.slice(0, o.limit || 20);
}

function get(id) { return readManifest().find((r) => r.id === id) || null; }

/** Compact newest-first summary for injecting into a session's context. */
function recentSummary(n = 8) {
  const items = list({ limit: n });
  if (!items.length) return '';
  return items.map((r) => {
    const when = r.iso.replace('T', ' ').slice(0, 16) + ' UTC';
    const cap = r.caption ? ` "${r.caption.slice(0, 60)}"` : '';
    return `- [${r.channel}] ${when} · ${r.sender || '?'} · ${r.filename} (${r.mime}, ${humanSize(r.size)})${cap} → ${r.path}`;
  }).join('\n');
}

/* ── Chunked uploads ────────────────────────────────────────────────────────────────────────────
 * Why: the one-shot path needs the whole file in memory at once (a Buffer here, a base64 string in
 * the browser AND in the JSON body), so the maximum upload size is set by the smallest body limit on
 * the path (nginx's 1 MiB default), minus base64's 33% tax. Chunking makes the wire unit a fixed
 * chunk instead of the file, so file size stops being a limit at all, and a dropped connection
 * resumes from the chunks already received instead of restarting at zero.
 *
 * Lifecycle: beginChunked → putChunk × N (any order, retries are idempotent) → finishChunked.
 * Chunks stage under stagingDir()/<upload_id>/ and are assembled one chunk at a time, so peak
 * memory is one chunk regardless of file size. Nothing reaches the manifest until finish succeeds,
 * so `list()` never hands the agent a path to a half-written file.
 *
 * Storage-driver constraint (tracked follow-up, NOT solved here): baseDir() resolves to the Self silo
 * via silo.selfSub(), and that function's own comment says writers should go through the driver
 * (Silo.put) rather than the raw path once a silo is encrypted or backed by a remote driver. Chunked
 * uploads reach the silo through exactly one raw-path write — saveFrom()'s rename/copy of the finished
 * file — because staging deliberately sits outside the silo. Whoever converts artifacts to the driver
 * has one call site to change here, not one per chunk.
 */

const ID_RE = /^[a-z0-9]+-[0-9a-f]{6}$/;   // server-minted ids only; anything else can't name a directory

function chunkSize() { return Number(process.env.ASMLTR_UPLOAD_CHUNK_SIZE) || 8 * 1024 * 1024; }
// A declared size is a claim, not bytes: it costs a client nothing to assert one. Without a bound,
// `size: Number.MAX_SAFE_INTEGER` plans 1.07e9 chunks and finishChunked walks every index looking for
// what is missing, pinning the event loop for the whole core with zero bytes uploaded.
function maxSize() { return Number(process.env.ASMLTR_UPLOAD_MAX_SIZE) || 128 * 1024 * 1024 * 1024; }
/*
 * Where in-flight chunks live. Deliberately NOT under baseDir(): baseDir() resolves to the Self silo,
 * which is both the artifact store a user browses in the Silos GUI and a directory scripts/backup.js
 * copies wholesale into every snapshot. A half-written upload is neither an artifact nor worth
 * archiving — staged under the silo, an abandoned partial rides into every backup taken before
 * sweepPartials() reaps it, up to 24h later, at full file size.
 *
 * Keep this on the SAME filesystem as baseDir(). finishChunked() hands the assembled file to
 * saveFrom(), which renames it into place; across a mount boundary that rename degrades to a full
 * copy (correct, via the EXDEV branch, just no longer free). That is what the override is for: point
 * ASMLTR_UPLOAD_STAGING_DIR at the same volume as ASMLTR_UPLOADS_DIR when uploads are relocated.
 */
function stagingDir() {
  return process.env.ASMLTR_UPLOAD_STAGING_DIR || path.join(os.homedir(), '.asmltr', 'uploads-partial');
}
function sessionDir(id) { return path.join(stagingDir(), id); }

/** Errors carry a stable `code` so HTTP callers switch on that instead of matching message prose. */
function uploadError(code, message) { return Object.assign(new Error(message), { code }); }

/** Remove a staging dir. Returns whether it is actually gone, and says so when it isn't. */
function discard(id) {
  try { fs.rmSync(sessionDir(id), { recursive: true, force: true }); return true; }
  catch (e) { console.error(`[uploads] could not discard staging for ${id}:`, e.message); return false; }
}

// null means "no such upload". An unreadable or corrupt meta.json is a DIFFERENT condition and must
// not masquerade as one: reporting a truncated meta.json as "unknown upload" sends a 404 for an
// upload the user just created, and the client declines to retry a 4xx.
function readMeta(id) {
  if (!ID_RE.test(String(id || ''))) return null;   // rejects traversal before the id reaches path.join
  let raw;
  try { raw = fs.readFileSync(path.join(sessionDir(id), 'meta.json'), 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return null;
    throw uploadError('BROKEN_UPLOAD', `uploads: cannot read upload ${id}: ${e.message}`);
  }
  try { return JSON.parse(raw); }
  catch { throw uploadError('BROKEN_UPLOAD', `uploads: upload ${id} has a corrupt meta.json`); }
}

/**
 * Indices already staged, ascending. A missing directory is legitimately empty; anything else is a
 * failure to READ, and returning [] for that told the client every chunk was missing when the bytes
 * were already on disk.
 */
function receivedIndices(id) {
  try {
    return fs.readdirSync(sessionDir(id)).filter((f) => /^\d+\.part$/.test(f))
      .map((f) => parseInt(f, 10)).sort((a, b) => a - b);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw uploadError('BROKEN_UPLOAD', `uploads: cannot list staged chunks for ${id}: ${e.message}`);
  }
}

// Accept only a literal non-negative integer. Number() alone is too permissive ('0x1' → 1), and a
// string that reaches path.join is how a chunk index becomes a path traversal.
function chunkIndexOf(v, chunks) {
  const n = typeof v === 'number' ? v
    : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN);
  if (!Number.isInteger(n) || n < 0) throw uploadError('BAD_INDEX', `uploads.putChunk: invalid chunk index ${JSON.stringify(v)}`);
  // Note `>= chunks` unconditionally: a zero-length upload has 0 chunks and must accept no index at
  // all, where a truthiness check would have skipped the bound entirely.
  if (n >= chunks) throw uploadError('BAD_INDEX', `uploads.putChunk: chunk index ${n} is past the end of the file (${chunks} chunks)`);
  return n;
}

/**
 * Open a chunked upload. Takes the same descriptive fields as `save()`, plus the declared `size`
 * (needed to know how many chunks to expect) and an optional `sha256` verified at finish.
 * @returns {{upload_id: string, chunk_size: number, chunks: number, received: number[]}}
 */
function beginChunked(a) {
  if (!a || !a.channel) throw uploadError('BAD_REQUEST', 'uploads.beginChunked: channel required');
  const size = Number(a.size);
  if (!Number.isInteger(size) || size < 0) throw uploadError('BAD_REQUEST', 'uploads.beginChunked: size must be a non-negative integer');
  if (size > maxSize()) {
    throw uploadError('BAD_REQUEST',
      `uploads.beginChunked: declared size ${size} is too large (maximum ${maxSize()}, set ASMLTR_UPLOAD_MAX_SIZE to raise it)`);
  }
  const cs = chunkSize();
  const ts = Date.now();
  const upload_id = ts.toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  fs.mkdirSync(sessionDir(upload_id), { recursive: true });
  const meta = {
    upload_id, ts, size, chunk_size: cs, chunks: Math.ceil(size / cs),
    channel: a.channel, filename: a.filename || null, mime: a.mime || null, sha256: a.sha256 || null,
    caption: a.caption || null, sender: a.sender || null, sender_id: a.senderId != null ? String(a.senderId) : null,
    instance: a.instance || null, conversation_key: a.conversationKey || null, kind: a.kind || null,
  };
  fs.writeFileSync(path.join(sessionDir(upload_id), 'meta.json'), JSON.stringify(meta));
  return { upload_id, chunk_size: cs, chunks: meta.chunks, received: [] };
}

/**
 * Stage one chunk. Re-sending an index overwrites it, so a retried chunk is safe.
 * @param {string} [sha256] optional digest of THIS chunk. Verifying per chunk is what makes the
 *   integrity promise real without ever hashing the whole file: a client that streams a large file
 *   cannot compute a whole-file digest without holding all of it, which is the thing chunking exists
 *   to avoid. A bad chunk is rejected on arrival rather than at assembly.
 */
function putChunk(uploadId, index, buffer, sha256) {
  const meta = readMeta(uploadId);
  if (!meta) throw uploadError('UNKNOWN_UPLOAD', `uploads.putChunk: unknown upload ${uploadId}`);
  if (!Buffer.isBuffer(buffer)) throw uploadError('BAD_REQUEST', 'uploads.putChunk: buffer required');
  const n = chunkIndexOf(index, meta.chunks);
  if (sha256) {
    const got = crypto.createHash('sha256').update(buffer).digest('hex');
    if (got !== String(sha256).toLowerCase()) {
      throw uploadError('INTEGRITY', `uploads.putChunk: chunk ${n} failed its checksum (got ${got}, expected ${sha256})`);
    }
  }
  fs.writeFileSync(path.join(sessionDir(meta.upload_id), `${n}.part`), buffer);
  const received = receivedIndices(meta.upload_id);
  return { ok: true, received_count: received.length, chunks: meta.chunks };
}

/** What the server already has, so a client can resume instead of restarting. Null if unknown. */
function chunkStatus(uploadId) {
  const meta = readMeta(uploadId);
  if (!meta) return null;
  return {
    upload_id: meta.upload_id, filename: meta.filename, size: meta.size,
    chunk_size: meta.chunk_size, chunks: meta.chunks, received: receivedIndices(meta.upload_id),
  };
}

/**
 * Assemble the staged chunks, verify them, and register the result in the manifest.
 * @returns {object} the manifest record, same shape `save()` returns (plus `sha256`)
 */
function finishChunked(uploadId, opts = {}) {
  const meta = readMeta(uploadId);
  if (!meta) throw uploadError('UNKNOWN_UPLOAD', `uploads.finishChunked: unknown upload ${uploadId}`);

  // Count what is missing without materializing an index per chunk: only the first few are ever
  // reported, and the array was the expensive part of an oversized declared size.
  const have = new Set(receivedIndices(meta.upload_id));
  const firstMissing = [];
  let missingCount = 0;
  for (let i = 0; i < meta.chunks; i++) {
    if (have.has(i)) continue;
    missingCount++;
    if (firstMissing.length < 10) firstMissing.push(i);
  }
  if (missingCount) {
    throw uploadError('MISSING_CHUNKS', `uploads.finishChunked: missing chunk${missingCount > 1 ? 's' : ''} ` +
      `${firstMissing.join(',')}${missingCount > firstMissing.length ? `… (${missingCount} total)` : ''}`);
  }

  const dir = sessionDir(meta.upload_id);
  const assembled = path.join(dir, 'assembled');
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(assembled, 'w');
  let size = 0;
  try {
    for (let i = 0; i < meta.chunks; i++) {          // one chunk resident at a time, never the whole file
      const b = fs.readFileSync(path.join(dir, `${i}.part`));
      fs.writeSync(fd, b); hash.update(b); size += b.length;
    }
  } finally { fs.closeSync(fd); }

  const digest = hash.digest('hex');
  const want = opts.sha256 || meta.sha256;
  // Check the bytes that actually reached the disk, not the bytes we meant to write. writeSync can
  // return a short count instead of throwing when the filesystem fills, and `size`/`hash` above are
  // both derived from the buffers, so on their own they would compare our input against itself.
  const onDisk = fs.statSync(assembled).size;
  // A failed check discards the staging dir: a corrupt upload should be re-sent, not retried forever.
  if (onDisk !== size) {
    discard(meta.upload_id);
    throw uploadError('INTEGRITY', `uploads.finishChunked: short write (${onDisk} of ${size} bytes reached disk, the upload area is probably full)`);
  }
  if (meta.size && size !== meta.size) {
    discard(meta.upload_id);
    throw uploadError('INTEGRITY', `uploads.finishChunked: size mismatch (assembled ${size}, declared ${meta.size})`);
  }
  if (want && want !== digest) {
    discard(meta.upload_id);
    throw uploadError('INTEGRITY', `uploads.finishChunked: checksum mismatch (got ${digest}, expected ${want})`);
  }

  const rec = saveFrom({
    ...meta, tempPath: assembled, sha256: digest,
    conversationKey: meta.conversation_key, senderId: meta.sender_id,
  });
  discard(meta.upload_id);
  return rec;
}

/** Throw away a partial upload. Returns false if there was nothing to discard, or the delete failed. */
function abortChunked(uploadId) {
  if (!ID_RE.test(String(uploadId || ''))) return false;      // same traversal guard as readMeta
  if (!fs.existsSync(sessionDir(uploadId))) return false;
  return discard(uploadId);                                   // works even when meta.json is corrupt
}

/**
 * Delete staging dirs older than maxAgeMs (abandoned uploads). Returns { removed, failed }; a sweep
 * that fails on every directory used to be indistinguishable from a sweep with nothing to do, which
 * is how a disk quietly fills.
 */
function sweepPartials(maxAgeMs = 24 * 3600 * 1000) {
  let names;
  try { names = fs.readdirSync(stagingDir()); }
  catch (e) {
    if (e.code !== 'ENOENT') console.error('[uploads] cannot read the partial-upload dir:', e.message);
    return { removed: 0, failed: 0 };
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0, failed = 0;
  for (const n of names) {
    const p = path.join(stagingDir(), n);
    try {
      if (fs.statSync(p).mtimeMs >= cutoff) continue;
      fs.rmSync(p, { recursive: true, force: true });
      removed++;
    } catch (e) { failed++; console.error(`[uploads] sweep could not remove ${p}:`, e.message); }
  }
  return { removed, failed };
}

module.exports = {
  save, saveFrom, list, get, recentSummary, readManifest, baseDir, manifestPath, humanSize,
  beginChunked, putChunk, chunkStatus, finishChunked, abortChunked, sweepPartials, chunkSize, stagingDir,
};
