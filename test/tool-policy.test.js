'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { policyFor, denyToolsEnv } = require('../shared/tool-policy');
const { buildToolbeltPrompt } = require('../shared/toolbelt-prompt');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-tool-policy-'));
const allowFile = path.join(tmp, 'tool-policy.json');
fs.writeFileSync(allowFile, JSON.stringify({
  siloAllow: { guilds: ['guild-allow-1'], channels: [] },
}));
process.env.ASMLTR_TOOL_POLICY_FILE = allowFile;

test('public discord denies shell/streams/send/write, not silo', () => {
  const p = policyFor({
    channel: 'discord', public: true,
    context: { scope_id: 'guild:other-guild' },
    channel_context: { channelId: 'ch1' },
  }, { bypass_moderation: false });
  assert.equal(p.restricted, true);
  assert.deepEqual(p.deny, {
    shell: true, streams: true, send: true, silo: false, write: true,
    siloWrite: false, video: true, image: true, code: true, attach: true, uploads: true, guildPost: true,
  });
});

test('allowlisted guild same denies; silo still on', () => {
  const p = policyFor({
    channel: 'discord', public: true,
    context: { scope_id: 'guild:guild-allow-1' },
    channel_context: { channelId: 'ch1' },
  }, { bypass_moderation: false });
  assert.deepEqual(p.deny, {
    shell: true, streams: true, send: true, silo: false, write: true,
    siloWrite: false, video: true, image: true, code: true, attach: true, uploads: true, guildPost: true,
  });
});

test('discord DM + bypass_moderation denies nothing', () => {
  const p = policyFor({
    channel: 'discord', public: false,
    context: { scope_id: 'dm:someone' },
  }, { bypass_moderation: true });
  assert.equal(p.restricted, false);
  assert.deepEqual(p.deny, {
    shell: false, streams: false, send: false, silo: false, write: false,
    siloWrite: false, video: false, image: false, code: false, attach: false, uploads: false, guildPost: true,
  });
});

test('discord DM without bypass is restricted', () => {
  const p = policyFor({
    channel: 'discord', public: false,
    context: { scope_id: 'dm:stranger' },
  }, { bypass_moderation: false });
  assert.equal(p.restricted, true);
  assert.equal(p.deny.shell, true);
  assert.equal(p.deny.send, true);
});

test('email and mcp are not Discord-restricted but deny video/image/code without authorization', () => {
  for (const ch of ['email', 'mcp', 'core', 'assistant-web']) {
    const p = policyFor({ channel: ch, public: false }, { bypass_moderation: false });
    assert.equal(p.restricted, false, ch);
    assert.equal(p.deny.send, false, ch);
    assert.equal(p.deny.video, true, ch);
    assert.equal(p.deny.image, true, ch);
    assert.equal(p.deny.attach, true, ch);
    assert.equal(p.deny.code, true, ch);
    assert.equal(p.deny.shell, true, ch);
    assert.equal(p.deny.write, true, ch);
  }
});

test('videoAllow principal may generate video without bypass', () => {
  const allow = {
    guilds: [], channels: [],
    videoPrincipals: ['dave-graham'],
    videoDiscordIds: [],
  };
  const p = policyFor(
    { channel: 'email', public: false },
    { bypass_moderation: false, user_key: 'dave-graham' },
    allow,
  );
  assert.equal(p.deny.video, false);
  assert.equal(p.deny.image, false);
  assert.equal(p.deny.attach, false);
  assert.equal(p.deny.code, true);
});

test('videoAllow discord id may generate video', () => {
  const allow = {
    guilds: [], channels: [],
    videoPrincipals: [],
    videoDiscordIds: ['405439774275534852'],
  };
  const p = policyFor(
    { channel: 'discord', public: true, sender: { raw_id: '405439774275534852' } },
    { bypass_moderation: false, user_key: 'dave-graham' },
    allow,
  );
  assert.equal(p.deny.video, false);
  assert.equal(p.deny.image, false);
  assert.equal(p.restricted, true);
});

test('imageAllow / photoAllow grants stills and post, not video', () => {
  const allow = {
    guilds: [], channels: [],
    videoPrincipals: [], videoDiscordIds: [],
    imagePrincipals: ['steve'], imageDiscordIds: ['313489081642254337'],
  };
  const p = policyFor(
    { channel: 'discord', public: true, sender: { raw_id: '313489081642254337' } },
    { bypass_moderation: false, user_key: 'steve' },
    allow,
  );
  assert.equal(p.deny.image, false);
  assert.equal(p.deny.attach, false);
  assert.equal(p.deny.video, true);
  assert.equal(p.restricted, true);
});

