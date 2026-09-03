'use strict';

function domainOf(addrOrDomain) {
  const s = String(addrOrDomain || '').trim().toLowerCase().replace(/^<|>$/g, '');
  if (!s) return '';
  if (s.includes('@')) return s.split('@').pop().replace(/^\./, '');
  return s.replace(/^@/, '').replace(/^\./, '');
}

function parseAuthResults(headerText) {
  const out = { dkim: null, spf: null, dmarc: null, dkimD: null, spfMailfrom: null, headerFrom: null };
  const s = String(headerText || '');
  if (!s.trim()) return out;
  const re = /\b(dkim|spf|dmarc)\s*=\s*(pass|fail|softfail|neutral|none|temperror|permerror|bestguesspass|policy)/gi;
  let m;
  while ((m = re.exec(s))) {
    const k = m[1].toLowerCase();
    if (!out[k]) out[k] = m[2].toLowerCase();
  }
  const i = /(?:^|[;\s])(?:header\.)?i\s*=\s*@?([A-Za-z0-9.-]+)/i.exec(s);
  const d = /(?:^|[;\s])d\s*=\s*@?([A-Za-z0-9.-]+)/i.exec(s);
  if (i) out.dkimD = i[1].toLowerCase();
  else if (d) out.dkimD = d[1].toLowerCase();
  const mf = /(?:smtp\.mailfrom|header\.mailfrom)\s*=\s*<?([^;>\s]+)>?/i.exec(s);
  if (mf) out.spfMailfrom = mf[1].toLowerCase();
  const hf = /header\.from\s*=\s*@?([A-Za-z0-9.-]+)/i.exec(s);
  if (hf) out.headerFrom = hf[1].toLowerCase();
  return out;
}

function alignsWithFrom(fromAddr, results) {
  const fromDom = domainOf(fromAddr);
  if (!fromDom) return false;
  const cands = [results && results.dkimD, domainOf(results && results.spfMailfrom), results && results.headerFrom]
    .map((x) => domainOf(x)).filter(Boolean);
  if (!cands.length) return false;
  return cands.some((d) => fromDom === d || fromDom.endsWith('.' + d) || d.endsWith('.' + fromDom));
}

module.exports = { domainOf, parseAuthResults, alignsWithFrom };
