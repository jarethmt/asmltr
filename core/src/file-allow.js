'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function hasDotDot(p) {
  return String(p || '').split(/[/\\]/).includes('..');
}

function fileServeRoots() {
  const roots = [];
  try { roots.push(require('../../shared/silo').silosRoot()); } catch (_) {}
  try { roots.push(require('../../shared/uploads').baseDir()); } catch (_) {}
  const cwd = process.env.ASMLTR_SESSION_CWD;
  if (cwd) {
    const resolved = path.resolve(cwd);
    if (resolved !== path.resolve(os.homedir())) roots.push(resolved);
  }
  return roots.filter(Boolean);
}

function underRoot(realFile, realRoot) {
  const f = path.resolve(realFile);
  const r = path.resolve(realRoot);
  return f === r || f.startsWith(r + path.sep);
}

function filePathAllowed(requested, roots, { realpathSync, homedir } = {}) {
  const rp = realpathSync || fs.realpathSync;
  const home = path.resolve((homedir || os.homedir)());
  if (!requested || hasDotDot(requested)) return false;
  let real;
  try { real = rp(requested); } catch (_) { return false; }
  if (real === home) return false;
  const list = roots && roots.length ? roots : [];
  for (const root of list) {
    let rr;
    try { rr = rp(root); } catch (_) { rr = path.resolve(root); }
    if (underRoot(real, rr)) return true;
  }
  return false;
}

module.exports = { hasDotDot, fileServeRoots, filePathAllowed };
