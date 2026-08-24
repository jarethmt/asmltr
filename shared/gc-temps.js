'use strict';
/**
 * Bounce + weekly GC for asmltr temp dirs (attach-stage, gen-ref, vis-prompt).
 * Default age 24h — same as core listen. Prefix-guarded; never walks $HOME.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;

function visPromptDir() {
  if (process.env.ASMLTR_GROK_PROMPT_DIR) return process.env.ASMLTR_GROK_PROMPT_DIR;
  return path.join(os.homedir(), '.asmltr', 'vis-prompt');
}

function ensureVisPromptDir() {
  const dir = visPromptDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (_) {}
  return dir;
}

function gcPrefixDir(dir, prefixes, maxAgeMs) {
  const cutoff = Date.now() - (maxAgeMs == null ? DAY_MS : Number(maxAgeMs));
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return 0; }
  for (const name of names) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.mtimeMs > cutoff) continue;
      fs.unlinkSync(p);
      removed++;
    } catch (_) {}
  }
  return removed;
}

/** vis-prompt JSON + ffmpeg in/out leftovers in the vis-prompt dir. */
function gcVisionPromptFiles(maxAgeMs) {
  return gcPrefixDir(visPromptDir(), ['asmltr-vis-prompt-', 'asmltr-vis-in-', 'asmltr-vis-out-'], maxAgeMs);
}

/** Leftovers from before vis-prompt moved off /tmp. */
function gcTmpVisionLeftovers(maxAgeMs) {
  return gcPrefixDir(os.tmpdir(), ['asmltr-vis-prompt-', 'asmltr-vis-in-', 'asmltr-vis-out-'], maxAgeMs);
}

function run(maxAgeMs) {
  const age = maxAgeMs == null ? DAY_MS : Number(maxAgeMs);
  const out = { attach: 0, genRef: 0, visPrompt: 0, tmpLeftover: 0 };
  try {
    const r = require('./outbound-stage').gc(age);
    out.attach = (r.removed || []).length;
  } catch (_) {}
  try {
    const r = require('./inbound-media').gc(age);
    out.genRef = (r.removed || []).length;
  } catch (_) {}
  try { out.visPrompt = gcVisionPromptFiles(age); } catch (_) {}
  try { out.tmpLeftover = gcTmpVisionLeftovers(age); } catch (_) {}
  return out;
}

module.exports = {
  DAY_MS, visPromptDir, ensureVisPromptDir, gcVisionPromptFiles, gcTmpVisionLeftovers, run,
};
