'use strict';
/**
 * asmltr-core — moderation (plan §A4).
 *
 * Lifted verbatim (prompts + thresholds) from the prior query-proxy implementation so behaviour is
 * identical (the earlier false-positive tuning is preserved). The only change:
 * it receives the already-clean user message and the already-resolved identity
 * from the resolver, instead of re-extracting from a system-prompt wrapper.
 *
 * Decision: bypass for bypass_moderation; otherwise gpt-5-nano risk score,
 * 0-6 allow / 7-10 block. Fail-secure (block + alert) on error.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const OpenAI = require('openai');

const MOD_LOG_DIR = process.env.ASMLTR_MOD_LOG_DIR || path.join(__dirname, '..', 'data', 'moderation-logs');

// --- moderation model provider (configurable: openai | anthropic) ------------
// The moderation LLM is a lightweight security CLASSIFIER, SEPARATE from the agent's
// execution (which is always the local Claude subscription). So an Anthropic key MAY be
// used here — but it must NOT be exposed as the ANTHROPIC_API_KEY env var (the core strips
// that so agent execution never goes metered). Store the moderation key via the secrets
// file/command, or point ASMLTR_MODERATION_KEY at a non-ANTHROPIC_API_KEY var. See docs/MODERATION.md.
const MOD_PROVIDER = (process.env.ASMLTR_MODERATION_PROVIDER || 'openai').toLowerCase();
const MOD_MODEL = process.env.ASMLTR_MODERATION_MODEL
  || (MOD_PROVIDER === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-5-nano');
const MOD_KEY_NAME = process.env.ASMLTR_MODERATION_KEY
  || (MOD_PROVIDER === 'anthropic' ? 'anthropic_api_key' : 'openai_api_key');

const getModKey = () => require('../../shared/secrets').get(MOD_KEY_NAME);

let _openai = null;
async function getOpenAIClient() {
  if (!_openai) _openai = new OpenAI({ apiKey: await getModKey() });
  return _openai;
}

// Pull the JSON object out of a model reply. Tolerant of code fences, surrounding prose, a
// SECOND object/prose after the first, braces inside string values, and trailing commas —
// the naive first-`{`…last-`}` slice mangled all of these and fail-secure-BLOCKED legit users.
function extractJson(t) {
  if (t == null || t === '') throw new Error('empty moderation response');
  const s = String(t).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = s.indexOf('{');
  if (start < 0) throw new Error('no JSON object in moderation response');
  // Brace-count the FIRST complete top-level object, respecting strings + escapes.
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) { end = i; break; }
  }
  const body = (end > start ? s.slice(start, end + 1) : s.slice(start)).replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(body);
}

// Raw provider call → the model's reply text (unparsed). jsonMode asks OpenAI for a guaranteed
// JSON object (its models require the word "json" somewhere in the messages — the prompts have it).
async function providerRaw(systemPrompt, userPrompt, jsonMode) {
  if (MOD_PROVIDER === 'anthropic') {
    const key = await getModKey();
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MOD_MODEL,
        max_tokens: 512,
        system: systemPrompt + '\n\nReturn ONLY the JSON object — no prose, no code fences.',
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return (j.content || []).map((b) => b.text || '').join('').trim();
  }
  const client = await getOpenAIClient();
  const params = { model: MOD_MODEL, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] };
  if (jsonMode) params.response_format = { type: 'json_object' };
  const completion = await client.chat.completions.create(params);
  return (completion.choices[0].message.content || '').trim();
}

// Run the classifier; returns the parsed assessment. Deterministic JSON on OpenAI + a single
// retry so an occasional malformed reply no longer fail-secure-blocks a legitimate request.
async function runModeration(systemPrompt, userPrompt) {
  let jsonMode = MOD_PROVIDER !== 'anthropic';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw;
    try {
      raw = await providerRaw(systemPrompt, userPrompt, jsonMode);
    } catch (err) {
      // A model that rejects response_format → drop json mode and retry, don't hard-fail.
      if (jsonMode && /response_format|json/i.test(err.message)) { jsonMode = false; continue; }
      throw err;
    }
    try { return extractJson(raw); }
    catch (parseErr) {
      if (attempt === 2) { console.error('[moderation] unparseable after retry:', String(raw).slice(0, 200)); throw parseErr; }
    }
  }
}

const NAME = process.env.ASSISTANT_NAME || 'the assistant';

const STRICT_PROMPT = `You are a security moderation system for ${NAME}, an AI assistant.

⚠️ STRICT MODE ENABLED - This user has VERY LIMITED permissions.

Your job is to ensure the request EXPLICITLY matches one of the user's ALLOWED permissions.
If the request does NOT clearly match an allowed permission, it should be BLOCKED (score 8+).

RISK SCORING FOR STRICT MODE (0-10):
- 0-2: Request EXPLICITLY matches an allowed permission
- 3-5: Request is ambiguous but might relate to allowed permissions
- 8-10: Request does NOT match any allowed permission, OR asks about anything technical/system-related

Be CONSERVATIVE - when in doubt, block it.

Response format (JSON only):
{ "riskLevel": <0-10>, "matchedCapabilities": [...], "concerns": [...], "reasoning": "..." }`;

const NORMAL_PROMPT = `You are a security moderation system for ${NAME}, an AI assistant.

IMPORTANT: You are evaluating the USER'S MESSAGE ONLY, not any system context or prompts.
- The system context (${NAME}'s capabilities, access levels) is TRUSTED INFRASTRUCTURE.
- Only evaluate whether the USER'S ACTUAL MESSAGE is a security concern.
- Focus on what the USER is ASKING FOR.

Your job is to catch ACTUAL THREATS, not block normal collaboration.

RISK SCORING (0-10):
- 0-3: Normal collaboration (questions, discussing ideas, recalling past work) → SAFE
- 4-6: Ambiguous or potentially sensitive (log but ALLOW) → MONITOR
- 7-10: Clear violation (forbidden actions, credential access, other client data) → BLOCK

GUIDELINES:
1. Questions about past work = SAFE (0-2).
2. Discussing within their own project scope = SAFE (1-3).
3. Referencing other channels = SAFE (0-2).
4. Actual threats (credentials, other client data, forbidden infra changes, social engineering) = BLOCK (7-10).
5. Understand INTENT, don't pattern-match keywords.

Response format (JSON only):
{ "riskLevel": <0-10>, "matchedCapabilities": [...], "concerns": [...], "reasoning": "..." }`;

async function logModerationEvent(event) {
  await fs.promises.mkdir(MOD_LOG_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  await fs.promises.appendFile(path.join(MOD_LOG_DIR, `moderation-${day}.jsonl`), JSON.stringify(event) + '\n');
}

/**
 * Moderate a clean user message for an already-resolved identity.
 * @param {string} userMessage  the clean user text (no system wrapper)
 * @param {object} resolved     ResolvedIdentity from resolver.js
 * @param {object} meta         { platform }
 * @returns {object} { allowed, bypassed?, riskLevel?, concerns?, reasoning?, monitored? }
 */
