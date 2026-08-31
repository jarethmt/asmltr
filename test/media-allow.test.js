'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe } = require('node:test');
const { policyFor, denyToolsEnv, isRestricted } = require('../shared/media-allow');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-media-allow-'));
const allowFile = path.join(tmp, 'media-allow.json');
fs.writeFileSync(allowFile, JSON.stringify({
  siloAllow: { guilds: ['guild-allow-1'], channels: [] },
}));
process.env.ASMLTR_MEDIA_ALLOW_FILE = allowFile;

test('public discord: Cast/allowlists only — not a V31 channel-deny plane', () => {
  const p = policyFor({
    channel: 'discord', public: true,
    context: { scope_id: 'guild:other-guild' },
    channel_context: { channelId: 'ch1' },
  }, { bypass_moderation: false });
  assert.equal(p.restricted, false);
  assert.equal(isRestricted({ channel: 'discord', public: true }, { bypass_moderation: false }), false);
  assert.equal(p.deny.send, false);
  assert.equal(p.deny.streams, false);
  assert.equal(p.deny.uploads, false);
  assert.equal(p.deny.silo, false);
  assert.equal(p.deny.video, true);
  assert.equal(p.deny.code, true);
  assert.equal(p.deny.shell, true);
  assert.equal(p.deny.guildPost, true);
});

test('allowlisted guild still not a channel-deny; silo still on', () => {
  const p = policyFor({
    channel: 'discord', public: true,
    context: { scope_id: 'guild:guild-allow-1' },
    channel_context: { channelId: 'ch1' },
  }, { bypass_moderation: false });
  assert.equal(p.restricted, false);
  assert.equal(p.deny.silo, false);
  assert.equal(p.deny.send, false);
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

test('discord DM without bypass is not a public V31 plane (overlay keeps no-shell)', () => {
  const p = policyFor({
    channel: 'discord', public: false,
    context: { scope_id: 'dm:stranger' },
  }, { bypass_moderation: false });
  assert.equal(p.restricted, false);
  assert.equal(isRestricted({ channel: 'discord', public: false }, { bypass_moderation: false }), false);
  assert.equal(p.deny.send, false);
  assert.equal(p.deny.shell, true); // code allowlist, not V31
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
    videoPrincipals: ['friend-a'],
    videoDiscordIds: [],
  };
  const p = policyFor(
    { channel: 'email', public: false },
    { bypass_moderation: false, user_key: 'friend-a' },
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
    videoDiscordIds: ['000000000000000001'],
  };
  const p = policyFor(
    { channel: 'discord', public: true, sender: { raw_id: '000000000000000001' } },
    { bypass_moderation: false, user_key: 'friend-a' },
    allow,
  );
  assert.equal(p.deny.video, false);
  assert.equal(p.deny.image, false);
  assert.equal(p.restricted, false);
});

test('photoAllow / imageAllow host lists are not a public stills gate', () => {
  const allow = {
    guilds: [], channels: [],
    videoPrincipals: [], videoDiscordIds: [],
    imagePrincipals: ['friend'], imageDiscordIds: ['111111111111111111'],
  };
  const p = policyFor(
    { channel: 'discord', public: true, sender: { raw_id: '111111111111111111' } },
    { bypass_moderation: false, user_key: 'friend' },
    allow,
  );
  assert.equal(p.deny.image, true);
  assert.equal(p.deny.attach, true);
  assert.equal(p.deny.video, true);
  assert.equal(p.restricted, false);
});

test('codeAllow may receive programs without bypass; still no video/image', () => {
  const allow = {
    guilds: [], channels: [],
    videoPrincipals: [], videoDiscordIds: [],
    codePrincipals: ['friend-b'], codeDiscordIds: [],
  };
  const p = policyFor(
    { channel: 'email', public: false },
    { bypass_moderation: false, user_key: 'friend-b' },
    allow,
  );
  assert.equal(p.deny.code, false);
  assert.equal(p.deny.shell, false);
  assert.equal(p.deny.write, false);
  assert.equal(p.deny.video, true);
  assert.equal(p.deny.image, true);
  assert.equal(p.deny.attach, true);
});




test('denyToolsEnv lists denied kinds', () => {
  assert.equal(
    denyToolsEnv({ shell: true, streams: true, send: true, silo: true, write: true, siloWrite: true, video: true, image: true, code: true, attach: true, uploads: true, guildPost: true }),
    'shell,streams,send,silo,write,siloWrite,video,image,code,attach,uploads,guildPost',
  );
  assert.equal(denyToolsEnv({ shell: true, streams: true, send: true, silo: false, write: true, siloWrite: true }), 'shell,streams,send,write,siloWrite');
});


function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('public default is not channel-deny: bypass + public stays unrestricted', () => {
  withEnv({ ASSISTANT_NAME: 'gaia', HOST_CHANNEL_POLICY: undefined }, () => {
    const p = policyFor({
      channel: 'discord', public: true,
      context: { scope_id: 'guild:other-guild' },
      channel_context: { channelId: 'ch1' },
    }, { bypass_moderation: true, user_key: 'owner' });
    assert.equal(isRestricted({ channel: 'discord', public: true }, { bypass_moderation: true }), false);
    assert.equal(p.restricted, false);
    assert.equal(p.deny.send, false);
    assert.equal(p.deny.shell, false);
  });
  withEnv({ ASSISTANT_NAME: undefined, HOST_CHANNEL_POLICY: '1' }, () => {
    assert.equal(isRestricted({ channel: 'discord', public: true }, { bypass_moderation: true }), false);
    assert.equal(isRestricted({ channel: 'discord', public: true }, { bypass_moderation: false }), false);
  });
});

test('voice handleStream denies all tools; discord text is unchanged', () => {
  const { isDiscordVoice } = require('../shared/media-allow');
  const voiceEnv = {
    channel: 'discord',
    public: true,
    conversation_key: 'discord-voice:gaia:guild:99',
    channel_context: { voice: true, guildId: '99' },
    context: { scope_id: 'guild:99' },
  };
  assert.equal(isDiscordVoice(voiceEnv), true);
  assert.equal(isDiscordVoice({ channel: 'discord', conversation_key: 'discord:gaia:channel:7' }), false);
  const owner = policyFor(voiceEnv, { bypass_moderation: true, user_key: 'owner' });
  assert.equal(owner.deny.all, true);
  for (const k of ['shell', 'streams', 'send', 'silo', 'write', 'siloWrite', 'video', 'image', 'code', 'attach', 'uploads', 'guildPost']) {
    assert.equal(owner.deny[k], true, k);
  }
  assert.equal(denyToolsEnv(owner.deny), 'shell,streams,send,silo,write,siloWrite,video,image,code,attach,uploads,guildPost');

  const text = policyFor({
    channel: 'discord', public: false,
    conversation_key: 'discord:gaia:channel:7',
    context: { scope_id: 'dm:someone' },
  }, { bypass_moderation: true });
  assert.equal(text.deny.all, undefined);
  assert.equal(text.deny.shell, false);
  assert.equal(text.restricted, false);
});

