'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  actorFromBy, isOperatorBy, speakerFromBy, steererLabel, frameInjectPrompt, planInject, gateInject,
} = require('../core/src/inject-steer');

test('operator aliases skip moderation and frame as Operator', () => {
  for (const by of ['operator', 'dashboard', 'tui', '', null, undefined]) {
    const p = planInject(by);
    assert.equal(p.skipModeration, true, String(by));
    assert.equal(p.owner, true, String(by));
    assert.equal(p.steerer, 'Operator', String(by));
    assert.equal(isOperatorBy(by), true, String(by));
  }
  assert.equal(actorFromBy(undefined), 'operator');
  assert.equal(steererLabel('dashboard'), 'Operator');
});

test('other by runs moderation, frames as that speaker, owner false', () => {
  const p = planInject('discord:999');
  assert.equal(p.skipModeration, false);
  assert.equal(p.owner, false);
  assert.equal(p.steerer, 'discord:999');
  assert.equal(p.speaker.channel, 'discord');
  assert.equal(p.speaker.raw_id, '999');
  assert.equal(isOperatorBy('discord:999'), false);
  const mesh = planInject('mesh:peer-a');
  assert.equal(mesh.skipModeration, false);
  assert.equal(mesh.steerer, 'Peer session "peer-a"');
  assert.equal(speakerFromBy('tui-not').steerer, 'tui-not');
});

test('mid-task frame uses Operator only for operator by', () => {
  const op = frameInjectPrompt('keep going', 'operator', { wasRunning: true });
  assert.match(op, /^\[Operator steering/);
  assert.match(op, /keep going$/);
  const other = frameInjectPrompt('friend note', 'discord:999', { wasRunning: true });
  assert.match(other, /^\[discord:999 steering/);
  assert.equal(other.includes('Operator'), false);
  assert.equal(frameInjectPrompt('idle', 'discord:999', { wasRunning: false, interrupt: false }), 'idle');
});

test('gateInject fail-closes when moderation blocks; operator never calls moderate', async () => {
  let moderateCalls = 0;
  const blocked = await gateInject({
    by: 'discord:999',
    text: 'do a bad thing',
    resolve: (e) => ({ user_key: 'default', display_name: e.sender.raw_id, bypass_moderation: false }),
    moderate: async () => { moderateCalls += 1; return { allowed: false, riskLevel: 8 }; },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.plan.owner, false);
  assert.equal(moderateCalls, 1);

  const allowed = await gateInject({
    by: 'discord:999',
    text: 'nudge the draft',
    resolve: (e) => ({ user_key: 'friend', display_name: e.sender.raw_id, bypass_moderation: false }),
    moderate: async () => { moderateCalls += 1; return { allowed: true, riskLevel: 1 }; },
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.blocked, false);
  assert.equal(allowed.plan.skipModeration, false);

  let opMod = 0;
  const op = await gateInject({
    by: 'operator',
    text: 'anything',
    resolve: () => { throw new Error('operator must not resolve'); },
    moderate: async () => { opMod += 1; return { allowed: false }; },
  });
  assert.equal(op.ok, true);
  assert.equal(op.plan.skipModeration, true);
  assert.equal(opMod, 0);
});