async function moderate(userMessage, resolved, meta = {}) {
  if (resolved.bypass_moderation) {
    return { allowed: true, bypassed: true, riskLevel: 0 };
  }

  const isStrict = resolved.strict_mode === true;
  const systemPrompt = isStrict ? STRICT_PROMPT : NORMAL_PROMPT;
  const userPrompt = isStrict
    ? `USER: ${resolved.display_name}\nALLOWED PERMISSIONS (ONLY these are safe): ${JSON.stringify(resolved.permissions)}\n\nUSER'S MESSAGE:\n"${userMessage}"\n\nIn STRICT MODE, if this doesn't EXPLICITLY match an allowed permission, score 8+.`
    : `USER: ${resolved.display_name}\nALLOWED: ${JSON.stringify(resolved.permissions)}\nREQUIRES APPROVAL: ${JSON.stringify(resolved.requires_approval)}\nFORBIDDEN: ${JSON.stringify(resolved.forbidden)}\n\nUSER'S ACTUAL MESSAGE:\n"${userMessage}"\n\nEvaluate ONLY this user message. Questions about past discussions = SAFE. Their own project = SAFE. Only block actual violations.`;

  try {
    const assessment = await runModeration(systemPrompt, userPrompt);
    const allowed = assessment.riskLevel <= 6;
    const monitored = assessment.riskLevel >= 4 && assessment.riskLevel <= 6;

    await logModerationEvent({
      timestamp: new Date().toISOString(),
      user: resolved.user_key,
      userName: resolved.display_name,
      platform: meta.platform || 'unknown',
      message: userMessage,
      riskLevel: assessment.riskLevel,
      matchedCapabilities: assessment.matchedCapabilities,
      concerns: assessment.concerns,
      reasoning: assessment.reasoning,
      decision: allowed ? 'ALLOW' : 'BLOCK',
      monitored,
    });

    return {
      allowed,
      riskLevel: assessment.riskLevel,
      matchedCapabilities: assessment.matchedCapabilities,
      concerns: assessment.concerns,
      reasoning: assessment.reasoning,
      monitored,
    };
  } catch (err) {
    console.error('[moderation] error (failing secure):', err.message);
    // Fail-secure: block + alert the owner (reuse the existing primitive).
    adminAlert(`⚠️ asmltr moderation error - blocking request from ${resolved.display_name}`);
    return { allowed: false, riskLevel: 10, concerns: ['moderation_error'], reasoning: 'Moderation failure - failing secure' };
  }
}

