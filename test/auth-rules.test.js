'use strict';
// Forward-auth access rules (core/src/auth-rules.js). These cover the rule SHAPES a migration from
// an external proxy gate has to carry one-to-one: host + wildcard host, path regex, per-user subject,
// source-network bypass, per-rule factor level, and first-match-wins ordering.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const R = require('../core/src/auth-rules');

function withRules(doc, fn) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'authrules-')), 'rules.json');
  fs.writeFileSync(f, JSON.stringify(doc));
  const prev = process.env.ASMLTR_AUTH_RULES;
  process.env.ASMLTR_AUTH_RULES = f;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.ASMLTR_AUTH_RULES; else process.env.ASMLTR_AUTH_RULES = prev;
  }
}

test('CIDR matching: v4, v6, single host, and v4-mapped v6', () => {
  assert.ok(R.ipInCidr('10.1.2.3', '10.0.0.0/8'));
  assert.ok(!R.ipInCidr('11.1.2.3', '10.0.0.0/8'));
  assert.ok(R.ipInCidr('172.19.0.7', '172.19.0.0/24'));
  assert.ok(!R.ipInCidr('172.20.0.7', '172.19.0.0/24'));
  assert.ok(R.ipInCidr('127.0.0.1', '127.0.0.1/32'));
  assert.ok(R.ipInCidr('203.0.113.9', '203.0.113.9')); // bare address = /32
  assert.ok(R.ipInCidr('::1', '::1/128'));
  assert.ok(R.ipInCidr('::ffff:10.1.2.3', '10.0.0.0/8'), 'v4-mapped v6 must match a v4 rule');
  assert.ok(!R.ipInCidr('10.1.2.3', '::1/128'), 'families must not cross-match');
  assert.ok(!R.ipInCidr('garbage', '10.0.0.0/8'));
  assert.ok(!R.ipInCidr('10.1.2.3', '10.0.0.0/99'), 'invalid prefix is rejected, not coerced');
});

test('wildcard domains cover sub-domains but not the apex', () => {
  assert.ok(R.domainMatches('*.example.com', 'a.example.com'));
  assert.ok(R.domainMatches('*.example.com', 'a.b.example.com'));
  assert.ok(!R.domainMatches('*.example.com', 'example.com'));
  assert.ok(!R.domainMatches('*.example.com', 'notexample.com'));
  assert.ok(R.domainMatches('example.com', 'example.com:443'), 'port is ignored');
  assert.ok(R.domainMatches(undefined, 'anything.test'), 'no domain = every host');
});

test('subject is unevaluable (null) when anonymous, so a later rule can challenge', () => {
  assert.strictEqual(R.subjectMatches('user:alice', null, []), null);
  assert.strictEqual(R.subjectMatches('user:alice', 'alice', []), true);
  assert.strictEqual(R.subjectMatches('user:alice', 'bob', []), false);
  assert.strictEqual(R.subjectMatches(undefined, null, []), true, 'no subject = applies to everyone');
  // flat array = OR, nested array = AND
  assert.strictEqual(R.subjectMatches(['user:alice', 'user:bob'], 'bob', []), true);
  assert.strictEqual(R.subjectMatches([['user:bob', 'group:admins']], 'bob', ['admins']), true);
  assert.strictEqual(R.subjectMatches([['user:bob', 'group:admins']], 'bob', []), false, 'AND needs both');
  assert.strictEqual(R.subjectMatches('group:admins', 'bob', ['admins']), true);
});

test('invalid resource regex is ignored, not thrown', () => {
  assert.strictEqual(R.resourcesMatch(['^/ok'], '/ok/1'), true);
  assert.strictEqual(R.resourcesMatch(['([unclosed'], '/anything'), false);
});

test('normalise drops unknown policies and subject-dependent bypass', () => {
  const d = R.normalise({ default_policy: 'two_factor', rules: [
    { domain: 'a.example.com', policy: 'nonsense' },
    { domain: 'b.example.com', subject: 'user:alice', policy: 'bypass' },
    { domain: 'c.example.com', policy: 'bypass' },
  ] });
  assert.strictEqual(d.default_policy, 'two_factor');
  assert.strictEqual(d.rules.length, 1);
  assert.strictEqual(d.rules[0].domain, 'c.example.com');
});

