'use strict';
/**
 * CARDDAV integration — contacts as a passive `tools` capability.
 *
 * Same shape as caldav: standard protocol, so SOGo (mailcow) and Google differ only in auth.
 * On mailcow this also reaches the per-domain GAL, not just a personal address book.
 *
 * config: {
 *   base_url,                  // SOGo: https://host/SOGo/dav/<user>/Contacts/
 *                              // Google: https://www.googleapis.com/carddav/v1/principals/<email>/lists/default/
 *   username_ref, password_ref,
 *   auth = 'password' | 'oauth2',
 *   refresh_token_ref, oauth_client_id_ref, oauth_client_secret_ref,
 * }
 */
const dav = require('../../../shared/dav');

async function withToken(cfg) {
  if (cfg.auth !== 'oauth2') return cfg;
  if (cfg.access_token) return cfg;
  const google = require('../../../shared/google-oauth');
  const { access_token } = await google.accessToken({
    client_id: cfg.oauth_client_id, client_secret: cfg.oauth_client_secret, refresh_token: cfg.refresh_token,
  });
  return { ...cfg, access_token };
}

function vcardField(vcf, field) {
  const flat = String(vcf || '').replace(/\r?\n[ \t]/g, '');
  const m = new RegExp(`^${field}(?:;[^:\\n]*)?:(.*)$`, 'im').exec(flat);
  return m ? m[1].trim() : null;
}
function vcardAll(vcf, field) {
  const flat = String(vcf || '').replace(/\r?\n[ \t]/g, '');
  const re = new RegExp(`^${field}(?:;[^:\\n]*)?:(.*)$`, 'gim');
  const out = []; let m;
  while ((m = re.exec(flat))) out.push(m[1].trim());
  return out;
}

/** Summarise a vCard. EMAIL/TEL repeat, so those come back as arrays. */
function summarise(vcf) {
  return {
    uid: vcardField(vcf, 'UID'),
    name: vcardField(vcf, 'FN'),
    org: vcardField(vcf, 'ORG'),
    title: vcardField(vcf, 'TITLE'),
    emails: vcardAll(vcf, 'EMAIL'),
    phones: vcardAll(vcf, 'TEL'),
  };
}

async function open(rawCfg = {}) {
  const cfg = await withToken(rawCfg);
  const c = dav.makeClient({ ...cfg, username: cfg.username, password: cfg.password });
  return {
    /** Address book collections under base_url — on mailcow includes the domain GAL. */
    async addressbooks() { return c.collections({ marker: 'addressbook' }); },
    /**
     * Enumerate an address book. Returns { enumerable:false } instead of throwing when the server
     * refuses — SOGo's per-domain GAL answers 501 to addressbook-query because it is a directory
     * you SEARCH, not a book you list. That is a property of the collection, not an error, and a
     * caller listing several books should not lose the ones that worked.
     */
    async contacts({ addressbook, limit = 500 } = {}) {
      const url = addressbook || c.base + '/';
      const body = `<?xml version="1.0"?><c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
        <d:prop><d:getetag/><c:address-data/></d:prop></c:addressbook-query>`;
      let rows;
      try {
        rows = await c.report(url, body, 'address-data');
      } catch (e) {
        const msg = String(e.message);
        // Google answers addressbook-query with 400 INVALID_ARGUMENT — it supports PROPFIND and
        // addressbook-multiget, not an open-ended query. Fall back to listing hrefs then fetching
        // them, which is what a real CardDAV client does against Google.
        if (/\b400\b/.test(msg)) {
          const listed = await c.listResources(url);
          const hrefs = listed.slice(0, limit);
          const got = [];
          for (const h of hrefs) {
            try { const { data, etag } = await c.getItem(h.url); got.push({ href: h.href, url: h.url, etag, ...summarise(data), vcard: data }); }
            catch (_) { /* skip an individual card rather than losing the whole book */ }
          }
          return Object.assign(got, { enumerable: true, via: 'propfind' });
        }
        if (/\b(501|403|405)\b/.test(msg)) {
          return Object.assign([], { enumerable: false, reason: 'collection does not support enumeration (search-only, e.g. a GAL)' });
        }
        throw e;
      }
      const out = rows.slice(0, limit).map((r) => ({ href: r.href, url: r.url, etag: r.etag, ...summarise(r.data), vcard: r.data }));
      return Object.assign(out, { enumerable: true, via: 'addressbook-query' });
    },
    /**
     * Search a directory by name or email — the only way to query a GAL.
     */
    async searchContacts({ addressbook, query, limit = 50 } = {}) {
      if (!query) throw new Error('carddav: query required');
      const url = addressbook || c.base + '/';
      const esc = String(query).replace(/[<>&]/g, '');
      const body = `<?xml version="1.0"?><c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
        <d:prop><d:getetag/><c:address-data/></d:prop>
        <c:filter test="anyof">
          <c:prop-filter name="FN"><c:text-match collation="i;unicode-casemap" match-type="contains">${esc}</c:text-match></c:prop-filter>
          <c:prop-filter name="EMAIL"><c:text-match collation="i;unicode-casemap" match-type="contains">${esc}</c:text-match></c:prop-filter>
        </c:filter></c:addressbook-query>`;
      let rows;
      try {
        rows = await c.report(url, body, 'address-data');
      } catch (e) {
        // SOGo's GAL refuses addressbook-query outright, filtered or not — it is exposed to clients
        // for autocomplete over its own protocol, not as a queryable CardDAV collection. Report
        // that plainly rather than throwing, so a caller searching several books keeps the rest.
        if (/\b(501|403|405)\b/.test(String(e.message))) {
          return Object.assign([], { searchable: false, reason: 'collection does not support CardDAV queries' });
        }
        throw e;
      }
      return Object.assign(rows.slice(0, limit).map((r) => ({ href: r.href, url: r.url, etag: r.etag, ...summarise(r.data), vcard: r.data })), { searchable: true });
    },
    async getContact(url) { const { data, etag } = await c.getItem(url); return { url, etag, ...summarise(data), vcard: data }; },
    /** Create or replace. Caller supplies a full vCard. */
    async putContact({ url, vcard, etag } = {}) {
      if (!url || !vcard) throw new Error('carddav: url + vcard required');
      return c.putItem(url, vcard, 'text/vcard; charset=utf-8', { etag });
    },
    async deleteContact({ url, etag } = {}) {
      if (!url) throw new Error('carddav: url required');
      return c.deleteItem(url, { etag });
    },
    async close() { /* stateless */ },
  };
}

async function probe(cfg = {}) {
  const h = await open(cfg);
  const books = await h.addressbooks();
  return { ok: true, addressbooks: books.length, names: books.map((x) => x.name).filter(Boolean).slice(0, 8) };
}

module.exports = { open, probe, kind: 'tools', lifecycle: 'passive' };
