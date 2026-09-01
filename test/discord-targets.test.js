'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { prefaceOnBehalf, sameGuild, sameChannel, forumTitle, isForumChannel, destGuildId, looksLikeSnowflake, matchScore, rankTargets, normName, isThreadChannel, isPostableGuildChannel, shouldFetchThreads } = require('../shared/discord-targets');
const { policyFor } = require('../shared/media-allow');

test('public preface prefixes when id present; overlay requires id', () => {
  const r = prefaceOnBehalf('100000000000000001', '1½ inch addendum');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Posting on behalf of <@100000000000000001>\n\n\n1½ inch addendum');
  const dup = prefaceOnBehalf('1', 'posting on behalf of <@99>\n\nhello');
  assert.equal(dup.text.startsWith('Posting on behalf of <@1>\n\n\n'), true);
  assert.equal(dup.text.includes('<@99>'), false);
  assert.equal(dup.body, 'hello');
  assert.equal(prefaceOnBehalf('', 'hi').ok, true);
  assert.equal(prefaceOnBehalf('', 'hi').text, 'hi');
  assert.equal(prefaceOnBehalf('1', '  ').ok, false);
  const chips = prefaceOnBehalf('1', '-# Working\n-# 💭 thinking\nThe addendum.');
  assert.equal(chips.text.includes('-#'), false);
  assert.equal(chips.text.includes('💭'), false);
  assert.match(chips.text, /The addendum/);
});

test('public sameGuild is not fenced; overlay restores host same-guild', () => {
  assert.equal(sameGuild('aaa', 'aaa').ok, true);
  assert.equal(sameGuild('aaa', 'bbb').ok, true);
  assert.equal(sameGuild('', 'aaa').ok, true);
});

test('forum parent vs thread', () => {
  assert.equal(isForumChannel({ type: 15 }), true);
  assert.equal(isForumChannel({ type: 16 }), true);
  assert.equal(isForumChannel({ type: 0, isThread: () => false }), false);
  assert.equal(isForumChannel({ type: 11, isThread: () => true }), false);
  assert.equal(isThreadChannel({ type: 11, isThread: () => true }), true);
  assert.equal(isPostableGuildChannel({ type: 0, isThread: () => false }), true);
  assert.equal(isPostableGuildChannel({ type: 5, isThread: () => false }), true);
  assert.equal(shouldFetchThreads({ type: 0, isThread: () => false }), true);
  assert.equal(shouldFetchThreads({ type: 5, isThread: () => false }), true);
  assert.equal(shouldFetchThreads({ type: 15 }), true);
  assert.equal(shouldFetchThreads({ type: 11, isThread: () => true }), false);
  assert.equal(forumTitle('Steak 666', 'body'), 'Steak 666');
  assert.equal(forumTitle('', 'First line\nrest').length <= 100, true);
  assert.equal(destGuildId({ guildId: 'g1' }), 'g1');
  assert.equal(destGuildId({ guild: { id: 'g2' } }), 'g2');
});

test('public guild: guildPost from Cast grants or owner (no Access 1-5, no V31 send-deny)', () => {
  const env = {
    channel: 'discord', public: true,
    context: { scope_id: 'guild:g1' },
    channel_context: { channelId: 'ch1' },
  };
  assert.equal(policyFor(env, { bypass_moderation: false, trust_tier: 0 }).deny.guildPost, true);
  assert.equal(policyFor(env, { bypass_moderation: false, trust_tier: 3 }).deny.send, false);
  assert.equal(policyFor(env, { bypass_moderation: false, trust_tier: 3 }).deny.guildPost, true);
  assert.equal(policyFor(env, { bypass_moderation: false, trust_tier: 6 }).deny.guildPost, true);
  assert.equal(policyFor(env, { bypass_moderation: true, trust_tier: 0, user_key: 'owner' }).deny.guildPost, false);
  assert.equal(policyFor(env, { bypass_moderation: false, trust_tier: 0, roles: ['trusted'] }).deny.guildPost, false);
  assert.equal(policyFor(env, { bypass_moderation: false, trust_tier: 0, permissions: ['guild-post'] }).deny.guildPost, false);
  assert.equal(policyFor(env, { bypass_moderation: false, trust_tier: 0, allow: ['send'] }).deny.guildPost, false);
  assert.equal(sameChannel('ch1', 'ch1'), true);
  assert.equal(sameChannel('ch1', 'ch2'), false);
});

test('names are not snowflakes; 666 steak matches a thread title', () => {
  assert.equal(looksLikeSnowflake('123456789012345678'), true);
  assert.equal(looksLikeSnowflake('666 degree steak thread'), false);
  assert.equal(normName('666 degree steak thread'), '666 steak');
  assert.ok(matchScore('666 degree steak thread', '666 Degree Steak') >= 90);
  const ranked = rankTargets('666 degree steak', [
    { id: '1', name: 'recipes-board', kind: 'forum' },
    { id: '2', name: '666 Degree Steak', kind: 'thread', parent: 'recipes-board' },
    { id: '3', name: 'arboretum', kind: 'channel' },
  ]);
  assert.equal(ranked[0].id, '2');
  assert.equal(ranked[0].kind, 'thread');
});

test('discord /out keeps send + fuzzy resolve; no parallel guild_post MCP tool', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /kind === 'guild_post'/);
  assert.match(src, /isForumChannel/);
  assert.match(src, /threads\.create/);
  assert.match(src, /messageReference/);
  assert.match(src, /same_channel/);
  assert.match(src, /guild_resolve/);
  assert.match(src, /fetchArchived/);
  assert.match(src, /listGuildPostTargets/);
  assert.match(src, /shouldFetchThreads/);
  const postBlock = src.slice(src.indexOf("kind === 'guild_post'"), src.indexOf("kind === 'guild_post'") + 1200);
  assert.equal(postBlock.includes('channelEnabled'), false);
  assert.match(src, /Mute\/disable is inbound only/);
  const cli = fs.readFileSync(path.join(__dirname, '../cli/asmltr.js'), 'utf8');
  assert.match(cli, /cmdGuildPost/);
  assert.match(cli, /deliverSameGuildPost/);
  assert.match(cli, /ASMLTR_ATTACH_GUILD/);
  const belt = fs.readFileSync(path.join(__dirname, '../mcp/toolbelt-server.js'), 'utf8');
  assert.equal(belt.includes('asmltr_guild_post'), false);
  assert.match(belt, /asmltr_send/);
});
