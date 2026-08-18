'use strict';
/**
 * Pricing — turn token/char/minute counts into a dollar value, for the Usage view.
 *
 * Two dollar numbers matter (see docs/usage): the **equivalent value** (what a surface WOULD cost at
 * public API rates — computed for everything, including subscription engines) and the **billed** amount
 * (what actually hits a card — API-key surfaces only). This module computes the equivalent value; the
 * caller decides `billed` from the engine/provider auth mode and records both.
 *
 * The table is a best-effort snapshot of public list prices; it drifts, so it's fully overridable via
 * ~/.asmltr/pricing.json (or $ASMLTR_PRICING_FILE), deep-merged over these defaults. Units:
 *   models  : { in, out }  USD per 1,000,000 tokens
 *   tts     : USD per 1,000 characters
 *   stt     : USD per minute of audio
 * Matching is longest-prefix on the model id, so `gpt-4o-transcribe-2026...` still resolves to its base.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// $/1M tokens {in,out}. Aliases (opus/sonnet/haiku) resolve to the current tier they track.
const DEFAULTS = {
  models: {
    // Anthropic (subscription via the Agent SDK on Eve's box → billed:false, but the equivalent value is real)
    'opus': { in: 15, out: 75 }, 'claude-opus': { in: 15, out: 75 },
    'sonnet': { in: 3, out: 15 }, 'claude-sonnet': { in: 3, out: 15 },
    'haiku': { in: 0.8, out: 4 }, 'claude-haiku': { in: 0.8, out: 4 },
    // Google Gemini
    'gemini-2.5-pro': { in: 1.25, out: 10 }, 'gemini-2.5-flash': { in: 0.3, out: 2.5 },
    'gemini-2.0-flash': { in: 0.1, out: 0.4 }, 'gemini': { in: 0.3, out: 2.5 },
    // OpenAI (codex/gpt models + moderation)
    'gpt-5': { in: 1.25, out: 10 }, 'gpt-5-nano': { in: 0.05, out: 0.4 }, 'gpt-5-mini': { in: 0.25, out: 2 },
    'gpt-4.1': { in: 2, out: 8 }, 'gpt-4.1-mini': { in: 0.4, out: 1.6 },
    'gpt-4o': { in: 2.5, out: 10 }, 'gpt-4o-mini': { in: 0.15, out: 0.6 },
    'o3': { in: 2, out: 8 }, 'o4-mini': { in: 1.1, out: 4.4 },
    // xAI Grok (subscription via the CLI → billed:false; equivalent value at public API rates)
    'grok-4': { in: 2, out: 6 }, 'grok-4.6': { in: 2, out: 6 }, 'grok-4.5': { in: 2, out: 6 },
    'grok-3': { in: 3, out: 15 }, 'grok-code': { in: 1, out: 2 }, 'grok-build': { in: 1, out: 2 }, 'grok': { in: 2, out: 6 },
  },
  // $ per 1,000 characters
  tts: {
    'tts-1': 0.015, 'tts-1-hd': 0.03, 'gpt-4o-mini-tts': 0.015,        // OpenAI
    'eleven_multilingual_v2': 0.30, 'eleven_turbo_v2_5': 0.15, 'eleven_flash_v2_5': 0.15, 'eleven_v3': 0.30, // ElevenLabs (creator-ish)
    'elevenlabs': 0.24, // fallback for any eleven_* model
  },
  // $ per minute of audio
  stt: {
    'gpt-4o-transcribe': 0.006, 'gpt-4o-mini-transcribe': 0.003, 'whisper-1': 0.006,
    'gpt-transcribe': 0.0045, 'gpt-live-transcribe': 0.017,
  },
};

let _cache;
function table() {
  if (_cache) return _cache;
  _cache = { models: { ...DEFAULTS.models }, tts: { ...DEFAULTS.tts }, stt: { ...DEFAULTS.stt } };
  try {
    const f = process.env.ASMLTR_PRICING_FILE || path.join(os.homedir(), '.asmltr', 'pricing.json');
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const k of ['models', 'tts', 'stt']) if (o[k]) Object.assign(_cache[k], o[k]);
  } catch (_) { /* no override — defaults */ }
  return _cache;
}
function reload() { _cache = null; return table(); }

// Longest-prefix match: 'gpt-4o-transcribe' matches before 'gpt-4o'. Also strips a trailing date suffix.
function match(map, id) {
  if (!id) return null;
  const key = String(id).toLowerCase();
  if (map[key]) return map[key];
  let best = null, bestLen = -1;
  for (const k of Object.keys(map)) {
    if (key.startsWith(k) && k.length > bestLen) { best = map[k]; bestLen = k.length; }
  }
  return best;
}

/** Equivalent USD for a model turn given input/output token counts. Returns 0 if the model is unknown. */
function tokenCostUsd(model, tokensIn, tokensOut) {
  const p = match(table().models, model);
  if (!p) return 0;
  return ((tokensIn || 0) * (p.in || 0) + (tokensOut || 0) * (p.out || 0)) / 1e6;
}
/** Equivalent USD for a TTS synth of `chars` characters on a given model. */
function ttsCostUsd(model, chars) {
  let rate = match(table().tts, model);
  if (rate == null && /^eleven/i.test(String(model || ''))) rate = table().tts.elevenlabs;
  return rate ? (chars || 0) / 1000 * rate : 0;
}
/** Equivalent USD for `seconds` of STT audio on a given model. */
function sttCostUsd(model, seconds) {
  const rate = match(table().stt, model);
  return rate ? (seconds || 0) / 60 * rate : 0;
}

module.exports = { tokenCostUsd, ttsCostUsd, sttCostUsd, table, reload, DEFAULTS };
