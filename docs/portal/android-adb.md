# Portal → Android over ADB — design & feasibility

**Status:** research + design only (2026-10-20). No firmware. The companion contracts are
[design.md](design.md) (§3 BLE connectivity, §6a the CDC drive loop, the Android notes) and
[drive.md](drive.md) (the proven Windows/desktop drive loop:
dongle = USB **device** = HID keyboard+mouse + CDC serial, driven over BLE from the asmltr phone app).

This doc answers one question: **can the Portal dongle control an Android device it's plugged into, over
ADB, and should we build it?** Short answer up front so nothing below is a surprise:

> **ADB control is real and has working ESP32-S3 prior art — but it requires the dongle to be the USB
> *host* and to *source 5 V VBUS* to the phone, which the current Waveshare board (USB-A plug,
> bus-powered, no boost) physically cannot do. Native USB-host ADB is therefore a *hardware-revision*
> feature, not something the shipping dongle can do. The interim that works *today* on the exact board
> we have is blind HID navigation of Android (the HID actuator already exists). ADB is roadmap R8,
> gated on either a host-capable Portal hardware variant or the Wi-Fi-ADB escape hatch (§7).**

---

## 1. Why Android breaks the desktop drive loop

On Windows/macOS/Linux the Portal is a **USB device**: it presents HID (keyboard+mouse) + CDC serial,
the host enumerates it, and the feedback loop closes through the dongle's *own* CDC port — a typed
one-liner redirects shell output to the COM/tty that **is** the dongle, and the dongle relays those
bytes up over BLE (PORTAL-DRIVE §1, DESIGN §6a). Text is instant; screenshots are few-second JPEG
snapshots. Nothing is installed.

Android kills that loop in two ways:

1. **No stock shell→serial path.** Stock Android has no user-reachable way to open a terminal and
   redirect its stdout to a USB CDC port. The elegant CDC return channel is a *desktop* capability.
   HID still works — Android accepts the dongle as a USB keyboard/mouse, so blind typing/navigation is
   universal — but there is no byte-level feedback the way there is on a desktop.
2. **The USB roles are inverted.** This is the hard part the whole doc hangs on. When you plug a USB
   dongle into a phone via USB-OTG, **the phone is the USB host and the dongle is the USB device.** ADB
   is the opposite relationship: ADB needs a **host** (the "computer") talking to an **Android in
   device/debug mode** running `adbd`. So for the dongle to be an "ADB controller," the **ESP32-S3 must
   run its USB-OTG port as a HOST** and speak the ADB wire protocol *to* the Android, with the Android
   in USB-debugging mode acting as the USB device. One port can't be both host and device at once, so
   the dongle must switch roles depending on what it's plugged into.

That role inversion, and the power that comes with it, is §2–§3.

---

## 2. USB role: can this dongle be a USB host?

### 2.1 The silicon can; the board can't

The ESP32-S3 has a single native USB-OTG controller (a Synopsys DWC-OTG core) on fixed pins
**GPIO19 (D−) / GPIO20 (D+)**. It is genuinely **dual-role**: it can be a USB **device** (what we use
today, via TinyUSB / `esp_tinyusb`) *or* a USB **host** (via ESP-IDF's native `usb_host_lib` / the
`usb_host` component). Espressif's own `usb_host_lib` supports **Full-Speed (12 Mbps) and Low-Speed**
devices and all four transfer types (control/bulk/interrupt/isochronous); measured bulk throughput on
an ESP32-S3 reaches **~1.15 MB/s**, ~95 % of the 12 Mbps FS bulk ceiling. (No High-Speed — the S3 PHY is
FS-only. ADB is fine at FS.) [espressif usb_host docs; circuitlabs]

**But there is exactly one USB-OTG controller.** You cannot be a HID+CDC *device* for a desktop and an
ADB *host* for a phone **at the same time** — it is one port, one role at a time. Role is chosen at
init: bring up `esp_tinyusb` (device) *or* `usb_host_lib` (host), tear down and re-init to switch. That
part is just software sequencing and is tractable.

### 2.2 The blocker: VBUS. A USB host must *supply* 5 V.

A USB host is the side that **sources VBUS** (5 V) onto the bus; the device *detects* that VBUS to know a
host is present and to enumerate. This is not optional:

> "USB Host won't work unless the device you plug in gets 5 V on VBUS. A USB-OTG host cable is not
> sufficient because the USB port does not provide VBUS 5 V output." [ikkaro; esp32.com forum]

