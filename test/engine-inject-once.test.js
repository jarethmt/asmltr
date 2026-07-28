'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { composeSystemPrompts, shouldReuseStable } = require('../core/src/prompt-parts');

// Representative parts. `toolbelt` carries internal separators (a bullet continuation + \n\n blocks) to
// mirror the real build (ASMLTR TOOLBELT + mesh bullet + SELF SILO + VAULT + ATTACH).
const PARTS = {
  identity: 'IDENTITY',
  speaker: 'SPEAKER',
  channel: 'CHANNEL',
  authz: 'AUTHZ',
  rel: 'REL',
  extra: 'EXTRA',
  toolbelt: 'TOOLBELT\n• MESH\n\nSILO\n\nVAULT\n\nATTACH',
  uploadsInstr: 'UPLOADS',
  uploadsList: 'RECENT',
  announce: 'ANNOUNCE',
};

// The pre-optimization inline build, reproduced exactly: start with identity, then append each present
// part with a '\n\n' separator, in this order. This is the invariant claude must keep seeing.
function oldConcat(p) {
  let s = p.identity + '\n\n' + p.speaker + '\n\n' + p.channel + '\n\n' + p.authz;
  if (p.rel) s += '\n\n' + p.rel;
  if (p.extra) s += '\n\n' + p.extra;
  if (p.toolbelt) s += '\n\n' + p.toolbelt;
  if (p.uploadsInstr) s += '\n\n' + p.uploadsInstr;
  if (p.uploadsList) s += '\n\n' + p.uploadsList;
  if (p.announce) s += '\n\n' + p.announce;
  return s;
}

test('FULL prompt is byte-identical to the old inline concatenation (no claude regression)', () => {
  assert.equal(composeSystemPrompts(PARTS).full, oldConcat(PARTS));
});

test('FULL still matches the old build when optional parts are absent', () => {
  const p = { ...PARTS, rel: '', extra: '', uploadsList: '', announce: '' };
  assert.equal(composeSystemPrompts(p).full, oldConcat(p));
  // no stray/double blank lines from the dropped parts
  assert.ok(!composeSystemPrompts(p).full.includes('\n\n\n'));
});

test('stable = identity + channel + toolbelt + uploads-instruction only', () => {
  assert.equal(composeSystemPrompts(PARTS).stable, ['IDENTITY', 'CHANNEL', PARTS.toolbelt, 'UPLOADS'].join('\n\n'));
});

test('volatile = speaker + authz + rel + extra + uploads-list + announce only', () => {
  assert.equal(composeSystemPrompts(PARTS).volatile, ['SPEAKER', 'AUTHZ', 'REL', 'EXTRA', 'RECENT', 'ANNOUNCE'].join('\n\n'));
});

test('stable ∪ volatile covers every non-empty part (nothing dropped)', () => {
  const { stable, volatile } = composeSystemPrompts(PARTS);
  for (const k of Object.keys(PARTS)) {
    const first = PARTS[k].split('\n')[0]; // toolbelt is multi-line
    assert.ok((stable + '\n\n' + volatile).includes(first), `part ${k} present in stable∪volatile`);
  }
});

test('THE KEY PROPERTY: changing only VOLATILE parts does NOT change stableHash', () => {
  const base = composeSystemPrompts(PARTS).stableHash;
  for (const k of ['speaker', 'authz', 'rel', 'extra', 'uploadsList', 'announce']) {
    const h = composeSystemPrompts({ ...PARTS, [k]: PARTS[k] + ' CHANGED' }).stableHash;
    assert.equal(h, base, `volatile part ${k} must not bust the stable hash → codex won't re-inject`);
  }
});

test('changing any STABLE part DOES change stableHash (→ stable block is re-sent)', () => {
  const base = composeSystemPrompts(PARTS).stableHash;
  for (const k of ['identity', 'channel', 'toolbelt', 'uploadsInstr']) {
    const h = composeSystemPrompts({ ...PARTS, [k]: PARTS[k] + ' CHANGED' }).stableHash;
    assert.notEqual(h, base, `stable part ${k} must move the hash → re-injection`);
  }
});

// ── the inject-once decision ──────────────────────────────────────────────────
const HASH = 'abc123';
const ROW = { last_stable_engine: 'codex', last_stable_hash: HASH };

test('reuse only when: history-retaining engine + not new + same engine + same hash', () => {
  assert.equal(shouldReuseStable({ canInjectOnce: true, isNew: false, row: ROW, engineId: 'codex', stableHash: HASH }), true);
});
test('no reuse on a fresh session (stable never delivered)', () => {
  assert.equal(shouldReuseStable({ canInjectOnce: true, isNew: true, row: ROW, engineId: 'codex', stableHash: HASH }), false);
});
test('no reuse when the stable block changed (hash mismatch)', () => {
  assert.equal(shouldReuseStable({ canInjectOnce: true, isNew: false, row: ROW, engineId: 'codex', stableHash: 'different' }), false);
});
test('no reuse after a mid-session engine switch (different engine has no replayed stable block)', () => {
  assert.equal(shouldReuseStable({ canInjectOnce: true, isNew: false, row: ROW, engineId: 'gemini', stableHash: HASH }), false);
});
test('no reuse when the engine does not retain history (e.g. claude → always full)', () => {
  assert.equal(shouldReuseStable({ canInjectOnce: false, isNew: false, row: ROW, engineId: 'codex', stableHash: HASH }), false);
});
test('no reuse when the prior hash is null (e.g. a turn that never sent the stable block)', () => {
  assert.equal(shouldReuseStable({ canInjectOnce: true, isNew: false, row: { last_stable_engine: 'codex', last_stable_hash: null }, engineId: 'codex', stableHash: HASH }), false);
});
