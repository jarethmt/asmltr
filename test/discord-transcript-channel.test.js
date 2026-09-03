'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  TRANSCRIPT_OFF_ALIASES,
  TRANSCRIPT_ON_ALIASES,
  isTranscriptOff,
  setTranscriptOff,
  serializeTranscriptOff,
  loadTranscriptOff,
  isTranscriptOffCmd,
  isTranscriptOnCmd,
  shouldPostLive,
  shouldUploadLeaveFile,
} = require('../connectors/types/discord/transcript-channel');

const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
const ownerBlock = src.slice(src.indexOf('const OWNER_ONLY_CMDS'), src.indexOf('const meta'));

test('only scribe-off / scribe-on (and spaced forms) are aliases; old transcribe/transcript names are gone', () => {
  for (const a of ['scribe-off', 'scribe off']) {
    assert.equal(isTranscriptOffCmd(a), true, a);
    assert.equal(isTranscriptOnCmd(a), false, a);
    assert.ok(TRANSCRIPT_OFF_ALIASES.includes(a), a);
  }
  for (const a of ['scribe-on', 'scribe on']) {
    assert.equal(isTranscriptOnCmd(a), true, a);
    assert.equal(isTranscriptOffCmd(a), false, a);
    assert.ok(TRANSCRIPT_ON_ALIASES.includes(a), a);
  }
  for (const dead of [
    'transcribe-off', 'transcribe off', 'transcript-off', 'transcript off',
    'transcribe-on', 'transcribe on', 'transcript-on', 'transcript on',
  ]) {
    assert.equal(isTranscriptOffCmd(dead), false, dead);
    assert.equal(isTranscriptOnCmd(dead), false, dead);
  }
  assert.equal(isTranscriptOffCmd('mute'), false);
  assert.equal(isTranscriptOnCmd('unmute'), false);
});

test('OWNER_ONLY_CMDS lists only scribe-off / scribe-on; old names are gone', () => {
  for (const a of ['scribe-off', 'scribe off', 'scribe-on', 'scribe on']) {
    assert.ok(ownerBlock.includes(`'${a}'`), a);
  }
  for (const dead of [
    'transcribe-off', 'transcribe off', 'transcript-off', 'transcript off',
    'transcribe-on', 'transcribe on', 'transcript-on', 'transcript on',
  ]) {
    assert.equal(ownerBlock.includes(`'${dead}'`), false, dead);
  }
  assert.match(src, /if \(OWNER_ONLY_CMDS\.has\(cmd\) && !\(await isOwner\(message\)\)\)/);
});

test('save then simulated reload restores off for that cid, not others', () => {
  const set = new Set();
  setTranscriptOff(set, '111', true);
  setTranscriptOff(set, 222, true); // numeric cid coerced
  setTranscriptOff(set, '333', false); // on = not in set
  const json = JSON.stringify({
    channels: { '111': true },
    channelsDefault: true,
    engageAllBots: false,
    transcriptOffChannels: serializeTranscriptOff(set),
  });
  const loaded = JSON.parse(json);
  const restored = loadTranscriptOff(loaded.transcriptOffChannels);
  assert.equal(isTranscriptOff(restored, '111'), true);
  assert.equal(isTranscriptOff(restored, '222'), true);
  assert.equal(isTranscriptOff(restored, '333'), false);
  assert.equal(isTranscriptOff(restored, '999'), false);
  assert.deepEqual(loaded.channels, { '111': true });
  assert.equal(loaded.channelsDefault, true);
  assert.equal(loaded.engageAllBots, false);
  assert.deepEqual(serializeTranscriptOff(restored), ['111', '222']);
});

test('load ignores missing/non-array transcriptOffChannels (fresh settings)', () => {
  assert.equal(isTranscriptOff(loadTranscriptOff(undefined), '111'), false);
  assert.equal(isTranscriptOff(loadTranscriptOff(null), '111'), false);
  assert.equal(isTranscriptOff(loadTranscriptOff({}), '111'), false);
  assert.deepEqual(serializeTranscriptOff(loadTranscriptOff([])), []);
});

