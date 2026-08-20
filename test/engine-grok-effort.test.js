'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-effort-'));
const nextFile = path.join(tmp, 'next-effort');
process.env.ASMLTR_GROK_NEXT_EFFORT_FILE = nextFile;
process.env.ASMLTR_CORE_DB = path.join(tmp, 'sess.db');
delete process.env.ASMLTR_GROK_EFFORT;
delete process.env.ASMLTR_GROK_MAX_TURNS;
delete process.env.ASMLTR_GROK_TIMEOUT_MS;
delete process.env.ASMLTR_GROK_EFFORT_ELEVATE_IDS;

const grok = require('../core/src/engines/grok');
const sessions = require('../core/src/sessions');

const noGit = path.join(tmp, 'nogit');
const gitCwd = path.join(tmp, 'gitproj');
fs.mkdirSync(noGit, { recursive: true });
fs.mkdirSync(path.join(gitCwd, '.git'), { recursive: true });

after(() => {
  try { sessions.db.close(); } catch (_) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  delete process.env.ASMLTR_GROK_EFFORT;
  delete process.env.ASMLTR_GROK_NEXT_EFFORT_FILE;
  delete process.env.ASMLTR_GROK_MAX_TURNS;
  delete process.env.ASMLTR_GROK_TIMEOUT_MS;
  delete process.env.ASMLTR_GROK_EFFORT_ELEVATE_IDS;
});

function effortOf(args) {
  const i = args.indexOf('--effort');
  assert.ok(i >= 0, 'buildArgs must include --effort');
  return args[i + 1];
}

function maxTurnsOf(args) {
  const i = args.indexOf('--max-turns');
  assert.ok(i >= 0, 'buildArgs must include --max-turns');
  return Number(args[i + 1]);
}

test('buildArgs includes --effort high by default', () => {
  delete process.env.ASMLTR_GROK_EFFORT;
  const args = grok.buildArgs({ prompt: 'What is 2+2?', cwd: noGit });
  assert.equal(effortOf(args), 'high');
});

