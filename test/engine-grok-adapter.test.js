'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const engines = require('../shared/engines');
const grok = require('../core/src/engines/grok');

test('grok is a known subscription-only engine with no npm package', () => {
  assert.equal(engines.known('grok'), true);
  const e = engines.ENGINES.grok;
  assert.equal(e.bin, 'grok');
  assert.equal(e.binEnv, 'ASMLTR_GROK_BIN');
  assert.equal(e.pkg, null);
  assert.ok(e.binPaths.includes('~/.grok/bin/grok'));
  assert.ok(e.binPaths.includes('~/.local/bin/grok'));
  assert.deepEqual(e.auth.modes, ['subscription']);
  assert.equal(e.auth.apiKeyEnv, null);
  assert.equal(e.auth.loginCmd, 'grok login --device-auth');
  const info = engines.authInfo('grok');
  assert.equal(info.mode, 'subscription');
  assert.equal(info.apiKeyEnv, null);
});

test('list() exposes pkg:null and installHint so the GUI can hide npm Install', () => {
  const row = engines.list().find((x) => x.id === 'grok');
  assert.ok(row);
  assert.equal(row.pkg, null);
  assert.equal(row.installHint, 'curl https://x.ai/cli/install.sh');
  assert.ok(row.auth.modes.includes('subscription'));
  assert.ok(!row.auth.modes.includes('api_key'));
});

test('envForLaunch(grok) never injects XAI_API_KEY', async () => {
  const env = await engines.envForLaunch('grok');
  assert.deepEqual(env, {});
  assert.ok(!('XAI_API_KEY' in env));
});

test('setAuthMode(grok, api_key) is refused', () => {
  assert.throws(() => engines.setAuthMode('grok', 'api_key'), /does not support auth mode/);
});

test('installLatest(grok) is a no-op without an npm package', () => {
  const r = engines.installLatest('grok');
  assert.equal(r.ok, false);
});

test('isUuid / resumeArgs: -r for a UUID, never -s or -c', () => {
  const id = '01234567-89ab-cdef-0123-456789abcdef';
  assert.equal(grok.isUuid(id), true);
  assert.equal(grok.isUuid('not-a-uuid'), false);
  assert.deepEqual(grok.resumeArgs(id), ['-r', id]);
  assert.deepEqual(grok.resumeArgs(null), []);
  assert.deepEqual(grok.resumeArgs('latest'), []);
});

test('buildArgs is headless -p, streaming-json, finite max-turns, no TUI', () => {
  const args = grok.buildArgs({ prompt: 'hello', systemPrompt: 'IDENTITY', sessionId: '01234567-89ab-cdef-0123-456789abcdef' });
  assert.equal(args[0], '--no-auto-update');
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('--output-format'));
  assert.equal(args[args.indexOf('--output-format') + 1], 'streaming-json');
  assert.ok(args.includes('--always-approve'));
  assert.ok(args.includes('--max-turns'));
  const mt = Number(args[args.indexOf('--max-turns') + 1]);
  assert.ok(Number.isFinite(mt) && mt > 0 && mt <= 100);
  assert.ok(args.includes('-s'));
  assert.ok(!args.includes('-r'));
  const p = args[args.indexOf('-p') + 1];
  assert.ok(p.includes('IDENTITY'));
  assert.ok(p.includes('hello'));
  assert.ok(p.includes('<system-instructions>'));
});

