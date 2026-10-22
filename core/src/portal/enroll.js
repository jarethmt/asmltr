'use strict';
/**
 * asmltr Portal — persistent-enrollment track (PORTAL-DRIVE §4 + §6).
 *
 * The DRIVE track (drive.js + recipes.js) runs a host with NO agent installed, over the dongle. This
 * module is the other half: it JOINS a host onto asmltr's self-hosted mesh so asmltr can reach it by
 * SSH/RDP afterwards — and the reverse, tearing that down cleanly. The installer is just one script
 * that rides the same Portal bridge (typed over HID / written over CDC).
 *
 * Division of labour (important — this file owns NONE of the HTTP wiring):
 *   • server.js (core owner, NOT us) exposes POST /v2/portal/enroll and the GET …/enroll/script
 *     endpoint the host fetches; it calls into the three functions here.
 *   • enroll()    — the asmltr-SIDE steps: mint a short-lived revocable token, register the device +
 *                   ssh/rd transports so it lands in the Fleet, drive `asmltr mesh enroll`/`resource`.
 *   • bootstrapCommand() — the per-OS one-liner the HOST runs to install + join (lives in recipes).
 *   • teardown()  — the reverse: host uninstall one-liner + asmltr-side deregistration.
 *   • victoryLap()— after enroll, SSH back over the mesh and paint SUCCESS on the target's own screen.
 *
 * TWO VALIDATED GOTCHAS baked in (so nobody re-debugs them — see mesh/README.md):
 *   1. A Windows host's newt MUST run as a SYSTEM scheduled task or the WireGuard adapter never
 *      transmits (tunnel sits one-way). The Windows bootstrap therefore targets an elevated shell and
 *      the server-generated script registers a SYSTEM task (mesh/deviceinstall.newtWindows).
 *   2. A host-mode mesh resource MUST carry a non-empty `alias` or it never routes. We always pass a
 *      resource name so the mesh CLI derives `<name>.mesh`; we NEVER create an empty-alias resource.
 *
 * Secrets never transit here in the clear: the per-device newt/olm creds live in the TRUST vault
 * (written by `asmltr mesh enroll`), and the enrollment token is a short-lived, revocable one-time
 * code (devices/enroll.js patterns) — not a credential on its own.
 */

const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const recipes = require('./recipes');
const store = require('../devices/store');
const deviceEnroll = require('../devices/enroll');
const meshIndex = require('../../../mesh'); // enrollSite / ensureHostClient / addResource — structured results
const { meshConfig, nameSlug } = require('../../../mesh/config');
const sshkey = require('../../../mesh/sshkey');

// The olm client the asmltr host itself uses to REACH enrolled devices. One per install; resources
// are granted to it so the host can open the ssh/rd wires. Overridable for multi-host setups.
const HOST_CLIENT_NAME = process.env.ASMLTR_MESH_HOST_CLIENT || 'host';

// The asmltr CLI binary — we shell out to `asmltr mesh …` for the server-side mesh steps (reuses the
// already-shipped, idempotent tooling rather than reimplementing Pangolin calls here).
const CLI_PATH = path.join(__dirname, '..', '..', '..', 'cli', 'asmltr.js');

// Standard transport ports we expose for a workstation. SSH is what the victory lap + ongoing access
// ride; RDP is the screen. Both are registered as device_transports so the device lands in the Fleet.
const SSH_PORT = 22;
const RD_PORT = 3389;

// Short-lived: the token only has to survive the few minutes between minting and the host fetching
// its install script over the bridge.
const TOKEN_TTL_MS = 15 * 60 * 1000;

/** Public base URL the HOST will fetch its install script from (the Portal bridge / core HTTP). */
function portalBaseUrl() {
  const raw =
    process.env.ASMLTR_PORTAL_BASE_URL ||
    process.env.ASMLTR_PUBLIC_URL ||
    process.env.BASE_URL ||
    meshConfig().dashboardUrl ||
    'http://127.0.0.1:3000';
  return String(raw).replace(/\/$/, '');
}

/**
 * bootstrapCommand(os, token, baseUrl) → the single shell line the HOST runs to install + join.
 *
 * Thin by design: it fetches the per-device mesh-client install script (authorized by `token`) from
 * {baseUrl}{ENROLL_SCRIPT_PATH}?os=<os> and runs it. Windows returns an elevated-PowerShell line
 * (the fetched script registers the SYSTEM scheduled task); Linux/macOS return a `curl | sudo sh`.
 * Delegates to the per-OS recipe so the exact shape lives in one place (recipes.js).
 */