test('ASMLTR_GROK_EFFORT overrides baseline', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    const args = grok.buildArgs({ prompt: 'What is 2+2?', cwd: noGit });
    assert.equal(effortOf(args), 'medium');
    process.env.ASMLTR_GROK_EFFORT = 'low';
    assert.equal(effortOf(grok.buildArgs({ prompt: 'hello', cwd: noGit })), 'low');
    process.env.ASMLTR_GROK_EFFORT = 'xhigh';
    assert.equal(effortOf(grok.buildArgs({ prompt: 'hello', cwd: noGit })), 'xhigh');
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('chooseEffort: medium chat, high lookup/Corona, xhigh code/git/deep-dive', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    assert.equal(grok.chooseEffort({ prompt: 'ok thanks', cwd: noGit }), 'medium');
    assert.equal(grok.chooseEffort({ prompt: "what's up", cwd: noGit }), 'medium');
    assert.equal(grok.chooseEffort({ prompt: 'gm', cwd: noGit }), 'medium');

    for (const p of [
      'look up the Padron 1964 in Corona',
      'lookup the Corona cigar notes',
      'pull the cigar writeup from Corona',
      'what is the recipe',
      'check the rolodex for Jess',
      'search my contacts for Steve',
      'why is nginx slow tonight',
      'troubleshoot the alerts',
      'can you diagnose this hang',
      'research the send policy',
      'look it up',
    ]) {
      assert.equal(grok.chooseEffort({ prompt: p, cwd: noGit }), 'high', p);
    }

    for (const p of [
      'Please implement a helper',
      'Refactor this module',
      'debug the crash',
      'IMPLEMENT the feature',
      'deep dive the mailbox',
      'open a PR for the adapter',
      'git commit this',
      'write some code for the picker',
      'patch the code in grok.js',
    ]) {
      assert.equal(grok.chooseEffort({ prompt: p, cwd: noGit }), 'xhigh', p);
    }
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('bare fix is not xhigh (Proposed Fix / quick fix)', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    for (const p of [
      'Proposed Fix',
      'quick fix',
      'Can you fix the typo',
      'please Fix it',
      'prefix the title',
      'the fixture is ready',
    ]) {
      assert.notEqual(grok.chooseEffort({ prompt: p, cwd: noGit }), 'xhigh', p);
      assert.equal(grok.chooseEffort({ prompt: p, cwd: noGit }), 'medium', p);
    }
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('score effortPrompt (current user message), not catch-up glue', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    const catchUp = '[Channel activity since you last replied]\n- Eve: Proposed Fix for the crash\n[End of catch-up]\n\n';
    assert.equal(grok.chooseEffort({
      prompt: catchUp + 'ok thanks',
      effortPrompt: 'ok thanks',
      cwd: noGit,
    }), 'medium');
    assert.equal(grok.chooseEffort({
      prompt: catchUp + 'implement the picker',
      effortPrompt: 'implement the picker',
      cwd: noGit,
    }), 'xhigh');
    assert.equal(grok.chooseEffort({
      prompt: catchUp + 'look up the cigar in Corona',
      effortPrompt: 'look up the cigar in Corona',
      cwd: noGit,
    }), 'high');
    // glued catch-up must not raise a chat ping
    assert.equal(grok.chooseEffort({
      prompt: catchUp + 'ok thanks',
      effortPrompt: 'ok thanks',
      cwd: noGit,
    }), 'medium');
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('auto-xhigh when cwd is a git repo (temp dir with .git)', () => {
  delete process.env.ASMLTR_GROK_EFFORT;
  const args = grok.buildArgs({ prompt: 'What is 2+2?', cwd: gitCwd });
  assert.equal(effortOf(args), 'xhigh');
});

test('NOT xhigh for a simple question when cwd is not a git repo', () => {
  delete process.env.ASMLTR_GROK_EFFORT;
  const args = grok.buildArgs({ prompt: 'What is 2+2? Reply with just the number.', cwd: noGit });
  assert.equal(effortOf(args), 'high');
  // missing cwd must not fall back to process.cwd() (the clone is a git repo)
  assert.equal(effortOf(grok.buildArgs({ prompt: 'What is 2+2?' })), 'high');
});

test('HOME is never treated as a project git repo', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    assert.equal(grok.isProjectGitRepo(os.homedir()), false);
    assert.equal(effortOf(grok.buildArgs({ prompt: 'hello', cwd: os.homedir() })), 'medium');
    assert.equal(grok.chooseEffort({ prompt: 'ok thanks', cwd: os.homedir() }), 'medium');
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('next-turn file: xhigh once then reset to baseline', () => {
  delete process.env.ASMLTR_GROK_EFFORT;
  fs.writeFileSync(nextFile, 'xhigh\n');
  assert.equal(grok.effortForTurn({ prompt: 'What is 2+2?', cwd: noGit }), 'xhigh');
  assert.equal(fs.existsSync(nextFile), false, 'next-effort file is consumed once');
  assert.equal(grok.effortForTurn({ prompt: 'What is 2+2?', cwd: noGit }), 'high');
});

test('next-turn session flag: xhigh once then reset to baseline', () => {
  delete process.env.ASMLTR_GROK_EFFORT;
  const key = 'assistant-web:local:effort-test';
  sessions.ensure(key, 'assistant-web', 'idle:45', noGit);
  assert.equal(sessions.setNextEffort(key, 'xhigh'), true);
  assert.equal(sessions.get(key).next_effort, 'xhigh');
  assert.equal(grok.effortForTurn({ prompt: 'What is 2+2?', cwd: noGit, conversationKey: key }), 'xhigh');
  assert.equal(sessions.get(key).next_effort, null);
  assert.equal(sessions.consumeNextEffort(key), null);
  assert.equal(grok.effortForTurn({ prompt: 'What is 2+2?', cwd: noGit, conversationKey: key }), 'high');
  sessions.remove(key);
});

test('one-shot next-effort still wins over keywords', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    assert.equal(grok.chooseEffort({ prompt: 'ok thanks', cwd: noGit, nextEffort: 'xhigh' }), 'xhigh');
    assert.equal(grok.chooseEffort({ prompt: 'implement the picker', cwd: noGit, nextEffort: 'medium' }), 'medium');
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('complete() skips auto-raise', () => {
  delete process.env.ASMLTR_GROK_EFFORT;
  const args = grok.buildArgs({ prompt: 'implement a title', complete: true, cwd: gitCwd });
  assert.equal(effortOf(args), 'high');
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    assert.equal(effortOf(grok.buildArgs({ prompt: 'deep dive the mailbox', complete: true, cwd: noGit })), 'medium');
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('max-turns-for-effort: medium 20, high 40, xhigh 60 (cap 100)', () => {
  assert.equal(grok.maxTurnsForEffort('medium'), 20);
  assert.equal(grok.maxTurnsForEffort('high'), 40);
  assert.equal(grok.maxTurnsForEffort('xhigh'), 60);
  assert.equal(grok.maxTurnsForEffort('low'), 20);
  assert.ok(grok.maxTurnsForEffort('xhigh') <= grok.MAX_TURNS_CAP);
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    assert.equal(maxTurnsOf(grok.buildArgs({ prompt: 'ok thanks', cwd: noGit })), 20);
    assert.equal(maxTurnsOf(grok.buildArgs({ prompt: 'look up the cigar in Corona', cwd: noGit })), 40);
    assert.equal(maxTurnsOf(grok.buildArgs({ prompt: 'implement the picker', cwd: noGit })), 60);
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('interactive watchdog is 5 / 10 / 60 even if env baseline is 10m', () => {
  delete process.env.ASMLTR_GROK_TIMEOUT_MS;
  assert.equal(grok.timeoutMsForEffort('medium'), 5 * 60 * 1000);
  assert.equal(grok.timeoutMsForEffort('high'), 10 * 60 * 1000);
  assert.equal(grok.timeoutMsForEffort('xhigh'), 60 * 60 * 1000);
  assert.ok(grok.timeoutMsForEffort('xhigh') <= grok.TIMEOUT_CAP_MS);
  process.env.ASMLTR_GROK_TIMEOUT_MS = '600000';
  try {
    assert.equal(grok.timeoutMsForEffort('medium'), 5 * 60 * 1000);
    assert.equal(grok.timeoutMsForEffort('high'), 10 * 60 * 1000);
    assert.equal(grok.timeoutMsForEffort('xhigh'), 60 * 60 * 1000);
  } finally {
    delete process.env.ASMLTR_GROK_TIMEOUT_MS;
  }
});

test('zip code / lastEffort inherit are not xhigh', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    assert.equal(grok.chooseEffort({ prompt: 'what is the zip code', cwd: noGit }), 'medium');
    assert.equal(grok.chooseEffort({ prompt: 'ok thanks', cwd: noGit, lastEffort: 'xhigh' }), 'medium');
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('email channel forces xhigh + 100 turns + 60m even without code words', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    const prompt = 'Thanks for the update, see you Monday';
    const chatty = 'Hi Ivy,\n\nJust circling back on dinner Thursday and whether Jess is free. Nothing urgent — hope you had a quiet weekend.\n\nThanks for the update, see you Monday\n';
    for (const p of [prompt, chatty]) {
      assert.equal(grok.chooseEffort({ prompt: p, cwd: noGit, channel: 'email' }), 'xhigh', p.slice(0, 40));
      assert.equal(effortOf(grok.buildArgs({ prompt: p, cwd: noGit, channel: 'email' })), 'xhigh');
      assert.equal(maxTurnsOf(grok.buildArgs({ prompt: p, cwd: noGit, channel: 'email' })), 100);
      assert.equal(grok.maxTurnsForEffort(grok.chooseEffort({ prompt: p, cwd: noGit, channel: 'email' }), { channel: 'email' }), 100);
      assert.equal(grok.timeoutMsForEffort('xhigh', { channel: 'email' }), 60 * 60 * 1000);
      assert.equal(grok.timeoutMsForEffort(grok.chooseEffort({ prompt: p, cwd: noGit, channel: 'email' }), { channel: 'email' }), grok.EMAIL_TIMEOUT_MS);
    }
    // generic xhigh (no channel) is 60m
    assert.equal(grok.timeoutMsForEffort('xhigh'), 60 * 60 * 1000);
    assert.ok(grok.EMAIL_TIMEOUT_MS <= grok.TIMEOUT_CAP_MS);
    assert.equal(grok.isEmailChannel('email'), true);
    assert.equal(grok.isEmailChannel('discord'), false);
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('discord ok thanks stays medium 20 / 5m', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    const opts = { prompt: 'ok thanks', cwd: noGit, channel: 'discord' };
    assert.equal(grok.chooseEffort(opts), 'medium');
    assert.equal(effortOf(grok.buildArgs(opts)), 'medium');
    assert.equal(maxTurnsOf(grok.buildArgs(opts)), 20);
    assert.equal(grok.maxTurnsForEffort('medium'), 20);
    assert.equal(grok.timeoutMsForEffort('medium', { channel: 'discord' }), 5 * 60 * 1000);
    assert.equal(grok.timeoutMsForEffort('high', { channel: 'discord' }), 10 * 60 * 1000);
    assert.equal(grok.timeoutMsForEffort(grok.chooseEffort(opts), opts), 5 * 60 * 1000);
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('Discord xhigh stays 60 turns / 60m; email xhigh is 100 / 60m', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    const impl = { prompt: 'Please implement a helper', cwd: noGit, channel: 'discord' };
    assert.equal(grok.chooseEffort(impl), 'xhigh');
    assert.equal(maxTurnsOf(grok.buildArgs(impl)), 60);
    assert.equal(grok.timeoutMsForEffort('xhigh', { channel: 'discord' }), 60 * 60 * 1000);
    const mail = { prompt: 'Thanks for the update, see you Monday', cwd: noGit, channel: 'email' };
    assert.equal(grok.chooseEffort(mail), 'xhigh');
    assert.equal(maxTurnsOf(grok.buildArgs(mail)), 100);
    assert.equal(grok.timeoutMsForEffort('xhigh', { channel: 'email' }), 60 * 60 * 1000);
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('assistant-web, assistant-native, and mcp match discord 5 / 10 / 60', () => {
  for (const channel of ['assistant-web', 'assistant-native', 'discord', 'mcp']) {
    assert.equal(grok.timeoutMsForEffort('medium', { channel }), 5 * 60 * 1000, channel);
    assert.equal(grok.timeoutMsForEffort('high', { channel }), 10 * 60 * 1000, channel);
    assert.equal(grok.timeoutMsForEffort('xhigh', { channel }), 60 * 60 * 1000, channel);
  }
});

test('one-shot next-effort still wins over email xhigh', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    assert.equal(grok.chooseEffort({
      prompt: 'Thanks for the update, see you Monday',
      cwd: noGit,
      channel: 'email',
      nextEffort: 'medium',
    }), 'medium');
    assert.equal(effortOf(grok.buildArgs({
      prompt: 'Thanks for the update, see you Monday',
      cwd: noGit,
      channel: 'email',
      nextEffort: 'medium',
    })), 'medium');
    assert.equal(maxTurnsOf(grok.buildArgs({
      prompt: 'Thanks for the update, see you Monday',
      cwd: noGit,
      channel: 'email',
      nextEffort: 'medium',
    })), 20);
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

function promptOf(args) {
  const i = args.indexOf('-p');
  assert.ok(i >= 0, 'buildArgs must include -p');
  return args[i + 1];
}

test('owner +xh → xhigh and token stripped', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  delete process.env.ASMLTR_GROK_EFFORT_ELEVATE_IDS;
  try {
    for (const prompt of ['hello +xh', '+xh hello', 'please +xh look this up']) {
      const opts = { prompt, cwd: noGit, owner: true };
      assert.equal(grok.chooseEffort(opts), 'xhigh', prompt);
      assert.equal(grok.classifyEffort(opts).reason, 'token:+xh', prompt);
      const args = grok.buildArgs(opts);
      assert.equal(effortOf(args), 'xhigh', prompt);
      const p = promptOf(args);
      assert.equal(p.includes('+xh'), false, 'stripped: ' + prompt);
      assert.ok(p.includes('hello') || p.includes('please') || p.includes('look'), p);
    }
    const bypass = grok.buildArgs({ prompt: 'ping +xh', cwd: noGit, bypass_moderation: true });
    assert.equal(effortOf(bypass), 'xhigh');
    assert.equal(promptOf(bypass).includes('+xh'), false);
    const byKey = grok.buildArgs({ prompt: 'ping +xh', cwd: noGit, user_key: 'owner' });
    assert.equal(effortOf(byKey), 'xhigh');
    assert.equal(promptOf(byKey).includes('+xh'), false);
    // wins over three-tier picker (lookup would be high)
    assert.equal(grok.chooseEffort({ prompt: 'look up Corona +xh', cwd: noGit, owner: true }), 'xhigh');
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('unknown user +xh stays picker and token remains', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  delete process.env.ASMLTR_GROK_EFFORT_ELEVATE_IDS;
  try {
    const opts = { prompt: 'hello +xh', cwd: noGit, senderId: '999000111222333444' };
    assert.equal(grok.chooseEffort(opts), 'medium');
    assert.equal(grok.classifyEffort(opts).reason, 'baseline');
    const args = grok.buildArgs(opts);
    assert.equal(effortOf(args), 'medium');
    assert.ok(promptOf(args).includes('+xh'), 'token remains for unknown');
    // picker still applies
    const impl = { prompt: 'implement the picker +xh', cwd: noGit, senderId: '999000111222333444' };
    assert.equal(grok.chooseEffort(impl), 'xhigh');
    assert.ok(promptOf(grok.buildArgs(impl)).includes('+xh'));
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('owner +h → high and token stripped', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  delete process.env.ASMLTR_GROK_EFFORT_ELEVATE_IDS;
  try {
    const opts = { prompt: 'hello +h', cwd: noGit, owner: true };
    assert.equal(grok.chooseEffort(opts), 'high');
    assert.equal(grok.classifyEffort(opts).reason, 'token:+h');
    const args = grok.buildArgs(opts);
    assert.equal(effortOf(args), 'high');
    assert.equal(promptOf(args).includes('+h'), false);
    assert.ok(promptOf(args).includes('hello'));
    // wins over xhigh picker
    assert.equal(grok.chooseEffort({ prompt: 'implement the picker +h', cwd: noGit, owner: true }), 'high');
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('+xh inside a word is ignored', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  delete process.env.ASMLTR_GROK_EFFORT_ELEVATE_IDS;
  try {
    for (const prompt of ['foo+xh bar', 'pre+xh', 'xx+xh', 'please +xhigh now']) {
      const opts = { prompt, cwd: noGit, owner: true };
      assert.equal(grok.chooseEffort(opts), 'medium', prompt);
      const args = grok.buildArgs(opts);
      assert.equal(effortOf(args), 'medium', prompt);
      assert.equal(promptOf(args), prompt);
    }
    assert.equal(grok.detectElevateToken('foo+xh bar'), null);
    assert.equal(grok.detectElevateToken('hello +xh'), '+xh');
    assert.equal(grok.detectElevateToken('hello +h'), '+h');
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('allowlisted senderId may +xh; off-list may not', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  process.env.ASMLTR_GROK_EFFORT_ELEVATE_IDS = '111,222,333';
  try {
    const yes = { prompt: 'hello +xh', cwd: noGit, senderId: '222' };
    assert.equal(grok.chooseEffort(yes), 'xhigh');
    assert.equal(promptOf(grok.buildArgs(yes)).includes('+xh'), false);
    const no = { prompt: 'hello +xh', cwd: noGit, senderId: '444' };
    assert.equal(grok.chooseEffort(no), 'medium');
    assert.ok(promptOf(grok.buildArgs(no)).includes('+xh'));
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
    delete process.env.ASMLTR_GROK_EFFORT_ELEVATE_IDS;
  }
});

test('+xh / +h override is one turn and does not persist nextEffort', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    assert.equal(grok.effortForTurn({ prompt: 'hello +xh', cwd: noGit, owner: true }), 'xhigh');
    assert.equal(fs.existsSync(nextFile), false);
    assert.equal(grok.effortForTurn({ prompt: 'hello', cwd: noGit, owner: true }), 'medium');
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('inbound email xhigh is 1h and 100 turns for every From', () => {
  const H = 60 * 60 * 1000;
  const sender = { channel: 'email', sender: { raw_id: 'other@example.com', raw_username: 'Other' } };
  assert.equal(grok.timeoutMsForEffort('xhigh', sender), 1 * H);
  assert.equal(grok.timeoutMsForEffort('xhigh', { channel: 'email' }), 1 * H);
  assert.equal(grok.maxTurnsForEffort('xhigh', sender), 100);
  assert.equal(grok.chooseEffort({ prompt: 'Thanks for the update', cwd: noGit, channel: 'email', sender: sender.sender }), 'xhigh');
  assert.equal(grok.EMAIL_TIMEOUT_MS, 1 * H);
});


test('discord / mcp / dashboard stay 5 / 10 / 60', () => {
  for (const channel of ['discord', 'assistant-web', 'assistant-native', 'mcp']) {
    assert.equal(grok.timeoutMsForEffort('medium', { channel }), 5 * 60 * 1000, channel);
    assert.equal(grok.timeoutMsForEffort('high', { channel }), 10 * 60 * 1000, channel);
    assert.equal(grok.timeoutMsForEffort('xhigh', { channel }), 60 * 60 * 1000, channel);
    assert.equal(grok.timeoutMsForEffort('xhigh', {
      channel,
      sender: { raw_id: 'other@example.com' },
    }), 60 * 60 * 1000, channel + ' email sender must not change interactive');
  }
});
