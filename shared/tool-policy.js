'use strict';
/**
 * V31: per-turn tool policy. Restricted Discord cannot shell/streams/send/cwd-write.
 * Silo read/write is not part of that deny (James 21 Aug 2026). Do not fold
 * silo denies into a V31 PR — privacy.md is the silo safeguard.
 * Video/image gen and writing programs for a caller are owner/bypass unless
 * tool-policy.json videoAllow / imageAllow / mediaAllow / codeAllow names them.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function policyFile() {
  return process.env.ASMLTR_TOOL_POLICY_FILE
    || path.join(os.homedir(), '.asmltr', 'tool-policy.json');
}

function loadAllowlist(file) {
  const p = file || policyFile();
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const silo = (j && j.siloAllow) || {};
    const video = (j && j.videoAllow) || {};
    const image = (j && (j.photoAllow || j.imageAllow)) || {};
    const media = (j && j.mediaAllow) || {};
    const code = (j && j.codeAllow) || {};
    const ids = (a, k) => ((a && a[k]) || []).map(String);
    return {
      guilds: (silo.guilds || []).map(String),
      channels: (silo.channels || []).map(String),
      videoPrincipals: ids(video, 'principals').concat(ids(media, 'principals')),
      videoDiscordIds: ids(video, 'discordIds').concat(ids(media, 'discordIds')),
      imagePrincipals: ids(image, 'principals').concat(ids(media, 'principals'), ids(video, 'principals')),
      imageDiscordIds: ids(image, 'discordIds').concat(ids(media, 'discordIds'), ids(video, 'discordIds')),
      codePrincipals: ids(code, 'principals'),
      codeDiscordIds: ids(code, 'discordIds'),
    };
  } catch {
    return {
      guilds: [], channels: [],
      videoPrincipals: [], videoDiscordIds: [],
      imagePrincipals: [], imageDiscordIds: [],
      codePrincipals: [], codeDiscordIds: [],
    };
  }
}

function guildIdFrom(envelope) {
  const sid = envelope && envelope.context && envelope.context.scope_id;
  const s = String(sid || '');
  if (s.startsWith('guild:')) return s.slice(6);
  return '';
}

function channelIdFrom(envelope) {
  const cc = envelope && envelope.channel_context;
  if (!cc) return '';
  return String(cc.channelId || cc.channel_id || '');
}

function siloAllowlisted(envelope, allow) {
  const a = allow || loadAllowlist();
  const g = guildIdFrom(envelope);
  const c = channelIdFrom(envelope);
  return !!(g && a.guilds.includes(g)) || !!(c && a.channels.includes(c));
}

function isRestricted(envelope, resolved) {
  const ch = String((envelope && envelope.channel) || '');
  if (ch !== 'discord') return false;
  if (envelope && envelope.public) return true;
  return !(resolved && resolved.bypass_moderation);
}

function senderRawId(envelope) {
  const s = envelope && envelope.sender;
  return String((s && (s.raw_id || s.id)) || '');
}

function ownerish(resolved) {
  return !!(resolved && (resolved.bypass_moderation || resolved.user_key === 'owner'));
}

function listed(envelope, resolved, principals, discordIds) {
  const key = String((resolved && resolved.user_key) || '');
  if (key && (principals || []).includes(key)) return true;
  const did = senderRawId(envelope);
  if (did && (discordIds || []).includes(did)) return true;
  return false;
}

/** Clips: owner/bypass, or videoAllow / mediaAllow. imageAllow / photoAllow do not grant video. */
function videoAuthorized(envelope, resolved, allow) {
  if (ownerish(resolved)) return true;
  const a = allow || loadAllowlist();
  return listed(envelope, resolved, a.videoPrincipals, a.videoDiscordIds);
}

/** Stills + asmltr post: owner/bypass, photo/image/media lists, or videoAllow (video implies stills). */
function imageAuthorized(envelope, resolved, allow) {
  if (ownerish(resolved)) return true;
  const a = allow || loadAllowlist();
  return listed(envelope, resolved, a.imagePrincipals, a.imageDiscordIds)
    || listed(envelope, resolved, a.videoPrincipals, a.videoDiscordIds);
}

function mediaAuthorized(envelope, resolved, allow) {
  return imageAuthorized(envelope, resolved, allow);
}

/** Write-a-program for this caller: owner/bypass or codeAllow. */
function codeAuthorized(envelope, resolved, allow) {
  if (ownerish(resolved)) return true;
  const a = allow || loadAllowlist();
  return listed(envelope, resolved, a.codePrincipals, a.codeDiscordIds);
}

/** Same-guild Discord post: owner, or Access card default_tier 1–5. */
function guildPostAuthorized(resolved) {
  if (ownerish(resolved)) return true;
  const t = Number(resolved && resolved.trust_tier);
  return t >= 1 && t <= 5;
}

function emptyDeny() {
  return {
    shell: false, streams: false, send: false, silo: false,
    write: false, siloWrite: false, video: false, image: false, code: false, attach: false,
    uploads: false, guildPost: false,
  };
}

function policyFor(envelope, resolved, allow) {
  const deny = emptyDeny();
  if (!videoAuthorized(envelope, resolved, allow)) deny.video = true;
  if (!imageAuthorized(envelope, resolved, allow)) {
    deny.image = true;
    deny.attach = true;
  }
  if (!codeAuthorized(envelope, resolved, allow)) {
    deny.code = true;
    deny.shell = true;
    deny.write = true;
  }
  // Same-guild Discord post: in a guild, Access 1–5 or owner.
  if (!guildIdFrom(envelope) || !guildPostAuthorized(resolved)) deny.guildPost = true;
  if (!isRestricted(envelope, resolved)) return { deny, restricted: false };
  deny.shell = true;
  deny.streams = true;
  deny.send = true;
  deny.write = true;
  deny.uploads = true;
  return { deny, restricted: true };
}

function denyToolsEnv(deny) {
  return ['shell', 'streams', 'send', 'silo', 'write', 'siloWrite', 'video', 'image', 'code', 'attach', 'uploads', 'guildPost']
    .filter((k) => deny && deny[k]).join(',');
}

function parseDenyEnv(raw) {
  const set = new Set(String(raw || '').split(',').map((x) => x.trim()).filter(Boolean));
  return {
    shell: set.has('shell'),
    streams: set.has('streams'),
    send: set.has('send'),
    silo: set.has('silo'),
    write: set.has('write'),
    siloWrite: set.has('siloWrite'),
    video: set.has('video'),
    image: set.has('image'),
    code: set.has('code'),
    attach: set.has('attach'),
    uploads: set.has('uploads'),
    guildPost: set.has('guildPost'),
  };
}

function exitIfDenied(kind) {
  const d = parseDenyEnv(process.env.ASMLTR_DENY_TOOLS);
  const mapped = kind === 'announce' ? 'send' : kind;
  if (d[mapped] || d[kind]) {
    console.error('denied: ' + mapped);
    process.exit(2);
  }
}

module.exports = {
  policyFile, loadAllowlist, policyFor, isRestricted, siloAllowlisted,
  videoAuthorized, imageAuthorized, mediaAuthorized, codeAuthorized, guildPostAuthorized,
  denyToolsEnv, parseDenyEnv, exitIfDenied, guildIdFrom, channelIdFrom,
};
