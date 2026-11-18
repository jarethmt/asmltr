#!/usr/bin/env node
'use strict';
/**
 * Google refresh-token health, per account.
 *
 * WHY THIS EXISTS, and what it deliberately does NOT do:
 *
 * A Google OAuth app whose consent screen is in "Testing" publishing status is issued refresh
 * tokens that expire after **7 days**, and that cannot be worked around in code. Exchanging a
 * refresh token returns a new ACCESS token only — proven by the response, which carries
 * `access_token` but no new `refresh_token`, and reports `refresh_token_expires_in` counting down
 * from the ORIGINAL grant. Refreshing more often does not extend anything.
 *
 * So this does not "keep tokens alive". It makes their death **loud and early** instead of silent.
 * That matters because the reminder-management Google token died quietly and nobody noticed for
 * months; the only symptom was reminders not arriving.
 *
 *   node scripts/google-token-health.js            # report
 *   node scripts/google-token-health.js --notify   # report + alert Jareth if anything is wrong
 *   node scripts/google-token-health.js --json     # machine-readable
 *
 * The durable fixes are (a) publish the consent screen to production, or (b) use app passwords for
 * mail, where no OAuth grant is involved at all.
 */
const { execFile } = require('child_process');
const secrets = require('../shared/secrets');
const integrations = require('../integrations/registry');

const WARN_DAYS = Number(process.env.GOOGLE_TOKEN_WARN_DAYS || 2);

function emailOf(v) {
  const m = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.exec(String(v || ''));
  return m ? m[0].toLowerCase() : null;
}

async function refreshProbe({ client_id, client_secret, refresh_token }) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) return { alive: false, error: j.error_description || j.error || `HTTP ${res.status}` };
  const secs = Number(j.refresh_token_expires_in);
  return { alive: true, days: Number.isFinite(secs) ? secs / 86400 : null, scope: j.scope };
}

async function main() {
  const json = process.argv.includes('--json');
  const notify = process.argv.includes('--notify');

  const client_id = await secrets.get('google_oauth_client_id');
  const client_secret = await secrets.get('google_oauth_client_secret');
  if (!client_id || !client_secret) {
    const msg = 'no Google OAuth client configured — nothing to check';
    console.log(json ? JSON.stringify({ error: msg }) : '  ' + msg);
    process.exit(0);
  }

  // group integrations by account so each grant is probed ONCE, not once per integration
  const byAccount = new Map();
  for (const it of integrations.list()) {
    const cfg = it.config || {};
    if (cfg.auth !== 'oauth2' || !cfg.refresh_token_ref) continue;
    const acct = emailOf(cfg.email_address || it.name) || cfg.refresh_token_ref;
    if (!byAccount.has(acct)) byAccount.set(acct, { ref: cfg.refresh_token_ref, types: [] });
    byAccount.get(acct).types.push(it.type);
  }

  const results = [];
  for (const [account, info] of byAccount) {
    const refresh_token = await secrets.get(info.ref);
    if (!refresh_token) { results.push({ account, state: 'missing', types: info.types }); continue; }
    const p = await refreshProbe({ client_id, client_secret, refresh_token });
    results.push({
      account, types: info.types,
      state: p.alive ? (p.days != null && p.days < WARN_DAYS ? 'expiring' : 'ok') : 'dead',
      days_left: p.days != null ? Number(p.days.toFixed(2)) : null,
      error: p.error || null,
    });
  }

  const bad = results.filter((r) => r.state !== 'ok');
  if (json) { console.log(JSON.stringify({ warn_days: WARN_DAYS, results }, null, 2)); }
  else {
    console.log(`=== Google refresh-token health (warn under ${WARN_DAYS}d) ===`);
    for (const r of results.sort((a, b) => (a.days_left ?? 0) - (b.days_left ?? 0))) {
      const left = r.days_left != null ? `${r.days_left}d left` : (r.error || r.state);
      console.log(`  ${r.state.toUpperCase().padEnd(9)}${r.account.padEnd(32)}${left}   [${r.types.join(', ')}]`);
    }
    if (!bad.length) console.log('  all grants healthy');
  }

  if (notify && bad.length) {
    const lines = bad.map((r) => `${r.account}: ${r.state}${r.days_left != null ? ` (${r.days_left}d left)` : ''}`);
    const msg = `Google auth needs attention — ${bad.length} account(s):\n${lines.join('\n')}\n`
      + 'Re-authorize from the dashboard Integrations cards. (Consent screen is in Testing, so grants last 7 days.)';
    await new Promise((res) => execFile('asmltr', ['notify', msg, '--title', 'Google token expiry'], () => res()));
  }
  process.exit(bad.some((r) => r.state === 'dead' || r.state === 'missing') ? 1 : 0);
}

main().catch((e) => { console.error('ERROR: ' + e.message); process.exit(2); });
