'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-grok-args-'));
process.env.ASMLTR_GROK_PROMPT_DIR = promptDir;
const engines = require('../shared/engines');
const grok = require('../core/src/engines/grok');
after(() => { try { fs.rmSync(promptDir, { recursive: true, force: true }); } catch (_) {} });

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

test('buildArgs is headless --prompt-file, streaming-json, no CLI turn cap, no TUI', () => {
  const args = grok.buildArgs({ prompt: 'hello', systemPrompt: 'IDENTITY', sessionId: '01234567-89ab-cdef-0123-456789abcdef' });
  assert.equal(args[0], '--no-auto-update');
  assert.ok(args.includes('--prompt-file'));
  assert.equal(args.includes('-p'), false);
  assert.ok(args.includes('--output-format'));
  assert.equal(args[args.indexOf('--output-format') + 1], 'streaming-json');
  assert.ok(args.includes('--always-approve'));
  assert.equal(args.includes('--max-turns'), false);
  assert.ok(args.includes('--effort'));
  assert.ok(args.includes('-s'));
  assert.ok(!args.includes('-r'));
  const f = args[args.indexOf('--prompt-file') + 1];
  const body = JSON.parse(require('fs').readFileSync(f, 'utf8'));
  try { require('fs').unlinkSync(f); } catch (_) {}
  const p = body.content.find((c) => c.type === 'text').text;
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

test('complete() honor effort low and image/video denies for classify', () => {
  const args = grok.buildArgs({
    prompt: 'YES or NO', complete: true, effort: 'low',
    denyShell: true, denyWrite: true, denyImage: true, denyVideo: true,
  });
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.equal(args[args.indexOf('--output-format') + 1], 'plain');
  const denies = [];
  for (let n = 0; n < args.length; n++) if (args[n] === '--deny') denies.push(args[n + 1]);
  assert.ok(denies.includes('image_gen'));
  assert.ok(denies.includes('image_edit'));
  assert.ok(denies.includes('Bash'));
});

test('buildArgs denyShell adds --disallowed-tools bash,shell,run_terminal_cmd and --deny Bash', () => {
  const args = grok.buildArgs({ prompt: 'hello', denyShell: true });
  assert.ok(args.includes('--always-approve'));
  const i = args.indexOf('--disallowed-tools');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], 'bash,shell,run_terminal_cmd');
  assert.ok(args[i + 1].includes('run_terminal_cmd'));
  const d = args.indexOf('--deny');
  assert.ok(d >= 0);
  assert.equal(args[d + 1], 'Bash');
});

test('buildArgs denyWrite adds search_replace and --deny Edit/Write, keeps always-approve', () => {
  const args = grok.buildArgs({ prompt: 'hello', denyWrite: true });
  assert.ok(args.includes('--always-approve'));
  const i = args.indexOf('--disallowed-tools');
  assert.ok(i >= 0);
  assert.ok(args[i + 1].includes('search_replace'));
  const denies = [];
  for (let n = 0; n < args.length; n++) if (args[n] === '--deny') denies.push(args[n + 1]);
  assert.ok(denies.includes('Edit'));
  assert.ok(denies.includes('Write'));
});

test('unrestricted buildArgs has no write/edit deny', () => {
  const args = grok.buildArgs({ prompt: 'hello' });
  assert.equal(args.includes('--disallowed-tools'), false);
  assert.equal(args.includes('--deny'), false);
  assert.ok(args.includes('--always-approve'));
});

test('buildArgs without denyShell does not pass --disallowed-tools', () => {
  const args = grok.buildArgs({ prompt: 'hello' });
  assert.equal(args.includes('--disallowed-tools'), false);
});

test('buildArgs denyVideo strips image_to_video and reference_to_video', () => {
  const args = grok.buildArgs({ prompt: 'hello', denyVideo: true });
  const i = args.indexOf('--disallowed-tools');
  assert.ok(i >= 0);
  assert.ok(args[i + 1].includes('image_to_video'));
  assert.ok(args[i + 1].includes('reference_to_video'));
  const denies = [];
  for (let n = 0; n < args.length; n++) if (args[n] === '--deny') denies.push(args[n + 1]);
  assert.ok(denies.includes('image_to_video'));
  assert.ok(denies.includes('reference_to_video'));
});

test('buildArgs denyImage strips image_gen and image_edit', () => {
  const args = grok.buildArgs({ prompt: 'hello', denyImage: true });
  const i = args.indexOf('--disallowed-tools');
  assert.ok(i >= 0);
  assert.ok(args[i + 1].includes('image_gen'));
  assert.ok(args[i + 1].includes('image_edit'));
});

