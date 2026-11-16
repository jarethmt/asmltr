'use strict';
/**
 * Locally-submitted mail carries no Authentication-Results.
 *
 * rspamd on a mailcow host sets `skip_authenticated = true`, so a message a user submits with
 * their own password (ESMTPSA) is never stamped — the auth gate in index.js then rejects it as
 * `missing AR`. On our install that silently killed owner mail: 15 real messages from
 * jareth@thoughtspacedesigns.com to eve@ had zero AR headers.
 *
 * Flipping rspamd's `skip_authenticated` is the obvious fix and the wrong one: with
 * `add_smtp_user` it writes the authenticated username into headers that travel out to
 * customers, and without it the stamped results are `none`, which the gate rejects anyway.
 *
 * So this recognises the local path HERE, and only on POSITIVE evidence — never on the mere
 * absence of a header, which is exactly what an attacker is trying to achieve:
 *
 *   1. no allowlisted Authentication-Results present (it never came in from outside), AND
 *   2. the From domain is one of OUR configured local domains, AND
 *   3. a DKIM-Signature exists whose d= is that same domain — our key, which we sign with on
 *      authenticated submission and an outsider cannot produce, AND
 *   4. EVERY Received hop is loopback or RFC1918. This is the load-bearing one: a message from
 *      the internet gets a Received header prepended by our own server naming a public source
 *      IP, and the sender cannot remove or alter the headers we add above theirs. Forged
 *      Received lines can only be added BELOW ours, so one public hop anywhere = not local.
 *
 * Opt-in: with no local domains configured this always returns false, so the public connector
 * keeps its fail-closed behaviour and only an install that declares its own domains changes.
 */

const PRIVATE_RE = [
  /^127\./, /^::1$/, /^0\.0\.0\.0$/, /^10\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^f[cd][0-9a-f]{2}:/i,
];

function isPrivateHost(token) {
  const t = String(token || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!t) return false;
  if (t === 'localhost') return true;
  return PRIVATE_RE.some((re) => re.test(t));
}

/** Every IP-looking token in a Received line must be private for that hop to count as local. */
function receivedHopIsLocal(line) {
  const s = String(line || '');
  const ips = s.match(/\[?\b(?:\d{1,3}\.){3}\d{1,3}\b\]?|\[[0-9a-f:]+\]/gi) || [];
  if (!ips.length) return true; // no address named (e.g. an LMTP hop by container id)
  return ips.every((ip) => isPrivateHost(ip));
}

function domainOfAddr(addr) {
  const s = String(addr || '').trim().toLowerCase().replace(/^<|>$/g, '');
  return s.includes('@') ? s.split('@').pop() : '';
}

function dkimDomains(headers) {
  const out = [];
  for (const h of headers || []) {
    const m = /(?:^|;|\s)d\s*=\s*([A-Za-z0-9.-]+)/i.exec(String(h || ''));
    if (m) out.push(m[1].toLowerCase());
  }
  return out;
}

/**
 * @param {object} o
 * @param {string}   o.fromAddr          parsed From address
 * @param {string[]} o.received          ALL Received header lines
 * @param {string[]} o.dkimSignatures    ALL DKIM-Signature header lines
 * @param {boolean}  o.hasAllowlistedAR  an Authentication-Results from a trusted authserv exists
 * @param {string[]} o.localDomains      configured local domains (empty = feature off)
 */
function isTrustedLocalSubmission(o) {
  const localDomains = (o.localDomains || []).map((d) => String(d || '').trim().toLowerCase()).filter(Boolean);
  if (!localDomains.length) return false;
  if (o.hasAllowlistedAR) return false;

  const fromDom = domainOfAddr(o.fromAddr);
  if (!fromDom || !localDomains.includes(fromDom)) return false;

  if (!dkimDomains(o.dkimSignatures).includes(fromDom)) return false;

  const received = o.received || [];
  if (!received.length) return false; // no chain at all proves nothing
  return received.every((r) => receivedHopIsLocal(r));
}

module.exports = { isTrustedLocalSubmission, isPrivateHost, receivedHopIsLocal, dkimDomains, domainOfAddr };
