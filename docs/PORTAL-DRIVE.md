# Portal drive — the generic remote-driver contract

The wire contract for driving any computer through a Portal (DESIGN §6a in the asmltr-portal repo).
Everything below is the **interface** each layer implements against — change it here first.

```
Eve ── asmltr core ── (device-gw relay) ── phone app ── BLE ── Portal dongle ── HID/CDC ── host
```

The dongle is a composite USB **HID keyboard+mouse + CDC serial**. Eve drives the host by (a) typing
via HID and (b) reading the host's output back through the dongle's own CDC — no agent installed.

## 1. BLE GATT (firmware implements; app uses)

Existing service `00657665-5f61-736d-6c74-72706f72` + a last byte:

| byte | name | ops | payload |
|------|------|-----|---------|
| `08` | **exec** | WRITE (chunked, load-style `[flags][rsvd][seqBE]` header) | reassembled payload = `[u8 mode][data…]`; mode `0x01` = type `data` as HID keystrokes, `0x02` = write `data` to the host over CDC-TX |
| `09` | **ioback** | NOTIFY | raw bytes the host wrote to the dongle's CDC (the return stream), MTU-chunked |

UUIDs: `exec` = `…727408`, `ioback` = `…727409`. The dongle also keeps the existing
`info/load/run/status/pair` chars; `exec`/`ioback` are the generic-driver additions.

### exec `mode 0x01` (HID) keystroke-script format

`data` is a UTF-8 **keystroke script**, not raw ASCII — literal text types as-is, and `{…}` tokens are
special keys / combos / delays, so recipes can open terminals:

- Literals: `powershell` → types those chars.
- Keys: `{ENTER}` `{TAB}` `{ESC}` `{SPACE}` `{BKSP}`
- Combos: `{GUI+r}` (Win/Cmd+R) `{CTRL+ALT+t}` `{GUI}` `{CTRL+c}` — `GUI`=Windows/Command key.
- Timing: `{DELAY:500}` (ms) — wait between steps (needed after opening a dialog).

Example (open PowerShell on Windows): `{GUI+r}{DELAY:400}powershell{ENTER}{DELAY:800}`.
The firmware parses this → HID reports. `mode 0x02` (CDC) `data` is written to the host verbatim.

## 2. Relay message shape (core ↔ app, over the device-gateway)

- **Server → app:** `{ "type": "portal.exec", "mode": "hid"|"cdc", "data": "<base64>" }`
  → app writes `[mode][data]` to the `exec` characteristic (chunking as needed).
- **App → server:** `{ "type": "portal.io", "data": "<base64>" }` — the drained `ioback` stream.
- **App → server (presence):** `{ "type": "portal.present", "paired": bool, "name": "asmltr-portal-…", "host_os": "…" }`
  answered on demand (also the vault-kill-switch presence check).

The app **auto-connects** to a paired Portal in the background (battery-cheap, DESIGN §5) and relays
both directions. A **Portal console** view shows the live `ioback` stream and can send a manual command.

## 3. The session bridge + per-OS recipes (skill)

Driving a host is: open a terminal (blind HID) → confirm via a CDC marker → start a serial-bridge REPL
→ stream commands over CDC. Each OS supplies a recipe `{ terminalOpen, probe, replBootstrap }`:

- `terminalOpen` — HID keystrokes to reach a shell. Windows: `GUI+r`, `powershell`, `Enter`.
  macOS: `GUI+Space`, `Terminal`, `Enter`. Linux: `Ctrl+Alt+T` (best-effort). Android: the **ADB** path
  (not HID-shell — see below).
- `probe` — a one-liner that finds the dongle's serial port **by VID/PID `303A:4002`** (never a guessed
  COM) and writes a known marker to it. Marker returns via `ioback` ⇒ terminal confirmed + OS locked in
  (refines `usb_host_os_set`).
- `replBootstrap` — a short line that bridges the dongle's serial ↔ the shell (reads commands from the
  port, writes stdout/stderr back). After it runs, commands flow as `exec:cdc` and results as `ioback`;
  no more blind typing. A screenshot is just a `replBootstrap` command that captures → downscales → JPEG
  → writes bytes to the port (few-second snapshot over BLE; text is instant).

**Android** has no stock shell→serial redirect, so its recipe uses **ADB** (consented RSA key), not the
CDC bridge; HID stays available for blind navigation. The recipe object marks `transport: "adb"`.

These recipes + the drive procedure live in a **core asmltr skill** (`portal-drive`) so every asmltr
instance knows how to use a Portal to drive a device.

## 4. Enrollment (persistent track)

`POST /v2/portal/enroll` mints a short-lived, revocable token and returns the per-OS bootstrap one-liner
that wraps `asmltr mesh enroll` (the already-shipped tooling). The enroll runs **over the bridge**
(exec:hid to open a shell → run the one-liner), installs the mesh client (Windows newt as SYSTEM; the
alias/SYSTEM gotchas are encoded in `mesh/`), **registers the device + `ssh`/`rd` transports** so it
lands in the Fleet, then the **victory lap**: a session connects back over the mesh and paints SUCCESS
on the target's own screen (GUI or console ASCII). The installer is just one script riding the bridge.

## 5. Safety

