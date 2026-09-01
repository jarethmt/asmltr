'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  looksLikePromptLeak, looksLikePromptRestatement, toolTitle, humanToolChip, discordToolLine, discordThoughtLine,
  speakerHintsFrom, mentionsSpeaker, identityHintsFrom, identityHintKindMap, mergeSpeakerLastNames,
  publicBlockHints, pickPublicReply, thoughtBudget,
  isImageGenTool,
  stripThoughtChrome, quietReplyFromResult, GENERATING_LINE,
} = require('../shared/step-public');

test('looksLikePromptLeak: generic prompt-restatement patterns only', () => {
  assert.equal(looksLikePromptLeak('CURRENT SPEAKER — READ FIRST'), true);
  assert.equal(looksLikePromptLeak('see identity.md for the rest'), true);
  assert.equal(looksLikePromptLeak('CLAUDE.md says hello'), true);
  assert.equal(looksLikePromptLeak('write owner@example.com a note'), true);
  assert.equal(looksLikePromptLeak('path is /home/someone/.asmltr'), true);
  assert.equal(looksLikePromptLeak('Reading a file'), false);
  assert.equal(looksLikePromptLeak('the answer is 42'), false);
  assert.equal(looksLikePromptLeak('The user is Ada (ada-id) asking me (Gaia) in #room'), true);
  assert.equal(looksLikePromptLeak('This is a Discord message in #food'), true);
  assert.equal(looksLikePromptLeak('I was @-mentioned, so I should reply'), true);
  assert.equal(looksLikePromptLeak('Let me search the recipe board'), false);
});

test('speaker hints are runtime-only; thoughts mentioning them are dropped', () => {
  const author = { username: 'wx412', globalName: 'Ada Lovelace' };
  const hints = speakerHintsFrom(author);
  const hintKinds = mergeSpeakerLastNames(new Map(), author, null);
  assert.ok(hints.includes('wx412'));
  assert.ok(hints.includes('Ada Lovelace'));
  assert.ok(hints.includes('Lovelace'));
  assert.equal(hints.includes('Ada'), false); // tokens under 4 chars are skipped
  assert.equal(mentionsSpeaker('Ada Lovelace asked for ingredients', hints), true);
  assert.equal(mentionsSpeaker('wx412 is waiting', hints), true);
  assert.equal(mentionsSpeaker('Checking the recipe board', hints), false);
  assert.equal(discordThoughtLine('The user is Ada Lovelace (wx412) asking in #food', hints, hintKinds), '');
  assert.equal(discordThoughtLine('Let me search more thoroughly', hints, hintKinds), '-# 💭 Let me search more thoroughly');
  assert.equal(discordThoughtLine('Morgan asked about the recipe', hints, hintKinds), '-# 💭 Morgan asked about the recipe');
});

test('thoughtBudget: xhigh uncapped; high/medium 2; below medium 0', () => {
  assert.equal(thoughtBudget('xhigh'), Infinity);
  assert.equal(thoughtBudget('high'), 2);
  assert.equal(thoughtBudget('medium'), 2);
  assert.equal(thoughtBudget('low'), 0);
  assert.equal(thoughtBudget(''), 2); // default before onEffort = medium
  assert.equal(thoughtBudget('high', { publicChannel: true }), 2);
  assert.equal(thoughtBudget('high', { publicChannel: false }), 2);
  assert.equal(thoughtBudget('xhigh', { imageGen: true }), 0);
  assert.equal(thoughtBudget('medium', { imageGen: true }), 0);
});

test('isImageGenTool and GENERATING_LINE', () => {
  assert.equal(isImageGenTool('image_gen'), true);
  assert.equal(isImageGenTool({ name: 'image_edit' }), true);
  assert.equal(isImageGenTool('image-gen'), true);
  assert.equal(isImageGenTool('Read'), false);
  assert.equal(isImageGenTool('Bash'), false);
  assert.equal(isImageGenTool({ name: 'web_search' }), false);
  assert.equal(GENERATING_LINE, '-# Generating - this takes a while. Please be patient.');
});

