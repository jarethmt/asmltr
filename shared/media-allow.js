'use strict';
/**
 * Media/code allowlists + deny-env helpers. Not a capability plane — Cast grants are.
 * Host overlays wrap policyFor for V31. Video/code/silo lists live here.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function policyFile() {
  const env = String(process.env.ASMLTR_MEDIA_ALLOW_FILE || '').trim();
  if (env) return env;
  const home = path.join(os.homedir(), '.asmltr');
  const neu = path.join(home, 'media-allow.json');
  // Host disk name may still be this; not a public capability plane.
  const old = path.join(home, 'tool-policy.json');
  try { if (fs.existsSync(neu)) return neu; } catch (_) {}
  return old;
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

/** Discord VOICE turn only — not Discord text. */
function isDiscordVoice(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const key = String(obj.conversation_key || obj.conversationKey || '');
  if (key.startsWith('discord-voice:')) return true;
  const cc = obj.channel_context || obj.channelContext || null;
  if (cc && cc.voice === true) return true;
  const ch = String(obj.channel || '').trim().toLowerCase();
  if (ch === 'discord' && obj.voice === true) return true;
  return false;
}

function denyAllFlags() {
  const deny = emptyDeny();
  for (const k of Object.keys(deny)) deny[k] = true;
  deny.all = true;
  return deny;
}


function siloAllowlisted(envelope, allow) {
  const a = allow || loadAllowlist();
  const g = guildIdFrom(envelope);
  const c = channelIdFrom(envelope);
  return !!(g && a.guilds.includes(g)) || !!(c && a.channels.includes(c));
}

function isRestricted(_envelope, _resolved) {
  // Public product: Cast grants are the plane. Overlay wraps this for V31.
  return false;
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

/** Stills + asmltr post: owner/bypass or videoAllow (video implies stills). photoAllow/imageAllow host lists are not a public gate. */
function imageAuthorized(envelope, resolved, allow) {
  if (ownerish(resolved)) return true;
  const a = allow || loadAllowlist();
  return listed(envelope, resolved, a.videoPrincipals, a.videoDiscordIds);
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

/** Same-guild Discord post: owner, trusted role, or resolve() allow (guild-post / send / *). */
function grantTokens(resolved) {
  const out = [];
  if (!resolved) return out;
  for (const key of ['permissions', 'allow', 'roles', 'role_ids']) {
    const v = resolved[key];
    if (Array.isArray(v)) {
      for (const x of v) {
        if (x && typeof x === 'object') out.push(String(x.id || x.name || ''));
        else out.push(String(x));
      }
    } else if (typeof v === 'string' && v) out.push(v);
  }
  return out.map((s) => s.toLowerCase()).filter(Boolean);
}

function guildPostAuthorized(resolved) {
  if (ownerish(resolved)) return true;
  const tokens = grantTokens(resolved);
  if (tokens.includes('trusted') || tokens.includes('guild-post') || tokens.includes('guildpost')
    || tokens.includes('send') || tokens.includes('*')) {
    return true;
  }
  return false;
}

function emptyDeny() {
  return {
    shell: false, streams: false, send: false, silo: false,
    write: false, siloWrite: false, video: false, image: false, code: false, attach: false,
    uploads: false, guildPost: false,
  };
}

function policyFor(envelope, resolved, allow) {
  // Voice handleStream: hard deny every tool. Discord TEXT is unchanged.
  if (isDiscordVoice(envelope)) return { deny: denyAllFlags(), restricted: true };
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
  // Same-guild Discord post: Cast grant (trusted / send / guild-post / *). Overlay may still V31-deny send.
  if (!guildIdFrom(envelope) || !guildPostAuthorized(resolved)) deny.guildPost = true;
  const restricted = isRestricted(envelope, resolved);
  if (!restricted) return { deny, restricted: false };
  deny.shell = true;
  deny.streams = true;
  deny.send = true;
  deny.write = true;
  deny.uploads = true;
  return { deny, restricted: true };
}

function denyToolsEnv(deny) {
  const keys = ['shell', 'streams', 'send', 'silo', 'write', 'siloWrite', 'video', 'image', 'code', 'attach', 'uploads', 'guildPost'];
  if (deny && deny.all) return keys.join(',');
  return keys.filter((k) => deny && deny[k]).join(',');
}

function parseDenyEnv(raw) {
  const set = new Set(String(raw || '').split(',').map((x) => x.trim()).filter(Boolean));
  const all = set.has('all');
  return {
    all,
    shell: all || set.has('shell'),
    streams: all || set.has('streams'),
    send: all || set.has('send'),
    silo: all || set.has('silo'),
    write: all || set.has('write'),
    siloWrite: all || set.has('siloWrite'),
    video: all || set.has('video'),
    image: all || set.has('image'),
    code: all || set.has('code'),
    attach: all || set.has('attach'),
    uploads: all || set.has('uploads'),
    guildPost: all || set.has('guildPost'),
  };
}

function exitIfDenied(kind) {
  const d = parseDenyEnv(process.env.ASMLTR_DENY_TOOLS);
  const mapped = kind === 'announce' ? 'send' : kind;
  if (d.all || d[mapped] || d[kind]) {
    console.error('denied: ' + mapped);
    process.exit(2);
  }
}

module.exports = {
  policyFile, loadAllowlist, policyFor, isRestricted, siloAllowlisted,
  videoAuthorized, imageAuthorized, mediaAuthorized, codeAuthorized, guildPostAuthorized, grantTokens,
  denyToolsEnv, parseDenyEnv, exitIfDenied, guildIdFrom, channelIdFrom,
  isDiscordVoice, denyAllFlags,
};