test('runTurn env marks the child as inside a turn and prepends bounce-guard', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'src', 'engines', 'grok.js'), 'utf8');
  assert.match(src, /ASMLTR_INSIDE_TURN: '1'/);
  assert.match(src, /ASMLTR_TURN_KEY/);
  assert.match(src, /withGuardPath/);
});

test('launchEnv strips XAI_API_KEY even if the parent has one', () => {
  const bounce = require('../shared/bounce');
  const env = grok.launchEnv({ PATH: '/bin', XAI_API_KEY: 'xai-should-never-leak', HOME: '/tmp' });
  assert.equal(env.PATH.startsWith(bounce.guardDir() + require('path').delimiter), true);
  assert.ok(env.PATH.includes('/bin'));
  assert.ok(!('XAI_API_KEY' in env));
});

test('buildArgs omits a turn-cap flag; runTurn/complete do not arm a kill timer', () => {
  const args = grok.buildArgs({ prompt: 'hello' });
  assert.equal(args.includes('--max-turns'), false);
  assert.ok(args.includes('--effort'));
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'src', 'engines', 'grok.js'), 'utf8');
  const build = src.match(/function buildArgs\([\s\S]*?\n\}/);
  assert.ok(build);
  assert.equal(build[0].includes('--max-turns'), false);
  assert.ok(src.includes('abortController'));
  const run = src.match(/async function runTurn\([\s\S]*?\n\}/);
  assert.ok(run);
  assert.equal(/setTimeout\([\s\S]{0,200}child\.kill/.test(run[0]), false);
  assert.equal(run[0].includes('watchdog'), false);
  const complete = src.match(/async function complete\([\s\S]*?\n\}/);
  assert.ok(complete);
  assert.equal(/setTimeout\([\s\S]{0,200}child\.kill/.test(complete[0]), false);
  assert.equal(complete[0].includes('watchdog'), false);
});

test('historyReplaysSystemPrompt is true after live-verified -r replay', () => {
  assert.equal(grok.historyReplaysSystemPrompt, true);
});

test('streaming-json parser maps text / thought / tool_call / usage / sessionId / error', () => {
  const state = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  const sid = '11111111-2222-3333-4444-555555555555';
  assert.equal(grok.applyEvent(grok.parseLine(`{"type":"text","delta":"Hi"}`), state).kind, 'delta');
  assert.equal(state.text, 'Hi');
  assert.equal(grok.applyEvent(grok.parseLine(`{"type":"text","data":"pong"}`), state).kind, 'delta');
  assert.equal(state.text, 'Hipong');
  assert.equal(grok.applyEvent({ type: 'thought', text: 'hmm' }, state).kind, 'thinking-delta');
  assert.equal(state.thinking, 'hmm');
  const rsn = grok.newState();
  assert.equal(grok.applyEvent({ type: 'reasoning', data: 'plan it' }, rsn).kind, 'thinking-delta');
  assert.equal(rsn.thinking, 'plan it');
  assert.equal(grok.extractText({ type: 'reasoning', text: 'nope' }), '');
  assert.equal(grok.extractText({ type: 'thought_summary', text: 'nope' }), '');
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
  for (const piece of ["Here's", " a summary"]) {
    const r = grok.applyEvent({ type: 'text', data: piece }, liveState);
    assert.equal(r.kind, 'delta');
    assert.equal(r.text, piece);
    live += r.text;
  }
  assert.equal(liveState.text, "Here's a summary");
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
  assert.ok(src.includes("r.text != null && r.text !== '' && onDelta"), 'onDelta must fire for whitespace tokens');
  assert.ok(src.includes('joined = prev + text'), 'incremental type:text data concatenates');
  assert.ok(!src.includes('[.!?]'), 'no invent-space after .!?');
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

test('applyEvent: next sentence without a space token stays honest time.The', () => {
  const state = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  let live = '';
  for (const piece of ['time.', 'The']) {
    const r = grok.applyEvent({ type: 'text', data: piece }, state);
    live += r.text;
  }
  assert.equal(state.text, 'time.The');
  assert.equal(live, 'time.The');
});

test('applyEvent: narration draft then restated answer stores one sentence, not both', () => {
  const state = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  const draft = 'Coconut aminos is already on your card as the soy-sauce stand-in.';
  const answer = 'Coconut aminos is already on your card as the soy-sauce replacement.';
  const a = grok.applyEvent({ type: 'text', text: draft }, state);
  assert.equal(a.kind, 'text');
  assert.equal(state.text, draft);
  const b = grok.applyEvent({ type: 'text', text: answer }, state);
  assert.equal(b.kind, 'text');
  assert.equal(state.text, answer);
  assert.deepEqual(state.segments, [draft]);
  assert.ok(!state.text.includes('stand-in'));
  assert.notEqual(state.text, draft + ' ' + answer);
});

test('applyEvent: status block then restated answer persist is the answer only', () => {
  const state = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  const status = "Vim is in Preferences, not Story — and it was a bad translation of your house rule, not something I believe about myself. I'll take it out. Coconut aminos is already on your card as the soy-sauce stand-in.";
  const answer = 'Coconut aminos is already on your card as the soy-sauce replacement. That stays.';
  grok.applyEvent({ type: 'text', text: status }, state);
  grok.applyEvent({ type: 'text', text: answer }, state);
  assert.equal(state.text, answer);
  assert.deepEqual(state.segments, [status]);
  const segs = state.segments.concat(state.text.trim() ? [state.text.trim()] : []);
  assert.equal(segs[segs.length - 1], answer);
});

test('applyEvent: tool call returns closed narration for live step streaming', () => {
  const state = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  const status = 'I will check the RE-review email and the silo.';
  grok.applyEvent({ type: 'text', text: status }, state);
  const r = grok.applyEvent({ type: 'tool_call', name: 'read_file', input: { path: '/tmp/x' } }, state);
  assert.equal(r.kind, 'tool');
  assert.equal(r.closed, status);
  assert.equal(state.text, '');
  assert.deepEqual(state.segments, [status]);
});

test('parseLine unwraps ACP agent_thought_chunk as thought', () => {
  const line = JSON.stringify({
    method: 'session/update',
    params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'checking mail' } } },
  });
  const ev = grok.parseLine(line);
  assert.equal(ev.type, 'thought');
  assert.equal(ev.text, 'checking mail');
  const state = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  const r = grok.applyEvent(ev, state);
  assert.equal(r.kind, 'thinking-delta');
  assert.equal(state.thinking, 'checking mail');
});