test('human chips: start only, no paths or ACP type names', () => {
  assert.equal(humanToolChip({ name: 'Read' }), 'Reading a file');
  assert.equal(humanToolChip({ name: 'read_file' }), 'Reading a file');
  assert.equal(humanToolChip({ name: 'Bash' }), 'Running a command');
  assert.equal(humanToolChip({ name: 'Grep' }), 'Searching');
  assert.equal(humanToolChip({ name: 'WebSearch' }), 'Looking something up');
  assert.equal(humanToolChip({ name: 'tool_call' }), 'Working');
  assert.equal(humanToolChip({ name: 'tool_call_update' }), 'Working');
  assert.equal(humanToolChip({}), 'Working');
  assert.equal(toolTitle({ name: '/tmp/secret' }), '');
  assert.equal(discordToolLine(false, { name: 'Read' }), '-# Reading a file');
  assert.equal(discordToolLine(true, { name: 'Read' }), '-# 🔧 `Read`');
  assert.equal(discordToolLine(true, { name: 'tool_call' }), '-# 🔧 `Working`');
  assert.ok(!discordToolLine(false, { name: 'Read', input: { path: '/home/someone/x' } }).includes('/home'));
});

test('stripThoughtChrome: email/mcp drop chips and thought preamble, keep the answer', () => {
  const leaked = "The user asked how the EXAMPLE.COM negotiation is going. That is not an ops-desk alert — I'll answer the thread directly.You did well on the first two replies.";
  const out = stripThoughtChrome(leaked);
  assert.equal(out.startsWith('You did well'), true, out.slice(0, 80));
  assert.equal(out.includes('ops-desk'), false);
  assert.equal(stripThoughtChrome('-# Working\n-# 💭 Checking mail\nThe SPF is fixed.'), 'The SPF is fixed.');
  assert.equal(stripThoughtChrome('You did well on the first two replies.'), 'You did well on the first two replies.');
  const q = quietReplyFromResult({
    segments: ['The user asked how the deal is going.', '**What worked**\nYou did not take $1,000.'],
    text: 'glued should not win',
  });
  assert.equal(q, '**What worked**\nYou did not take $1,000.');
});


test('stripThoughtChrome: glued plan+letter in one last segment survives (no name/plan cut)', () => {
  const plan = 'Photo is two CyberPower PR2200LCDRT2U units. OEM cartridge is RB1290X4F — I’ll send the Amazon links and flag that you need two, one per unit.';
  const letter = "You're right — those are CyberPower. The model is PR2200LCDRT2U.";
  const glued = plan + '\n\n' + letter;
  assert.equal(stripThoughtChrome(glued), glued);
  assert.equal(quietReplyFromResult({ segments: [glued], text: glued }), glued);
  assert.equal(stripThoughtChrome("I'll send the invoice tomorrow."), "I'll send the invoice tomorrow.");
  const greeted = 'Alex,\n\n' + letter;
  assert.equal(stripThoughtChrome(greeted), greeted);
  assert.equal(stripThoughtChrome(letter), letter);
});

test('discordThoughtLine: leaky bubbles dropped whole; safe intent becomes 💭 chip', () => {
  assert.equal(discordThoughtLine('CURRENT SPEAKER — READ FIRST, TRUST THIS'), '');
  assert.equal(discordThoughtLine('I should open identity.md next'), '');
  assert.equal(discordThoughtLine('see CLAUDE.md'), '');
  assert.equal(discordThoughtLine('email owner@example.com about this'), '');
  assert.equal(discordThoughtLine('check /home/someone/.asmltr'), '');
  assert.equal(discordThoughtLine(''), '');
  const safe = discordThoughtLine('Checking the mailbox before I answer.');
  assert.equal(safe, '-# 💭 Checking the mailbox before I answer.');
  const long = 'x'.repeat(400);
  const clamped = discordThoughtLine(long);
  assert.ok(clamped.startsWith('-# 💭 '));
  assert.ok(clamped.length <= '-# 💭 '.length + 280);
  assert.ok(clamped.endsWith('…'));
});

test('Discord never renderSteps raw thought text', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.equal(src.includes("renderStep('💭 '"), false);
  assert.match(src, /discordThoughtLine/);
  assert.match(src, /onThinking:/);
  assert.match(src, /if \(quietImageGen \|\| maxThoughts <= 0\) return;/);
  assert.match(src, /not xhigh: 💭 only, no tooling/);
  assert.match(src, /no Working filler on medium\/high/);
  assert.match(src, /let stopBeat = \(\) => \{\};/);
  assert.match(src, /try \{ stopBeat\(\); \} catch/);
  assert.equal(src.includes('looksLikeImageGen'), false);
  assert.match(src, /GENERATING_LINE/);
  assert.match(src, /isImageGenTool/);
  assert.match(src, /quietImageGen/);
  assert.match(src, /enterImageGenQuiet/);
  assert.match(src, /meta && meta.imageGen/);
  assert.match(src, /thoughtBudget\(effort, \{ imageGen: quietImageGen \}\)/);
  assert.match(src, /pickPublicReply/);
  assert.equal(src.includes('identityHintsFrom'), false);
  assert.equal(src.includes('loadIdentityHints'), false);
  assert.match(src, /speakerHintsFrom/);
  assert.match(src, /publicBlockHints/);
  assert.match(src, /mergeSpeakerLastNames/);
  assert.match(src, /leakDropped/);
});

