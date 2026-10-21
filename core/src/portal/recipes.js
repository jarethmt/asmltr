// asmltr Portal — per-OS drive recipes for the generic remote-driver.
//
// Contract: ../../../docs/PORTAL-DRIVE.md (§1 the exec HID keystroke-script format, §3 the per-OS
// recipes, §6a in asmltr-portal/DESIGN.md for the no-install CDC-loop concept).
//
// Driving any computer through a Portal is the same shape on every desktop OS:
//   1. open a shell with a blind HID keystroke script           (terminalOpen → exec:hid mode 0x01)
//   2. type one probe line that finds the dongle's OWN serial    (probe → exec:hid)
//      port BY VID/PID 303A:4002 and writes the marker ASMLTR_OK
//   3. confirm the marker comes back on `ioback`  ⇒ terminal is real + OS is locked in
//   4. type one bootstrap REPL that bridges that serial port ↔   (replBootstrap → exec:hid)
//      the shell; after it runs, commands flow as exec:cdc (mode 0x02) and results on `ioback`
//
// The port is ALWAYS discovered by its USB VID/PID (303A:4002 — Espressif TinyUSB CDC on the
// dongle), NEVER a guessed COM/tty number, because the dongle is one of possibly several serial
// devices on the host and its node name is not predictable.
//
// Every command's output on the return channel is terminated with the sentinel below, so the
// reader (the portal-drive skill) knows when one command's result ends and can frame screenshots
// (which arrive as a base64 blob between two sentinels).
//
// Android is the exception: stock Android has no shell→serial redirect, so there is no CDC bridge.
// Its recipe carries transport:'adb' — HID stays available for blind navigation only.

'use strict';

// USB identity of the dongle's CDC serial interface. Discovery keys off this, never a port name.
const DONGLE_VID = '303A';
const DONGLE_PID = '4002';

// Marker the probe writes to the port; its arrival on `ioback` confirms the terminal + locks the OS.
const PROBE_MARKER = 'ASMLTR_OK';

// End-of-transmission sentinel the REPL appends after each command's combined stdout+stderr.
const EOT = '__ASMLTR_EOT__';

// ---------------------------------------------------------------------------
// Windows — PowerShell. Win+R → powershell → Enter opens the shell. Discovery uses CIM
// Win32_SerialPort filtered on PNPDeviceID (the only place the VID/PID appears); the port is opened
// with System.IO.Ports.SerialPort. The REPL loops ReadLine → Invoke-Expression → write result back.
// ---------------------------------------------------------------------------
const WINDOWS_PROBE =
  "$p=(Get-CimInstance Win32_SerialPort | " +
  `Where-Object { $_.PNPDeviceID -like '*VID_${DONGLE_VID}&PID_${DONGLE_PID}*' } | ` +
  "Select-Object -First 1).DeviceID; " +
  "if($p){ $sp=New-Object System.IO.Ports.SerialPort $p,115200; $sp.Open(); " +
  `$sp.WriteLine('${PROBE_MARKER}'); $sp.Close() }`;

const WINDOWS_REPL =
  "$p=(Get-CimInstance Win32_SerialPort | " +
  `Where-Object { $_.PNPDeviceID -like '*VID_${DONGLE_VID}&PID_${DONGLE_PID}*' } | ` +
  "Select-Object -First 1).DeviceID; " +
  "$sp=New-Object System.IO.Ports.SerialPort $p,115200; $sp.ReadTimeout=-1; $sp.Open(); " +
  "while($sp.IsOpen){ $line=$sp.ReadLine(); " +
  "try{ $out=Invoke-Expression $line 2>&1 | Out-String }catch{ $out=($_ | Out-String) }; " +
  `$sp.Write($out + \"\`n${EOT}\`n\") }`;

// ---------------------------------------------------------------------------
// Linux — Ctrl+Alt+T opens the common terminal. The dongle's CDC node resolves via
// /dev/serial/by-id/* (the by-id symlink carries the VID). stty puts it in raw mode, then a shell
// loop reads a line, eval's it, and writes combined stdout+stderr + the sentinel back to the port.
// (A python3 one-liner reading the tty is an equivalent fallback if the shell loop misbehaves.)
// ---------------------------------------------------------------------------
const LINUX_PORT = "P=$(ls /dev/serial/by-id/*" + DONGLE_VID + "* 2>/dev/null | head -n1)";

const LINUX_PROBE =
  `${LINUX_PORT}; [ -n "$P" ] && printf '${PROBE_MARKER}\\n' > "$P"`;

