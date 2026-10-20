'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ca = require('../shared/claude-agents');

// The shape `claude agents --json` prints, as of CLI 2.1.275. Synthetic rows, not a capture: a real
// one carries working directories and session names from whoever ran it.
const SAMPLE = [
  { id: '3b3a097d', cwd: '/home/op', kind: 'background', startedAt: 1780333953154, sessionId: '3b3a097d-58a9-4ad6-9f94-f2c45d87de47', name: 'stale job', state: 'blocked' },
  { pid: 572623, id: 'fb44cbe4', cwd: '/home/op/repo/.claude/worktrees/a', kind: 'background', startedAt: 1789671166923, sessionId: 'fb44cbe4-9ac6-4bbc-86e0-dda68620d8f1', name: 'slicer work', status: 'busy', state: 'working' },
  { pid: 750095, id: '9e49cb66', cwd: '/home/op/repo', kind: 'interactive', startedAt: 1789686046271, sessionId: '9e49cb66-768e-45dc-ad19-a8a24145d9f3', name: 'pr review', status: 'idle', state: 'idle' },
];

test('a row keeps both liveness fields and derives one boolean', () => {
  const [stale, busy, idle] = ca.parseAgentsJson(JSON.stringify(SAMPLE));
  assert.equal(busy.name, 'slicer work');
  assert.equal(busy.pid, 572623);
  assert.equal(busy.kind, 'background');
  assert.equal(busy.working, true);
  assert.equal(busy.blocked, false);
  assert.equal(busy.started_unix, 1789671166, 'ms to seconds, to match asmltr event timestamps');

  // `blocked` means waiting on a human, which is the state worth surfacing, so it is not folded in.
  assert.equal(stale.blocked, true);
  assert.equal(stale.working, false);
  assert.equal(stale.pid, null, 'an older row carries no pid');

  assert.equal(idle.working, false);
  assert.equal(idle.kind, 'interactive');
});

test('an unusable row is dropped, not turned into a blank peer', () => {
  const rows = ca.parseAgentsJson(JSON.stringify([{ name: 'no id at all' }, null, 'nonsense', { id: 'ok' }]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'ok');
});

test('parsing survives a banner printed before the array', () => {
  const rows = ca.parseAgentsJson('Warning: update available\n' + JSON.stringify(SAMPLE));
  assert.equal(rows.length, 3, 'the array is still recoverable');
});

test('parsing garbage is an empty list, not a throw', () => {
  for (const bad of ['', '   ', 'not json', '{"not":"an array"}', undefined, null]) {
    assert.deepEqual(ca.parseAgentsJson(bad), [], `input: ${JSON.stringify(bad)}`);
  }
});

test('tagKnown marks the peers asmltr already tracks', () => {
  const agents = ca.parseAgentsJson(JSON.stringify(SAMPLE));
  const tagged = ca.tagKnown(agents, [
    { session_id: 'fb44cbe4-9ac6-4bbc-86e0-dda68620d8f1' },
    { engine_session_id: 'something-else' },
  ]);
  assert.equal(tagged.find((a) => a.id === 'fb44cbe4').tracked_by_asmltr, true);
  assert.equal(tagged.find((a) => a.id === '9e49cb66').tracked_by_asmltr, false, 'an untracked peer is the interesting one');
  assert.equal(ca.tagKnown(agents, []).every((a) => a.tracked_by_asmltr === false), true);
});

// --- the exec path, driven with a fake `claude` on PATH ---------------------------------------
function fakeClaude(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-fakeclaude-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, body, { mode: 0o755 });
  return { dir, bin };
}

test('listAgents returns the parsed rows when the CLI cooperates', async () => {
  const { dir, bin } = fakeClaude(`#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(SAMPLE)}\nJSON\n`);
  const saved = process.env.ASMLTR_CLAUDE_BIN;
  process.env.ASMLTR_CLAUDE_BIN = bin;
  try {
    const r = await ca.listAgents();
    assert.equal(r.ok, true);
    assert.equal(r.error, null);
    assert.equal(r.agents.length, 3);
  } finally {
    if (saved === undefined) delete process.env.ASMLTR_CLAUDE_BIN; else process.env.ASMLTR_CLAUDE_BIN = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing claude binary is an empty list with a reason, not a crash', async () => {
  const saved = process.env.ASMLTR_CLAUDE_BIN;
  process.env.ASMLTR_CLAUDE_BIN = '/nonexistent/claude-does-not-exist';
  try {
    const r = await ca.listAgents();
    assert.deepEqual(r.agents, []);
    assert.equal(r.ok, false);
    assert.match(r.error, /no claude binary|ENOENT/);
  } finally {
    if (saved === undefined) delete process.env.ASMLTR_CLAUDE_BIN; else process.env.ASMLTR_CLAUDE_BIN = saved;
  }
});

test('a non-zero exit that still printed the array is salvaged', async () => {
  // The CLI warns and exits 1 in some states while still emitting usable JSON. Throwing away a good
  // array because of the exit code would blank the column for no reason.
  const { dir, bin } = fakeClaude(`#!/bin/sh\necho 'heads up' >&2\ncat <<'JSON'\n${JSON.stringify(SAMPLE.slice(0, 1))}\nJSON\nexit 1\n`);
  const saved = process.env.ASMLTR_CLAUDE_BIN;
  process.env.ASMLTR_CLAUDE_BIN = bin;
  try {
    const r = await ca.listAgents();
    assert.equal(r.agents.length, 1);
    assert.equal(r.ok, true);
  } finally {
    if (saved === undefined) delete process.env.ASMLTR_CLAUDE_BIN; else process.env.ASMLTR_CLAUDE_BIN = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hung CLI is bounded by the timeout', async () => {
  const { dir, bin } = fakeClaude('#!/bin/sh\nsleep 30\n');
  const saved = process.env.ASMLTR_CLAUDE_BIN;
  process.env.ASMLTR_CLAUDE_BIN = bin;
  const started = Date.now();
  try {
    const r = await ca.listAgents({ timeoutMs: 300 });
    assert.deepEqual(r.agents, []);
    assert.equal(r.ok, false);
    assert.ok(Date.now() - started < 5000, 'returned promptly rather than hanging asmltr ls');
  } finally {
    if (saved === undefined) delete process.env.ASMLTR_CLAUDE_BIN; else process.env.ASMLTR_CLAUDE_BIN = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--all and --cwd reach the CLI', async () => {
  // The fake echoes its own arguments back as a name so the call can be asserted.
  const { dir, bin } = fakeClaude('#!/bin/sh\nprintf \'[{"id":"x","name":"%s"}]\' "$*"\n');
  const saved = process.env.ASMLTR_CLAUDE_BIN;
  process.env.ASMLTR_CLAUDE_BIN = bin;
  try {
    const r = await ca.listAgents({ all: true, cwd: '/home/op/repo' });
    assert.match(r.agents[0].name, /agents --json --all --cwd \/home\/op\/repo/);
  } finally {
    if (saved === undefined) delete process.env.ASMLTR_CLAUDE_BIN; else process.env.ASMLTR_CLAUDE_BIN = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