test('looksLikePromptRestatement does not treat vendor email as a prompt dump', () => {
  assert.equal(looksLikePromptRestatement('write owner@example.com a note'), false);
  assert.equal(looksLikePromptLeak('write owner@example.com a note'), true);
  assert.equal(looksLikePromptRestatement('CURRENT SPEAKER — READ FIRST'), true);
});

test('identityHintsFrom splits hyphenated principal ids and keeps mailboxes whole', () => {
  const hints = identityHintsFrom([{
    id: 'fixture-person',
    display_name: 'Ada Lovelace',
    identifiers: [
      { surface: 'email', value: 'ada@example.com' },
      { surface: 'discord', value: '123456789012345678' },
    ],
  }, { id: 'self', display_name: 'GaiaBot' }]);
  assert.ok(hints.includes('fixture-person'));
  assert.ok(hints.includes('person'));
  assert.ok(hints.includes('Lovelace'));
  assert.ok(hints.includes('ada@example.com'));
  assert.equal(hints.includes('com'), false);
  assert.equal(hints.includes('123456789012345678'), false);
  assert.equal(hints.includes('self'), false);
  assert.equal(hints.includes('GaiaBot'), false);
  const hintKinds = identityHintKindMap([{
    id: 'fixture-person',
    display_name: 'Ada Lovelace',
    identifiers: [
      { surface: 'email', value: 'ada@example.com' },
      { surface: 'discord', value: '123456789012345678' },
    ],
  }, { id: 'self', display_name: 'GaiaBot' }]);
  assert.equal(discordThoughtLine('Updating principal fixture-person', hints, hintKinds), '-# 💭 Updating principal fixture-person');
  assert.equal(discordThoughtLine('Email Ada Lovelace the links', hints, hintKinds), '');
  assert.equal(discordThoughtLine('Checking the recipe board', hints, hintKinds), '-# 💭 Checking the recipe board');
});