test('bad default_policy falls back to one_factor rather than failing open', () => {
  assert.strictEqual(R.normalise({ default_policy: 'allow-everything', rules: [] }).default_policy, 'one_factor');
});

// The ported rule set, in the order it must be evaluated.
const PORTED = {
  default_policy: 'two_factor',
  rules: [
    { domain: 'auth.example.com', policy: 'bypass' },
    { domain: 'app.example.com', networks: ['172.19.0.0/24', '127.0.0.1/32', '::1/128'], policy: 'bypass' },
    { domain: 'app.example.com', resources: ['^/public-reports.*'], policy: 'bypass' },
    { domain: 'app.example.com', resources: ['^/machine-api.*'], policy: 'bypass' },
    { domain: 'app.example.com', resources: ['^/contractor/.*'], subject: 'user:bob', policy: 'one_factor' },
    { domain: 'app.example.com', subject: 'user:bob', policy: 'deny' },
    { domain: '*.example.com', subject: 'user:bob', policy: 'deny' },
    { domain: 'dash.example.com', subject: 'user:alice', policy: 'two_factor' },
    { domain: 'dash.example.com', policy: 'deny' },
    { domain: '*.example.com', policy: 'two_factor' },
  ],
};

test('ported rule set: first-match-wins produces the intended policy per request', () => {
  withRules(PORTED, () => {
    const p = (host, pth, user, ip) => R.evaluate({ host, path: pth, user, ip: ip || '198.51.100.5' }).policy;

    assert.strictEqual(p('auth.example.com', '/', null), 'bypass', 'login host is anonymous');
    assert.strictEqual(p('app.example.com', '/x', null, '172.19.0.9'), 'bypass', 'internal network bypasses');
    assert.strictEqual(p('app.example.com', '/x', null, '127.0.0.1'), 'bypass');
    assert.strictEqual(p('app.example.com', '/x', null), 'two_factor', 'outside that network it is gated');
    assert.strictEqual(p('app.example.com', '/public-reports/q3', null), 'bypass', 'carve-out path stays open');
    assert.strictEqual(p('app.example.com', '/machine-api/v1', null), 'bypass');

    // the scoped contractor: allowed on exactly one prefix, denied elsewhere
    assert.strictEqual(p('app.example.com', '/contractor/notes', 'bob'), 'one_factor');
    assert.strictEqual(p('app.example.com', '/elsewhere', 'bob'), 'deny');
    assert.strictEqual(p('other.example.com', '/', 'bob'), 'deny', 'wildcard deny covers other hosts');

    // the restricted dashboard: one named user with 2FA, everyone else denied
    assert.strictEqual(p('dash.example.com', '/', 'alice'), 'two_factor');
    assert.strictEqual(p('dash.example.com', '/', 'carol'), 'deny');

    assert.strictEqual(p('app.example.com', '/elsewhere', 'alice'), 'two_factor', 'default for everyone else');
    assert.strictEqual(p('unlisted.test', '/', 'alice'), 'two_factor', 'unmatched host -> default_policy');
  });
});

test('anonymous request to a subject-scoped path is challenged, not denied outright', () => {
  withRules(PORTED, () => {
    // /contractor/* is bob-only; anonymous must fall through to a challengeable policy so the
    // proxy redirects to login rather than returning a dead 403.
    assert.strictEqual(R.evaluate({ host: 'app.example.com', path: '/contractor/notes', user: null, ip: '198.51.100.5' }).policy, 'two_factor');
  });
});

test('sessionIsTwoFactor only accepts a real second factor', () => {
  assert.ok(!R.sessionIsTwoFactor({ sub: 'a', amr: ['pwd'] }));
  assert.ok(!R.sessionIsTwoFactor({ sub: 'a', amr: ['ext'] }), 'external IdP alone is not a second factor');
  assert.ok(!R.sessionIsTwoFactor({ sub: 'a' }), 'a pre-amr token degrades to single factor');
  assert.ok(R.sessionIsTwoFactor({ sub: 'a', amr: ['pwd', 'totp'] }));
  assert.ok(R.sessionIsTwoFactor({ sub: 'a', amr: ['recovery'] }));
  assert.ok(R.sessionIsTwoFactor({ sub: 'a', amr: ['passkey'] }), 'a passkey is a strong factor on its own');
});