function bootstrapCommand(os, token, baseUrl) {
  if (!token) throw new Error('bootstrapCommand: token is required');
  const url = (baseUrl ? String(baseUrl).replace(/\/$/, '') : portalBaseUrl());
  const recipe = recipes.getRecipe(os);
  if (typeof recipe.install !== 'function') {
    throw new Error(`bootstrapCommand: no install recipe for os '${os}'`);
  }
  return recipe.install(token, url);
}

/** Run an `asmltr mesh …` subcommand; resolve {ok,stdout} or {ok:false,error} — never throws. */
async function meshCli(args) {
  try {
    const { stdout } = await execFileP(process.execPath, [CLI_PATH, 'mesh', ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: process.env,
    });
    return { ok: true, stdout: (stdout || '').trim() };
  } catch (e) {
    return { ok: false, error: e.stderr ? String(e.stderr).trim() : e.message };
  }
}

/**
 * enroll({ os, deviceName, deviceId }) → { token, bootstrapCommand, device, mesh }.
 *
 * asmltr-side steps, in order:
 *   1. find/create the device row (platform = normalized OS) — so it shows in the Fleet immediately.
 *   2. register its `ssh` (:22) and `rd` (:3389) transports at their mesh aliases (<slug>-ssh.mesh,
 *      <slug>-rd.mesh) — the addresses asmltr will reach it on once the tunnel is up.
 *   3. mint a short-lived, revocable one-time enrollment token (devices/enroll.js → enrollments).
 *   4. drive `asmltr mesh enroll <device> --os <os>` + `asmltr mesh resource …` for ssh/rd. Tolerant:
 *      if the mesh isn't provisioned the CLI says so and we return mesh.status='not-configured'
 *      rather than failing — the device + token are still valid for a later mesh bring-up.
 */