test('applyEvent: thought chunks coalesce and flush on tool / text / end', () => {
  const state = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(grok.applyEvent({ type: 'thought', data: 'Checking' }, state).kind, 'thinking-delta');
  assert.equal(grok.applyEvent({ type: 'thought', data: ' mail' }, state).kind, 'thinking-delta');
  assert.equal(state.thinking, 'Checking mail');
  const tool = grok.applyEvent({ type: 'tool_call', name: 'read_file', input: { path: '/tmp/x' } }, state);
  assert.equal(tool.kind, 'tool');
  assert.equal(tool.closedThinking, 'Checking mail');
  assert.equal(state.thinking, '');
  grok.applyEvent({ type: 'thought', text: 'Now answer' }, state);
  const text = grok.applyEvent({ type: 'text', data: 'Hi' }, state);
  assert.equal(text.kind, 'delta');
  assert.equal(text.closedThinking, 'Now answer');
  grok.applyEvent({ type: 'thought', data: 'Wrap up' }, state);
  const end = grok.applyEvent({ type: 'end', sessionId: '11111111-2222-3333-4444-555555555555' }, state);
  assert.equal(end.kind, 'end');
  assert.equal(end.closedThinking, 'Wrap up');
});


test('applyEvent: tool_call_update does not emit onTool or close thinking', () => {
  const state = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  grok.applyEvent({ type: 'thought', text: 'scratch' }, state);
  const r = grok.applyEvent({ type: 'tool_call_update', name: 'Read' }, state);
  assert.equal(r.kind, 'tool_update');
  assert.equal(r.tool, undefined);
  assert.equal(state.thinking, 'scratch');
  assert.deepEqual(state.tools, []);
});

test('applyEvent: nameless tool_call does not use type as name', () => {
  const state = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  const r = grok.applyEvent({ type: 'tool_call', input: {} }, state);
  assert.equal(r.kind, 'tool');
  assert.equal(r.tool.name, '');
  assert.notEqual(r.tool.name, 'tool_call');
  assert.equal(grok.toolNameOf({ type: 'tool_call' }), '');
  assert.equal(grok.toolNameOf({ type: 'tool_call', name: 'tool_call' }), '');
  assert.equal(grok.toolNameOf({ type: 'tool_call', name: 'Read' }), 'Read');
  assert.equal(grok.toolNameOf({ type: 'tool_call', toolCall: { name: 'Bash' } }), 'Bash');
});

test('applyEvent: named tool_call still closes thinking once', () => {
  const state = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  grok.applyEvent({ type: 'thought', text: 'plan' }, state);
  grok.applyEvent({ type: 'thought', text: ' more' }, state);
  const r = grok.applyEvent({ type: 'tool_call', name: 'Read', input: { path: '/tmp/x' } }, state);
  assert.equal(r.kind, 'tool');
  assert.equal(r.tool.name, 'Read');
  assert.equal(r.closedThinking, 'plan more');
  assert.equal(state.thinking, '');
  const upd = grok.applyEvent({ type: 'tool_call_update' }, state);
  assert.equal(upd.kind, 'tool_update');
  assert.equal(state.thinking, '');
});