The known-good ESP32-S3 ADB prior art spells out the same requirement: USB-OTG mode needs
**"external 5 V VBUS power to supply the connected Android phone … min 1 A."** The reference
**ESP32-S3-USB-OTG** devkit solves it with an onboard **boost converter** (battery 3.6–4.2 V → 5 V,
enabled by `BOOST_EN`/GPIO13).

Now look at **our** hardware ([HARDWARE.md](hardware.md)): the Waveshare ESP32-S3-LCD-1.47 is a
**USB-A *plug*, bus-powered** board. That plug's VBUS pin is an **input** — it's how the whole board gets
its 3.3 V. There is **no 5 V boost, no separate power input, and no way to drive VBUS as an output.** So
the dongle cannot simultaneously (a) draw its own power from the port and (b) assert 5 V onto that same
port to power/enumerate a phone. **On this exact board, native USB-host ADB is physically impossible
without added hardware.** This is the headline blocker, and it is a *board* problem, not a *chip*
problem.

What a host-capable Portal would need (hardware revision), any one of:

- A board with a **host-capable USB receptacle + an onboard 5 V boost** and a **separate power source**
  for the ESP32 (the ESP32-S3-USB-OTG devkit pattern). The slim USB-A-plug stick form factor goes away.
- A **powered-OTG Y-cable / powered hub** that injects 5 V VBUS from a wall/battery while the dongle
  drives only D+/D−. Works on the bench; ugly in the field and defeats "just a stick."
- An **external USB-host-controller IC** (MAX3421E) on SPI that owns its own host port and VBUS — adds a
  chip + a port, and you still have to supply that port's 5 V. (See §4; this is how Arduino does USB
  host, and there's an ESP32 port of the library.)

### 2.3 Role *detection* (which mode to boot into)

Even with host-capable hardware, the dongle must decide **desktop-device vs Android-host** per plug-in.
Options, best-first:

- **Can't rely on OTG-ID pin.** Classic USB-OTG uses the ID pin in the micro-AB connector to pick role.
  A USB-A plug has **no ID pin**, so there is no electrical role signal to read. (Another reason the
  current connector is wrong for host mode.)
- **VBUS presence.** If the dongle is bus-powered and sees VBUS, *something is hosting it* → it should be
  a **device** (desktop case). If a host-capable Portal is self/battery-powered and sees **no** external
  VBUS on plug-in, the thing attached is passive/needs-power → candidate to **become host** (Android
  case). This is the cleanest signal on a redesigned board.
- **Try-device-then-host timeout.** Boot as device; if no host enumerates us within N seconds, tear down
  and come up as host and try to enumerate *them*. Slow but robust, and matches how the Portal already
  wants to "detect the device and run the matching profile" (DESIGN §2).
- **User/controller selection.** The Portal has a screen + BOOT button and a BLE controller. The honest
  MVP is: the operator picks "Android (ADB)" from the menu (or the asmltr app sets the profile), and the
  dongle boots host mode deliberately. Detection automation is a polish item, not a blocker.

---

## 3. The ADB wire protocol over USB (what the host must speak)

Once the dongle is a USB host and has enumerated the Android, it finds the ADB interface by **USB
interface class triplet `0xFF / 0x42 / 0x01`** (vendor-specific / ADB / 1), which exposes a **bulk IN**
and a **bulk OUT** endpoint. Everything below rides those two bulk endpoints.

### 3.1 Message framing

Every ADB message is a **24-byte header** + optional payload. Header is six little-endian `uint32`:

```
struct amessage {
    uint32 command;      // one of the A_* command constants below
    uint32 arg0;
    uint32 arg1;
    uint32 data_length;  // payload byte count that follows
    uint32 data_crc32;   // CRC32 of the payload (sum of bytes in older impls; CRC32 per spec)
    uint32 magic;        // == command XOR 0xFFFFFFFF  (integrity / framing check)
};
```

Command constants (ASCII little-endian — the four letters are legible in a hexdump):

