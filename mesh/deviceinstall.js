'use strict';
/**
 * mesh/deviceinstall.js — generate the commands that put a device on the mesh.
 *
 * This is the reusable form of the steps validated by hand on 2026-10-19, with the lessons baked in
 * so the Portal (or a human) never re-learns them:
 *
 *  • Windows newt MUST run as SYSTEM (elevated). As a normal user the WireGuard adapter is created
 *    but never transmits — the tunnel sits one-way and nothing routes. => a SYSTEM scheduled task.
 *  • A Linux olm client co-resident with its own gerbil needs its OWN interface name (default `olm`
 *    collides with any other Pangolin membership on the host) and `-override-dns=false` (don't seize
 *    host DNS), plus a ts-input ACCEPT punch so Tailscale's input filter doesn't drop its traffic.
 *
 * Returns descriptors, not side effects — the caller prints them, ships them to the Portal, or runs
 * them. Secrets are interpolated by the caller from the vault; never logged here.
 */

const DEFAULT_NEWT_VERSION = process.env.ASMLTR_MESH_NEWT_VERSION || '1.18.1';

/** Windows newt as a persistent SYSTEM scheduled task. `endpoint` = the mesh dashboard origin. */
function newtWindows({ org, id, secret, endpoint, version = DEFAULT_NEWT_VERSION, installDir = 'C:\\Program Files\\newt' }) {
  const task = `newt-${org}-mesh`;
  const exe = `${installDir}\\newt.exe`;
  const log = `${installDir}\\newt.log`;
  const url = `https://github.com/fosrl/newt/releases/download/${version}/newt_windows_amd64.exe`;
  // One self-contained elevated PowerShell block. Run it in an elevated shell (or via the Portal's
  // one-click elevation). Download is done here so there is no separate copy step.
  const powershell = [
    `New-Item -ItemType Directory -Force -Path "${installDir}" | Out-Null`,
    `Invoke-WebRequest -Uri "${url}" -OutFile "${exe}"`,
    `Get-Process newt -ErrorAction SilentlyContinue | Stop-Process -Force`,
    `$a = '/c "\\"${exe}\\" --id ${id} --secret ${secret} --endpoint ${endpoint} --log-level INFO > \\"${log}\\" 2>&1"'`,
    `$act = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $a`,
    `$trg = New-ScheduledTaskTrigger -AtStartup`,
    `$pr  = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest`,
    `Register-ScheduledTask -TaskName "${task}" -Action $act -Trigger $trg -Principal $pr -Force | Out-Null`,
    `Start-ScheduledTask -TaskName "${task}"`,
  ].join('\n');
  return {
    os: 'windows', kind: 'newt', task, exe, version,
    note: 'MUST run elevated — the task runs as SYSTEM so the WireGuard adapter can transmit.',
    powershell,
    uninstall: `Stop-ScheduledTask -TaskName "${task}"; Unregister-ScheduledTask -TaskName "${task}" -Confirm:$false; Get-Process newt -EA SilentlyContinue | Stop-Process -Force`,
  };
}

