'use strict';

/** Per-channel Discord voice-transcript hide (persist like mute). */

const TRANSCRIPT_OFF_ALIASES = Object.freeze([
  'scribe-off', 'scribe off',
]);
const TRANSCRIPT_ON_ALIASES = Object.freeze([
  'scribe-on', 'scribe on',
]);

function _cid(cid) {
  return String(cid == null ? '' : cid);
}

function isTranscriptOff(set, cid) {
  if (!set || typeof set.has !== 'function') return false;
  const id = _cid(cid);
  return !!id && set.has(id);
}

function setTranscriptOff(set, cid, off) {
  const id = _cid(cid);
  if (!set || typeof set.add !== 'function' || !id) return set;
  if (off) set.add(id);
  else set.delete(id);
  return set;
}

function serializeTranscriptOff(set) {
  return Array.from(set || []).map(String).filter(Boolean).sort();
}

function loadTranscriptOff(arr) {
  const set = new Set();
  if (!Array.isArray(arr)) return set;
  for (const c of arr) {
    if (c == null || c === '') continue;
    set.add(String(c));
  }
  return set;
}

function isTranscriptOffCmd(cmd) {
  return TRANSCRIPT_OFF_ALIASES.includes(String(cmd || '').trim().toLowerCase());
}

function isTranscriptOnCmd(cmd) {
  return TRANSCRIPT_ON_ALIASES.includes(String(cmd || '').trim().toLowerCase());
}

/** Live 🗣️ / 🔊 posts. Per-channel off wins; else instance voice_post_transcript default. */
function shouldPostLive({ offSet, cid, instanceDefault } = {}) {
  if (isTranscriptOff(offSet, cid)) return false;
  return instanceDefault !== false;
}

/** Leave-voice .txt upload. Per-channel off wins; else instance voice_transcript_file default. */
function shouldUploadLeaveFile({ offSet, cid, instanceDefault } = {}) {
  if (isTranscriptOff(offSet, cid)) return false;
  return instanceDefault !== false;
}

module.exports = {
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
};
