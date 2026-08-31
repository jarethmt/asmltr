'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-effort-'));
const nextFile = path.join(tmp, 'next-effort');
process.env.ASMLTR_GROK_NEXT_EFFORT_FILE = nextFile;
process.env.ASMLTR_GROK_PROMPT_DIR = path.join(tmp, 'prompts');
fs.mkdirSync(process.env.ASMLTR_GROK_PROMPT_DIR, { recursive: true });
process.env.ASMLTR_CORE_DB = path.join(tmp, 'sess.db');
delete process.env.ASMLTR_GROK_EFFORT;
delete process.env.ASMLTR_GROK_MAX_TURNS;
delete process.env.ASMLTR_GROK_TIMEOUT_MS;
delete process.env.ASMLTR_GROK_EFFORT_ELEVATE_IDS;

const grok = require('../core/src/engines/grok');

const noGit = path.join(tmp, 'nogit');
const gitCwd = path.join(tmp, 'gitproj');
fs.mkdirSync(noGit, { recursive: true });
fs.mkdirSync(path.join(gitCwd, '.git'), { recursive: true });

after(() => {
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

function assertNoMaxTurns(args) {
  assert.equal(args.includes('--max-turns'), false, 'buildArgs must omit --max-turns');
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
      'search my contacts for Alex',
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
      'commit and push',
      'push this, then commit',
      'Please commit the change and push it',
      'write some code for the picker',
      'patch the code in grok.js',
    ]) {
      assert.equal(grok.chooseEffort({ prompt: p, cwd: noGit }), 'xhigh', p);
    }
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('visual kind words are not xhigh in the sync picker', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    for (const p of [
      'Please generate an image of a corgi',
      'can you make a new picture',
      'the picture you made of Alex',
      'generate a report',
      'I attached an image, please generate a report',
      'make a list',
    ]) {
      assert.notEqual(grok.chooseEffort({ prompt: p, cwd: noGit }), 'xhigh', p);
    }
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('raiseForImageGen: Discord yes → xhigh; web/email keep their effort', () => {
  const med = { effort: 'medium', reason: 'baseline' };
  assert.deepEqual(grok.raiseForImageGen(med, { imageGen: false, channel: 'discord' }), {
    effort: 'medium', reason: 'baseline', imageGen: false,
  });
  assert.deepEqual(grok.raiseForImageGen(med, { imageGen: true, channel: 'discord' }), {
    effort: 'xhigh', reason: 'image-gen', imageGen: true,
  });
  assert.deepEqual(grok.raiseForImageGen({ effort: 'high', reason: 'web' }, { imageGen: true, channel: 'assistant-web' }), {
    effort: 'high', reason: 'web', imageGen: true,
  });
  assert.deepEqual(grok.raiseForImageGen({ effort: 'xhigh', reason: 'email' }, { imageGen: true, channel: 'email' }), {
    effort: 'xhigh', reason: 'email', imageGen: true,
  });
});

test('bare code is not xhigh; write/patch code still is', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    for (const p of [
      'the code',
      'show me the code',
      'here is some code',
      'what is the zip code',
      'error code 500',
      'code of conduct',
      'I have a code',
    ]) {
      assert.notEqual(grok.chooseEffort({ prompt: p, cwd: noGit }), 'xhigh', p);
    }
    for (const p of [
      'write some code for the picker',
      'write the code',
      'patch the code in grok.js',
      'coding session',
      'the codebase',
    ]) {
      assert.equal(grok.chooseEffort({ prompt: p, cwd: noGit }), 'xhigh', p);
    }
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('bare commit is not xhigh; commit+push in the same post is', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    for (const p of [
      'commit this',
      'we should commit',
      'I have a prior commit in mind',
      'Commit the change. Then we can talk.',
    ]) {
      assert.notEqual(grok.chooseEffort({ prompt: p, cwd: noGit }), 'xhigh', p);
    }
    for (const p of [
      'commit and push',
      'push and then commit',
      'Commit this and push to origin',
      'Commit now. Push later.',
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

test('buildArgs never includes a turn-cap flag and always includes --effort', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    for (const opts of [
      { prompt: 'ok thanks', cwd: noGit },
      { prompt: 'look up the cigar in Corona', cwd: noGit },
      { prompt: 'implement the picker', cwd: noGit },
      { prompt: 'Thanks for the update, see you Monday', cwd: noGit, channel: 'email' },
      { prompt: 'Thanks for the update, see you Monday', cwd: noGit, channel: 'mcp' },
      { prompt: 'ok thanks', cwd: noGit, channel: 'discord' },
      { prompt: 'ok thanks', cwd: noGit, channel: 'assistant-web' },
      { prompt: 'title me', complete: true, cwd: noGit },
    ]) {
      const args = grok.buildArgs(opts);
      assertNoMaxTurns(args);
      assert.ok(args.includes('--effort'), JSON.stringify(opts));
    }
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('runTurn picture classify uses moderation.classifyRaw not grok complete', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'src', 'engines', 'grok.js'), 'utf8');
  assert.match(src, /moderation\.classifyRaw/);
  assert.match(src, /parseImageGenVerdict/);
  assert.match(src, /r\.skipped/);
  assert.match(src, /pictureIntentClassifyText/);
  assert.match(src, /shouldClassifyPictureIntent/);
  assert.match(src, /You are not shown any photo/);
  assert.equal(src.includes('complete(Object.assign'), false);
  const server = fs.readFileSync(path.join(__dirname, '..', 'core', 'src', 'server.js'), 'utf8');
  assert.match(server, /image-gen-classify/);
});

test('runTurn source does not arm a kill timer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'src', 'engines', 'grok.js'), 'utf8');
  const run = src.match(/async function runTurn\([\s\S]*?\n\}/);
  assert.ok(run);
  assert.equal(/setTimeout\([\s\S]{0,240}child\.kill/.test(run[0]), false);
  assert.equal(run[0].includes('watchdog'), false);
  assert.ok(run[0].includes('abortController'));
  const complete = src.match(/async function complete\([\s\S]*?\n\}/);
  assert.ok(complete);
  assert.equal(/setTimeout\([\s\S]{0,240}child\.kill/.test(complete[0]), false);
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

test('ASMLTR_GROK_XHIGH_CHANNELS is ignored; email/mcp still force xhigh', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  process.env.ASMLTR_GROK_XHIGH_CHANNELS = 'discord,telegram';
  try {
    assert.equal(grok.chooseEffort({ prompt: 'hello', cwd: noGit, channel: 'discord' }), 'medium');
    assert.equal(grok.chooseEffort({ prompt: 'hello', cwd: noGit, channel: 'telegram' }), 'medium');
    assert.equal(grok.chooseEffort({ prompt: 'hello', cwd: noGit, channel: 'email' }), 'xhigh');
    assert.equal(grok.classifyEffort({ prompt: 'hello', cwd: noGit, channel: 'email' }).reason, 'email');
    assert.equal(grok.chooseEffort({ prompt: 'hello', cwd: noGit, channel: 'mcp' }), 'xhigh');
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
    delete process.env.ASMLTR_GROK_XHIGH_CHANNELS;
  }
});

test('email channel forces xhigh even without code words', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    const prompt = 'Thanks for the update, see you Monday';
    const chatty = 'Hi Gaia,\n\nJust circling back on dinner Thursday and whether Sam is free. Nothing urgent — hope you had a quiet weekend.\n\nThanks for the update, see you Monday\n';
    for (const p of [prompt, chatty]) {
      assert.equal(grok.chooseEffort({ prompt: p, cwd: noGit, channel: 'email' }), 'xhigh', p.slice(0, 40));
      assert.equal(effortOf(grok.buildArgs({ prompt: p, cwd: noGit, channel: 'email' })), 'xhigh');
      assert.equal(grok.classifyEffort({ prompt: p, cwd: noGit, channel: 'email' }).reason, 'email');
      assertNoMaxTurns(grok.buildArgs({ prompt: p, cwd: noGit, channel: 'email' }));
    }
    assert.equal(grok.isEmailChannel('email'), true);
    assert.equal(grok.isEmailChannel('discord'), false);
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('discord ok thanks stays medium; --effort present; no turn cap', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    const opts = { prompt: 'ok thanks', cwd: noGit, channel: 'discord' };
    assert.equal(grok.chooseEffort(opts), 'medium');
    const args = grok.buildArgs(opts);
    assert.equal(effortOf(args), 'medium');
    assertNoMaxTurns(args);
    assert.ok(args.includes('--effort'));
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('Discord xhigh stays picker; email xhigh is still xhigh', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    const impl = { prompt: 'Please implement a helper', cwd: noGit, channel: 'discord' };
    assert.equal(grok.chooseEffort(impl), 'xhigh');
    assert.equal(effortOf(grok.buildArgs(impl)), 'xhigh');
    assertNoMaxTurns(grok.buildArgs(impl));
    const mail = { prompt: 'Thanks for the update, see you Monday', cwd: noGit, channel: 'email' };
    assert.equal(grok.chooseEffort(mail), 'xhigh');
    assert.equal(effortOf(grok.buildArgs(mail)), 'xhigh');
    assertNoMaxTurns(grok.buildArgs(mail));
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('web channels always high after oneshot; not overridable by +h/+xh or picker', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    for (const channel of ['assistant-web', 'assistant-native', 'eve-assistant-web', 'eve-assistant-native']) {
      assert.equal(grok.isWebChannel(channel), true, channel);
      const chat = { prompt: 'ok thanks', cwd: noGit, channel };
      assert.equal(grok.chooseEffort(chat), 'high', channel);
      assert.equal(grok.classifyEffort(chat).reason, 'web', channel);
      assert.equal(effortOf(grok.buildArgs(chat)), 'high', channel);
      assertNoMaxTurns(grok.buildArgs(chat));
      assert.equal(grok.chooseEffort({ prompt: 'implement the picker', cwd: noGit, channel }), 'high', channel);
      assert.equal(grok.chooseEffort({ prompt: 'generate an image of a corgi', cwd: noGit, channel }), 'high', channel);
      assert.equal(grok.chooseEffort({ prompt: 'look up the cigar in Corona', cwd: noGit, channel }), 'high', channel);
      assert.equal(grok.chooseEffort({ prompt: 'hello +xh', cwd: noGit, channel, owner: true }), 'high', channel);
      assert.equal(grok.chooseEffort({ prompt: 'hello +h', cwd: noGit, channel, owner: true }), 'high', channel);
      assert.equal(grok.classifyEffort({ prompt: 'hello +xh', cwd: noGit, channel, owner: true }).reason, 'web', channel);
      assert.equal(grok.chooseEffort({ prompt: 'ok thanks', cwd: noGit, channel, nextEffort: 'medium' }), 'medium', channel);
      assert.equal(grok.chooseEffort({ prompt: 'ok thanks', cwd: noGit, channel, effort: 'xhigh' }), 'xhigh', channel);
    }
    assert.equal(grok.isWebChannel('discord'), false);
    assert.equal(grok.isWebChannel('email'), false);
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('mcp channel forces xhigh even without code words', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    const prompt = 'Thanks for the update, see you Monday';
    const chatty = 'operator here, peer to peer. Can you take a look when you have a minute?';
    for (const p of [prompt, chatty]) {
      assert.equal(grok.chooseEffort({ prompt: p, cwd: noGit, channel: 'mcp' }), 'xhigh', p.slice(0, 40));
      assert.equal(effortOf(grok.buildArgs({ prompt: p, cwd: noGit, channel: 'mcp' })), 'xhigh');
      assert.equal(grok.classifyEffort({ prompt: p, cwd: noGit, channel: 'mcp' }).reason, 'mcp');
      assertNoMaxTurns(grok.buildArgs({ prompt: p, cwd: noGit, channel: 'mcp' }));
    }
    assert.equal(grok.isMcpChannel('mcp'), true);
    assert.equal(grok.isMcpChannel('MCP'), true);
    assert.equal(grok.isMcpChannel('email'), false);
    assert.equal(grok.isMcpChannel('discord'), false);
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('mcp xhigh wins over one-shot next-effort', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    assert.equal(grok.chooseEffort({
      prompt: 'Thanks for the update, see you Monday',
      cwd: noGit,
      channel: 'mcp',
      nextEffort: 'medium',
    }), 'xhigh');
    const args = grok.buildArgs({
      prompt: 'Thanks for the update, see you Monday',
      cwd: noGit,
      channel: 'mcp',
      nextEffort: 'medium',
    });
    assert.equal(effortOf(args), 'xhigh');
    assertNoMaxTurns(args);
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('email xhigh wins over one-shot next-effort', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    assert.equal(grok.chooseEffort({
      prompt: 'Thanks for the update, see you Monday',
      cwd: noGit,
      channel: 'email',
      nextEffort: 'medium',
    }), 'xhigh');
    const args = grok.buildArgs({
      prompt: 'Thanks for the update, see you Monday',
      cwd: noGit,
      channel: 'email',
      nextEffort: 'medium',
    });
    assert.equal(effortOf(args), 'xhigh');
    assertNoMaxTurns(args);
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});


function promptOf(args) {
  const i = args.indexOf('--prompt-file');
  assert.ok(i >= 0, 'buildArgs must include --prompt-file');
  const body = JSON.parse(fs.readFileSync(args[i + 1], 'utf8'));
  return body.content.find((c) => c.type === 'text').text;
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
    assert.equal(effortOf(byKey), 'medium');
    assert.equal(promptOf(byKey).includes('+xh'), true);
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
    const opts = { prompt: 'hello +xh', cwd: noGit, senderId: '000000000000000000' };
    assert.equal(grok.chooseEffort(opts), 'medium');
    assert.equal(grok.classifyEffort(opts).reason, 'baseline');
    const args = grok.buildArgs(opts);
    assert.equal(effortOf(args), 'medium');
    assert.ok(promptOf(args).includes('+xh'), 'token remains for unknown');
    // picker still applies
    const impl = { prompt: 'implement the picker +xh', cwd: noGit, senderId: '000000000000000000' };
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

test('owner-from email helpers still parse From; they do not set a kill timer', () => {
  const OWNER = 'owner@example.com';
  process.env.ASMLTR_OWNER_FROM_EMAIL = OWNER;
  try {
    const owner = { channel: 'email', sender: { raw_id: OWNER, raw_username: 'Owner Name' } };
    assert.equal(grok.parseEmailAddress('Owner Name <owner@example.com>'), OWNER);
    assert.equal(grok.parseEmailAddress(OWNER), OWNER);
    assert.equal(grok.parseEmailAddress('Owner Name'), '');
    assert.equal(grok.isOwnerFromEmail(owner), true);
    assert.equal(grok.chooseEffort({ prompt: 'Thanks for the update', cwd: noGit, channel: 'email', sender: owner.sender }), 'xhigh');
    assertNoMaxTurns(grok.buildArgs({ prompt: 'Thanks for the update', cwd: noGit, channel: 'email', sender: owner.sender }));

    const other = { channel: 'email', sender: { raw_id: 'other@example.com', raw_username: 'Other' } };
    assert.equal(grok.isOwnerFromEmail(other), false);
    assert.equal(grok.chooseEffort({ prompt: 'Thanks for the update', cwd: noGit, ...other }), 'xhigh');
  } finally {
    delete process.env.ASMLTR_OWNER_FROM_EMAIL;
  }
});

test('owner-from helper is off when ASMLTR_OWNER_FROM_EMAIL is unset', () => {
  delete process.env.ASMLTR_OWNER_FROM_EMAIL;
  const ownerish = { channel: 'email', sender: { raw_id: 'owner@example.com' } };
  assert.equal(grok.isOwnerFromEmail(ownerish), false);
  assert.equal(grok.chooseEffort({ prompt: 'Thanks for the update', cwd: noGit, ...ownerish }), 'xhigh');
});

test('next-turn session flag: xhigh once then reset to baseline', () => {
  delete process.env.ASMLTR_GROK_EFFORT;
  const sessions = require('../core/src/sessions');
  const key = 'assistant-web:local:effort-test';
  sessions.ensure(key, 'assistant-web', 'idle:45', noGit);
  assert.equal(sessions.setNextEffort(key, 'xhigh'), true);
  assert.equal(sessions.get(key).next_effort, 'xhigh');
  assert.equal(grok.effortForTurn({ prompt: 'What is 2+2?', cwd: noGit, conversationKey: key }), 'xhigh');
  assert.equal(sessions.get(key).next_effort, null);
  assert.equal(sessions.consumeNextEffort(key), null);
  assert.equal(grok.effortForTurn({ prompt: 'What is 2+2?', cwd: noGit, conversationKey: key }), 'high');
  sessions.remove(key);
  try { sessions.db.close(); } catch (_) {}
});

test('discord-voice stays low even with lookup-ish words; discord text stays picker', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    const voiceKey = { conversationKey: 'discord-voice:gaia:guild:1', channel: 'discord', cwd: noGit };
    const voiceCtx = { channel: 'discord', channel_context: { voice: true, guildId: '1' }, cwd: noGit };
    const voiceFlag = { channel: 'discord', voice: true, cwd: noGit };
    for (const p of ['ok thanks', 'look up the Padron 1964 in Corona', 'search my contacts', 'can you hear me']) {
      assert.equal(grok.chooseEffort({ prompt: p, ...voiceKey }), 'low', 'key:' + p);
      assert.equal(grok.classifyEffort({ prompt: p, ...voiceKey }).reason, 'discord-voice', 'key reason:' + p);
      assert.equal(grok.chooseEffort({ prompt: p, ...voiceCtx }), 'low', 'ctx:' + p);
      assert.equal(grok.chooseEffort({ prompt: p, ...voiceFlag }), 'low', 'flag:' + p);
      assert.equal(effortOf(grok.buildArgs({ prompt: p, ...voiceKey })), 'low', 'args:' + p);
    }
    const text = { prompt: 'ok thanks', cwd: noGit, channel: 'discord' };
    assert.equal(grok.chooseEffort(text), 'medium');
    assert.equal(effortOf(grok.buildArgs(text)), 'medium');
    assert.equal(grok.chooseEffort({ prompt: 'look up the cigar in Corona', cwd: noGit, channel: 'discord' }), 'high');
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('server passes voice signal into grok classify opts and moderate', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'core', 'src', 'server.js'), 'utf8');
  assert.match(server, /isDiscordVoice/);
  assert.match(server, /channel_context:\s*e\.channel_context/);
  assert.match(server, /voice:\s*voiceTurn/);
  assert.match(server, /moderation\.moderate\([^\n]*voice:\s*voiceTurn/);
  const grokSrc = fs.readFileSync(path.join(__dirname, '..', 'core', 'src', 'engines', 'grok.js'), 'utf8');
  assert.match(grokSrc, /isDiscordVoice\(opts\)/);
  assert.match(grokSrc, /reason: 'discord-voice'/);
  assert.match(grokSrc, /conversationKey, channel_context, voice/);
});