/** Linux newt (site connector) as a systemd service. `binPath` = installed newt binary. */
function newtLinux({ org, id, secret, endpoint, version = DEFAULT_NEWT_VERSION, binPath = '/opt/newt/bin/newt' }) {
  const unit = `newt-${org}-mesh`;
  const unitPath = `/etc/systemd/system/${unit}.service`;
  const service = [
    '[Unit]',
    `Description=asmltr mesh newt site connector (${org})`,
    'After=network-online.target', 'Wants=network-online.target',
    '', '[Service]', 'Type=simple',
    `ExecStart=${binPath} --id ${id} --secret ${secret} --endpoint ${endpoint} --log-level INFO`,
    'Restart=on-failure', 'RestartSec=5s', 'StandardOutput=journal', 'StandardError=journal',
    '', '[Install]', 'WantedBy=multi-user.target', '',
  ].join('\n');
  const enable = `systemctl daemon-reload && systemctl enable --now ${unit}.service`;
  // One self-contained `sh` installer (served by the enroll/script endpoint to `curl … | sudo sh`):
  // download the newt binary for this arch, write the unit (quoted heredoc ⇒ no $-expansion of the
  // embedded secret), enable it. Idempotent — re-running just re-downloads + re-enables.
  const script = [
    '#!/bin/sh',
    'set -e',
    `BIN="${binPath}"`,
    'mkdir -p "$(dirname "$BIN")"',
    'ARCH="$(uname -m)"; case "$ARCH" in x86_64|amd64) A=amd64;; aarch64|arm64) A=arm64;; *) A=amd64;; esac',
    `curl -fsSL "https://github.com/fosrl/newt/releases/download/${version}/newt_linux_\${A}" -o "$BIN"`,
    'chmod +x "$BIN"',
    `cat > "${unitPath}" <<'ASMLTR_NEWT_UNIT'`,
    service,
    'ASMLTR_NEWT_UNIT',
    `systemctl daemon-reload && systemctl enable --now ${unit}.service`,
    `echo "asmltr: newt site connector '${unit}' installed + started"`,
    '',
  ].join('\n');
  return {
    os: 'linux', kind: 'newt', unit, unitPath, service, version, enable, script,
    uninstall: `systemctl disable --now ${unit}.service; rm -f ${unitPath}; systemctl daemon-reload`,
  };
}

/**
 * macOS newt (site connector) as a launchd SYSTEM daemon — the darwin analogue of newtLinux.
 * A LaunchDaemon (not a LaunchAgent) runs as root at boot with no login session, which is what the
 * WireGuard adapter needs (same reason Windows must run as SYSTEM). `binPath` = installed newt.
 *
 * olm-on-mac is a deliberate follow-up: enrolled workstations join as newt sites, which is all the
 * persistent track needs for SSH/RDP reach. This generator covers newt only.
 */
function newtMacos({ org, id, secret, endpoint, version = DEFAULT_NEWT_VERSION, binPath = '/usr/local/newt/newt' }) {
  const label = `com.asmltr.${org}.newt`;
  const plistPath = `/Library/LaunchDaemons/${label}.plist`;
  const logPath = '/usr/local/newt/newt.log';
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>', `  <string>${label}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${binPath}</string>`,
    '    <string>--id</string>', `    <string>${id}</string>`,
    '    <string>--secret</string>', `    <string>${secret}</string>`,
    '    <string>--endpoint</string>', `    <string>${endpoint}</string>`,
    '    <string>--log-level</string>', '    <string>INFO</string>',
    '  </array>',
    '  <key>RunAtLoad</key>', '  <true/>',
    '  <key>KeepAlive</key>', '  <true/>',
    '  <key>StandardOutPath</key>', `  <string>${logPath}</string>`,
    '  <key>StandardErrorPath</key>', `  <string>${logPath}</string>`,
    '</dict>',
    '</plist>',
  ].join('\n');
  const load = `launchctl bootout system "${plistPath}" 2>/dev/null || true; launchctl bootstrap system "${plistPath}" 2>/dev/null || launchctl load -w "${plistPath}"`;
  const uninstall = `launchctl bootout system "${plistPath}" 2>/dev/null; rm -f "${plistPath}"`;
  // One self-contained `sh` installer (served to `curl … | sudo sh`): download the darwin binary for
  // this arch, write the plist (quoted heredoc ⇒ no $-expansion of the secret), own it root:wheel,
  // (re)load the daemon. Idempotent.
  const script = [
    '#!/bin/sh',
    'set -e',
    `BIN="${binPath}"`,
    'mkdir -p "$(dirname "$BIN")"',
    'ARCH="$(uname -m)"; case "$ARCH" in arm64|aarch64) A=arm64;; x86_64|amd64) A=amd64;; *) A=arm64;; esac',
    `curl -fsSL "https://github.com/fosrl/newt/releases/download/${version}/newt_darwin_\${A}" -o "$BIN"`,
    'chmod +x "$BIN"',
    `cat > "${plistPath}" <<'ASMLTR_NEWT_PLIST'`,
    plist,
    'ASMLTR_NEWT_PLIST',
    `chown root:wheel "${plistPath}"`,
    load,
    `echo "asmltr: newt launchd daemon '${label}' installed + loaded"`,
    '',
  ].join('\n');
  return {
    os: 'macos', kind: 'newt', label, plistPath, logPath, plist, version, script,
    note: 'LaunchDaemon runs as root at boot (no login session) so the WireGuard adapter can transmit.',
    load, uninstall,
  };
}