async function enroll({ os, deviceName, deviceId } = {}) {
  const osKey = recipes.normalizeOs(os) || 'linux';
  const name = deviceName || deviceId;
  if (!name) throw new Error('enroll: deviceName or deviceId is required');
  const slug = nameSlug(name);

  // 1. device row (idempotent — reuse an existing row by id/slug if present).
  let device = (deviceId && store.devices.get(deviceId)) || store.devices.get(slug) || null;
  if (!device) {
    device = store.devices.create({ id: slug, name, kind: 'workstation', platform: osKey });
  } else if (device.platform !== osKey) {
    device = store.devices.update(device.id, { platform: osKey });
  }
  const did = device.id;

  // 2. ssh + rd transports at their mesh aliases. The alias is ALWAYS non-empty (gotcha #2).
  const sshUser = process.env.ASMLTR_PORTAL_SSH_USER || 'root';
  store.transports.upsert(did, {
    transport: 'ssh',
    address: `${slug}-ssh.mesh`,
    params: { port: SSH_PORT, user: sshUser, via: 'mesh' },
  });
  store.transports.upsert(did, {
    transport: 'rd',
    address: `${slug}-rd.mesh`,
    params: { port: RD_PORT, via: 'mesh' },
  });

  // 3. short-lived revocable enrollment token (one-time code, stored hashed — not a credential).
  const minted = deviceEnroll.mintCode(did, 'ssh', TOKEN_TTL_MS);

  // 4. server-side mesh provisioning — a FIRST-CLASS step with a structured, clearly-reported result.
  //    Each sub-step is independently guarded: a mesh failure never undoes the device row + transports
  //    created above (steps 1-2), so the device always lands in the Fleet and the token stays valid for
  //    a later mesh bring-up. `status` is one of: ok | not-configured | degraded.
  const cfg = meshConfig();
  const mesh = {
    configured: !!cfg.enabled,
    status: cfg.enabled ? 'ok' : 'not-configured',
    org: cfg.org || null,
    site: null,      // { name, siteId, created }      — the device's newt site
    client: null,    // { name, clientId, created }    — the asmltr host's olm client (reach)
    resources: [],   // [{ name, alias, port, ok, error? }] — ssh + rd site-resources
    reasons: [],     // human-readable notes / failures
    steps: [],       // back-compat log line per attempt
  };
  if (!cfg.enabled) {
    mesh.reasons.push('ASMLTR_MESH_DASHBOARD_URL unset — device + token still valid for later mesh bring-up');
    mesh.steps.push('skipped: mesh not configured');
  } else {
    // 4a. register the device as a newt SITE (idempotent — reuses an existing site by name).
    try {
      const s = await meshIndex.enrollSite(name);
      mesh.site = { name: s.name, siteId: s.siteId || null, created: !!s.created };
      mesh.steps.push(`site ${s.name}: ${s.created ? 'created' : 'exists'}`);
    } catch (e) {
      mesh.status = 'degraded';
      mesh.reasons.push(`site: ${e.message}`);
      mesh.steps.push(`site ${name}: FAILED (${e.message})`);
    }
    // 4b. ensure the asmltr host's olm CLIENT exists (what reaches the device once the tunnel is up).
    try {
      const c = await meshIndex.ensureHostClient(HOST_CLIENT_NAME);
      mesh.client = { name: c.name, clientId: c.clientId || null, created: !!c.created };
      mesh.steps.push(`host-client ${c.name}: ${c.created ? 'created' : 'exists'}`);
    } catch (e) {
      mesh.status = 'degraded';
      mesh.reasons.push(`host-client: ${e.message}`);
      mesh.steps.push(`host-client ${HOST_CLIENT_NAME}: FAILED (${e.message})`);
    }
    // 4c. expose ssh (:22) + rd (:3389) as host-mode resources, granted to the host client. The
    //     resource name always gives a non-empty alias to derive (gotcha #2). Needs the site.
    if (mesh.site) {
      for (const [rname, port] of [[`${slug}-ssh`, SSH_PORT], [`${slug}-rd`, RD_PORT]]) {
        try {
          const r = await meshIndex.addResource(name, { name: rname, tcp: String(port), clients: [HOST_CLIENT_NAME] });
          mesh.resources.push({ name: rname, alias: (r && r.alias) || `${rname}.mesh`, port, ok: true });
          mesh.steps.push(`resource ${rname}: ok`);
        } catch (e) {
          mesh.status = 'degraded';
          mesh.resources.push({ name: rname, alias: `${rname}.mesh`, port, ok: false, error: e.message });
          mesh.reasons.push(`resource ${rname}: ${e.message}`);
          mesh.steps.push(`resource ${rname}: FAILED (${e.message})`);
        }
      }
    } else {
      mesh.status = 'degraded';
      mesh.reasons.push('resources skipped — site not enrolled');
      mesh.steps.push('resources: skipped (no site)');
    }
  }

  return {
    token: minted.code,
    bootstrapCommand: bootstrapCommand(osKey, minted.code, portalBaseUrl()),
    device: store.devices.get(did),
    mesh,
  };
}

/**
 * teardown({ os, deviceName, deviceId }) → { uninstallCommand, ok, mesh }.
 *
 * The reverse of enroll():
 *   • uninstallCommand — the per-OS host one-liner that stops + removes the newt/olm unit/task and
 *     leaves the mesh (recipes[os].uninstall(org); names match mesh/deviceinstall.js).
 *   • asmltr-side deregistration — revoke the device's credentials/token (fails the hot path closed +
 *     deletes vault material), remove the mesh ssh/rd resources, and drop the ssh/rd transports.
 */
async function teardown({ os, deviceName, deviceId } = {}) {
  const osKey = recipes.normalizeOs(os) || 'linux';
  const name = deviceName || deviceId;
  if (!name) throw new Error('teardown: deviceName or deviceId is required');
  const slug = nameSlug(name);
  const device = (deviceId && store.devices.get(deviceId)) || store.devices.get(slug) || null;
  const did = device ? device.id : (deviceId || slug);

  const cfg = meshConfig();
  const org = cfg.org || 'mesh';

  // Host-side uninstall one-liner (what the Portal types on the target to leave the mesh).
  const recipe = recipes.getRecipe(osKey);
  const uninstallCommand = typeof recipe.uninstall === 'function' ? recipe.uninstall(org) : null;

  const mesh = { status: cfg.enabled ? 'ok' : 'not-configured', steps: [] };

  // asmltr-side: revoke credentials + token (vault delete + hash drop), best-effort.
  let revoked = null;
  try {
    revoked = await deviceEnroll.revoke(did); // whole device: transports revoked, grants + sessions closed
  } catch (e) {
    mesh.steps.push(`revoke: FAILED (${e.message})`);
    mesh.status = 'degraded';
  }

  // Remove the mesh resources (idempotent via the CLI). Only meaningful when the mesh is configured.
  if (cfg.enabled) {
    for (const rname of [`${slug}-ssh`, `${slug}-rd`]) {
      const r = await meshCli(['resource', name, rname, '--remove']);
      // `--remove` may not be a CLI verb in every build; treat a failure as non-fatal + reported.
      mesh.steps.push(r.ok ? `resource ${rname}: removed` : `resource ${rname}: not removed (${r.error})`);
    }
  } else {
    mesh.steps.push('mesh not configured — no resources to remove');
  }

  // Drop the device's ssh/rd transports from the registry so it stops advertising those wires.
  let droppedTransports = 0;
  if (device) {
    for (const t of ['ssh', 'rd']) {
      if (store.transports.remove(did, t)) droppedTransports++;
    }
  }

  return {
    ok: mesh.status !== 'degraded',
    uninstallCommand,
    mesh,
    revoked,
    dropped_transports: droppedTransports,
  };
}

