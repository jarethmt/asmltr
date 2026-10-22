'use strict';
/**
 * mesh/index.js — asmltr's networking-plane provisioning + enrollment.
 *
 * Turns the hand-run flow (validated live 2026-10-19) into reusable, idempotent operations:
 *   provision()       one-time control-plane bootstrap: server admin → TRUST vault, org, asmltr-OIDC
 *                     IdP linked with an Admin role-mapping (SSO login = Admin), all skip-if-exists.
 *   ensureHostClient()the olm client the asmltr host itself uses to REACH enrolled devices.
 *   enrollSite()      register a device as a newt site; stash its newt creds in the vault.
 *   addResource()     expose a private TCP/UDP service on a site (alias ALWAYS set — see pangolin.js).
 *   status()          summary of the live mesh.
 *
 * Secrets go through shared/vault.js (SACRED). Nothing here hardcodes a host path, domain, or the
 * assistant's name — all of it resolves from mesh/config.js (env).
 */

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { meshConfig, vaultKeys, slug, nameSlug } = require('./config');
const { PangolinClient } = require('./pangolin');
const vault = require('../shared/vault');

const IDP_NAME = process.env.ASMLTR_MESH_IDP_NAME || 'asmltr'; // the asmltr OIDC provider, product-named

function randPassword() {
  return crypto.randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 28);
}
function randId(n = 15) {
  return crypto.randomBytes(16).toString('base64').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, n);
}
function randSecret(n = 48) {
  return crypto.randomBytes(48).toString('base64').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, n);
}
function pangctl(container, args) {
  return execFileSync('docker', ['exec', container, 'pangctl', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
async function vaultGet(key) {
  try { const s = await vault.getSecret(key); return s && s.value ? s.value : null; } catch (_) { return null; }
}
async function vaultPut(key, value) {
  await vault.storeSecret(key, { value }, { minTrust: 'SACRED' });
}
const noop = () => {};

/** Login as the mesh admin (creds from vault). Throws if admin not provisioned yet. */
async function adminClient(cfg, keys) {
  const email = await vaultGet(keys.adminEmail);
  const password = await vaultGet(keys.adminPassword);
  if (!email || !password) throw new Error('mesh admin not provisioned (run `asmltr mesh provision`)');
  const pg = new PangolinClient({ apiBase: cfg.apiBase, email, password });
  await pg.login();
  return pg;
}

// --- provision() sub-steps ---------------------------------------------------

async function ensureAdmin(cfg, keys, { container, log }) {
  const email = await vaultGet(keys.adminEmail);
  const password = await vaultGet(keys.adminPassword);
  if (email && password) {
    try { await new PangolinClient({ apiBase: cfg.apiBase, email, password }).login(); log('· admin: present + login ok'); return false; }
    catch (_) { log('· admin: vault creds present but login failed — resetting'); }
  }
  const em = email || cfg.adminEmail;
  const pw = randPassword();
  if (!em) throw new Error('cannot provision admin: no ASMLTR_MESH_BASE_DOMAIN (need admin@<domain>)');
  pangctl(container, ['set-admin-credentials', '--email', em, '--password', pw]);
  await vaultPut(keys.adminEmail, em);
  await vaultPut(keys.adminPassword, pw);
  log(`✓ admin set: ${em} (pw → vault ${keys.adminPassword})`);
  return true;
}

async function ensureOrg(pg, cfg, { log }) {
  const r = await pg.getOrg(cfg.org);
  if (r.ok && r.data) { log(`· org: ${cfg.org} exists`); return false; }
  const c = await pg.createOrg({ orgId: cfg.org, name: cfg.orgName, subnet: cfg.subnet, utilitySubnet: cfg.utilitySubnet });
  if (!c.ok) throw new Error('createOrg failed: ' + (c.message || c.status));
  log(`✓ org: ${cfg.org} created (subnet ${cfg.subnet}, utility ${cfg.utilitySubnet})`);
  return true;
}

async function ensureOidc(pg, cfg, keys, { log }) {
  const list = await pg.listIdp();
  const idps = (list.data && (list.data.idps || list.data.idpList || list.data)) || [];
  const existing = Array.isArray(idps) ? idps.find((i) => i.name === IDP_NAME) : null;
  if (existing) { log(`· oidc: IdP '${IDP_NAME}' exists (idpId=${existing.idpId}) — linking ensured below`);
    await pg.linkIdpToOrg(existing.idpId, cfg.org, { roleMapping: 'Admin', orgMapping: cfg.org });
    return false;
  }
  if (!cfg.oidcAuthOrigin) throw new Error('cannot provision OIDC: ASMLTR_AUTH_ORIGIN not set (asmltr OIDC provider)');
  const issuer = cfg.oidcIssuer || (cfg.oidcAuthOrigin + '/oidc');

  // 1. Create the Pangolin IdP first (placeholder creds) to learn its idpId for the callback URL.
  const ph = { name: IDP_NAME, clientId: 'pending', clientSecret: 'pending',
    authUrl: issuer + '/auth', tokenUrl: issuer + '/token',
    identifierPath: 'sub', emailPath: '', namePath: 'preferred_username',
    scopes: 'openid profile', autoProvision: true, variant: 'oidc' };
  const created = await pg.createOidcIdp(ph);
  if (!created.ok) throw new Error('createOidcIdp failed: ' + (created.message || created.status));
  const idpId = created.data && (created.data.idpId || created.data.id);
  if (!idpId) throw new Error('createOidcIdp: no idpId in response');

  // 2. Register an OIDC client in asmltr's own provider with the real callback URLs.
  const oidc = require('../core/src/oidc');
  const redirect_uris = [
    `${cfg.dashboardUrl}/api/v1/auth/idp/${idpId}/oidc/callback`,
    `${cfg.dashboardUrl}/auth/idp/${idpId}/oidc/callback`,
  ];
  const client = oidc.addClient({ client_name: `mesh-${cfg.org}`, redirect_uris });

  // 3. Point the Pangolin IdP at the real client creds, 4. link to org with Admin mapping.
  await pg.req('POST', `/idp/${idpId}/oidc`, { ...ph, clientId: client.client_id, clientSecret: client.client_secret });
  await pg.linkIdpToOrg(idpId, cfg.org, { roleMapping: 'Admin', orgMapping: cfg.org });
  await vaultPut(keys.oidcClientId, client.client_id);
  await vaultPut(keys.oidcClientSecret, client.client_secret);
  log(`✓ oidc: IdP '${IDP_NAME}' (idpId=${idpId}) created + linked to org '${cfg.org}' as Admin`);
  log('  ⚠ asmltr core restart needed for the new OIDC client to load before first SSO login');
  return true;
}

// --- public API --------------------------------------------------------------

async function provision({ log = noop } = {}) {
  const cfg = meshConfig();
  if (!cfg.enabled) { log('· mesh not configured (ASMLTR_MESH_DASHBOARD_URL unset) — skip'); return { skipped: true }; }
  const keys = vaultKeys(cfg);
  log(`mesh provision → ${cfg.dashboardUrl} (org ${cfg.org})`);
  const adminChanged = await ensureAdmin(cfg, keys, { container: cfg.pangolinContainer, log });
  const pg = await adminClient(cfg, keys);
  const orgChanged = await ensureOrg(pg, cfg, { log });
  const oidcChanged = await ensureOidc(pg, cfg, keys, { log });
  return { skipped: false, adminChanged, orgChanged, oidcChanged };
}

/** The olm client the asmltr host uses to reach enrolled devices. Idempotent; creds → vault. */
async function ensureHostClient(device, { log = noop } = {}) {
  const cfg = meshConfig();
  const keys = vaultKeys(cfg);
  const name = nameSlug(device) || 'host';
  const pg = await adminClient(cfg, keys);
  const list = await pg.listClients(cfg.org);
  const clients = (list.data && (list.data.clients || list.data)) || [];
  const found = Array.isArray(clients) ? clients.find((c) => c.name === name) : null;
  if (found) { log(`· client '${name}' exists (id ${found.clientId})`); return { clientId: found.clientId, name, created: false }; }
  const defaults = await pg.pickClientDefaults(cfg.org);
  const d = defaults.data || {};
  const olmId = d.olmId || randId();
  const olmSecret = d.olmSecret || randSecret();
  // defaults may suggest the exit-node address (collision) — never reuse 10.200.0.1; let Pangolin assign.
  const r = await pg.createClient(cfg.org, { name, olmId, secret: olmSecret, subnet: d.subnet, type: 'olm' });
  if (!r.ok) throw new Error('createClient failed: ' + (r.message || r.status));
  await vaultPut(keys.olmId(name), olmId);
  await vaultPut(keys.olmSecret(name), olmSecret);
  log(`✓ client '${name}' created (id ${r.data.clientId}); olm creds → vault`);
  return { clientId: r.data.clientId, name, olmId, olmSecret, created: true };
}

/** Register a device as a newt site. Returns newt creds (also stashed in the vault). */
async function enrollSite(device, { log = noop } = {}) {
  const cfg = meshConfig();
  const keys = vaultKeys(cfg);
  const name = nameSlug(device);
  if (!name) throw new Error('enrollSite: device name required');
  const pg = await adminClient(cfg, keys);
  const existingList = await pg.listSites(cfg.org);
  const sites = (existingList.data && (existingList.data.sites || existingList.data)) || [];
  const found = Array.isArray(sites) ? sites.find((s) => s.name === name) : null;
  if (found) { log(`· site '${name}' already enrolled (id ${found.siteId})`); return { siteId: found.siteId, name, created: false }; }
  const r = await pg.createSite(cfg.org, { name, type: 'newt' });
  if (!r.ok) throw new Error('createSite failed: ' + (r.message || r.status));
  const d = r.data || {};
  const newtId = d.newtId || d.nt || null;
  const newtSecret = d.secret || d.newtSecret || null;
  if (newtId) await vaultPut(keys.newtId(name), newtId);
  if (newtSecret) await vaultPut(keys.newtSecret(name), newtSecret);
  log(`✓ site '${name}' enrolled (id ${d.siteId}); newt creds → vault`);
  return { siteId: d.siteId, name, newtId, newtSecret, created: true };
}

/**
 * Expose a private service on a site as a host-mode site-resource, granted to clients.
 * alias is auto-derived (`<name>.mesh`) if not given — NEVER empty (empty alias = no routing).
 */
async function addResource(device, { name, tcp, udp, destination = '127.0.0.1', clients = [], alias, log = noop }) {
  const cfg = meshConfig();
  const keys = vaultKeys(cfg);
  const siteName = nameSlug(device);
  const rname = name || `${siteName}-svc`;
  const pg = await adminClient(cfg, keys);
  const sites = ((await pg.listSites(cfg.org)).data || {});
  const siteArr = sites.sites || sites || [];
  const site = Array.isArray(siteArr) ? siteArr.find((s) => s.name === siteName) : null;
  if (!site) throw new Error(`addResource: site '${siteName}' not enrolled`);
  // resolve client names → ids
  const clist = ((await pg.listClients(cfg.org)).data || {});
  const carr = clist.clients || clist || [];
  const clientIds = (clients.length ? clients : [])
    .map((cn) => (Array.isArray(carr) ? carr.find((c) => c.name === nameSlug(cn)) : null))
    .filter(Boolean).map((c) => c.clientId);
  const r = await pg.addSiteResource(cfg.org, {
    name: rname, alias: alias || `${rname}.mesh`, siteId: site.siteId,
    destination, tcp, udp, clientIds, enabled: true,
  });
  if (!r.ok) throw new Error('addSiteResource failed: ' + (r.message || r.status));
  log(`✓ resource '${rname}' (${alias || rname + '.mesh'} → ${destination}:${tcp || udp}) on site '${siteName}', granted ${clientIds.length} client(s)`);
  return r.data;
}

/**
 * Provision a free-standing Portal dongle onto the mesh as its own olm client (idempotent).
 *
 * A dongle is a first-class mesh node, independent of whatever host it later drives: this mints
 * it an olm identity (olmId/secret) that its firmware's esp_olm client authenticates with. The
 * WireGuard keypair is generated ON the dongle (olm registers the public key), so it is NOT part
 * of the returned bundle — only the auth creds + where to reach the server are.
 *
 * Returns the exact config the firmware expects in its NVS "portal" namespace:
 *   { olm_server, olm_id, olm_secret, olm_org }  (+ clientId for bookkeeping)
 * which the dashboard/app writes over BLE at pair time (the "buy a board → flash → enroll" flow).
 */
async function provisionDongle(name, { log = noop } = {}) {
  const cfg = meshConfig();
  if (!cfg.enabled) throw new Error('mesh not configured (set ASMLTR_MESH_DASHBOARD_URL)');
  const keys = vaultKeys(cfg);
  const slug = nameSlug(name);
  if (!slug) throw new Error('provisionDongle: name required');
  const pg = await adminClient(cfg, keys);

  const list = await pg.listClients(cfg.org);
  const clients = (list.data && (list.data.clients || list.data)) || [];
  const found = Array.isArray(clients) ? clients.find((c) => c.name === slug) : null;

  let olmId, olmSecret, clientId;
  if (found) {
    clientId = found.clientId;
    olmId = await vaultGet(keys.olmId(slug));
    olmSecret = await vaultGet(keys.olmSecret(slug));
    if (!olmId || !olmSecret) {
      throw new Error(`dongle '${slug}' exists in Pangolin but its creds are not in the vault — `
        + `delete the client in Pangolin and re-provision, or restore the vault entry`);
    }
    log(`· dongle '${slug}' already provisioned (clientId ${clientId})`);
  } else {
    const defaults = await pg.pickClientDefaults(cfg.org);
    const d = defaults.data || {};
    olmId = d.olmId || randId();
    olmSecret = d.olmSecret || randSecret();
    // never reuse the exit node's .1 — let Pangolin assign the client subnet
    const r = await pg.createClient(cfg.org, { name: slug, olmId, secret: olmSecret, subnet: d.subnet, type: 'olm' });
    if (!r.ok) throw new Error('createClient failed: ' + (r.message || r.status));
    clientId = r.data.clientId;
    await vaultPut(keys.olmId(slug), olmId);
    await vaultPut(keys.olmSecret(slug), olmSecret);
    log(`✓ dongle '${slug}' olm client created (clientId ${clientId}); creds → vault`);
  }

  return {
    name: slug,
    clientId,
    olm_server: cfg.dashboardUrl,
    olm_id: olmId,
    olm_secret: olmSecret,
    olm_org: cfg.org,
  };
}

async function status({ log = noop } = {}) {
  const cfg = meshConfig();
  if (!cfg.enabled) return { enabled: false };
  const keys = vaultKeys(cfg);
  const pg = await adminClient(cfg, keys);
  const sites = (((await pg.listSites(cfg.org)).data || {}).sites) || [];
  const clients = (((await pg.listClients(cfg.org)).data || {}).clients) || [];
  const resources = (((await pg.listSiteResources(cfg.org)).data || {}).siteResources) || [];
  return {
    enabled: true, dashboardUrl: cfg.dashboardUrl, org: cfg.org, subnet: cfg.subnet,
    sites: sites.map((s) => ({ name: s.name, online: s.online })),
    clients: clients.map((c) => ({ name: c.name, online: c.online })),
    resources: resources.map((r) => ({ name: r.name, alias: r.alias, dest: r.destination, tcp: r.tcpPortRangeString, udp: r.udpPortRangeString })),
  };
}

module.exports = { provision, ensureHostClient, enrollSite, addResource, provisionDongle, status, meshConfig };