/**
 * Linux olm (client) as a systemd service — the pattern of the live olm-eve.service.
 * `iface` MUST be unique on the host; `envFile` holds OLM_ID/OLM_SECRET at mode 600.
 */
function olmLinux({ org, id, secret, endpoint, iface, binPath = '/opt/olm/bin/olm', envDir = '/opt/olm/etc', dataDir = '/opt/olm/data' }) {
  const ifn = iface || `olm-${org}`;
  const unit = `olm-${org}-mesh`;
  const envFile = `${envDir}/olm.env`;
  const service = [
    '[Unit]',
    `Description=asmltr mesh olm client (${org}) — reaches enrolled devices`,
    'After=network-online.target docker.service', 'Wants=network-online.target',
    '', '[Service]', 'Type=simple',
    `EnvironmentFile=${envFile}`,
    `Environment=HOME=${dataDir}`,
    // -override-dns=false: never seize host DNS. Unique -interface: never collide with other olm/tailscale.
    `ExecStart=${binPath} -endpoint ${endpoint} -id \${OLM_ID} -secret \${OLM_SECRET} -interface ${ifn} -override-dns=false -log-level INFO`,
    // Punch the olm interface through Tailscale's input filter; non-fatal if ts-input is absent.
    `ExecStartPost=-/bin/sh -c "/usr/sbin/iptables -C ts-input -i ${ifn} -j ACCEPT 2>/dev/null || /usr/sbin/iptables -I ts-input 1 -i ${ifn} -j ACCEPT || true"`,
    'Restart=on-failure', 'RestartSec=5s', 'LimitNOFILE=65536', 'StandardOutput=journal', 'StandardError=journal',
    '', '[Install]', 'WantedBy=multi-user.target', '',
  ].join('\n');
  const envContent = `OLM_ID=${id}\nOLM_SECRET=${secret}\n`;
  return {
    os: 'linux', kind: 'olm', unit, iface: ifn, unitPath: `/etc/systemd/system/${unit}.service`,
    envFile, envContent, service,
    note: 'Agent bash sandboxes block host-netns WireGuard; run via systemd (full privileges), not a bare shell.',
    install: `install -d -m700 ${envDir} ${dataDir}; umask 077; printf '%s' "$ENV" > ${envFile}; systemctl daemon-reload; systemctl enable --now ${unit}.service`,
    uninstall: `systemctl disable --now ${unit}.service; rm -f /etc/systemd/system/${unit}.service ${envFile}; systemctl daemon-reload`,
  };
}

/** Pick the right generator. role 'site'→newt, 'client'→olm. */
function installPlan({ role, os, ...opts }) {
  if (role === 'site' || role === 'newt') {
    if (os === 'windows') return newtWindows(opts);
    if (os === 'macos') return newtMacos(opts);
    return newtLinux(opts);
  }
  if (role === 'client' || role === 'olm') {
    if (os === 'windows') throw new Error('olm-on-windows not supported here; Windows devices enroll as newt sites');
    if (os === 'macos') throw new Error('olm-on-macos not implemented yet; macOS devices enroll as newt sites');
    return olmLinux(opts);
  }
  throw new Error(`installPlan: unknown role '${role}'`);
}

module.exports = { newtWindows, newtLinux, newtMacos, olmLinux, installPlan, DEFAULT_NEWT_VERSION };