| command | value | meaning |
|---------|-------|---------|
| `A_CNXN` | `0x4E584E43` ("CNXN") | connect / banner exchange |
| `A_AUTH` | `0x48545541` ("AUTH") | authentication (RSA) |
| `A_OPEN` | `0x4E45504F` ("OPEN") | open a stream to a service |
| `A_OKAY` | `0x59414B4F` ("OKAY") | ready / flow-control ack |
| `A_WRTE` | `0x45545257` ("WRTE") | write data on a stream |
| `A_CLSE` | `0x45534C43` ("CLSE") | close a stream |
| `A_SYNC` | `0x434E5953` ("SYNC") | (internal/sync service) |
| `A_STLS` | `0x534C5453` ("STLS") | upgrade to TLS (Android 9+ option) |

`A_VERSION = 0x01000001`; modern `MAX_PAYLOAD = 256*1024` (older peers negotiate down to `4096`). Take
the **min** of the two sides' maxdata from the CNXN exchange.

### 3.2 Handshake, step by step

1. **CNXN (host → device):** `command=A_CNXN, arg0=A_VERSION, arg1=MAX_PAYLOAD,`
   `payload="host::features=cmd,shell_v2,stat_v2,..."` (a NUL-terminated **banner**). The banner's
   leading token is `host::`; the `features=` list is what makes modern `shell_v2`/`exec` work.
2. **AUTH dance (device → host, then host → device):** a secured device replies with
   **`A_AUTH, arg0=ADB_AUTH_TOKEN(1)`** and a **20-byte random token** (SHA-1-sized) in the payload.
   The host must prove it holds a trusted key:
   - **`A_AUTH, arg0=ADB_AUTH_SIGNATURE(2)`, payload = RSA signature of the token.** The signature is
     **RSASSA-PKCS1-v1.5** over the token with the **SHA-1 DigestInfo prefix** prepended, using an
     **RSA-2048** private key. If the device already trusts this public key (seen before), it answers
     CNXN and we're connected — **no prompt**.
   - If the device *doesn't* recognise the key, it NAKs; the host then sends
     **`A_AUTH, arg0=ADB_AUTH_RSAPUBLICKEY(3)`, payload = the public key** in Android's `ANDROID_PUBKEY`
     format (little-endian modulus + `n0inv` + `rr`, base64, with a trailing ` user@host` label). **This
     is when the Android pops the "Allow USB debugging? [RSA key fingerprint] [ ] Always allow"
     dialog.** A human must tap **Allow** on the device screen.
   - **This consent gate is a feature, not a bug** — it aligns exactly with the Portal trust model
     (DESIGN §8): the dongle can only drive an Android that a present human explicitly authorised, and
     "Always allow" persists the dongle's key so repeat plug-ins are silent. (`adbd` must be enabled:
     Developer Options → USB debugging. That's itself a consent step.)
3. **CNXN (device → host):** on accepted auth the device returns its own CNXN with banner
   `device::...` (model/features). Connected.

### 3.3 Streams: shell, screencap, input injection

Streams are multiplexed over the one bulk pair by `(local-id, remote-id)` in `arg0/arg1`:

- **OPEN a service:** `A_OPEN, arg0=local_id, payload="<service>\0"`. Device replies `A_OKAY` (accepted,
  gives its `remote_id`) or `A_CLSE` (refused).
- **Data flows as `A_WRTE`**, each answered by an `A_OKAY` (ADB's per-message flow control — you must
  OKAY before the peer sends the next WRTE). **CLSE** tears the stream down.
- Services we care about (all just service strings on OPEN):
  - **`shell:<cmd>`** (or `shell,v2:<cmd>`) — run a command, stdout/stderr come back as `A_WRTE`
    payloads. `shell:` with no command = interactive shell. This is the workhorse.
  - **Input injection is just shell:** `shell:input tap <x> <y>`, `shell:input swipe ...`,
    `shell:input text '...'`, `shell:input keyevent <KEYCODE>`. No special service — if we have
    `shell:` we have full touch/key control of the UI.
  - **Screenshots:** `shell:screencap -p` streams a PNG to stdout (beware: some shells mangle `\n`;
    `screencap -p | base64` or writing to `/sdcard` then pulling avoids that). Alternatively the
    `framebuffer:` service streams raw RGBA. Either way bytes come back over the WRTE stream.
  - **File pull/push:** the `sync:` service (STAT/SEND/RECV sub-protocol) — needed only if we want
    `adb pull/push`; not required for shell+screenshot control.
  - **`exec:<cmd>`** — like shell but a clean binary stdout (no PTY line-ending translation) — the
    better channel for `exec:screencap -p` to get an unmangled PNG.