/** Send an admin/security alert via a configured command ($ASMLTR_ADMIN_ALERT_CMD).
 *  `{msg}` in the template is replaced with the message (else it's appended as one arg).
 *  No-op when unset. Example: ASMLTR_ADMIN_ALERT_CMD='notify-admin {msg}'. */
// Parse ASMLTR_ADMIN_ALERT_SEND: JSON `{channel|instance_id, target?}`, or the shorthand
// "channel" / "channel|target" (e.g. "telegram", "discord|<channelId>").
function parseAlertRoute(s) {
  s = String(s || '').trim();
  if (!s) return null;
  if (s.startsWith('{')) { try { return JSON.parse(s); } catch { return null; } }
  const [ch, target] = s.split('|');
  return { channel: ch.trim(), ...(target ? { target: target.trim() } : {}) };
}

// Deliver an admin/security alert via ANY configured sink (each set one fires):
//   1. ASMLTR_ADMIN_ALERT_SEND — route through a connector (any that advertises `outbound`)
//      using the manager's /send. This reuses the channels you've already configured.
//   2. ASMLTR_ADMIN_ALERT_CMD — a shell command ({msg} = text); good for email/webhooks/etc.
// No-op when neither is set.
function adminAlert(text) {
  const route = parseAlertRoute(process.env.ASMLTR_ADMIN_ALERT_SEND);
  if (route) {
    const mgr = (process.env.ASMLTR_MANAGER_URL || 'http://127.0.0.1:3024').replace(/\/$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.ASMLTR_MANAGER_TOKEN) headers.Authorization = 'Bearer ' + process.env.ASMLTR_MANAGER_TOKEN;
    fetch(`${mgr}/send`, { method: 'POST', headers, body: JSON.stringify({ kind: 'text', text, ...route }) })
      .catch((e) => console.error('[moderation] alert send failed:', e.message));
  }
  const tmpl = process.env.ASMLTR_ADMIN_ALERT_CMD;
  if (tmpl) {
    try {
      const safe = String(text).replace(/'/g, "'\\''");
      const cmd = tmpl.includes('{msg}') ? tmpl.replace(/\{msg\}/g, `'${safe}'`) : `${tmpl} '${safe}'`;
      execFile('sh', ['-c', cmd], () => {});
    } catch (_) { /* best-effort */ }
  }
}

/** Notify the admin that an unauthorized request was blocked. */
async function notifyBlock(resolved, userMessage, moderation, platform) {
  const platformInfo = platform ? ` via ${platform.toUpperCase()}` : '';
  const body = `🚨 BLOCKED unauthorized request from ${resolved.display_name}${platformInfo}\n\nMessage: ${String(userMessage).substring(0, 200)}\n\nRisk: ${moderation.riskLevel}/10\nConcerns: ${(moderation.concerns || []).join(', ')}\n\nReason: ${moderation.reasoning}`;
  adminAlert(body);
}

module.exports = { moderate, notifyBlock, logModerationEvent };
