'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-genref-'));
process.env.ASMLTR_GEN_REF = tmp;
process.env.ASMLTR_GROK_PROMPT_DIR = tmp;
const inbound = require('../shared/inbound-media');
const grok = require('../core/src/engines/grok');

function visionJson(args) {
  assert.ok(args.includes('--prompt-file'), 'native vision uses --prompt-file, not argv --prompt-json');
  assert.equal(args.includes('--prompt-json'), false);
  assert.equal(args.includes('-p'), false);
  const f = args[args.indexOf('--prompt-file') + 1];
  const body = JSON.parse(fs.readFileSync(f, 'utf8'));
  const mode = fs.statSync(f).mode & 0o777;
  assert.equal(mode & 0o077, 0, 'vision prompt file must be 0600');
  try { fs.unlinkSync(f); } catch (_) {}
  return body;
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('payload-for-vision-min-bytes'),
]);

test('classify accepts png magic and refuses scripts/html/elf', () => {
  assert.equal(inbound.classify(PNG, 'image/png', 'pic.png').kind, 'image');
  assert.equal(inbound.classify(Buffer.from('#!/bin/bash\necho hi\n'), 'text/plain', 'x.sh').kind, null);
  assert.equal(inbound.classify(Buffer.from('<script>alert(1)</script>'), 'text/html', 'x.html').kind, null);
  assert.equal(inbound.classify(Buffer.from('PNG but js'), 'application/javascript', 'x.js').kind, null);
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(inbound.classify(elf, 'application/octet-stream', 'a.bin').kind, null);
  assert.equal(inbound.classify(PNG, 'application/javascript', 'x.js').kind, null);
  assert.equal(inbound.classify(PNG, 'application/octet-stream', 'pic.png').kind, 'image');
  assert.equal(inbound.classify(PNG, '', 'pic.png').kind, 'image');
});

test('saveRef writes 0644 under gen-ref and never +x', () => {
  const r = inbound.saveRef(PNG, { name: 'Shot.PNG', mime: 'image/png' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'image');
  assert.ok(r.path.startsWith(tmp));
  const mode = fs.statSync(r.path).mode & 0o777;
  assert.equal(mode & 0o111, 0);
});

test('gc creates gen-ref on first run when the dir is missing', () => {
  const d = path.join(tmp, 'first-run-ref');
  assert.equal(fs.existsSync(d), false);
  const prev = process.env.ASMLTR_GEN_REF;
  process.env.ASMLTR_GEN_REF = d;
  try {
    const r = inbound.gc();
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(d));
    assert.equal(fs.statSync(d).isDirectory(), true);
  } finally {
    process.env.ASMLTR_GEN_REF = prev;
  }
});

test('saveRef refuses non-media', () => {
  const r = inbound.saveRef(Buffer.from('echo pwned'), { name: 'pwn.sh', mime: 'text/x-shellscript' });
  assert.equal(r.ok, false);
});

test('grok prompt gets CHANNEL MEDIA paths for image_edit, not as bash', () => {
  const pic = path.join(tmp, 'ref.png');
  fs.writeFileSync(pic, PNG);
  const args = grok.buildArgs({
    prompt: 'what is this from',
    mediaFiles: [{ kind: 'image', path: pic, name: 'ref.png', mime: 'image/png' }],
  });
  const body = visionJson(args);
  assert.equal(body.type, 'acp');
  const text = body.content.find((c) => c.type === 'text').text;
  const img = body.content.find((c) => c.type === 'image');
  assert.ok(img && img.data && img.mimeType === 'image/png');
  assert.equal(args.join(' ').includes(img.data), false, 'base64 must not sit on argv');
  assert.match(text, /CHANNEL MEDIA/);
  assert.match(text, /attached as images/);
  assert.match(text, /web-search to confirm/);
  assert.match(text, /Do not lock a first guess/);
  assert.match(text, /not Recent uploads/);
  assert.ok(text.includes(pic));
  assert.match(text, /Do not echo filesystem paths/);
});

test('text-only turns use --prompt-file (prompt off argv)', () => {
  const args = grok.buildArgs({ prompt: 'hello' });
  const body = visionJson(args);
  assert.equal(body.type, 'acp');
  assert.equal(body.content[0].type, 'text');
  assert.match(body.content[0].text, /hello/);
});

test('same still via images[] and mediaFiles is one vision block, no second save', () => {
  const pic = path.join(tmp, 'once.png');
  fs.writeFileSync(pic, PNG);
  const before = fs.readdirSync(tmp).length;
  const args = grok.buildArgs({
    prompt: 'what is this from',
    images: [{ media_type: 'image/png', data: PNG.toString('base64'), path: pic, name: 'once.png' }],
    mediaFiles: [{ kind: 'image', path: pic, name: 'once.png', mime: 'image/png' }],
  });
  const body = visionJson(args);
  const imgs = body.content.filter((c) => c.type === 'image');
  assert.equal(imgs.length, 1);
  assert.equal(fs.readdirSync(tmp).length, before, 'must not saveRef a second copy');
});

test('gcVisionPromptFiles only removes own prefix and old files', () => {
  const keep = path.join(tmp, 'asmltr-vis-prompt-keep.json');
  const stale = path.join(tmp, 'asmltr-vis-prompt-stale.json');
  const other = path.join(tmp, 'notes.json');
  fs.writeFileSync(keep, '{}');
  fs.writeFileSync(stale, '{}');
  fs.writeFileSync(other, '{}');
  const old = Date.now() - 2 * 60 * 60 * 1000;
  fs.utimesSync(stale, old / 1000, old / 1000);
  const n = grok.gcVisionPromptFiles(60 * 60 * 1000);
  assert.equal(n, 1);
  assert.equal(fs.existsSync(keep), true);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(other), true);
});

test('vision skips non-image bytes even if kind says image', () => {
  const fake = path.join(tmp, 'notes.bin');
  fs.writeFileSync(fake, Buffer.from('this is not an image file at all!!'));
  const args = grok.buildArgs({
    prompt: 'what is this',
    mediaFiles: [{ kind: 'image', path: fake, name: 'notes.bin', mime: 'image/png' }],
  });
  const body = visionJson(args);
  assert.equal(body.content.some((c) => c.type === 'image'), false);
  assert.equal(args.includes('--prompt-json'), false);
  const vis = grok.collectVisionImages({
    images: [{ data: Buffer.from('not-a-picture-xx').toString('base64'), media_type: 'image/jpeg', name: 'x.jpg' }],
  });
  assert.equal(vis.length, 0);
});