For our purposes the minimal viable surface is **CNXN + AUTH + `shell:`** — that alone gives commands,
`input` UI control, and `screencap`.

---

## 4. RSA auth on the ESP32 (crypto + key storage)

- **The maths is already on-board.** ESP-IDF ships **mbedTLS** with RSA-2048 and the hardware RSA
  accelerator; signing one 20-byte token per connection is trivial (sub-100 ms, once). We do **not** need
  wolfSSL for the classic USB-ADB path (the prior-art project pulls wolfSSL only for the *wireless*
  Android-11+ SPAKE2/TLS path — see §5.1; classic USB AUTH is plain RSA-PKCS1v1.5 + SHA-1 and mbedTLS
  covers it).
- **Signature detail that trips people up:** ADB does **not** sign a SHA-1 *hash of* the token — it signs
  the 20-byte token *as if it were already the digest*, i.e. prepend the 15-byte SHA-1 ASN.1 DigestInfo
  prefix to the raw token and RSA-sign that. Get this exact or the device silently rejects the signature.
- **Public-key format:** Android's `ANDROID_PUBKEY` (not PEM/DER) — 2048-bit modulus as little-endian
  32-bit words, plus Montgomery `n0inv` and `rr` precompute, base64-encoded, ` label` appended. We must
  emit this byte-for-byte for the RSAPUBLICKEY message.
- **Key storage:** generate the RSA-2048 keypair **once on-device**, store in **NVS on the encrypted
  flash** (the board already plans flash-encryption + secure boot + eFuse, DESIGN §8). The private key
  never leaves the dongle. The dongle's ADB identity is then a stable, per-dongle credential — and
  because the *first* use requires the human "Allow USB debugging" tap, enrolling the dongle's key onto a
  target Android is itself an auditable consent event (ties to DESIGN §8 trust + Cast attribution).
- **Optional:** reuse the same key tiering as the vault-kill-switch (§8b) so the ADB identity can live in
  the dongle-only encrypted tier — pull the dongle, the Android trust is moot because the key is gone.

---

## 5. Prior art (what already exists, and what's reusable)

### 5.1 `wolfxalpha4/esp32-adb-client` — the direct precedent (MIT)

A **standalone dual-mode (USB-OTG **and** Wi-Fi) ADB host for the ESP32-S3.** This is the single most
relevant project found.
- **USB host via the ESP32-S3 native USB peripheral (GPIO19/20)** — i.e. ESP-IDF `usb_host_lib`, not an
  external controller. Confirms native-host ADB is achievable on S3 silicon.
- **Classic RSA AUTH** with keys in `adb_keys.h`; **Android-11+ wireless pairing** via **SPAKE2 over
  Curve25519 + TLS 1.3** using **wolfSSL**; **port-5555 TCP/IP** auto-discovery (subnet scan) for
  Android 4.4–15.
- Interactive serial CLI runs `getprop`, `pm list packages`, `input keyevent`, etc. — proving the
  shell/input surface we need.
- **Explicitly requires external 5 V VBUS ≥1 A to power the phone in USB-OTG mode** — independent
  confirmation of our §2.2 blocker.
- **Maturity: early** (≈5 commits, few stars). Its own README notes classic **TCP/IP works reliably but
  USB-OTG mode has "occasional hiccups."** Treat as a **reference implementation to study/port**, not a
  turnkey dependency — but MIT-licensed, so we can lift the AUTH/stream logic.

### 5.2 General ESP32-S3 USB-host building blocks

- **`tanakamasayuki/EspUsbHost`** — Arduino-layer USB host for ESP32-S3 (keyboard/mouse class); good
  reference for driving `usb_host_lib` bulk/interrupt transfers, not ADB-specific.
- **Espressif `usb_host_lib`** (the `usb_host` component) and the `esp-usb` managed components — the
  supported native host stack; mature enough for class drivers (CDC-ACM, MSC, HID host all exist as
  Espressif components). ADB would be "just another" vendor-specific class driver over bulk endpoints.
- **`espressif/esp-usb-bridge`** — S2/S3 as a USB↔UART/JTAG bridge; *not* ADB, but a worked example of
  the S3 owning a USB link.

### 5.3 External-controller route (MAX3421E)

