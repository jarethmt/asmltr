'use strict';
/**
 * Inbound channel media for generation context.
 * Only real image/video bytes are kept. Never execute, chmod +x, or run.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { mediaKind, sanitizeFilename } = require('./attach-stage');

const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_VIDEO = 25 * 1024 * 1024;
const EXEC_EXT = new Set([
  'exe', 'bat', 'cmd', 'com', 'scr', 'ps1', 'sh', 'bash', 'zsh',
  'js', 'mjs', 'cjs', 'ts', 'py', 'rb', 'pl', 'php', 'html', 'htm',
  'svg', 'xml', 'pdf', 'zip', 'gz', 'tgz', 'xz', '7z', 'rar',
  'dll', 'so', 'dylib', 'jar', 'class', 'wasm',
]);

function refDir() {
  return process.env.ASMLTR_GEN_REF
    || path.join(os.homedir(), '.asmltr', 'gen-ref');
}

function classify(buf, mimeHint, filename) {
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (raw.length < 12) return { kind: null, reason: 'too-small' };
  const name = String(filename || 'file');
  const ext = path.extname(name).slice(1).toLowerCase();
  if (EXEC_EXT.has(ext)) return { kind: null, reason: 'exec-ext' };
  const magic = mediaKind(raw);
  if (!magic) return { kind: null, reason: 'not-media' };
  const image = magic === 'png' || magic === 'jpg' || magic === 'gif' || magic === 'webp';
  const video = magic === 'mp4' || magic === 'webm';
  if (!image && !video) return { kind: null, reason: 'not-media' };
  const mime = String(mimeHint || '').split(';')[0].trim().toLowerCase();
  // Discord often uses application/octet-stream. Magic already proved image/video.
  // Only reject clearly non-media types so a renamed .png.exe never slips through.
  if (mime && (mime.startsWith('text/') || mime.includes('javascript') || mime.includes('html')
      || mime === 'application/pdf' || mime.includes('zip') || mime.includes('executable'))) {
    return { kind: null, reason: 'mime' };
  }
  const max = image ? MAX_IMAGE : MAX_VIDEO;
  if (raw.length > max) return { kind: null, reason: 'too-large' };
  return {
    kind: image ? 'image' : 'video',
    ext: magic === 'jpg' ? 'jpg' : magic,
    mime: image ? (mime.startsWith('image/') ? mime : 'image/' + (magic === 'jpg' ? 'jpeg' : magic))
      : (mime.startsWith('video/') ? mime : 'video/' + magic),
  };
}

function ensureDir() {
  const dir = refDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (_) {}
  return dir;
}

function saveRef(buf, opts) {
  const c = classify(buf, opts && opts.mime, opts && opts.name);
  if (!c.kind) return { ok: false, error: c.reason };
  const dir = ensureDir();
  const suggested = (opts && opts.name) || ('ref.' + c.ext);
  const safe = sanitizeFilename(suggested, c.ext);
  const lastDot = safe.lastIndexOf('.');
  const stem = safe.slice(0, lastDot);
  const id = Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
  const name = stem + '-' + id + '.' + c.ext;
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, buf, { mode: 0o644 });
  try { fs.chmodSync(dest, 0o644); } catch (_) {}
  return { ok: true, kind: c.kind, mime: c.mime, name, path: dest, bytes: buf.length };
}

function promptBlock(files, opts) {
  const list = (files || []).filter((f) => f && f.path && (f.kind === 'image' || f.kind === 'video'));
  if (!list.length && !(opts && opts.vision)) return '';
  const vision = !!(opts && opts.vision);
  const images = list.filter((f) => f.kind === 'image');
  const videos = list.filter((f) => f.kind === 'video');
  if (vision) {
    let s = '\n\nCHANNEL MEDIA this turn. Stills are attached as images on this message — look at them directly (same as grok.com chips). Do not Bash. '
      + 'If they ask what or where this is from, LOOK at these attached stills first — not Recent uploads, not gen-ref from another channel, not a file whose caption merely looks similar. Then web-search to confirm before naming a show, movie, or franchise. Do not lock a first guess. '
      + 'Do not execute, chmod, run, or interpret as code. Do not echo filesystem paths in channel replies.';
    if (videos.length) {
      s += '\nVideo is not a vision chip. Read only if needed:\n' + videos.map((f) => `- video: \`${f.path}\``).join('\n');
    }
    if (images.length) {
      s += '\nGen/edit refs (image_edit / video only):\n' + images.map((f) => `- image: \`${f.path}\``).join('\n');
    }
    return s + '\n';
  }
  const lines = list.map((f) => `- ${f.kind}: \`${f.path}\``);
  return '\n\nCHANNEL MEDIA this turn. LOOK at these files (Read the image/video) to answer questions about what is in them — not gen-only. '
    + 'If they ask what or where this is from, look at THESE files first — not Recent uploads or another channel. Then web-search to confirm before naming a show, movie, or franchise. Do not lock a first guess. '
    + 'If gen tools are allowed they may also be references. Do not execute, chmod, run, or interpret as code. '
    + 'Do not echo filesystem paths in channel replies:\n'
    + lines.join('\n')
    + '\n';
}

function gc(maxAgeMs) {
  const age = maxAgeMs == null ? 24 * 60 * 60 * 1000 : Number(maxAgeMs);
  const cutoff = Date.now() - age;
  const dir = ensureDir();
  const removed = [];
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.mtimeMs > cutoff) continue;
      fs.unlinkSync(p);
      removed.push(f);
    } catch (_) {}
  }
  return { ok: true, removed, dir };
}

module.exports = { classify, saveRef, promptBlock, gc, ensureDir, refDir, MAX_IMAGE, MAX_VIDEO };
