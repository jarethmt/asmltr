'use strict';
/**
 * Forward-auth access rules (docs/AUTH.md "Access rules").
 *
 * The plain `ASMLTR_AUTH_ALLOW` allowlist answers one question — "may this user in at all?" — which
 * is too coarse once several services share one gate: a user may be allowed one path and denied its
 * siblings, an API sub-path may need to stay anonymous, and a dashboard may need a second factor
 * while the rest of the host does not. This module adds first-match-wins rules over
 * (domain, path, subject, source network) → policy, which is the shape reverse-proxy gates have
 * converged on, so an existing deployment's rules can be carried over one-to-one.
 *
 * Rules live in a JSON file (ASMLTR_AUTH_RULES) rather than an env var: they are multi-line and
 * edited far more often than the rest of the config, and a file can be re-read without a restart —
 * restarting core drops live sessions, so a rule edit must never require one.
 *
 * Policies: bypass (no session needed) · one_factor (any session) · two_factor (session that used a
 * second factor) · deny (never). Unmatched requests fall through to `default_policy`.
 *
 * Dependency-free on purpose — this sits on the request path for every gated service.
 */

const fs = require('fs');

// ── source-network matching (CIDR, v4 + v6, no deps) ──────────────────────────
// Returns the address as a BigInt plus its bit-width, normalising IPv4-mapped v6
// (::ffff:1.2.3.4) down to v4 so a "10.0.0.0/8" rule still matches a proxy that hands us v6 form.
function ipToBig(ip) {
  if (typeof ip !== 'string' || !ip) return null;
  let s = ip.trim();
  if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']')); // [::1]:1234
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) s = mapped[1];
  if (s.includes('.') && !s.includes(':')) {
    const p = s.split('.');
    if (p.length !== 4) return null;
    let v = 0n;
    for (const o of p) {
      const n = Number(o);
      if (!/^\d{1,3}$/.test(o) || n > 255) return null;
      v = (v << 8n) | BigInt(n);
    }
    return { v, bits: 32 };
  }
  if (!s.includes(':')) return null;
  // IPv6, including :: compression and a trailing dotted-quad
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const v4 = ipToBig(tail[1]);
    if (!v4) return null;
    const hi = (v4.v >> 16n) & 0xffffn, lo = v4.v & 0xffffn;
    s = s.slice(0, tail.index) + hi.toString(16) + ':' + lo.toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const rear = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const fill = 8 - head.length - rear.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array(fill).fill('0'), ...rear];
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return { v, bits: 128 };
}

/** Does `ip` fall inside `cidr`? A bare address is treated as a single-host range. */
function ipInCidr(ip, cidr) {
  if (typeof cidr !== 'string' || !cidr) return false;
  const slash = cidr.indexOf('/');
  const netStr = slash === -1 ? cidr : cidr.slice(0, slash);
  const net = ipToBig(netStr);
  const addr = ipToBig(ip);
  if (!net || !addr || net.bits !== addr.bits) return false;
  const prefix = slash === -1 ? net.bits : Number(cidr.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > net.bits) return false;
  const host = BigInt(net.bits - prefix);
  return (addr.v >> host) === (net.v >> host);
}

// ── matchers ──────────────────────────────────────────────────────────────────
/** Exact host, or a leading-wildcard pattern. `*.example.com` covers sub.example.com, not example.com. */
function domainMatches(pattern, host) {
  if (!pattern) return true; // a rule without a domain applies to every host
  const p = String(pattern).toLowerCase();
  const h = String(host || '').toLowerCase().split(':')[0];
  if (!h) return false;
  // `*.example.com` covers any sub-domain but deliberately NOT the apex, matching the
  // convention of the proxy gates these rules are ported from.
  if (p.startsWith('*.')) return h.endsWith('.' + p.slice(2));
  return p === h;
}

const _reCache = new Map(); // pattern -> RegExp|null, so a bad regex is reported once, not per request
function toRe(src) {
  if (_reCache.has(src)) return _reCache.get(src);
  let re = null;
  try { re = new RegExp(src); } catch (e) {
    console.warn(`[auth-rules] ignoring invalid resource pattern ${JSON.stringify(src)}: ${e.message}`);
  }
  _reCache.set(src, re);
  return re;
}

/** Any-of over regexes tested against the request path (with query string, as proxies send it). */
function resourcesMatch(resources, path) {
  if (!resources) return true;
  const list = Array.isArray(resources) ? resources : [resources];
  if (!list.length) return true;
  return list.some((src) => { const re = toRe(String(src)); return re ? re.test(path || '/') : false; });
}

/**
 * Subject terms: "user:<name>" / "group:<name>". A flat array is OR; a nested array is AND
 * (matching the convention of the proxy gates these rules are ported from).
 * Returns null — "cannot be evaluated" — when the request has no identity yet, so an anonymous
 * request is challenged by a later rule instead of silently matching or silently skipping.
 */
function subjectMatches(subject, user, groups) {
  if (!subject) return true;
  if (!user) return null;
  const g = (groups || []).map((x) => String(x).toLowerCase());
  const one = (term) => {
    const t = String(term);
    const i = t.indexOf(':');
    const kind = i === -1 ? 'user' : t.slice(0, i).toLowerCase();
    const val = (i === -1 ? t : t.slice(i + 1)).toLowerCase();
    if (kind === 'user') return String(user).toLowerCase() === val;
    if (kind === 'group') return g.includes(val);
    return false;
  };
  const list = Array.isArray(subject) ? subject : [subject];
  return list.some((entry) => (Array.isArray(entry) ? entry.every(one) : one(entry)));
}

