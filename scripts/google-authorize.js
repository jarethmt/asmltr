#!/usr/bin/env node
'use strict';
/**
 * Authorize a Google account for asmltr and register it as a `mail` integration.
 *
 * Two steps, because consent needs a browser and this box has none:
 *
 *   1)  node scripts/google-authorize.js url   --account you@gmail.com
 *       Prints a consent URL. Open it in a browser, approve. Google then redirects to
 *       http://localhost:8080/?code=... which will NOT load — nothing is listening there, and
 *       that is fine. The code is in the address bar.
 *
 *   2)  node scripts/google-authorize.js claim --account you@gmail.com --code "<code or full URL>"
 *       Exchanges the code for a long-lived REFRESH token, stores it in the TRUST vault, and
 *       creates the integration. The refresh token is the only thing persisted, as a vault ref —
 *       access tokens are minted per open and never stored.
 *
 * The OAuth client is reused from the existing reminder-management grant, so no new Google Cloud
 * project is needed. One grant covers mail + calendar + contacts + tasks together.
 */
const fs = require('fs');
const path = require('path');
const google = require('../shared/google-oauth');
const vault = require('../shared/vault');
const registry = require('../integrations/registry');

const REDIRECT = 'http://localhost:8080/';
const CLIENT_FILE = process.env.GOOGLE_OAUTH_CLIENT
  || '/root/.claude/skills/reminder-management/config/oauth-credentials.json';

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function slug(addr) { return 'google_' + String(addr).replace(/[^a-z0-9]+/gi, '_').toLowerCase(); }

function client() {
  const raw = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8'));
  const c = raw.installed || raw.web;
  if (!c || !c.client_id || !c.client_secret) throw new Error(`no usable OAuth client in ${CLIENT_FILE}`);
  return { client_id: c.client_id, client_secret: c.client_secret };
}

function extractCode(s) {
  const v = String(s || '').trim();
  if (!v) throw new Error('--code is required');
  if (v.includes('code=')) {                      // a pasted full redirect URL
    const m = /[?&]code=([^&\s]+)/.exec(v);
    if (m) return decodeURIComponent(m[1]);
  }
  return v;                                        // a bare code
}

async function main() {
  const cmd = process.argv[2];
  const account = arg('account');
  if (!cmd || !['url', 'claim'].includes(cmd)) {
    console.log('usage: google-authorize.js url|claim --account <email> [--code <code|url>]');
    process.exit(1);
  }
  if (!account) throw new Error('--account <email> is required');
  const { client_id, client_secret } = client();

  if (cmd === 'url') {
    console.log('\nOpen this in a browser, signed in as ' + account + ':\n');
    console.log(google.authUrl({ client_id, redirect_uri: REDIRECT, login_hint: account }));
    console.log('\nScopes requested: ' + google.scopeList());
    console.log('\nAfter approving, the browser lands on a page that FAILS TO LOAD. That is expected.');
    console.log('Copy the whole address-bar URL (or just the code=... value) and run:\n');
    console.log(`  node scripts/google-authorize.js claim --account ${account} --code "<paste>"\n`);
    return;
  }

  // claim
  const code = extractCode(arg('code'));
  const { refresh_token, scope } = await google.exchangeCode({ client_id, client_secret, code, redirect_uri: REDIRECT });

  // Store the secrets in the TRUST vault; only *_ref key NAMES go in the config.
  // shared/secrets.js is read-only by design, so writes go through the vault client directly.
  const refKey = slug(account) + '_refresh_token';
  const addrKey = slug(account) + '_address';
  const idKey = 'google_oauth_client_id';
  const secKey = 'google_oauth_client_secret';
  for (const [k, v] of [[refKey, refresh_token], [addrKey, account], [idKey, client_id], [secKey, client_secret]]) {
    await vault.storeSecret(k, { value: v });
    console.log('  vault <- ' + k);
  }
  console.log('refresh token stored. granted scopes:\n  ' + String(scope || '').split(' ').join('\n  '));

  const it = registry.create({
    type: 'mail', kind: 'tools', lifecycle: 'passive', name: account,
    config: {
      imap_host: 'imap.gmail.com', imap_port: 993,
      smtp_host: 'smtp.gmail.com', smtp_port: 587,
      auth: 'oauth2',
      email_address: account,
      user_ref: slug(account) + '_address',
      refresh_token_ref: refKey,
      oauth_client_id_ref: idKey,
      oauth_client_secret_ref: secKey,
    },
  });
  console.log('\nintegration created: ' + it.id + '  (' + it.kind + '/' + it.lifecycle + ')');
  console.log('test it with:  node -e "require(\'./integrations/registry\').test(\'' + it.id + '\').then(r=>console.log(r))"');
}

main().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
