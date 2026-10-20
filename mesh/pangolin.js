'use strict';
/**
 * mesh/pangolin.js — authenticated client for the Pangolin control-plane API.
 *
 * Two non-obvious things this encodes so nobody re-learns them the hard way:
 *  1. Pangolin's CSRF check is a STATIC header value, not a real token:
 *       server.mjs → `if (!csrfToken || csrfToken !== "x-csrf-protection")`.
 *     Every mutating call must carry `x-csrf-token: x-csrf-protection`.
 *  2. A host-mode site-resource only becomes routable if it has a non-empty `alias`:
 *       server.mjs → generateSubnetProxyTargetV2() builds the alias→destination target
 *       `only when siteResource.alias` is set. Empty alias = the resource never enters the
 *       olm client's WireGuard allowedIPs and every packet to it is silently dropped.
 *     addSiteResource() therefore REQUIRES an alias.
 */

const CSRF_HEADER = { 'x-csrf-token': 'x-csrf-protection' };

class PangolinClient {
  constructor({ apiBase, email, password }) {
    if (!apiBase) throw new Error('PangolinClient: apiBase required');
    this.apiBase = apiBase.replace(/\/$/, '');
    this.email = email;
    this.password = password;
    this._cookies = new Map(); // name -> value
  }

  _cookieHeader() {
    return [...this._cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  _absorb(res) {
    const sc = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const line of sc) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this._cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async req(method, path, body) {
    const headers = { 'Content-Type': 'application/json', ...CSRF_HEADER };
    const cookie = this._cookieHeader();
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(this.apiBase + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this._absorb(res);
    let j = {};
    try { j = await res.json(); } catch (_) { /* some ops return empty */ }
    return { ok: res.ok, status: res.status, data: j.data, message: j.message, success: j.success, raw: j };
  }

  async login() {
    const r = await this.req('POST', '/auth/login', { email: this.email, password: this.password });
    // A 2FA-required or wrong-cred response is not ok; surface it clearly.
    if (!r.ok || r.raw.error) throw new Error(`pangolin login failed (${r.status}): ${r.message || JSON.stringify(r.raw)}`);
    return r;
  }

  // --- orgs ------------------------------------------------------------------
  async getOrg(orgId) { return this.req('GET', `/org/${orgId}`); }
  async createOrg({ orgId, name, subnet, utilitySubnet }) {
    return this.req('PUT', '/org', { orgId, name, subnet, utilitySubnet });
  }

  // --- OIDC identity provider (asmltr's own OIDC → mesh SSO) ------------------
  async listIdp() { return this.req('GET', '/idp'); }
  async createOidcIdp(body) { return this.req('PUT', '/idp/oidc', body); }
  async linkIdpToOrg(idpId, orgId, { roleMapping, orgMapping }) {
    return this.req('PUT', `/idp/${idpId}/org/${orgId}`, { roleMapping, orgMapping });
  }

  // --- sites (newt connectors) ----------------------------------------------
  async listSites(orgId) { return this.req('GET', `/org/${orgId}/sites`); }
  async createSite(orgId, { name, type = 'newt' }) {
    return this.req('PUT', `/org/${orgId}/site`, { name, type });
  }

  // --- clients (olm) ---------------------------------------------------------
  async listClients(orgId) { return this.req('GET', `/org/${orgId}/clients`); }
  async pickClientDefaults(orgId) { return this.req('GET', `/org/${orgId}/pick-client-defaults`); }
  async createClient(orgId, { name, olmId, secret, subnet, type = 'olm' }) {
    return this.req('PUT', `/org/${orgId}/client`, { name, olmId, secret, subnet, type });
  }

  // --- site-resources (the private TCP/UDP services a client reaches) --------
  async listSiteResources(orgId) { return this.req('GET', `/org/${orgId}/site-resources`); }
  /**
   * Create a host-mode site-resource. `alias` is MANDATORY (see file header) — a mesh hostname
   * like `yoga-ssh.mesh`. `destination` is the target as seen FROM the site (e.g. 127.0.0.1 for a
   * service on the site node itself). Ports via tcp/udp range strings ('22', '3000-3010', '*').
   */
  async addSiteResource(orgId, { name, alias, siteId, destination = '127.0.0.1', tcp, udp, clientIds = [], enabled = true }) {
    if (!alias) throw new Error('addSiteResource: alias is required (empty alias = resource never routes)');
    const body = {
      name, alias, mode: 'host', siteId, destination,
      tcpPortRangeString: tcp || undefined,
      udpPortRangeString: udp || undefined,
      clientIds, userIds: [], roleIds: [], enabled,
    };
    return this.req('PUT', `/org/${orgId}/site-resource`, body);
  }
  async grantClientToResource(siteResourceId, clientId) {
    return this.req('POST', `/site-resource/${siteResourceId}/clients/add`, { clientId });
  }
  async deleteSiteResource(siteResourceId) { return this.req('DELETE', `/site-resource/${siteResourceId}`); }
}

module.exports = { PangolinClient, CSRF_HEADER };
