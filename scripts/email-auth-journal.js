#!/usr/bin/env node
'use strict';
/**
 * Print (or email) the last N hours of inbound mail rejected for DKIM/SPF/DMARC.
 * Empty log → stdout empty, exit 0 (do not send).
 *
 *   node scripts/email-auth-journal.js [--hours 24]
 *   node scripts/email-auth-journal.js --hours 24 --send
 *
 * --send mails ASMLTR_OWNER_FROM_EMAIL via `asmltr send`. No address is hardcoded.
 */
require('../shared/loadenv');
const { spawnSync } = require('child_process');
const {
  loadAuthRejectLog, filterAuthRejectsSince, formatAuthJournal,
} = require('../connectors/types/email/index.js');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

const hours = Math.max(1, parseInt(argVal('--hours', '24'), 10) || 24);
const send = process.argv.includes('--send');
const sinceMs = Date.now() - hours * 3600 * 1000;
const body = formatAuthJournal(filterAuthRejectsSince(loadAuthRejectLog(), sinceMs));

if (!body) process.exit(0);

if (!send) {
  process.stdout.write(body + (body.endsWith('\n') ? '' : '\n'));
  process.exit(0);
}

const to = String(process.env.ASMLTR_OWNER_FROM_EMAIL || '').trim();
if (!to) {
  console.error('email-auth-journal --send needs ASMLTR_OWNER_FROM_EMAIL');
  process.exit(1);
}
const day = new Date().toISOString().slice(0, 10);
const subject = 'Blocked email journal — ' + day;
const bin = process.env.ASMLTR_BIN || 'asmltr';
const r = spawnSync(bin, ['send', 'email', to, body, '--subject', subject], { encoding: 'utf8' });
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status == null ? 1 : r.status);