test('pickPublicReply: public leak posts a reason, never the raw reply; DMs still do', () => {
  const records = [{
    id: 'fixture-person',
    display_name: 'Ada Lovelace',
    identifiers: [{ surface: 'email', value: 'ada@example.com' }],
  }];
  const hints = identityHintsFrom(records);
  const hintKinds = identityHintKindMap(records);
  const opts = { hints, hintKinds };
  assert.equal(pickPublicReply({
    pending: '',
    replyText: 'Sent to ada@example.com',
    leakDropped: true,
    publicSurface: true,
    ...opts,
  }), 'response blocked due to privacy rules: no email');
  assert.equal(pickPublicReply({
    pending: '',
    replyText: 'Sent to ada@example.com',
    leakDropped: true,
    publicSurface: false,
    ...opts,
  }), 'Sent to ada@example.com');
  assert.equal(pickPublicReply({
    pending: '',
    replyText: 'Alex picked Rivera as a last name.',
    leakDropped: false,
    publicSurface: true,
    hints: identityHintsFrom([{ id: 'owner', display_name: 'Alex Rivera' }]),
    hintKinds: identityHintKindMap([{ id: 'owner', display_name: 'Alex Rivera' }]),
  }), 'response blocked due to privacy rules: no last name');
  assert.equal(pickPublicReply({
    pending: '',
    replyText: 'Use vendor@example.com for the catalog.',
    leakDropped: false,
    publicSurface: true,
    ...opts,
  }), 'Use vendor@example.com for the catalog.');
  assert.equal(pickPublicReply({
    pending: 'Sent. Same pack, to the address on file.',
    replyText: 'Sent to ada@example.com',
    leakDropped: false,
    publicSurface: true,
    ...opts,
  }), 'Sent. Same pack, to the address on file.');
  assert.equal(pickPublicReply({
    pending: '',
    replyText: 'Updating fixture-person now.',
    leakDropped: false,
    publicSurface: true,
    ...opts,
  }), 'Updating fixture-person now.');
  const notice = pickPublicReply({
    pending: '',
    replyText: 'Sent to ada@example.com',
    leakDropped: true,
    publicSurface: true,
    ...opts,
  });
  assert.equal(notice.includes('ada@example.com'), false);
  assert.equal(notice.includes('Lovelace'), false);
  assert.equal(pickPublicReply({
    pending: 'Alex picked it.',
    replyText: '',
    leakDropped: true,
    publicSurface: true,
    hints: identityHintsFrom([{ id: 'owner', display_name: 'Alex Rivera' }]),
    hintKinds: identityHintKindMap([{ id: 'owner', display_name: 'Alex Rivera' }]),
  }), 'Alex picked it.');
  assert.equal(pickPublicReply({
    pending: '',
    replyText: 'Yes, Rivera is the correct spelling.',
    leakDropped: false,
    publicSurface: true,
    hints: identityHintsFrom([{ id: 'owner', display_name: 'Alex Rivera' }]),
    hintKinds: identityHintKindMap([{ id: 'owner', display_name: 'Alex Rivera' }]),
  }), 'response blocked due to privacy rules: no last name');
  const grayOwner = {
    hints: identityHintsFrom([{ id: 'owner', display_name: 'Alex Gray' }]),
    hintKinds: identityHintKindMap([{ id: 'owner', display_name: 'Alex Gray' }]),
  };
  assert.equal(pickPublicReply({
    pending: '',
    replyText: 'Don’t get a regular 60 Gray reading — look for SI units.',
    leakDropped: false,
    publicSurface: true,
    ...grayOwner,
  }), 'Don’t get a regular 60 Gray reading — look for SI units.');
  assert.equal(pickPublicReply({
    pending: '',
    replyText: 'The industry mixed base, shape, gray-equivalent, and color temp.',
    leakDropped: false,
    publicSurface: true,
    ...grayOwner,
  }), 'The industry mixed base, shape, gray-equivalent, and color temp.');
  assert.equal(pickPublicReply({
    pending: '',
    replyText: 'A 50/100/150 Gray 3-way. Real grays, not equivalent.',
    leakDropped: false,
    publicSurface: true,
    ...grayOwner,
  }).startsWith('response blocked'), false);
  const blackCard = {
    hints: identityHintsFrom([{ id: 'neighbor', display_name: 'Ada Black' }]),
    hintKinds: identityHintKindMap([{ id: 'neighbor', display_name: 'Ada Black' }]),
  };
  assert.equal(pickPublicReply({
    pending: '',
    replyText: 'Paint the wall black.',
    leakDropped: false,
    publicSurface: true,
    ...blackCard,
  }), 'Paint the wall black.');
  assert.equal(pickPublicReply({
    pending: '',
    replyText: 'The customer last name is Black.',
    leakDropped: false,
    publicSurface: true,
    ...blackCard,
  }), 'response blocked due to privacy rules: no last name');
  assert.equal(pickPublicReply({
    pending: '',
    replyText: 'Check the Lovelace kernel docs.',
    leakDropped: false,
    publicSurface: true,
    ...opts,
  }), 'Check the Lovelace kernel docs.');
  assert.equal(pickPublicReply({
    pending: '',
    replyText: 'Ada Lovelace wrote the notes.',
    leakDropped: false,
    publicSurface: true,
    ...opts,
  }), 'response blocked due to privacy rules: no last name');
  const parkStaff = {
    hints: identityHintsFrom([{ id: 'staff', display_name: 'Riley Park' }]),
    hintKinds: identityHintKindMap([{ id: 'staff', display_name: 'Riley Park' }]),
  };
  assert.equal(pickPublicReply({
    pending: '',
    replyText: 'North / Lincoln Park — tonight into Friday (EDT)',
    leakDropped: false,
    publicSurface: true,
    ...parkStaff,
  }), 'North / Lincoln Park — tonight into Friday (EDT)');
  assert.equal(pickPublicReply({
    pending: '',
    replyText: 'Riley Park is on site.',
    leakDropped: false,
    publicSurface: true,
    ...parkStaff,
  }), 'response blocked due to privacy rules: no last name');
  assert.equal(pickPublicReply({
    pending: '',
    replyText: 'Is Park the correct spelling?',
    leakDropped: false,
    publicSurface: true,
    ...parkStaff,
  }), 'response blocked due to privacy rules: no last name');
  const kinds = identityHintKindMap([{ id: 'owner', display_name: 'Alex Rivera' }]);
  assert.equal(kinds.get('alex'), 'first-name');
  assert.equal(kinds.get('rivera'), 'last-name');
  assert.equal(identityHintKindMap([{ id: 'solo', display_name: 'Casey' }]).get('casey'), 'first-name');
  assert.equal(identityHintKindMap([{ id: 'ada', display_name: 'Ada Lovelace' }]).get('lovelace'), 'last-name');
  assert.deepEqual(publicBlockHints(['Alex', 'Rivera', 'wx412'], kinds).map((h) => h.toLowerCase()), ['rivera']);
});