test('when off: live post and leave-file upload skipped for that origin cid; when on: allowed', () => {
  const off = loadTranscriptOff(['chan-off']);
  assert.equal(shouldPostLive({ offSet: off, cid: 'chan-off', instanceDefault: true }), false);
  assert.equal(shouldUploadLeaveFile({ offSet: off, cid: 'chan-off', instanceDefault: true }), false);
  assert.equal(shouldPostLive({ offSet: off, cid: 'chan-on', instanceDefault: true }), true);
  assert.equal(shouldUploadLeaveFile({ offSet: off, cid: 'chan-on', instanceDefault: true }), true);
  // instance default still applies when channel is not in the off-set
  assert.equal(shouldPostLive({ offSet: off, cid: 'chan-on', instanceDefault: false }), false);
  assert.equal(shouldUploadLeaveFile({ offSet: off, cid: 'chan-on', instanceDefault: false }), false);
  // per-channel off wins even if instance default is on
  assert.equal(shouldPostLive({ offSet: off, cid: 'chan-off', instanceDefault: true }), false);
});

test('index.js persists transcriptOffChannels and gates live/leave by origin cid', () => {
  assert.match(src, /require\('\.\/transcript-channel'\)/);
  assert.match(src, /transcriptOffChannels/);
  assert.match(src, /saveSettings\(\)/);
  const save = src.slice(src.indexOf('function saveSettings()'), src.indexOf('function saveSettings()') + 420);
  assert.match(save, /transcriptOffChannels/);
  assert.match(save, /channelsDefault/);
  assert.match(save, /engageAllBots/);

  assert.match(src, /shouldPostLive/);
  assert.match(src, /shouldUploadLeaveFile/);
  assert.match(src, /isTranscriptOffCmd/);
  assert.match(src, /isTranscriptOnCmd/);

  const handle = src.slice(src.indexOf('async function handleControlCommands'), src.indexOf('function buildSystemExtra'));
  assert.match(handle, /setTranscriptOff\(transcriptOffChannels/);
  assert.match(handle, /saveSettings\(\)/);
  assert.match(handle, /scribe-on/);
  assert.equal(/voicePostTranscript\s*=\s*true/.test(handle), false);
  assert.equal(/voicePostTranscript\s*=\s*false/.test(handle), false);
  // off reply must not promise a leave .txt
  const offReply = handle.slice(handle.indexOf('isTranscriptOffCmd'), handle.indexOf('isTranscriptOnCmd') + 400);
  assert.equal(/upload the full transcript/.test(offReply), false);
  assert.match(offReply, /scribe-on/);

  const partial = src.slice(src.indexOf('async function onVoicePartial'), src.indexOf('async function handleVoiceUtterance'));
  assert.match(partial, /shouldPostLive/);

  const utter = src.slice(src.indexOf('async function handleVoiceUtterance'), src.indexOf('async function engineKeys'));
  assert.match(utter, /shouldPostLive/);
  assert.match(utter, /🔊 \*\*\$\{NAME\}:\*\*/);
  // spoken mirror gated the same way
  const mirror = utter.slice(utter.indexOf('🔊'));
  assert.match(src.slice(src.indexOf('if (full.trim() && live())'), src.indexOf('if (full.trim() && live())') + 280), /shouldPostLive/);

  const upload = src.slice(src.indexOf('async function uploadTranscript'), src.indexOf('async function uploadTranscript') + 700);
  assert.match(upload, /shouldUploadLeaveFile/);

  const join = src.slice(src.indexOf('async function doJoinVoice'), src.indexOf('async function doLeaveVoice'));
  assert.match(join, /isTranscriptOff\(transcriptOffChannels/);
  assert.match(join, /scribe-off/);

  const help = src.slice(src.indexOf("case 'help'"), src.indexOf("case 'help'") + 900);
  assert.match(help, /scribe-off/);
  assert.match(help, /scribe-on/);
});