// ── rules file (hot-reloaded) ─────────────────────────────────────────────────
const POLICIES = new Set(['bypass', 'one_factor', 'two_factor', 'deny']);
let _cache = { path: null, mtimeMs: 0, doc: null };

function defaultDoc() {
  // No rules file: preserve the historical allowlist behaviour exactly, so upgrading changes nothing.
  const allow = (process.env.ASMLTR_AUTH_ALLOW || '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    default_policy: 'one_factor',
    rules: allow.length ? [{ subject: allow.map((u) => `user:${u}`), policy: 'one_factor' }, { policy: 'deny' }] : [],
    _source: allow.length ? 'ASMLTR_AUTH_ALLOW' : 'none',
  };
}

function normalise(raw) {
  const doc = raw && typeof raw === 'object' ? raw : {};
  const dp = String(doc.default_policy || 'one_factor');
  const rules = Array.isArray(doc.rules) ? doc.rules : [];
  const out = [];
  rules.forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    const policy = String(r.policy || '');
    if (!POLICIES.has(policy)) { console.warn(`[auth-rules] rule #${i} has unknown policy ${JSON.stringify(r.policy)} — skipped`); return; }
    if (policy === 'bypass' && r.subject) { console.warn(`[auth-rules] rule #${i}: 'bypass' cannot depend on a subject (nobody is identified yet) — skipped`); return; }
    out.push({ ...r, policy, _i: i });
  });
  return { default_policy: POLICIES.has(dp) ? dp : 'one_factor', rules: out, _source: 'file' };
}

/** Load (and cache) the rules document. Re-reads only when the file's mtime/size changes. */
function load() {
  const p = process.env.ASMLTR_AUTH_RULES || '';
  if (!p) { _cache = { path: null, mtimeMs: 0, doc: null }; return defaultDoc(); }
  let st;
  try { st = fs.statSync(p); } catch (_) {
    if (_cache.path !== p) console.warn(`[auth-rules] ASMLTR_AUTH_RULES=${p} not readable — falling back to ASMLTR_AUTH_ALLOW`);
    _cache = { path: p, mtimeMs: 0, doc: null };
    return defaultDoc();
  }
  const stamp = st.mtimeMs + ':' + st.size;
  if (_cache.path === p && _cache.mtimeMs === stamp && _cache.doc) return _cache.doc;
  let doc;
  try { doc = normalise(JSON.parse(fs.readFileSync(p, 'utf8'))); }
  catch (e) {
    console.warn(`[auth-rules] ${p} is not valid JSON (${e.message}) — keeping the previous rules`);
    return _cache.doc || defaultDoc();
  }
  _cache = { path: p, mtimeMs: stamp, doc };
  console.log(`[auth-rules] loaded ${doc.rules.length} rule(s) from ${p} (default_policy=${doc.default_policy})`);
  return doc;
}

// ── evaluation ────────────────────────────────────────────────────────────────
/**
 * First-match-wins. `user` null = anonymous; rules that need a subject are then skipped so the
 * request falls through to a rule that can challenge it.
 * → { policy, rule, index, default_policy }
 */
function evaluate({ host, path, ip, user, groups } = {}) {
  const doc = load();
  for (const r of doc.rules) {
    if (!domainMatches(r.domain, host)) continue;
    if (!resourcesMatch(r.resources, path)) continue;
    if (r.networks && !(Array.isArray(r.networks) ? r.networks : [r.networks]).some((c) => ipInCidr(ip, c))) continue;
    const sm = subjectMatches(r.subject, user, groups);
    if (sm === null || sm === false) continue;
    return { policy: r.policy, rule: r, index: r._i, default_policy: doc.default_policy };
  }
  return { policy: doc.default_policy, rule: null, index: -1, default_policy: doc.default_policy };
}

/** What the request looked like to the proxy. Only the proxy can reach core, so its headers are trusted. */
function contextFromRequest(req) {
  const h = req.headers || {};
  const host = h['x-forwarded-host'] || h.host || '';
  let path = h['x-forwarded-uri'] || h['x-original-uri'] || '';
  if (!path && h['x-original-url']) {
    try { path = new URL(h['x-original-url']).pathname; } catch (_) { path = h['x-original-url']; }
  }
  if (!path) path = req.originalUrl || req.url || '/';
  const xff = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xff || req.ip || (req.socket && req.socket.remoteAddress) || '';
  return { host: String(host), path: String(path), ip: String(ip) };
}

/** True when the session was established with a second factor (TOTP / recovery code / passkey). */
function sessionIsTwoFactor(session) {
  const amr = (session && session.amr) || [];
  return amr.some((m) => m === 'totp' || m === 'recovery' || m === 'passkey' || m === 'mfa');
}

module.exports = {
  evaluate, contextFromRequest, sessionIsTwoFactor, load,
  // exported for tests
  ipInCidr, ipToBig, domainMatches, resourcesMatch, subjectMatches, normalise,
};
