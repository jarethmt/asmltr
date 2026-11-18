'use strict';
/**
 * S3-compatible storage driver — AWS S3, Backblaze B2, DigitalOcean Spaces, Cloudflare R2, MinIO.
 * Implements the shared/storage.js contract via the S3 REST API with SigV4 (aws4fetch). Registers as
 * the `s3` storage type. Path-style addressing ({endpoint}/{bucket}/{key}) for max compatibility.
 *
 * config: {
 *   endpoint,           // e.g. https://s3.us-east-1.amazonaws.com | https://s3.us-west-002.backblazeb2.com
 *   region,             // e.g. us-east-1 | us-west-002 | auto (R2)
 *   bucket,
 *   access_key_id, secret_access_key,   // resolved via shared/secrets.js upstream
 *   prefix,             // optional key prefix to confine this backend (e.g. 'asmltr-silos')
 * }
 *
 * mint() → a **presigned URL** for the DATA PLANE: a peer transfers bytes DIRECT to the bucket, owner
 * out of the path. That's the S3-native answer to the control/data-plane split.
 */
const { AwsClient } = require('aws4fetch');
const { registerDriver } = require('../../../shared/storage');

function enc(rel) {
  return String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

class S3Storage {
  constructor({ endpoint, region = 'us-east-1', bucket, access_key_id, secret_access_key, prefix = '' } = {}) {
    if (!endpoint || !bucket) throw new Error('s3: endpoint + bucket required');
    this.endpoint = String(endpoint).replace(/\/+$/, '');
    this.bucket = bucket;
    this.prefix = String(prefix || '').replace(/^\/+|\/+$/g, '');
    this.client = new AwsClient({ accessKeyId: access_key_id, secretAccessKey: secret_access_key, region, service: 's3' });
  }
  _key(rel) { return [this.prefix, rel].filter(Boolean).join('/'); }
  _url(rel) { return `${this.endpoint}/${this.bucket}/${enc(this._key(rel))}`; }

  async put(rel, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const r = await this.client.fetch(this._url(rel), { method: 'PUT', body: buf });
    if (!r.ok) throw new Error(`s3 put ${rel}: HTTP ${r.status}`);
    return { path: String(rel), size: buf.length, etag: r.headers.get('etag') || undefined };
  }
  async get(rel) {
    const r = await this.client.fetch(this._url(rel), { method: 'GET' });
    if (!r.ok) throw new Error(`s3 get ${rel}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  async stat(rel) {
    const r = await this.client.fetch(this._url(rel), { method: 'HEAD' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`s3 head ${rel}: HTTP ${r.status}`);
    return { path: String(rel), size: +(r.headers.get('content-length') || 0), mtime: Date.parse(r.headers.get('last-modified') || '') || null, type: 'file' };
  }
  async list(prefix = '', { recursive = true } = {}) {
    const p = this._key(prefix);
    const params = new URLSearchParams({ 'list-type': '2', prefix: p ? p + '/' : '' });
    if (!recursive) params.set('delimiter', '/');
    const r = await this.client.fetch(`${this.endpoint}/${this.bucket}?${params}`, { method: 'GET' });
    if (!r.ok) throw new Error(`s3 list: HTTP ${r.status}`);
    const xml = await r.text();
    const out = [];
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const b = m[1];
      const key = (b.match(/<Key>([^<]+)<\/Key>/) || [])[1];
      if (!key) continue;
      const rel = key.slice(this.prefix ? this.prefix.length + 1 : 0);
      out.push({ path: rel, size: +((b.match(/<Size>(\d+)<\/Size>/) || [])[1] || 0), mtime: Date.parse((b.match(/<LastModified>([^<]+)<\/LastModified>/) || [])[1] || '') || null, type: 'file' });
    }
    return out;
  }
  async remove(rel) {
    // object store: removing a "dir" = delete every key under the prefix
    const st = await this.stat(rel);
    if (st) { const r = await this.client.fetch(this._url(rel), { method: 'DELETE' }); if (!r.ok && r.status !== 404) throw new Error(`s3 del ${rel}: HTTP ${r.status}`); return; }
    for (const e of await this.list(rel, { recursive: true })) {
      await this.client.fetch(this._url(e.path), { method: 'DELETE' });
    }
  }
  async move(from, to) {
    const copy = await this.client.fetch(this._url(to), { method: 'PUT', headers: { 'x-amz-copy-source': `/${this.bucket}/${enc(this._key(from))}` } });
    if (!copy.ok) throw new Error(`s3 copy ${from}->${to}: HTTP ${copy.status}`);
    await this.remove(from);
  }
  async mkdir() { /* object stores have no directories — no-op */ }
  /** Presigned URL for the data plane. verb: 'GET'|'PUT'; ttl seconds. */
  async mint(rel, { verb = 'GET', ttl = 900 } = {}) {
    const url = `${this._url(rel)}?X-Amz-Expires=${ttl}`;
    const signed = await this.client.sign(url, { method: verb, aws: { signQuery: true } });
    return { url: signed.url, verb, expires_in: ttl };
  }
}

registerDriver('s3', (cfg) => new S3Storage(cfg));
module.exports = { S3Storage, kind: 'storage', lifecycle: 'passive' };