test('buildArgs on resume uses -r and not -s', () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const args = grok.buildArgs({ prompt: 'next', resume: id, sessionId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' });
  assert.deepEqual(args.slice(args.indexOf('-r'), args.indexOf('-r') + 2), ['-r', id]);
  assert.ok(!args.includes('-s'));
});

test('complete() argv uses plain output', () => {
  const args = grok.buildArgs({ prompt: 'title me', complete: true, model: 'grok-3' });
  assert.equal(args[args.indexOf('--output-format') + 1], 'plain');
  assert.equal(args[args.indexOf('-m') + 1], 'grok-3');
});

test('launchEnv strips XAI_API_KEY even if the parent has one', () => {
  const env = grok.launchEnv({ PATH: '/bin', XAI_API_KEY: 'xai-should-never-leak', HOME: '/tmp' });
  assert.equal(env.PATH, '/bin');
  assert.ok(!('XAI_API_KEY' in env));
});

test('timeout and max-turns are finite (never infinite)', () => {
  assert.ok(grok.DEFAULT_TIMEOUT_MS > 0 && grok.DEFAULT_TIMEOUT_MS <= 30 * 60 * 1000);
  assert.ok(grok.DEFAULT_MAX_TURNS > 0 && grok.DEFAULT_MAX_TURNS <= 100);
  assert.equal(grok.timeoutMs(), grok.DEFAULT_TIMEOUT_MS);
  assert.equal(grok.maxTurns(), grok.DEFAULT_MAX_TURNS);
});

test('historyReplaysSystemPrompt is true after osiris verified -r replay', () => {
  assert.equal(grok.historyReplaysSystemPrompt, true);
});

test('streaming-json parser maps text / thought / tool_call / usage / sessionId / error', () => {
  const state = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  const sid = '11111111-2222-3333-4444-555555555555';
  assert.equal(grok.applyEvent(grok.parseLine(`{"type":"text","delta":"Hi"}`), state).kind, 'delta');
  assert.equal(state.text, 'Hi');
  assert.equal(grok.applyEvent(grok.parseLine(`{"type":"text","data":"pong"}`), state).kind, 'delta');
  assert.equal(state.text, 'Hipong');
  assert.equal(grok.applyEvent({ type: 'thought', text: 'hmm' }, state).kind, 'thinking');
  assert.equal(grok.applyEvent({ type: 'tool_call', name: 'shell', input: { cmd: 'ls' } }, state).kind, 'tool');
  assert.equal(state.tools[0].name, 'shell');
  assert.equal(grok.applyEvent({ type: 'usage', usage: { input_tokens: 10, output_tokens: 4 } }, state).kind, 'usage');
  assert.equal(state.usage.tokens_in, 10);
  assert.equal(grok.applyEvent({ type: 'end', sessionId: sid }, state).kind, 'end');
  assert.equal(state.engineSessionId, sid);
  assert.equal(grok.applyEvent({ type: 'error', message: 'nope' }, state).kind, 'error');
  assert.equal(state.isError, true);
  assert.equal(grok.parseLine('not json'), null);

  // grok 1.0.5 tokens are incremental data pieces (often leading space). Live
  // assembly must match untrimmed state.text concat — trim() would mash.
  const liveState = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  let live = '';
  for (const piece of ["Here", " is", " a", " summary"]) {
    const r = grok.applyEvent({ type: 'text', data: piece }, liveState);
    assert.equal(r.kind, 'delta');
    assert.equal(r.text, piece);
    live += r.text;
  }
  assert.equal(liveState.text, "Here is a summary");
  assert.equal(live, liveState.text);
  assert.equal(grok.sessionIdFrom({ sessionId: sid }), sid);
});

test('runTurn signature destructures systemPrompt (identity contract)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'src', 'engines', 'grok.js'), 'utf8');
  const m = src.match(/async function runTurn\(\{([\s\S]*?)\}\)/);
  assert.ok(m);
  const params = m[1].split(',').map((s) => s.trim().split(/[=:\s]/)[0]);
  assert.ok(params.includes('systemPrompt'));
  assert.ok(params.includes('resume'));
  assert.ok(!src.includes('onSegment(r.text.trim())'), 'onSegment must not trim leading spaces');
  assert.ok(src.includes('onSegment(r.text)'));
});

test('engines.get("grok") lazy-loads the grok adapter', () => {
  const { get } = require('../core/src/engines');
  const impl = get('grok');
  assert.equal(impl.id, 'grok');
  assert.equal(typeof impl.runTurn, 'function');
  assert.equal(typeof impl.complete, 'function');
});

test('applyEvent: space-only delta after period produces "time. The" not "time.The"', () => {
  const liveState = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  let live = '';
  for (const piece of ['time.', ' ', 'The']) {
    const r = grok.applyEvent({ type: 'text', data: piece }, liveState);
    assert.equal(r.kind, 'delta');
    live += r.text;
  }
  assert.equal(liveState.text, 'time. The');
  assert.equal(live, liveState.text);
  assert.notEqual(live, 'time.The');
});

test('applyEvent: next sentence without leading space still stores ". "', () => {
  const state = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  let live = '';
  for (const piece of ['time.', 'The']) {
    const r = grok.applyEvent({ type: 'text', data: piece }, state);
    live += r.text;
  }
  assert.equal(state.text, 'time. The');
  assert.equal(live, 'time. The');
});