The classic **Arduino `USB_Host_Shield_2.0`** (felis) + a **MAX3421E** USB-host IC over SPI, with an
ESP32 port (`touchgadget/USB_Host_Shield_2.0_feather_esp32`). This gives a **second, independent USB
host port with its own VBUS** — sidestepping the "one OTG controller, wrong connector" problem — at the
cost of an extra IC, SPI wiring (SS/INT/SCK/MISO/MOSI), and you still supply that port's 5 V. No ready
ADB layer exists on it (the felis library is HID/FTDI/etc.), so you'd port the ADB protocol onto it
yourself. Viable for a bench/hardware-revision Portal, not the slim stick.

### 5.4 TinyUSB host

TinyUSB *does* have a host stack (`tuh_*`), but on ESP32 the **supported/mature host path is Espressif's
`usb_host_lib`**, and Espressif's TinyUSB integration is primarily the **device** side. For ADB-host we'd
build on `usb_host_lib` (as the prior art does), not `tuh_*`.

---

## 6. Mapping ADB onto the asmltr drive model (BLE exec/ioback)

The good news: **ADB control drops into the existing drive contract with almost no new surface.** From
asmltr's side, Android control should feel like the Windows REPL. The BLE GATT already has the two
characteristics we need (PORTAL-DRIVE §1):

| asmltr concept | desktop (CDC loop) | Android (ADB) |
|----------------|--------------------|---------------|
| send a command | `exec` char, `mode 0x02` → CDC-TX → shell | `exec` char, **new `mode 0x03` (adb-shell)** → dongle opens `shell:<cmd>` stream |
| get output back | `ioback` notify = CDC-RX bytes | `ioback` notify = ADB `A_WRTE` stream payloads |
| screenshot | typed one-liner → JPEG bytes over CDC | `exec:screencap -p` → PNG → **base64** → chunked over `ioback` |
| HID typing | `exec` `mode 0x01` keystroke script | **still available** (blind nav, pre-consent) |

Concretely:
- The `portal-drive` skill's per-OS recipe object already reserves **`transport: "adb"`** for Android
  (PORTAL-DRIVE §3). That recipe carries: enable-USB-debugging guidance for the human, the "tap Allow"
  consent note, and the service strings (`shell:`, `exec:screencap -p`).
- **Relay shape is unchanged** (PORTAL-DRIVE §2): `{type:"portal.exec", mode:"adb", data:"<base64 cmd>"}`
  down; `{type:"portal.io", data:"<base64>"}` up. The phone app relays bytes blind — it doesn't need to
  know ADB; the **dongle** owns the ADB state machine (CNXN/AUTH/stream framing) and only ever exposes
  "command in / output out" to BLE. That keeps the BLE surface identical to the desktop loop.
- **Throughput:** BLE-via-phone is ~10–30 KB/s (DESIGN §6a), the real bottleneck — **not** the FS-USB
  link (~1 MB/s). So: shell text is instant; a `screencap` PNG is a **few-second** downscaled/JPEG
  snapshot, same UX as the desktop CDC screenshot. Live screen stays the job of post-enroll mesh RDP.
- **Enrollment** (DESIGN §6, PORTAL-DRIVE §4) over ADB is cleaner than desktop: no blind terminal-open
  needed — `shell:` *is* the shell. The Android profile's `enroll()` runs `pm`/`settings`/`am` + drops
  an agent (or Termux/mesh client) via `shell:` + `sync:` push; teardown uninstalls symmetrically.

---

## 7. The Wi-Fi-ADB escape hatch (sidesteps the VBUS blocker — but reopens a settled decision)

The prior art is **dual-mode** for a reason: **ADB also runs over TCP** (`adb tcpip 5555`, or Android
11+ **wireless debugging** with SPAKE2 pairing). If the dongle talks ADB over Wi-Fi, **there is no USB
host, no VBUS, no role switch, no connector problem** — the blocker in §2 simply vanishes, and the same
CNXN/AUTH/stream logic from §3 runs over a socket instead of bulk endpoints.

