'use strict';
/**
 * Public Discord name→channel helpers used by asmltr send.
 * Confirm / on-behalf-of / same-guild fence live in the host overlay.
 * Mute/disable is inbound only. Forum: thread comments; forum channel = new post.
 */

const { stripThoughtChrome } = require('./step-public');

function prefaceOnBehalf(speakerId, text) {
  // Public product: prefix when an id is present; overlay requires id.
  const id = String(speakerId || '').replace(/[^\d]/g, '');
  let body = String(text || '').replace(/^\s*posting on behalf of\s+<@\d+>\s*/i, '');
  body = stripThoughtChrome(body).trim();
  if (!body) return { ok: false, error: 'text required' };
  if (!id) return { ok: true, body, text: body };
  return { ok: true, body, text: 'Posting on behalf of <@' + id + '>\n\n\n' + body };
}


function sameChannel(sourceId, destId) {
  const a = String(sourceId || '').trim();
  const b = String(destId || '').trim();
  return !!(a && b && a === b);
}

function sameGuild(sourceGuild, destGuild) {
  // Public product: send is not fenced to one guild. Overlay wrap restores host same-guild.
  void sourceGuild; void destGuild;
  return { ok: true };
}


function forumTitle(title, body) {
  const raw = String(title || '').trim() || String(body || '').split(/\n/)[0].trim();
  const s = raw.replace(/\s+/g, ' ').slice(0, 100);
  return s || 'post';
}

function isThreadChannel(ch) {
  if (!ch) return false;
  if (typeof ch.isThread === 'function') return !!ch.isThread();
  const t = ch.type;
  return t === 10 || t === 11 || t === 12 || String(t) === '11';
}

function isForumChannel(ch) {
  if (!ch || isThreadChannel(ch)) return false;
  const t = ch.type;
  return t === 15 || t === 16 || t === 'GUILD_FORUM' || t === 'GUILD_MEDIA'
    || String(t) === '15' || String(t) === '16';
}

/** Guild text, announcement, forum, or media — places a same-guild post can land. */
function isPostableGuildChannel(ch) {
  if (!ch || isThreadChannel(ch)) return false;
  const t = ch.type;
  return t === 0 || t === 5 || t === 15 || t === 16
    || t === 'GUILD_TEXT' || t === 'GUILD_ANNOUNCEMENT' || t === 'GUILD_FORUM' || t === 'GUILD_MEDIA';
}

/** Threads live on text, announcement, forum, and media parents — not only forums. */
function shouldFetchThreads(ch) {
  return isPostableGuildChannel(ch);
}

function destGuildId(ch) {
  if (!ch) return '';
  if (ch.guildId) return String(ch.guildId);
  if (ch.guild && ch.guild.id) return String(ch.guild.id);
  return '';
}

function looksLikeSnowflake(s) {
  return /^\d{17,22}$/.test(String(s || '').trim());
}

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[#]/g, '')
    .replace(/[°]/g, ' ')
    .replace(/\b(degree|degrees|thread|the|in|on|at|to|board|channel|forum|post|this)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchScore(query, name) {
  const q = normName(query);
  const n = normName(name);
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.includes(q)) return 90;
  if (q.includes(n) && n.length >= 3) return 80;
  const qt = q.split(' ').filter(Boolean);
  const nt = n.split(' ').filter(Boolean);
  if (!qt.length) return 0;
  let hit = 0;
  for (const t of qt) {
    if (nt.some((x) => x === t || x.includes(t) || t.includes(x))) hit += 1;
  }
  return Math.round((100 * hit) / qt.length);
}

function rankTargets(query, rows) {
  const scored = (rows || []).map((row) => ({ ...row, score: matchScore(query, row.name) }))
    .filter((row) => row.score >= 50)
    .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
  return scored.slice(0, 5);
}

module.exports = {
  prefaceOnBehalf, sameGuild, sameChannel, forumTitle, isForumChannel, destGuildId,
  isThreadChannel, isPostableGuildChannel, shouldFetchThreads,
  looksLikeSnowflake, normName, matchScore, rankTargets,
};

