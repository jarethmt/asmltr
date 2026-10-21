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
