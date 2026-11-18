'use strict';
/**
 * WebDAV storage driver (Nextcloud, ownCloud, generic WebDAV) — implements the shared/storage.js
 * contract over HTTP WebDAV verbs. Registers itself as the `webdav` storage type.
 *
 * config: {
 *   base_url,           // WebDAV files root, e.g. https://host/remote.php/dav/files/<userid>
 *   username, password, // app password preferred (credentials resolve via shared/secrets.js upstream)
 *   root,               // subfolder to confine this backend to (e.g. 'asmltr-silos') — NEVER the account root
 * }
 * Every op is confined under `root`; nothing outside it is ever touched.
 *
 * mint(): WebDAV has no native presigning. For now returns { url: null } (owner proxies the data
 * plane). Nextcloud public-share links via the OCS Share API are a later data-plane enhancement.
 */
const { registerDriver } = require('../../../shared/storage');

function enc(rel) {
  return String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

class WebdavStorage {
  constructor({ base_url, username, password, root = '' } = {}) {
    if (!base_url) throw new Error('webdav: base_url required');
    this.base = String(base_url).replace(/\/+$/, '');
    this.root = String(root || '').replace(/^\/+|\/+$/g, '');
    this.auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }
  _url(rel) {
    const parts = [this.root, rel].filter(Boolean).join('/');
    return this.base + '/' + enc(parts);
  }
  async _req(method, rel, { headers = {}, body } = {}) {
    const r = await fetch(this._url(rel), { method, headers: { Authorization: this.auth, ...headers }, body });
    return r;
  }
  async _ensureParents(rel) {
    const segs = [this.root, rel].filter(Boolean).join('/').split('/').filter(Boolean);
    segs.pop(); // drop the file itself
    let acc = '';
    for (const s of segs) {
      acc = acc ? acc + '/' + s : s;
      const r = await fetch(this.base + '/' + enc(acc), { method: 'MKCOL', headers: { Authorization: this.auth } });
      if (![201, 405 /* exists */, 301].includes(r.status)) { /* keep going; PUT will surface real errors */ }
    }
  }
  async put(rel, data) {
    await this._ensureParents(rel);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const r = await this._req('PUT', rel, { body: buf });
    if (![200, 201, 204].includes(r.status)) throw new Error(`webdav put ${rel}: HTTP ${r.status}`);
    return { path: String(rel), size: buf.length };
  }
  async get(rel) {
    const r = await this._req('GET', rel);
    if (r.status !== 200) throw new Error(`webdav get ${rel}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  async _propfind(rel, depth) {
    const r = await this._req('PROPFIND', rel, { headers: { Depth: String(depth), 'Content-Type': 'application/xml' } });
    if (r.status === 404) return null;
    if (r.status !== 207) throw new Error(`webdav propfind ${rel}: HTTP ${r.status}`);
    return parseMultistatus(await r.text(), this.base);
  }
  async stat(rel) {
    const rows = await this._propfind(rel, 0);
    if (!rows || !rows.length) return null;
    const e = rows[0];
    return { path: String(rel), size: e.size, mtime: e.mtime, type: e.type };
  }
  async list(prefix = '', { recursive = false } = {}) {
    const rows = await this._propfind(prefix, recursive ? 'infinity' : 1);
    if (!rows) return [];
    const rootAbs = '/' + enc([this.base.replace(/^https?:\/\/[^/]+/, ''), this.root, prefix].filter(Boolean).join('/')).replace(/^\//, '');
    // map each entry's href back to a silo-relative path under `prefix`
    const basePathEnc = new URL(this._url(prefix)).pathname.replace(/\/+$/, '');
    return rows
      .filter((e) => e.pathname.replace(/\/+$/, '') !== basePathEnc) // drop the folder itself
      .map((e) => {
        const relFromRoot = decodeURIComponent(e.pathname.slice(new URL(this._url('')).pathname.length)).replace(/^\/+|\/+$/g, '');
        return { path: relFromRoot, size: e.size, mtime: e.mtime, type: e.type };
      });
  }
  async remove(rel) {
    const r = await this._req('DELETE', rel);
    if (![200, 204, 404].includes(r.status)) throw new Error(`webdav delete ${rel}: HTTP ${r.status}`);
  }
  async move(from, to) {
    await this._ensureParents(to);
    const r = await this._req('MOVE', from, { headers: { Destination: this._url(to), Overwrite: 'T' } });
    if (![201, 204].includes(r.status)) throw new Error(`webdav move ${from}->${to}: HTTP ${r.status}`);
  }
  async mkdir(rel) {
    const segs = [this.root, rel].filter(Boolean).join('/').split('/').filter(Boolean);
    let acc = '';
    for (const s of segs) {
      acc = acc ? acc + '/' + s : s;
      const r = await fetch(this.base + '/' + enc(acc), { method: 'MKCOL', headers: { Authorization: this.auth } });
      if (![201, 405, 301].includes(r.status)) throw new Error(`webdav mkcol ${acc}: HTTP ${r.status}`);
    }
  }
  async mint(/* rel, opts */) { return { url: null }; } // data plane via owner for now
}

// Parse a WebDAV PROPFIND multistatus body → [{ pathname, size, mtime, type }].
function parseMultistatus(xml) {
  const out = [];
  const blocks = xml.match(/<[a-z0-9]*:?response[\s\S]*?<\/[a-z0-9]*:?response>/gi) || [];
  for (const b of blocks) {
    const href = (b.match(/<[a-z0-9]*:?href>([^<]+)<\/[a-z0-9]*:?href>/i) || [])[1];
    if (!href) continue;
    const isCol = /<[a-z0-9]*:?collection\s*\/?>/i.test(b);
    const size = parseInt((b.match(/<[a-z0-9]*:?getcontentlength>(\d+)<\/[a-z0-9]*:?getcontentlength>/i) || [])[1] || '0', 10);
    const lm = (b.match(/<[a-z0-9]*:?getlastmodified>([^<]+)<\/[a-z0-9]*:?getlastmodified>/i) || [])[1];
    out.push({ pathname: new URL(href, 'http://x').pathname, size, mtime: lm ? Date.parse(lm) : null, type: isCol ? 'dir' : 'file' });
  }
  return out;
}

registerDriver('webdav', (cfg) => new WebdavStorage(cfg));
module.exports = { WebdavStorage, kind: 'storage', lifecycle: 'passive' };
