'use strict';

// Local operator surfaces that already POST /v2/inject (dashboard, TUI, SDK default).
// Strict `operator` plus those aliases so a core bounce does not moderate loopback.
const OPERATOR_BY = new Set(['operator', 'dashboard', 'tui']);

function actorFromBy(by) {
  if (by == null) return 'operator';
  const s = String(by).trim();
  return s || 'operator';
}

function isOperatorBy(by) {
  return OPERATOR_BY.has(actorFromBy(by));
}

function speakerFromBy(by) {
  const actor = actorFromBy(by);
  if (actor.startsWith('mesh:')) {
    const label = actor.slice(5);
    return { channel: 'mesh', raw_id: label, steerer: 'Peer session "' + label + '"' };
  }
  const colon = actor.indexOf(':');
  if (colon > 0) {
    return { channel: actor.slice(0, colon), raw_id: actor.slice(colon + 1), steerer: actor };
  }
  return { channel: actor, raw_id: actor, steerer: actor };
}

function steererLabel(by) {
  if (isOperatorBy(by)) return 'Operator';
  return speakerFromBy(by).steerer;
}

function frameInjectPrompt(text, by, { wasRunning, interrupt } = {}) {
  const body = String(text || '');
  if (!(wasRunning || interrupt)) return body;
  return '[' + steererLabel(by) + ' steering — you are mid-task. Incorporate the following guidance into the work you are ALREADY doing and continue it. Do NOT restart from scratch, and do NOT treat it as a standalone question to answer in isolation.]\n\n' + body;
}

/** Plan the operator-vs-other inject branch. Pure; callers run moderation when skipModeration is false. */
function planInject(by) {
  const actor = actorFromBy(by);
  const operator = isOperatorBy(by);
  if (operator) {
    return {
      actor,
      operator: true,
      skipModeration: true,
      owner: true,
      steerer: 'Operator',
      speaker: { channel: 'operator', raw_id: actor, steerer: 'Operator' },
    };
  }
  const speaker = speakerFromBy(actor);
  return {
    actor,
    operator: false,
    skipModeration: false,
    owner: false,
    steerer: speaker.steerer,
    speaker,
  };
}

async function gateInject({ by, text, resolve, moderate, platform }) {
  const plan = planInject(by);
  if (plan.skipModeration) return { ok: true, blocked: false, plan, resolved: null, mod: null };
  const resolved = resolve({
    channel: plan.speaker.channel,
    sender: { raw_id: String(plan.speaker.raw_id || plan.actor) },
  });
  const mod = await moderate(text, resolved, { platform: platform || plan.speaker.channel });
  if (!mod || !mod.allowed) return { ok: false, blocked: true, plan, resolved, mod: mod || { allowed: false } };
  return { ok: true, blocked: false, plan, resolved, mod };
}

module.exports = {
  actorFromBy, isOperatorBy, speakerFromBy, steererLabel, frameInjectPrompt, planInject, gateInject, OPERATOR_BY,
};
