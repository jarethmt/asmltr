'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIR = new Set(['node_modules', '.git', 'extras', 'test', 'docs']);

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
}

test('public product js does not require overlay modules or retired planes', () => {
  const files = [];
  walk(ROOT, files);
  const hits = [];
  const needles = [
    'load-host-overlay',
    'wrapAbortAllow',
    'hostGate',
    'toolbelt-prompt',
    'loadIdentityHints',
    'load-outbound-stage',
    'sqlite-stmt-keep',
  ];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    const src = fs.readFileSync(f, 'utf8');
    for (const n of needles) {
      if (src.includes(n)) hits.push(rel + ': ' + n);
    }
    if (/require\([^)]*(ivy-local|host-local)/.test(src)) hits.push(rel + ': require host overlay extras');
    if (src.includes("shared/tool-policy'") || src.includes("require('../tool-policy')") || src.includes("require('./tool-policy')")) {
      hits.push(rel + ': require tool-policy');
    }
    if (src.includes("shared/guild-post'") || src.includes("require('../guild-post')") || src.includes("require('./guild-post')")) {
      hits.push(rel + ': require guild-post');
    }
    if (src.includes("shared/outbound-stage'") || src.includes("require('../outbound-stage')") || src.includes("require('./outbound-stage')")) {
      hits.push(rel + ': require outbound-stage');
    }
  }
  assert.deepEqual(hits, []);
});
