'use strict';
/**
 * Minimal WebDAV/CalDAV/CardDAV client shared by the `caldav` and `carddav` integrations.
 *
 * Both protocols are WebDAV with different report bodies and payload formats, so discovery,
 * auth and XML handling live here once rather than twice.
 *
 * Auth is either Basic (mailcow/SOGo, an app password) or an OAuth2 bearer (Google). That is the
 * ONLY difference between the two providers — Google speaks standard CalDAV and CardDAV, so no
 * Google-specific API is needed for calendars or contacts.
 */

function basic(user, pass) { return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'); }

function authHeader(cfg) {
  if (cfg.auth === 'oauth2') {
    if (!cfg.access_token) throw new Error('dav: access_token required for auth=oauth2');
    return 'Bearer ' + cfg.access_token;
  }
  if (!cfg.username || !cfg.password) throw new Error('dav: username + password required');
  return basic(cfg.username, cfg.password);
}

/** Tags are namespace-prefixed inconsistently across servers; match on local name only. */
function tag(name) { return new RegExp(`<(?:[A-Za-z0-9]+:)?${name}[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${name}>`, 'gi'); }
function one(xml, name) { const m = tag(name).exec(xml || ''); return m ? m[1] : null; }
function many(xml, name) { const out = []; let m; const re = tag(name); while ((m = re.exec(xml || ''))) out.push(m[1]); return out; }
function unesc(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** One <response> block per resource, so href stays paired with its props. */
function responses(xml) {
  return many(xml, 'response').map((block) => ({
    href: unesc(one(block, 'href') || '').trim(),
    displayname: unesc(one(block, 'displayname') || '').trim() || null,
    ctag: unesc(one(block, 'getctag') || '').trim() || null,
    etag: unesc(one(block, 'getetag') || '').trim() || null,
    raw: block,
  }));
}

function makeClient(cfg) {
  const base = String(cfg.base_url || '').replace(/\/+$/, '');
  if (!base) throw new Error('dav: base_url required');
  const origin = new URL(base).origin;
  const auth = authHeader(cfg);

  /** hrefs come back absolute-path; turn one into a full URL. */
  function abs(href) {
    if (!href) return null;
    if (/^https?:\/\//i.test(href)) return href;
    return origin + (href.startsWith('/') ? href : '/' + href);
  }

  async function req(method, url, { body, depth, headers = {} } = {}) {
    const h = { Authorization: auth, ...headers };
    if (depth != null) h.Depth = String(depth);
    if (body) h['Content-Type'] = headers['Content-Type'] || 'application/xml; charset=utf-8';
    const r = await fetch(url, { method, headers: h, body });
    const text = await r.text().catch(() => '');
    if (r.status === 401 || r.status === 403) throw new Error(`dav: ${r.status} not authorised for ${url}`);
    if (!r.ok && r.status !== 207) throw new Error(`dav: ${method} ${r.status} ${text.slice(0, 160)}`);
    return { status: r.status, text, etag: r.headers.get('etag') };
  }

  return {
    base, abs, req,
    /** Child collections of base — calendars or address books, depending on the caller. */
    async collections({ marker } = {}) {
      const { text } = await req('PROPFIND', base + '/', {
        depth: 1,
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
          <d:prop><d:displayname/><d:resourcetype/><cs:getctag/></d:prop></d:propfind>`,
      });
      const selfPath = new URL(base + '/').pathname.replace(/\/+$/, '');
      const seen = new Set();
      return responses(text)
        .filter((r) => r.href && r.href.replace(/\/+$/, '') !== selfPath)   // not the container itself
        .filter((r) => {
          // Match on <resourcetype> ONLY. SOGo advertises each calendar three times — the real
          // collection plus `.ics` and `.xml` alternate representations that carry an EMPTY
          // resourcetype. Testing the whole response block matched all three and then handed a
          // REPORT the `.ics` href, which 501s. A real collection has both `collection` and the
          // protocol marker (`calendar` / `addressbook`).
          const rt = (one(r.raw, 'resourcetype') || '').replace(/\s+/g, '');
          if (!/collection/i.test(rt)) return false;
          return marker ? new RegExp(marker, 'i').test(rt) : true;
        })
        .filter((r) => { const k = r.href.replace(/\/+$/, ''); if (seen.has(k)) return false; seen.add(k); return true; })
        .map((r) => ({ href: r.href, url: abs(r.href), name: r.displayname, ctag: r.ctag }));
    },
    /**
     * List the RESOURCES in a collection (not sub-collections) via PROPFIND. Needed where a server
     * refuses an open-ended REPORT — Google's CardDAV answers addressbook-query with 400 and
     * expects PROPFIND + multiget instead.
     */
    async listResources(collectionUrl) {
      const url = collectionUrl || base + '/';
      const { text } = await req('PROPFIND', url, {
        depth: 1,
        body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>',
      });
      const selfPath = new URL(url).pathname.replace(/\/+$/, '');
      return responses(text)
        .filter((r) => r.href && r.href.replace(/\/+$/, '') !== selfPath)
        .filter((r) => !/collection/i.test((one(r.raw, 'resourcetype') || '')))   // resources only
        .map((r) => ({ href: r.href, url: abs(r.href), etag: r.etag }));
    },
    /** REPORT with a caller-supplied body; returns href + etag + payload per item. */
    async report(collectionUrl, body, payloadTag) {
      const { text } = await req('REPORT', collectionUrl, { depth: 1, body });
      return responses(text).map((r) => ({
        href: r.href, url: abs(r.href), etag: r.etag,
        data: payloadTag ? unesc(one(r.raw, payloadTag) || '') : null,
      }));
    },
    async getItem(url) { const { text, etag } = await req('GET', url, { headers: { Accept: '*/*' } }); return { data: text, etag }; },
    async putItem(url, data, contentType, { etag } = {}) {
      const headers = { 'Content-Type': contentType };
      if (etag) headers['If-Match'] = etag;          // optimistic concurrency: never clobber blindly
      const r = await req('PUT', url, { body: data, headers });
      return { status: r.status, etag: r.etag };
    },
    async deleteItem(url, { etag } = {}) {
      const headers = {};
      if (etag) headers['If-Match'] = etag;
      await req('DELETE', url, { headers });
      return { deleted: true };
    },
  };
}

module.exports = { makeClient, responses, one, many, unesc, authHeader };