test('no rules file: the legacy ASMLTR_AUTH_ALLOW behaviour is preserved exactly', () => {
  const prevRules = process.env.ASMLTR_AUTH_RULES, prevAllow = process.env.ASMLTR_AUTH_ALLOW;
  delete process.env.ASMLTR_AUTH_RULES;
  try {
    process.env.ASMLTR_AUTH_ALLOW = '';
    assert.strictEqual(R.evaluate({ host: 'x.test', path: '/', user: 'anyone' }).policy, 'one_factor',
      'empty allowlist = any signed-in user passes');

    process.env.ASMLTR_AUTH_ALLOW = 'alice, bob';
    assert.strictEqual(R.evaluate({ host: 'x.test', path: '/', user: 'alice' }).policy, 'one_factor');
    assert.strictEqual(R.evaluate({ host: 'x.test', path: '/', user: 'carol' }).policy, 'deny');
  } finally {
    if (prevRules === undefined) delete process.env.ASMLTR_AUTH_RULES; else process.env.ASMLTR_AUTH_RULES = prevRules;
    if (prevAllow === undefined) delete process.env.ASMLTR_AUTH_ALLOW; else process.env.ASMLTR_AUTH_ALLOW = prevAllow;
  }
});

test('contextFromRequest reads the headers proxies actually send', () => {
  assert.deepStrictEqual(
    R.contextFromRequest({ headers: { 'x-forwarded-host': 'a.example.com', 'x-forwarded-uri': '/p?q=1', 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } }),
    { host: 'a.example.com', path: '/p?q=1', ip: '203.0.113.9' });
  // nginx auth_request style
  assert.deepStrictEqual(
    R.contextFromRequest({ headers: { host: 'b.example.com', 'x-original-url': 'https://b.example.com/deep/path' } }),
    { host: 'b.example.com', path: '/deep/path', ip: '' });
});

test('a malformed rules file keeps the last good rules instead of failing open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authrules-bad-'));
  const f = path.join(dir, 'rules.json');
  fs.writeFileSync(f, JSON.stringify({ default_policy: 'deny', rules: [] }));
  const prev = process.env.ASMLTR_AUTH_RULES;
  process.env.ASMLTR_AUTH_RULES = f;
  try {
    assert.strictEqual(R.evaluate({ host: 'x.test', path: '/', user: 'alice' }).policy, 'deny');
    fs.writeFileSync(f, '{ this is not json');
    assert.strictEqual(R.evaluate({ host: 'x.test', path: '/', user: 'alice' }).policy, 'deny',
      'broken edit must not silently widen access');
  } finally {
    if (prev === undefined) delete process.env.ASMLTR_AUTH_RULES; else process.env.ASMLTR_AUTH_RULES = prev;
  }
});

test('loginRedirect sends browsers to the login screen but leaves API callers a 401', () => {
  const ctx = { host: 'app.example.com', path: '/deep/page', ip: '203.0.113.1' };
  const rd = 'https://auth.example.com/';

  // a browser navigation gets a redirect carrying the original URL
  const htmlReq = { headers: { accept: 'text/html,application/xhtml+xml', 'x-forwarded-proto': 'https' } };
  const to = R.loginRedirect(htmlReq, ctx, rd);
  assert.ok(to, 'a browser must get a redirect target');
  const u = new URL(to);
  assert.strictEqual(u.origin + u.pathname, 'https://auth.example.com/');
  assert.strictEqual(u.searchParams.get('rd'), 'https://app.example.com/deep/page');

  // Sec-Fetch-Mode: navigate also counts as a browser navigation
  assert.ok(R.loginRedirect({ headers: { 'sec-fetch-mode': 'navigate' } }, ctx, rd));

  // XHR / API / CLI callers must NOT be redirected — they need the actionable status
  assert.strictEqual(R.loginRedirect({ headers: { accept: 'application/json' } }, ctx, rd), null);
  assert.strictEqual(R.loginRedirect({ headers: {} }, ctx, rd), null);
  // and with nothing configured there is no redirect at all
  assert.strictEqual(R.loginRedirect(htmlReq, ctx, ''), null);
  // a malformed target is ignored rather than throwing on the request path
  assert.strictEqual(R.loginRedirect(htmlReq, ctx, 'not a url'), null);
});