test('codeAllow may receive programs without bypass; still no video/image', () => {
  const allow = {
    guilds: [], channels: [],
    videoPrincipals: [], videoDiscordIds: [],
    codePrincipals: ['nick-myers'], codeDiscordIds: [],
  };
  const p = policyFor(
    { channel: 'email', public: false },
    { bypass_moderation: false, user_key: 'nick-myers' },
    allow,
  );
  assert.equal(p.deny.code, false);
  assert.equal(p.deny.shell, false);
  assert.equal(p.deny.write, false);
  assert.equal(p.deny.video, true);
  assert.equal(p.deny.image, true);
  assert.equal(p.deny.attach, true);
});

test('restricted prompt omits send/streams/silo/bash-silo', () => {
  const text = buildToolbeltPrompt({
    deny: { shell: true, streams: true, send: true, silo: true, attach: true },
    selfSiloDir: '/tmp/self',
    attachments: true,
    channel: 'discord',
    chTarget: 'ch1',
  });
  assert.equal(text.includes('asmltr send'), false);
  assert.ok(text.includes('asmltr guild-post'));
  assert.ok(text.includes('Post complete'));
  assert.equal(text.includes('asmltr streams'), false);
  assert.equal(text.includes('asmltr announce'), false);
  assert.equal(text.includes('SELF SILO'), false);
  assert.equal(text.includes('asmltr silo'), false);
  assert.equal(/use the Bash tool/.test(text), false);
  assert.ok(text.includes('asmltr ls'));
  assert.equal(text.includes('asmltr bounce'), false);
  assert.equal(text.includes('asmltr post --file'), false);
});

test('allowlisted silo + no bash advertises silo MCP not Bash silo', () => {
  const text = buildToolbeltPrompt({
    deny: { shell: true, streams: true, send: true, silo: false, siloWrite: true },
    selfSiloDir: '/tmp/self',
  });
  assert.ok(text.includes('SELF SILO'));
  assert.ok(text.includes('asmltr_silo_find'));
  assert.equal(text.includes('use the Bash tool'), false);
  assert.equal(text.includes('asmltr send'), false);
  assert.equal(text.includes('asmltr streams'), false);
  assert.equal(text.includes('asmltr announce'), false);
  assert.equal(text.includes('asmltr silo put'), false);
  assert.equal(text.includes('NaN'), false);
  assert.ok(text.includes('asmltr silo get'));
});

test('silo prompt has no NaN; put only when siloWrite is allowed', () => {
  const owner = buildToolbeltPrompt({ deny: {}, selfSiloDir: '/tmp/self', bypassModeration: true });
  assert.equal(owner.includes('NaN'), false);
  assert.ok(owner.includes('asmltr silo put'));
  assert.ok(owner.includes('asmltr bounce'));
  assert.ok(owner.includes('ALWAYS last'));
  assert.ok(owner.includes('Do not wait on another session to write the mail'));
  assert.ok(owner.includes('--force'));
  const ro = buildToolbeltPrompt({
    deny: { siloWrite: true },
    selfSiloDir: '/tmp/self',
  });
  assert.equal(ro.includes('NaN'), false);
  assert.equal(ro.includes('asmltr silo put'), false);
});

test('denyToolsEnv lists denied kinds', () => {
  assert.equal(
    denyToolsEnv({ shell: true, streams: true, send: true, silo: true, write: true, siloWrite: true, video: true, image: true, code: true, attach: true, uploads: true, guildPost: true }),
    'shell,streams,send,silo,write,siloWrite,video,image,code,attach,uploads,guildPost',
  );
  assert.equal(denyToolsEnv({ shell: true, streams: true, send: true, silo: false, write: true, siloWrite: true }), 'shell,streams,send,write,siloWrite');
});

test('restricted prompt names video/image/code off when denied', () => {
  const text = buildToolbeltPrompt({ deny: { video: true, image: true, code: true } });
  assert.ok(text.includes('VIDEO GENERATION is off this turn'));
  assert.ok(text.includes('IMAGE GENERATION is off this turn'));
  assert.ok(text.includes('WRITING PROGRAMS is off this turn'));
  const on = buildToolbeltPrompt({ deny: {} });
  assert.equal(on.includes('VIDEO GENERATION is off this turn'), false);
  assert.equal(on.includes('IMAGE GENERATION is off this turn'), false);
  assert.equal(on.includes('WRITING PROGRAMS is off this turn'), false);
});
