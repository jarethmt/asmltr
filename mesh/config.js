'use strict';
/**
 * mesh/config.js — resolve the Pangolin networking-plane config from env.
 *
 * The mesh is asmltr's self-hosted networking plane (Pangolin control plane + gerbil WireGuard +
 * olm/newt clients). One mesh per install. Everything here comes from env with portable defaults —
 * no host paths, no hardcoded domains, no assistant name baked into strings (CLAUDE.md conventions).
 *
 * Required to be "enabled": ASMLTR_MESH_DASHBOARD_URL (the Pangolin control-plane origin).
 * Admin credentials never live in env — they are provisioned into the TRUST vault during setup
 * (see mesh/index.js provision()) under the keys from vaultKeys() below.
 */

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
}

/** Device/client/site/resource name: lowercase, hyphens kept (e.g. "eve-host", "yoga-ssh"). */
function nameSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

/** Derive a /24 utility subnet that won't overlap the org subnet: base octets [a,b,c,d] → a.(b+1).0.0/24. */
function deriveUtilitySubnet(subnet) {
  const base = String(subnet).split('/')[0].split('.').map(Number);
  if (base.length !== 4 || base.some((n) => Number.isNaN(n))) return '10.201.0.0/24';
  return `${base[0]}.${(base[1] + 1) & 0xff}.0.0/24`;
}

function meshConfig(env = process.env) {
  const assistant = slug(env.ASSISTANT_NAME) || 'assistant';
  const dashboardUrl = (env.ASMLTR_MESH_DASHBOARD_URL || '').replace(/\/$/, '');
  const baseDomain = env.ASMLTR_MESH_BASE_DOMAIN || '';
  const org = slug(env.ASMLTR_MESH_ORG) || assistant;
  const subnet = env.ASMLTR_MESH_SUBNET || '10.200.0.0/20';
  // The "utility" subnet is a SEPARATE range Pangolin assigns resource-alias addresses from
  // (e.g. a host-resource's aliasAddress). Must not overlap `subnet`. Default: bump the 2nd octet
  // of the subnet base by one, as a /24 (10.200.0.0/20 → 10.201.0.0/24, matching the live deploy).
  const utilitySubnet = env.ASMLTR_MESH_UTILITY_SUBNET || deriveUtilitySubnet(subnet);
  // Admin account always follows admin@<base-domain> (CLAUDE.md: owner wants this format), random pw.
  const adminEmail = env.ASMLTR_MESH_ADMIN_EMAIL || (baseDomain ? `admin@${baseDomain}` : '');

  return {
    enabled: !!dashboardUrl,
    dashboardUrl,
    apiBase: dashboardUrl ? dashboardUrl + '/api/v1' : '',
    baseDomain,
    org,
    orgName: env.ASMLTR_MESH_ORG_NAME || (assistant ? assistant[0].toUpperCase() + assistant.slice(1) : 'Mesh'),
    subnet,
    utilitySubnet,
    adminEmail,
    pangolinContainer: env.ASMLTR_MESH_PANGOLIN_CONTAINER || 'pangolin',
    // asmltr's own OIDC provider — the IdP the mesh dashboard logs in against (SSO → Admin).
    oidcIssuer: env.ASMLTR_OIDC_ISSUER || (env.ASMLTR_AUTH_ORIGIN ? env.ASMLTR_AUTH_ORIGIN.replace(/\/$/, '') + '/oidc' : ''),
    oidcAuthOrigin: (env.ASMLTR_AUTH_ORIGIN || '').replace(/\/$/, ''),
  };
}

/** Vault key names for this mesh's secrets. Scoped by org so multiple installs never collide. */
function vaultKeys(cfg) {
  const o = cfg.org;
  return {
    adminEmail: `pangolin_${o}_admin_email`,
    adminPassword: `pangolin_${o}_admin_password`,
    oidcClientId: `pangolin_${o}_oidc_client_id`,
    oidcClientSecret: `pangolin_${o}_oidc_client_secret`,
    // per-device creds use `pangolin_${o}_<device>_newt_id` / `_secret`, `_olm_id` / `_secret`
    newtId: (device) => `pangolin_${o}_${nameSlug(device)}_newt_id`,
    newtSecret: (device) => `pangolin_${o}_${nameSlug(device)}_newt_secret`,
    olmId: (device) => `pangolin_${o}_${nameSlug(device)}_olm_id`,
    olmSecret: (device) => `pangolin_${o}_${nameSlug(device)}_olm_secret`,
  };
}

module.exports = { meshConfig, vaultKeys, slug, nameSlug, deriveUtilitySubnet };