The catch: **DESIGN §3 deliberately dropped Wi-Fi from the dongle** (BLE-only, "the dongle never needs
Wi-Fi credentials or an AP"). Wi-Fi-ADB reopens that. Honest trade:
- **Pro:** works on the *current* board (it has Wi-Fi b/g/n), no hardware revision, reuses all the ADB
  protocol work, and Android-11+ wireless pairing has its own strong consent (QR/6-digit code).
- **Con:** the dongle needs to join a network (credentials, or the target Android's hotspot), and the
  target must have wireless debugging on. It's no longer "plug a stick into a phone with nothing else" —
  it's "pair the dongle to the phone's ADB over the LAN." That's a different product gesture and
  contradicts the §3 BLE-only stance.

**Recommendation on this:** keep it documented as the **fastest path to a *working ADB demo*** (prove the
AUTH + shell + screencap logic over TCP on the hardware we have, today), but treat USB-host ADB as the
"true Portal" gesture to be unlocked by a hardware revision. Decide with the operator before adding Wi-Fi back
to the dongle — it's a product-identity call, not just an engineering one.

---

## 8. Feasibility, effort, risks

**Feasibility verdict:**
- **ADB protocol + RSA AUTH + shell/screencap/input on ESP32-S3:** *proven* (mbedTLS + `usb_host_lib`;
  prior art exists, MIT). **Realistic.**
- **On the *current* Waveshare USB-A-plug bus-powered board, via native USB host:** **not possible** —
  cannot source VBUS. Hard blocker.
- **On a host-capable Portal hardware revision (boost + separate power + host receptacle):** realistic,
  medium effort.
- **Over Wi-Fi-ADB on the current board:** realistic *now*, but reopens the BLE-only decision.

**Biggest risks, ranked:**
1. **VBUS / connector / power (hardware)** — the gating issue; needs a board redesign for native host.
2. **`usb_host_lib` host-mode robustness** — the prior art itself reports USB-OTG "hiccups" vs. reliable
   TCP. Full-Speed-only, single-device, async-only, no transfer timeouts — all workable, but the host
   stack is less battle-tested than the device stack we already ship.
3. **Role switching** — one OTG controller means device↔host is a teardown/re-init, and with a USB-A
   plug there's no ID pin to detect role. Needs a deliberate detection strategy (§2.3) or manual select.
4. **Throughput** — *not* a real risk: BLE is the bottleneck, not USB; screenshots are snapshots by
   design.
5. **ADB protocol exactness** — the SHA-1-DigestInfo-prefix signing quirk and `ANDROID_PUBKEY` format are
   easy to get subtly wrong (silent auth failure). Mitigated by porting the MIT prior art.
6. **Android fragmentation** — `screencap` stdout mangling, `shell_v2` vs v1, OEM Developer-Options
   differences. Manageable, matches the prior art's Android 4.4–15 coverage.

---

## 9. Staged build plan (rungs)

Rungs are independent enough to stop at any point with value banked.

- **R8.0 — HID-only Android (ships on current board, no new hardware).** Recognise Android at
  enumeration; the Android recipe uses **blind HID navigation** (already-built actuator) for
  tap/type/swipe-by-coordinate. No feedback loop. *Delivers "drive an Android from the phone app today,"
  honestly limited.* This is the **interim** and it needs nothing new.
- **R8.1 — ADB protocol library, validated over Wi-Fi/TCP (current board).** Build the CNXN/AUTH(RSA via
  mbedTLS)/OPEN/WRTE/OKAY/CLSE state machine + `shell:`/`exec:screencap` as a pure, transport-agnostic
  module. Validate it against a real Android over **TCP** (`adb tcpip 5555`) on the hardware we have —
  this de-risks *all* the protocol/crypto work without touching USB host. Prove the "Allow USB debugging"
  consent + silent-reconnect-after-Always-allow flow.
- **R8.2 — hardware spike: native USB host on an S3 with VBUS.** On an **ESP32-S3-USB-OTG devkit** (or
  current board + powered-OTG cable injecting 5 V), bring up `usb_host_lib`, enumerate an Android,
  bind the ADB interface (`0xFF/0x42/0x01`), and run R8.1's state machine over **bulk endpoints**.
  Measure reliability. This answers "does native host ADB actually hold up" before committing to board
  design.
- **R8.3 — role selection + Portal integration.** Implement device↔host mode switching (boot-as-device,
  fall back to host; or controller-selected profile) and wire ADB into the BLE drive contract: new
  `exec` `mode 0x03`, `ioback` carrying ADB stream bytes, `transport:"adb"` recipe in the `portal-drive`
  skill, screenshot = base64 PNG over `ioback`.
- **R8.4 — Android enroll/teardown profile.** `shell:`-driven mesh-client install + agent drop + register
  device (ssh/rd), symmetric uninstall, victory-lap on the Android's own screen (a toast / activity).
- **R8.5 (if pursued) — host-capable Portal hardware revision.** Spec a Portal variant with a
  host-capable USB receptacle, 5 V boost, and its own power so the "stick into a phone, ADB, done"
  gesture works without a cable. Product decision with the operator.

---

## 10. Recommendation

1. **Ship R8.0 (blind HID Android) now** — it's the only Android control the current board can do, it
   reuses the existing HID actuator, and it's honest about having no feedback. Do this first.
2. **Do R8.1 next: build the ADB stack and prove it over TCP/Wi-Fi.** All the genuinely hard parts
   (RSA AUTH signing quirk, `ANDROID_PUBKEY`, the stream state machine, consent flow, screencap) are
   *transport-independent* and can be fully validated on the hardware we already have, with zero VBUS
   drama. Port the MIT `esp32-adb-client` AUTH/stream code rather than reinventing it. This is the
   highest-leverage work and it de-risks everything downstream.
3. **Treat native USB-host ADB as a hardware-revision feature (R8.2 → R8.5), not a current-board
   feature.** Be explicit with the operator: the slim USB-A-plug, bus-powered dongle we have **cannot source
   VBUS** and therefore cannot be a USB host for a phone. A host-capable Portal needs a different
   board (boost + separate power + host receptacle). The chip can do it; this board can't.
4. **Flag the Wi-Fi-ADB path as a product decision, not just an engineering one.** It's the fastest route
   to a working ADB demo and it dodges the VBUS blocker entirely — but it reopens DESIGN §3's deliberate
   BLE-only stance. Don't quietly add Wi-Fi back to the dongle; raise it.
5. **Keep the consent gate central.** The "enable USB debugging" + on-device "Allow this RSA key" taps
   are exactly the human-in-the-loop authorization the Portal trust model wants (DESIGN §8). Store the
   dongle's RSA identity in encrypted flash (optionally the vault-kill-switch tier) so it's a stable,
   revocable, attributable credential.

**One-line bottom line:** *ADB control of Android from the Portal is a sound design and has working
ESP32-S3 precedent — but it's a USB-**host** feature that needs VBUS the current board can't supply, so
build the (transport-independent) ADB stack now over TCP, keep blind-HID as the shipping interim, and
gate native USB-host ADB on a host-capable Portal hardware revision.*

---

### Sources
- [wolfxalpha4/esp32-adb-client](https://github.com/wolfxalpha4/esp32-adb-client) — dual-mode USB-OTG + Wi-Fi ADB host for ESP32-S3 (MIT); confirms native-host ADB and the external-5 V-VBUS requirement.
- [ESP-IDF USB Host API (usb_host_lib)](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/usb_host.html) — FS/LS only, all transfer types, async-only, single device, config-1-only.
- [USB implementation in the ESP32 series — circuitlabs.net](https://circuitlabs.net/usb-implementation-in-esp32-series/) — ~1.15 MB/s FS bulk throughput measured on S3.
- [ESP32-S3-USB-OTG devkit user guide](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-usb-otg/user_guide.html) — onboard 5 V boost (BOOST_EN/GPIO13) to power a downstream device.
- [ESP32 as USB Host — ikkaro.net](https://www.ikkaro.net/esp32-as-usb-host/) & [ESP32 forum: USB host on DevKitC-1](https://www.esp32.com/viewtopic.php?t=27826) — "won't work unless the device gets 5 V on VBUS."
- [tanakamasayuki/EspUsbHost](https://github.com/tanakamasayuki/EspUsbHost) — ESP32-S3 native USB host reference (HID).
- [felis/USB_Host_Shield_2.0](https://github.com/felis/USB_Host_Shield_2.0) & [touchgadget ESP32 port](https://github.com/touchgadget/USB_Host_Shield_2.0_feather_esp32) — MAX3421E external-USB-host route.
- [espressif/esp-usb-bridge](https://github.com/espressif/esp-usb-bridge) — S2/S3 USB bridge (not ADB; S3-owns-USB example).
- ADB wire protocol constants (`A_CNXN/A_AUTH/A_OPEN/A_WRTE/A_OKAY/A_CLSE`, AUTH TOKEN/SIGNATURE/RSAPUBLICKEY, 24-byte header, `ANDROID_PUBKEY`, RSA-2048 PKCS1v1.5 + SHA-1 DigestInfo signing) — AOSP `platform/packages/modules/adb` (`protocol.txt`, `types.h`, `auth.cpp`, `crypto/`).