test('applyEvent: tool call closes narration so later text is not glued', () => {
  const state = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  const status = 'Coconut aminos is already on your card as the soy-sauce stand-in.';
  const answer = 'Coconut aminos is already on your card as the soy-sauce replacement.';
  grok.applyEvent({ type: 'text', text: status }, state);
  grok.applyEvent({ type: 'tool_call', name: 'edit', input: { path: 'Preferences' } }, state);
  assert.deepEqual(state.segments, [status]);
  assert.equal(state.text, '');
  grok.applyEvent({ type: 'text', text: answer }, state);
  assert.equal(state.text, answer);
  assert.ok(!state.text.includes('stand-in'));
});

test('applyEvent: time. + The as complete-shaped events stay honest, not replace', () => {
  const state = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  grok.applyEvent({ type: 'text', text: 'time.' }, state);
  const r = grok.applyEvent({ type: 'text', text: 'The' }, state);
  assert.equal(state.text, 'time.The');
  assert.equal(r.text, 'The');
  assert.deepEqual(state.segments, []);
});

test('applyEvent: owner kettle incremental draft + tool + answer stores FINAL only', () => {
  const draft = 'TEST-DRAFT: the kettle is on.';
  const mid = 'Yes. I can do it on purpose, and I just did.';
  const fin = 'TEST-FINAL: the tea is poured.';
  const answer = mid + '\n\n' + fin;
  const state = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  for (const piece of ['TEST-DRAFT: ', 'the kettle ', 'is on.']) {
    grok.applyEvent({ type: 'text', data: piece }, state);
  }
  assert.equal(state.text, draft);
  grok.applyEvent({ type: 'tool_call', name: 'read', input: {} }, state);
  assert.deepEqual(state.segments, [draft]);
  assert.equal(state.text, '');
  grok.applyEvent({ type: 'text', data: 'Yes' }, state);
  assert.equal(state.text, 'Yes');
  assert.ok(!state.text.includes('on.Yes'));
  grok.applyEvent({ type: 'text', data: '. I can do it on purpose, and I just did.' }, state);
  grok.applyEvent({ type: 'text', data: '\n\n' + fin }, state);
  assert.equal(state.text, answer);
  const segs = state.segments.concat(state.text.trim() ? [state.text.trim()] : []);
  assert.equal(segs[segs.length - 1], answer);
  assert.ok(!state.text.startsWith('TEST-DRAFT'));
  assert.ok(!state.text.includes('on.Yes'));
});

test('applyEvent: owner kettle snapshots last complete block wins', () => {
  const draft = 'TEST-DRAFT: the kettle is on.';
  const mid = 'Yes. I can do it on purpose, and I just did.';
  const fin = 'TEST-FINAL: the tea is poured.';
  const state = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  grok.applyEvent({ type: 'text', text: draft }, state);
  grok.applyEvent({ type: 'text', text: mid }, state);
  grok.applyEvent({ type: 'text', text: fin }, state);
  assert.equal(state.text, fin);
  assert.deepEqual(state.segments, [draft, mid]);
  const segs = state.segments.concat(state.text.trim() ? [state.text.trim()] : []);
  assert.equal(segs[segs.length - 1], fin);
  assert.ok(!state.text.includes('on.Yes'));
  assert.ok(!state.text.includes('kettle'));
});

test('joinText: honest concat; URLs/IPs/query/versions unspaced; space token kept', () => {
  assert.equal(grok.joinText("Here's", ' a summary'), "Here's a summary");
  assert.equal(grok.joinText('time.', ' The'), 'time. The');
  assert.equal(grok.joinText('time.', 'The'), 'time.The');
  assert.equal(['127.', '0.', '0.', '1'].reduce((a, b) => grok.joinText(a, b), ''), '127.0.0.1');
  assert.equal(grok.joinText('accounts.', 'google.com'), 'accounts.google.com');
  assert.equal(grok.joinText('auth?', 'response_type'), 'auth?response_type');
  assert.equal(grok.joinText('www.', 'googleapis.com'), 'www.googleapis.com');
  assert.equal(grok.joinText('file.', 'json'), 'file.json');
  assert.equal(grok.joinText('v1.', '2.3'), 'v1.2.3');
  assert.equal(grok.joinText(grok.joinText('time.', ' '), 'The'), 'time. The');
  assert.equal(grok.extractText({ type: 'text', data: ' ' }), ' ');
  assert.equal(grok.extractText({ type: 'text', data: ' a summary' }), ' a summary');
  const state = grok.newState('01234567-89ab-cdef-0123-456789abcdef');
  const r = grok.applyEvent({ type: 'text', data: ' ' }, state);
  assert.equal(r.kind, 'delta');
  assert.equal(r.text, ' ');
  assert.equal(state.text, ' ');
});
