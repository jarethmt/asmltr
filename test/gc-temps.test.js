'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-gctemps-'));
process.env.ASMLTR_GROK_PROMPT_DIR = dir;
process.env.ASMLTR_GEN_REF = path.join(dir, 'gen-ref');
process.env.ASMLTR_ATTACH_STAGE = path.join(dir, 'stage');
const gc = require('../shared/gc-temps');
const grok = require('../core/src/engines/grok');

test('default vis-prompt dir is under ~/.asmltr (not /tmp) when env unset', () => {
  const prev = process.env.ASMLTR_GROK_PROMPT_DIR;
  delete process.env.ASMLTR_GROK_PROMPT_DIR;
  try {
    const p = gc.visPromptDir();
    assert.equal(p, path.join(os.homedir(), '.asmltr', 'vis-prompt'));
    assert.equal(p.startsWith(os.tmpdir() + path.sep), false);
    assert.equal(grok.visionPromptDir(), p);
  } finally {
    process.env.ASMLTR_GROK_PROMPT_DIR = prev;
  }
});

test('gcVisionPromptFiles only own prefix; grok buildArgs writes under vis-prompt dir', () => {
  const keep = path.join(dir, 'asmltr-vis-prompt-keep.json');
  const stale = path.join(dir, 'asmltr-vis-prompt-stale.json');
  const other = path.join(dir, 'notes.json');
  fs.writeFileSync(keep, '{}');
  fs.writeFileSync(stale, '{}');
  fs.writeFileSync(other, '{}');
  const old = Date.now() - 2 * 60 * 60 * 1000;
  fs.utimesSync(stale, old / 1000, old / 1000);
  assert.equal(gc.gcVisionPromptFiles(60 * 60 * 1000), 1);
  assert.equal(fs.existsSync(keep), true);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(other), true);
  const args = grok.buildArgs({ prompt: 'hello' });
  const f = args[args.indexOf('--prompt-file') + 1];
  assert.ok(String(f).startsWith(dir));
  const mode = fs.statSync(f).mode & 0o777;
  assert.equal(mode & 0o077, 0);
  try { fs.unlinkSync(f); } catch (_) {}
});

test('asmltr.js wires gc-temps', () => {
  const src = fs.readFileSync(path.join(__dirname, '../cli/asmltr.js'), 'utf8');
  assert.match(src, /case 'gc-temps'/);
  assert.match(src, /gc-temps/);
  const core = fs.readFileSync(path.join(__dirname, '../core/src/server.js'), 'utf8');
  assert.match(core, /ASMLTR_GC_TEMPS/);
  assert.match(core, /gc-temps/);
});
