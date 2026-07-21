'use strict';
/**
 * Voice module for the Discord connector — runs on the SAME bot/gateway as text
 * (the owner's call: one bot, one token). @discordjs/voice is lazy-loaded so an audio-dep
 * failure can't take down the text path; all callers wrap in try/catch.
 *
 * v1: join a channel + play a soft chime. Per-user audio receive → STT → transcript →
 * Haiku gatekeeper land in the next increments.
 */
const path = require('path');

const CHIME = path.join(__dirname, 'assets', 'chime.ogg');
const DRONE = path.join(__dirname, 'assets', 'drone.ogg');
let V = null;
const lib = () => (V || (V = require('@discordjs/voice')));
const connections = new Map(); // guildId -> VoiceConnection
const dronePlayers = new Map(); // guildId -> looping "working" drone player

async function joinChannel(voiceChannel) {
  const { joinVoiceChannel, entersState, VoiceConnectionStatus } = lib();
  const prior = connections.get(voiceChannel.guild.id);
  if (prior) { try { prior.destroy(); } catch (_) {} }
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false, // must NOT be deaf — we receive audio for STT
    selfMute: false, // must NOT be muted — we speak (chime / TTS)
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 20000);
  connections.set(voiceChannel.guild.id, connection);
  return connection;
}

async function playChime(guildId) {
  const conn = connections.get(guildId);
  if (!conn) return null;
  const { createAudioPlayer, createAudioResource, NoSubscriberBehavior } = lib();
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  player.play(createAudioResource(CHIME));
  conn.subscribe(player);
  return player;
}

// --- listening: per-user audio → PCM → transcribe(WAV) → onUtterance -----------
const listening = new Set(); // guildIds currently listening

// wrap raw 48kHz stereo s16le PCM in a minimal WAV container for the STT API
function pcmToWav(pcm, rate = 48000, channels = 2) {
  const h = Buffer.alloc(44);
  const byteRate = rate * channels * 2, blockAlign = channels * 2;
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(byteRate, 28); h.writeUInt16LE(blockAlign, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// RMS amplitude of 16-bit PCM — used to skip near-silent chunks. Discord's VAD flags
// brief noises as "speech"; handed near-silence, STT models hallucinate "." / stray chars.
function rmsInt16(buf) {
  const n = buf.length >> 1; if (!n) return 0;
  let sum = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) { const s = buf.readInt16LE(i); sum += s * s; }
  return Math.sqrt(sum / n);
}
// Reject transcripts with no real content (pure punctuation / a single stray char).
function meaningful(t) {
  if (!t) return false;
  return t.replace(/[\s\p{P}\p{S}]/gu, '').length >= 2;
}

// transcribe = async (wavBuffer) -> text ; onUtterance = (speakerName, text) => {}
function startListening(guildId, client, { transcribe, onUtterance, log = () => {} }) {
  const conn = connections.get(guildId);
  if (!conn) return false;
  const { EndBehaviorType } = lib();
  const prism = require('prism-media');
  const receiver = conn.receiver;
  const active = new Set(); // userIds mid-capture (avoid double-subscribe)
  listening.add(guildId);

  receiver.speaking.on('start', (userId) => {
    if (!listening.has(guildId) || active.has(userId)) return;
    active.add(userId);
    const opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
    const chunks = [];
    opus.on('error', () => {}); decoder.on('error', () => {});
    opus.pipe(decoder);
    decoder.on('data', (c) => chunks.push(c));
    decoder.on('end', async () => {
      active.delete(userId);
      const pcm = Buffer.concat(chunks);
      if (pcm.length < 48000 * 2 * 2 * 0.3) return; // < ~0.3s → too short (still keeps a crisp wake word)
      if (rmsInt16(pcm) < 300) return;              // near-silent → skip (kills STT silence-hallucinations)
      try {
        const text = (await transcribe(pcmToWav(pcm)) || '').trim();
        if (!meaningful(text)) return;              // drop ".", single chars, empty
        const u = client.users.cache.get(userId);
        const name = (u && (u.globalName || u.username)) || userId;
        onUtterance(name, text);
      } catch (e) { log(`stt failed: ${e.message}`); }
    });
  });
  return true;
}

// speak an mp3 (e.g. ElevenLabs TTS) into the channel; resolves when playback ends
async function speak(guildId, mp3Buffer) {
  const conn = connections.get(guildId);
  if (!conn) return null;
  const { createAudioPlayer, createAudioResource, NoSubscriberBehavior, entersState, AudioPlayerStatus } = lib();
  const { Readable } = require('stream');
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  player.play(createAudioResource(Readable.from(mp3Buffer)));
  conn.subscribe(player);
  try {
    await entersState(player, AudioPlayerStatus.Playing, 5000);
    await entersState(player, AudioPlayerStatus.Idle, 120000);
  } catch (_) {}
  try { player.stop(); } catch (_) {}
  return player;
}

function stopListening(guildId) { listening.delete(guildId); }

// Soft looping "I'm working on it" drone — played while a turn is being generated, so the
// speaker knows something is happening between the chime and the spoken reply.
function startDrone(guildId) {
  const conn = connections.get(guildId);
  if (!conn) return;
  stopDrone(guildId);
  const { createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus } = lib();
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  const loop = () => { try { player.play(createAudioResource(DRONE)); } catch (_) {} };
  player.on(AudioPlayerStatus.Idle, loop); // re-play on end → loops until stopped
  player.on('error', () => {});
  loop();
  conn.subscribe(player);
  dronePlayers.set(guildId, player);
}
function stopDrone(guildId) {
  const p = dronePlayers.get(guildId);
  if (!p) return;
  try { p.removeAllListeners(); p.stop(true); } catch (_) {}
  dronePlayers.delete(guildId);
}

function leave(guildId) {
  const c = connections.get(guildId);
  if (!c) return false;
  stopListening(guildId);
  try { c.destroy(); } catch (_) {}
  connections.delete(guildId);
  return true;
}

const isConnected = (guildId) => connections.has(guildId);

module.exports = { joinChannel, playChime, speak, leave, isConnected, startListening, stopListening, startDrone, stopDrone };
