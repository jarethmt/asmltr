// asmltr mesh <status|provision|enroll|resource|host-client> — the Pangolin networking plane (mesh/).
async function cmdMesh(rest, f) {
  try { require('../shared/loadenv'); } catch (_) {}
  const mesh = require('../mesh');
  const di = require('../mesh/deviceinstall');
  const verb = rest[0] || 'status';
  const pos = rest.slice(1).filter((a) => !a.startsWith('-'));
  const log = (m) => console.log(A.dim(m));
  const dot = (on) => (on ? A.grn('●') : A.dim('○'));
  switch (verb) {
    case 'status': {
      const s = await mesh.status();
      if (!s.enabled) return console.log(A.yel('mesh not configured — set ASMLTR_MESH_DASHBOARD_URL'));
      console.log(A.bold('mesh ') + A.dim(s.dashboardUrl) + A.dim(`  org=${s.org} subnet=${s.subnet}`));
      console.log(A.bold('  sites:     ') + (s.sites.map((x) => x.name + dot(x.online)).join('  ') || A.dim('(none)')));
      console.log(A.bold('  clients:   ') + (s.clients.map((x) => x.name + dot(x.online)).join('  ') || A.dim('(none)')));
      console.log(A.bold('  resources: ') + (s.resources.map((r) => `${r.name}${A.dim(' ' + r.alias + '→' + r.dest + ':' + (r.tcp || ''))}`).join('  ') || A.dim('(none)')));
      const key = require('../mesh/sshkey').detect();
      console.log(A.bold('  ssh key:   ') + (key.exists ? A.dim(key.fingerprint || key.path) : A.yel('none — `asmltr mesh sshkey create`')));
      return;
    }
    case 'provision': {
      const r = await mesh.provision({ log });
      console.log(r.skipped ? A.yel('· mesh not configured — skipped') : A.grn('✓ provisioned') + A.dim(` (admin=${r.adminChanged} org=${r.orgChanged} oidc=${r.oidcChanged})`));
      if (r.oidcChanged) console.log(A.yel('  ⚠ restart asmltr-core so the new OIDC client loads before first SSO login'));
      return;
    }
    case 'host-client': {
      const r = await mesh.ensureHostClient(pos[0] || 'host', { log });
      console.log(A.grn(`✓ host client '${r.name}'`) + A.dim(` (id ${r.clientId}${r.created ? ', created' : ''})`));
      return;
    }
    case 'enroll': {
      const device = pos[0];
      if (!device) return console.log('usage: asmltr mesh enroll <device> [--os windows|linux]');
      const site = await mesh.enrollSite(device, { log });
      const osk = (f.os || 'linux').toLowerCase();
      const cfg = mesh.meshConfig();
      const plan = di.installPlan({ role: 'site', os: osk, org: cfg.org, id: site.newtId || '<newt-id — see vault>', secret: site.newtSecret || '<newt-secret — see vault>', endpoint: cfg.dashboardUrl });
      console.log(A.grn(`✓ site '${site.name}' enrolled`) + A.dim(` (id ${site.siteId}${site.created ? ', created' : ', existing'})`));
      console.log(A.bold(`\nRun on the ${osk} device${osk === 'windows' ? ' (elevated — runs as SYSTEM):' : ':'}`));
      console.log(osk === 'windows' ? plan.powershell : (plan.service + '\n\n' + A.dim('# ' + plan.enable)));
      return;
    }
    case 'resource': {
      const [device, name] = pos;
      if (!device || !name || (!f.tcp && !f.udp)) return console.log('usage: asmltr mesh resource <device> <name> --tcp <ports>|--udp <ports> [--to <dest>] [--client <name>]');
      const clients = f.client ? (Array.isArray(f.client) ? f.client : [f.client]) : [];
      const r = await mesh.addResource(device, { name, tcp: f.tcp, udp: f.udp, destination: f.to || '127.0.0.1', clients, log });
      console.log(A.grn(`✓ resource '${name}'`) + A.dim(` alias ${r.alias} (${r.aliasAddress}) → ${r.destination}`));
      return;
    }
    case 'sshkey': {
      const sshkey = require('../mesh/sshkey');
      const sub = pos[0] || 'status';
      if (sub === 'create') {
        const r = sshkey.ensure({ create: true });
        if (r.created) { console.log(A.grn('✓ created mesh SSH identity') + A.dim(` ${r.path}`)); }
        else console.log(A.yel('· identity already present') + A.dim(` ${r.path}`));
        console.log(A.dim('  ' + (r.fingerprint || '')) + '\n  ' + r.publicKey);
        return;
      }
      const d = sshkey.detect();
      if (!d.exists) {
        console.log(A.yel('✗ no mesh SSH identity found') + A.dim(` (looked for ${d.suggestedPath} …)`));
        console.log(A.dim('  Portal provisioning installs this key on targets so asmltr can SSH in.'));
        console.log('  run ' + A.bold('asmltr mesh sshkey create') + ' to generate one.');
        return;
      }
      console.log(A.grn('✓ mesh SSH identity') + A.dim(` ${d.path}`));
      console.log(A.dim('  ' + (d.fingerprint || '')));
      console.log('  ' + d.publicKey);
      return;
    }
    default:
      console.log('asmltr mesh <status|provision|enroll <device> [--os ...]|resource <device> <name> --tcp N [--to dest] [--client c]|sshkey [status|create]|host-client [name]>');
  }
}

// asmltr vault <status|unseal|seal|init> — TRUST vault bootstrap + passphrase-unseal (shared/vault.js).
// --- asmltr device: the machines asmltr drives (docs/DEVICE-REGISTRY.md) -------------------------
