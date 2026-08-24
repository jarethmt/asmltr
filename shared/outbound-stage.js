'use strict';
/**
 * Stage files for THIS-channel attach without Bash.
 * Post only files already in attach-stage (or generator output ingested into it).
 * Delete only after a confirmed post. Bounce GC > 1 day.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 25 * 1024 * 1024;
const MEDIA_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov']);

function stageDir() {
  return process.env.ASMLTR_ATTACH_STAGE
    || path.join(os.homedir(), '.asmltr', 'attach-stage');
}

function indexPath() {
  return path.join(stageDir(), 'index.json');
}

function ensureDir() {
  fs.mkdirSync(stageDir(), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(stageDir(), 0o700); } catch (_) {}
  if (!fs.existsSync(indexPath())) {
    fs.writeFileSync(indexPath(), JSON.stringify({ items: {} }, null, 2), { mode: 0o600 });
  }
}

function loadIndex() {
  ensureDir();
  try {
    const j = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    if (j && typeof j === 'object' && j.items && typeof j.items === 'object') return j;
  } catch (_) {}
  return { items: {} };
}

function saveIndex(idx) {
  ensureDir();
  const tmp = indexPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2));
  fs.renameSync(tmp, indexPath());
}

function real(p) {
  return fs.realpathSync(p);
}

function inside(root, p) {
  let r, x;
  try { r = real(root); x = real(p); } catch { return false; }
  const sep = path.sep;
  return x === r || x.startsWith(r.endsWith(sep) ? r : r + sep);
}

function sanitizeFilename(input, fallbackExt) {
  const raw = String(input || '').trim() || 'file';
  const base = path.basename(raw).toLowerCase();
  const lastDot = base.lastIndexOf('.');
  let stem = lastDot > 0 ? base.slice(0, lastDot) : base;
  let ext = lastDot > 0 ? base.slice(lastDot + 1) : String(fallbackExt || 'bin');
  stem = stem.replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  ext = ext.replace(/[^a-z0-9]+/g, '');
  if (!stem) stem = 'file';
  if (!ext) ext = 'bin';
  return stem + '.' + ext;
}

function extOf(name) {
  const s = sanitizeFilename(name);
  return s.slice(s.lastIndexOf('.') + 1);
}

function isMediaExt(name) {
  return MEDIA_EXT.has(extOf(name));
}

function mediaKind(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 6).toString('ascii') === 'GIF87a' || buf.slice(0, 6).toString('ascii') === 'GIF89a') return 'gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  return '';
}

function denyRoots() {
  const home = os.homedir();
  return [
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.asmltr', 'silos'),
    path.join(home, '.asmltr', 'secrets'),
    path.join(home, '.asmltr', 'auth'),
    path.join(home, '.grok', 'auth.json'),
    path.join(home, 'src', 'asmltr', 'core', 'data'),
  ];
}

function underDenied(abs) {
  for (const d of denyRoots()) {
    try {
      if (fs.existsSync(d) && inside(d, abs)) return true;
      if (fs.existsSync(d) && real(d) === abs) return true;
    } catch (_) {}
    if (String(abs).startsWith(d + path.sep) || abs === d) return true;
  }
  if (/(^|[\\/])\.env(\.|$)/i.test(abs)) return true;
  if (/\.(db|sqlite)(-wal|-shm)?$/i.test(abs)) return true;
  return false;
}

function ingestRoots() {
  const roots = [stageDir()];
  const extra = process.env.ASMLTR_ATTACH_INGEST;
  if (extra) {
    for (const p of String(extra).split(path.delimiter)) {
      if (p) roots.push(p);
    }
  }
  const cwd = process.env.ASMLTR_ATTACH_INGEST_CWD;
  if (cwd) {
    let resolved = path.resolve(cwd);
    try { resolved = fs.realpathSync(cwd); } catch (_) {}
    const home = os.homedir();
    if (resolved !== home && resolved !== path.resolve(home)) {
      roots.push(path.join(cwd, 'images'));
      roots.push(path.join(cwd, 'videos'));
    }
  }
  roots.push(path.join(os.homedir(), '.grok'));
  roots.push(path.join(os.homedir(), '.asmltr', 'gen-ref'));
  return roots;
}

/** Generator output or already-staged media. Never silo/secrets/home junk. */
function ingestAllowed(srcPath) {
  let abs;
  try { abs = real(srcPath); } catch { return false; }
  let st;
  try { st = fs.statSync(abs); } catch { return false; }
  if (!st.isFile() || st.size < 1 || st.size > MAX_BYTES) return false;
  if (underDenied(abs)) return false;
  const buf = Buffer.alloc(16);
  const fd = fs.openSync(abs, 'r');
  try { fs.readSync(fd, buf, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (!mediaKind(buf)) return false;
  if (inside(stageDir(), abs)) return true;
  for (const root of ingestRoots()) {
    try {
      if (fs.existsSync(root) && inside(root, abs)) {
        if (inside(stageDir(), root) || path.basename(root) === 'images' || path.basename(root) === 'videos') return true;
        if (/[/\\](images|videos)[/\\][^/\\]+$/i.test(abs)) return true;
      }
    } catch (_) {}
  }
  return false;
}

function uniqueName(name) {
  ensureDir();
  const safe = sanitizeFilename(name);
  const lastDot = safe.lastIndexOf('.');
  const stem = safe.slice(0, lastDot);
  const ext = safe.slice(lastDot + 1);
  let n = safe;
  let i = 2;
  const idx = loadIndex();
  while (fs.existsSync(path.join(stageDir(), n)) || idx.items[n]) {
    n = stem + '-' + i + '.' + ext;
    i += 1;
  }
  return n;
}

function assertStagedPath(p) {
  if (!p || !inside(stageDir(), p)) throw new Error('not a staged file');
  const abs = real(p);
  if (!inside(stageDir(), abs)) throw new Error('not a staged file');
  return abs;
}

/** Discord/Telegram /out file posts: attach-stage, gen-ref, uploads, silos. Not /etc, not $HOME. */
function outboundFileRoots() {
  const roots = [stageDir()];
  try { roots.push(require('./uploads').baseDir()); } catch (_) {}
  try { roots.push(require('./inbound-media').refDir()); } catch (_) {}
  try { roots.push(require('./silo').silosRoot()); } catch (_) {}
  return roots.filter(Boolean);
}

function outboundFileAllowed(p) {
  if (!p || String(p).split(/[/\\]/).includes('..')) return false;
  let abs;
  try { abs = real(p); } catch (_) { return false; }
  return outboundFileRoots().some((root) => inside(root, abs));
}

function resolveStagedName(name) {
  const base = path.basename(String(name || ''));
  if (!base || base !== String(name).replace(/^.*[/\\]/, '') || base.includes('..') || /[/\\]/.test(String(name))) {
    throw new Error('staged name only (no paths)');
  }
  const safe = sanitizeFilename(base);
  const abs = path.join(stageDir(), safe);
  if (!fs.existsSync(abs)) throw new Error('not staged: ' + safe);
  return { name: safe, path: assertStagedPath(abs) };
}

function stageFile(srcPath, opts) {
  const src = path.resolve(String(srcPath || ''));
  if (!ingestAllowed(src)) {
    throw new Error('refused: only generator images/videos or files already in attach-stage');
  }
  const suggested = (opts && opts.name) || path.basename(src);
  if (!isMediaExt(suggested) && !isMediaExt(src)) {
    throw new Error('refused: not an image/video');
  }
  const name = uniqueName(suggested);
  const dest = path.join(stageDir(), name);
  fs.copyFileSync(src, dest);
  assertStagedPath(dest);
  const st = fs.statSync(dest);
  const rec = {
    name,
    path: dest,
    source: src,
    bytes: st.size,
    created_at: Date.now(),
    complete: true,
    posted: false,
    posted_at: null,
    message_id: null,
    channel: (opts && opts.channel) || null,
    target: (opts && opts.target) || null,
  };
  const idx = loadIndex();
  idx.items[name] = rec;
  saveIndex(idx);
  return rec;
}

function preparePost(srcPath, opts) {
  const src = path.resolve(String(srcPath || ''));
  if (inside(stageDir(), src) || (fs.existsSync(src) && inside(stageDir(), src))) {
    const name = path.basename(src);
    const rec = get(name);
    if (rec && rec.path) {
      rec.path = assertStagedPath(rec.path);
      return rec;
    }
    return stageFile(src, opts);
  }
  return stageFile(src, opts);
}

function get(name) {
  const idx = loadIndex();
  const rec = idx.items[String(name)] || null;
  if (rec && rec.path) {
    try { rec.path = assertStagedPath(rec.path); } catch { return null; }
  }
  return rec;
}

function listUnposted() {
  const idx = loadIndex();
  return Object.values(idx.items).filter((r) => {
    if (!r || !r.complete || r.posted || !r.path) return false;
    try { assertStagedPath(r.path); } catch { return false; }
    return fs.existsSync(r.path);
  });
}

function markPosted(name, meta) {
  const idx = loadIndex();
  const rec = idx.items[String(name)];
  if (!rec) throw new Error('not staged: ' + name);
  rec.posted = true;
  rec.posted_at = Date.now();
  rec.message_id = (meta && meta.messageId) || rec.message_id || null;
  if (meta && meta.channel) rec.channel = meta.channel;
  if (meta && meta.target) rec.target = meta.target;
  saveIndex(idx);
  return rec;
}

function removePostedFile(name) {
  const idx = loadIndex();
  const rec = idx.items[String(name)];
  if (!rec) return { ok: false, error: 'not staged' };
  if (!rec.posted) return { ok: false, error: 'not posted yet — will not delete' };
  try {
    if (rec.path && fs.existsSync(rec.path) && inside(stageDir(), rec.path)) fs.unlinkSync(rec.path);
  } catch (e) {
    return { ok: false, error: e.message, rec };
  }
  delete idx.items[String(name)];
  saveIndex(idx);
  return { ok: true, name };
}

function gc(maxAgeMs) {
  const age = maxAgeMs == null ? DAY_MS : Number(maxAgeMs);
  const cutoff = Date.now() - age;
  ensureDir();
  const idx = loadIndex();
  const removed = [];
  for (const [name, rec] of Object.entries(idx.items)) {
    const t = Number(rec && rec.created_at) || 0;
    if (t && t > cutoff) continue;
    try {
      if (rec.path && fs.existsSync(rec.path) && inside(stageDir(), rec.path)) fs.unlinkSync(rec.path);
    } catch (_) {}
    delete idx.items[name];
    removed.push(name);
  }
  for (const f of fs.readdirSync(stageDir())) {
    if (f === 'index.json' || f.endsWith('.tmp')) continue;
    const p = path.join(stageDir(), f);
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      if (st.mtimeMs > cutoff) continue;
      if (idx.items[f]) continue;
      if (!inside(stageDir(), p)) continue;
      fs.unlinkSync(p);
      removed.push(f);
    } catch (_) {}
  }
  saveIndex(idx);
  return { ok: true, removed, dir: stageDir() };
}

module.exports = {
  DAY_MS, MAX_BYTES, stageDir, ensureDir, sanitizeFilename, uniqueName, stageFile,
  preparePost, ingestAllowed, assertStagedPath, resolveStagedName, outboundFileAllowed, outboundFileRoots,
  get, listUnposted, markPosted, removePostedFile, gc, isMediaExt, mediaKind,
};