/**
 * ASCII success banner painted on the enrolled host. Deliberately 7-bit-friendly except the ✓ the
 * task asks for (UTF-8; printf passes it through).
 */
function successBanner() {
  return [
    '======================================',
    '          ENROLLED  ✓',
    '            a s m l t r',
    '   this machine is now on the mesh',
    '======================================',
  ].join('\n');
}

/**
 * victoryLap(deviceId) → { ok, method }.
 *
 * After enroll, connect BACK to the just-enrolled host over the mesh and paint SUCCESS on its own
 * screen — the moment that proves the round trip works end to end. Best-effort by design: a freshly
 * joined tunnel may need a few seconds, so a failure here is informational, never fatal to enroll.
 *
 * Method: SSH to the device's `ssh` transport alias using the asmltr host's mesh SSH identity
 * (mesh/sshkey — its PUBLIC key is what Portal provisioning dropped into the target's
 * authorized_keys). The remote command prints the banner to the SSH session AND broadcasts it to any
 * logged-in console (`wall` on Linux/macOS, `msg *` on Windows) so it lands on a screen a human sees.
 *
 * GUI variant (noted, not built): instead of a console banner, push a desktop toast —
 *   Linux: `notify-send`,  macOS: `osascript -e 'display notification …'`,  Windows: a BurntToast /
 *   balloon-tip. That belongs behind the same SSH session once we know the target has a desktop.
 */
async function victoryLap(deviceId) {
  const device = store.devices.get(deviceId);
  if (!device) return { ok: false, method: 'none', reason: 'unknown device' };

  const ssh = (device.transports || []).find((t) => t.transport === 'ssh' && t.enabled);
  if (!ssh || !ssh.address) return { ok: false, method: 'none', reason: 'no ssh transport/alias' };

  const key = sshkey.detect();
  if (!key.exists) {
    // No identity yet ⇒ Portal provisioning never installed a key ⇒ we can't SSH back.
    return { ok: false, method: 'none', reason: 'no mesh ssh identity (run `asmltr mesh sshkey create`)' };
  }

  const user = (ssh.params && ssh.params.user) || process.env.ASMLTR_PORTAL_SSH_USER || 'root';
  const port = (ssh.params && ssh.params.port) || SSH_PORT;
  const banner = successBanner();

  // Remote one-liner: show on this session, then try to broadcast to any console (best-effort).
  const isWindows = recipes.normalizeOs(device.platform) === 'windows';
  const remote = isWindows
    ? `echo(${banner.replace(/\n/g, ' & echo ')} & msg * "ENROLLED - this machine is now on the asmltr mesh" 2>NUL`
    : `printf '%s\\n' "${banner.replace(/"/g, '\\"')}"; ` +
      `command -v wall >/dev/null 2>&1 && printf '%s\\n' "${banner.replace(/"/g, '\\"')}" | wall 2>/dev/null || true`;

  const args = [
    '-i', key.path,
    '-p', String(port),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=8',
    `${user}@${ssh.address}`,
    remote,
  ];

  try {
    await execFileP('ssh', args, { encoding: 'utf8', timeout: 20_000 });
    store.transports.touch(deviceId, 'ssh'); // we just proved the wire works — record last_seen
    return { ok: true, method: 'ssh', address: `${user}@${ssh.address}:${port}` };
  } catch (e) {
    return { ok: false, method: 'ssh', address: `${user}@${ssh.address}:${port}`, reason: e.stderr ? String(e.stderr).trim() : e.message };
  }
}

module.exports = { bootstrapCommand, enroll, teardown, victoryLap, successBanner, portalBaseUrl };