Driving is remote keyboard control of an arbitrary machine → the trust gate is non-negotiable: the
Portal runs modules/commands only from its **paired** instance, one up-front consent per drive session,
and the **vault-kill-switch** (unplug the Portal → Eve can't use dongle-only credentials) is the physical
counterweight. Never bypass OS elevation (UAC/sudo) — assisted, consented provisioning only.

## 6. Install / uninstall (persistent track)

The DRIVE track (§3) runs a host with no agent over the dongle. The **persistent track**
(`core/src/portal/enroll.js`) is the other half: it JOINS a host onto asmltr's self-hosted mesh so
asmltr can reach it by SSH/RDP afterwards — and tears that down cleanly. The installer is just one
script riding the same bridge (§2): `exec:hid` to open a shell, then the one-liner below.

**Ownership:** `enroll.js` owns only the *logic*. `core/src/server.js` (core owner, NOT this module)
wires `POST /v2/portal/enroll` and the script-serving endpoint. The per-OS install/uninstall
one-liners live in `recipes.js` (`recipe.install(token, baseUrl)` / `recipe.uninstall(org)`) so the
shapes stay in one place.

### enroll({ os, deviceName, deviceId })
asmltr-SIDE steps, in order:
1. find/create the device row (`devices/store.js`), platform = normalized OS — it lands in the Fleet
   immediately.
2. register `ssh` (:22) and `rd` (:3389) transports at their mesh aliases `<slug>-ssh.mesh` /
   `<slug>-rd.mesh` — the addresses asmltr reaches it on once the tunnel is up.
3. mint a **short-lived, revocable one-time token** (`devices/enroll.js` → `enrollments`, 15 min). The
   token is not a credential — it only authorizes the host to fetch its install script.
4. drive the already-shipped `asmltr mesh enroll <device> --os <os>` + `asmltr mesh resource …`
   (via `execFile`). **Tolerant:** if the mesh isn't provisioned the CLI says so and enroll returns
   `mesh.status='not-configured'` instead of failing — the device + token stay valid for a later
   bring-up.

Returns `{ token, bootstrapCommand, device, mesh }`.

### bootstrapCommand(os, token, baseUrl)
The ONE line the host runs. Thin by design: it fetches the per-device mesh-client install script
(authorized by `token`) from `{baseUrl}/v2/portal/enroll/script?os=<os>` and runs it.
- **Windows:** elevated-PowerShell `iwr … | iex`. The fetched script registers newt as a **SYSTEM
  scheduled task** (`mesh/deviceinstall.newtWindows`).
- **Linux:** `curl -fsSL -H 'Authorization: Bearer <token>' … | sudo sh` → a systemd newt unit.
- **macOS:** same `curl | sudo sh` → a launchd olm daemon.
- **Android:** no shell one-liner — enrollment is the ADB path; `install()` returns a note.

### teardown({ os, deviceName, deviceId })
The reverse. Returns `{ uninstallCommand, ok, mesh, revoked, dropped_transports }`:
- `uninstallCommand` — the per-OS host one-liner that stops + removes the newt/olm unit/task and
  leaves the mesh (`recipe.uninstall(org)`; unit/task names match `mesh/deviceinstall.js` exactly:
  `newt-<org>-mesh`, `olm-<org>-mesh`).
- asmltr-side deregistration — revoke the device's credentials/token (vault delete + hash drop via
  `devices/enroll.revoke`), remove the mesh ssh/rd resources, and drop the ssh/rd transports.

### victoryLap(deviceId)
After enroll, connect BACK over the mesh and paint SUCCESS on the target's own screen — the moment
that proves the round trip end to end. It SSHes to the device's `ssh` transport alias using the
asmltr host's **mesh SSH identity** (`mesh/sshkey`; its PUBLIC key is what Portal provisioning dropped
into the target's `authorized_keys`), and runs a remote one-liner that prints a bold ASCII
`ENROLLED ✓ / asmltr` banner to the SSH session and broadcasts it to any logged-in console (`wall` on
Linux/macOS, `msg *` on Windows). A **GUI variant** (noted, not built) would instead push a desktop
toast: `notify-send` / `osascript -e 'display notification …'` / BurntToast. Best-effort by design —
a freshly joined tunnel may need a few seconds, so a failure is informational, never fatal to enroll.
Returns `{ ok, method }`.

### The two gotchas (baked into the scripts, never re-debug)
1. **Windows newt MUST run as a SYSTEM scheduled task** or the WireGuard adapter is created but never
   transmits (tunnel one-way). The Windows bootstrap targets an elevated shell; the server-generated
   script registers the SYSTEM task (`RunLevel Highest`).
2. **A host-mode mesh resource MUST have a non-empty `alias`** or it never routes (every packet
   silently dropped). enroll always passes a resource *name* so the mesh CLI derives `<name>.mesh`;
   we never create an empty-alias resource.

**Assumptions:** the enrollment token authorizes a `GET …/enroll/script` the core owner serves (it
returns the `deviceinstall.js` body for that device+OS); `deviceinstall.js` has no macOS generator yet
(the endpoint supplies the launchd plist); the SSH user for the victory lap defaults to
`ASMLTR_PORTAL_SSH_USER` (fallback `root`); `baseUrl` resolves from `ASMLTR_PORTAL_BASE_URL` →
`ASMLTR_PUBLIC_URL` → `BASE_URL` → the mesh dashboard URL → `http://127.0.0.1:3000`.