const LINUX_REPL =
  `${LINUX_PORT}; [ -n "$P" ] && { stty -F "$P" raw -echo 115200 2>/dev/null; ` +
  `while IFS= read -r l < "$P"; do o=$(eval "$l" 2>&1); printf '%s\\n${EOT}\\n' "$o" > "$P"; done; }`;

// ---------------------------------------------------------------------------
// macOS — Cmd+Space (Spotlight) → Terminal → Enter opens the shell. The dongle's CDC ACM node
// enumerates as /dev/cu.usbmodem* (cu.* is the call-out node, correct for writing; tty.usbmodem*
// also exists). VID/PID is 303A:4002 — ioreg can confirm it, but the usbmodem glob is the practical
// resolver. Same shell read/eval/write-back loop as Linux.
// ---------------------------------------------------------------------------
const MACOS_PORT =
  "P=$(ls /dev/cu.usbmodem* /dev/tty.usbmodem* 2>/dev/null | head -n1)";

const MACOS_PROBE =
  `${MACOS_PORT}; [ -n "$P" ] && printf '${PROBE_MARKER}\\n' > "$P"`;

const MACOS_REPL =
  `${MACOS_PORT}; [ -n "$P" ] && { stty -f "$P" raw -echo 115200 2>/dev/null; ` +
  `while IFS= read -r l < "$P"; do o=$(eval "$l" 2>&1); printf '%s\\n${EOT}\\n' "$o" > "$P"; done; }`;

const recipes = {
  windows: {
    os: 'windows',
    transport: 'cdc',
    // Win+R, type powershell, Enter; waits let the Run dialog and the shell actually appear.
    terminalOpen: '{GUI+r}{DELAY:400}powershell{ENTER}{DELAY:900}',
    probe: WINDOWS_PROBE,
    replBootstrap: WINDOWS_REPL,
  },

  macos: {
    os: 'macos',
    transport: 'cdc',
    // Cmd+Space opens Spotlight, type Terminal, Enter; waits cover Spotlight + Terminal launch.
    terminalOpen: '{GUI+SPACE}{DELAY:400}Terminal{ENTER}{DELAY:900}',
    probe: MACOS_PROBE,
    replBootstrap: MACOS_REPL,
  },

  linux: {
    os: 'linux',
    transport: 'cdc',
    // Ctrl+Alt+T is the common terminal bind (best-effort — DE-dependent); wait for the window.
    terminalOpen: '{CTRL+ALT+t}{DELAY:900}',
    probe: LINUX_PROBE,
    replBootstrap: LINUX_REPL,
  },

  android: {
    os: 'android',
    transport: 'adb',
    // No HID shell + no stock shell→serial redirect on Android, so there is no CDC bridge and no
    // terminalOpen/probe/REPL. Driving is over ADB with a consented (RSA-key-authorized) connection;
    // HID remains available ONLY for blind navigation (DESIGN §6a, PORTAL-DRIVE §3).
    terminalOpen: null,
    probe: null,
    replBootstrap: null,
    notes:
      'Android: drive via ADB (consented RSA key), not the CDC loop — stock Android offers no ' +
      'shell→serial redirect. HID is available for blind navigation only; no probe/marker handshake ' +
      'and no serial-bridge REPL. Richer feedback (screen/input) is the ADB path (roadmap R8).',
  },
};

// Normalize common OS aliases (process.platform values, detection strings) to a recipe key.
function normalizeOs(os) {
  const s = String(os || '').toLowerCase();
  if (!s) return null;
  // Order matters: "darwin" contains "win", so test macOS/darwin before Windows.
  if (s.includes('mac') || s.includes('darwin') || s.includes('osx')) return 'macos';
  if (s.includes('android')) return 'android';
  if (s.includes('win')) return 'windows';
  if (s.includes('linux') || s.includes('unix') || s.includes('nix')) return 'linux';
  return recipes[s] ? s : null;
}

// Return the recipe for an OS (accepting aliases), or a sane default (Linux) when unknown — the
// desktop CDC-loop shape is the safest fallback for an unrecognized Unix-like host.
function getRecipe(os) {
  const key = normalizeOs(os);
  return (key && recipes[key]) || recipes.linux;
}

module.exports = {
  recipes,
  getRecipe,
  normalizeOs,
  DONGLE_VID,
  DONGLE_PID,
  PROBE_MARKER,
  EOT,
};
