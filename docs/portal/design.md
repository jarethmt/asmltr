# asmltr Portal — Design & Architecture

The spec we build against. Hardware facts: [HARDWARE.md](hardware.md). Build/roadmap: [build.md](build.md).

---

## 1. Concept

The portal is a credential-bearing USB device that **enrolls an asmltr agent onto a host** and makes
it reachable over the asmltr backbone — collapsing the manual "join the VPN + copy the SSH key +
register the node" dance into one plug-in, with a screen that narrates every step and a symmetric
teardown. It is both a **node** on the asmltr backbone and a **provisioner** of new ones.

## 2. Profile / module system (Flipper-spirit, one purpose)

Each target type is a self-contained **profile** — pick which ones get baked in at flash time (keeps
firmware lean), shareable as a repo of community profiles. A profile is a data structure + logic:

```
profile {
  name            // "linux", "windows", "android", "iot-foo"
  detect()        // fingerprint: USB descriptors, enumeration behavior, responses
  connect()       // how to reach it (USB HID inject / USB-net / ADB / serial / network)
  enroll()        // deterministic steps: get agent in, join backbone, register
  teardown()      // SYMMETRIC removal: revoke node, remove key/agent, deregister
  ui{}            // screen states + status strings for this profile
}
```

The firmware runtime (detection, connectivity, screen/menu, phone bridge, logging) is fixed; profiles
are the content. **Teardown is first-class, not an afterthought** — it's what makes "tech support for
a friend" legitimate (you can always cleanly remove yourself) and keeps hosts tidy.

### 2a. Loader engine + sideloadable modules (the Flipper-but-safe core)

The firmware is a fixed **loader engine**; every profile/loader (mac, windows, linux, …) is a
**module the engine runs — not native code.** Modules are **pushed over BLE** (`load`), stored in
flash (16 MB — room for a library), and **triggered** (`run`) now or later. This is the mechanism
behind R9's self-teaching library: the assistant observes an unknown target, synthesizes a new module, **signs
it**, and pushes it to the dongle.

Module formats, simplest-first:
- **Declarative step-DSL (v1):** a list of steps — `SEND_KEYS`, `WAIT`, `EXPECT`, `RUN`, `LED`,
  `SCREEN` — the engine interprets. Covers mac/windows/linux provisioning and is trivially safe (no
  arbitrary computation). This *is* the "pass a generic function over BLE" API: you send a step-list,
  the engine executes it.
- **Sandboxed VM (later):** WASM (WAMR) or Berry, for modules that need real branching/logic. Still
  sandboxed — a bad module can't escape the engine or brick the device (watchdog + resource caps).

**Not** used: native dynamic code (`dlopen`-style) — there is no standard/safe ESP-IDF path for it.
Whole-firmware **OTA** is possible over BLE but heavy (MB = minutes) — reserved for firmware updates,
never per-module.

## 3. Connectivity: BLE-only, controller-driven (decided 2026-10-19)

The portal does **not** acquire its own internet. It is a **BLE peripheral driven by a controller**
that already has connectivity. The controller orchestrates; the portal acts on the target it is
physically plugged into (USB → HID / serial). This inverts the earlier "acquire network wisely" idea
— far simpler, and the dongle never needs WiFi credentials or an AP.

**Controllers (who drives it):**
- **asmltr native app (primary)** — Android **and iOS**. BLE is the only link that works on an
  iPhone (Wi-Fi Direct / SoftAP can't be driven from iOS), so BLE is what makes the portal
  phone-universal. "Phone in your pocket, in range" is the main case.
- **Desktop Chrome / Edge** — via **Web Bluetooth**. A deliberate *programmed requirement*: Chromium
  browsers only. Firefox and Safari have no Web Bluetooth and are unsupported for desktop control.

**Deferred / not now (and why — so we don't relitigate it):**
- **SoftAP / WiFi-join / USB-net** — dropped. A controller joining the dongle's AP loses its own
  internet, and Android actively tears down an internet-less AP ("avoid bad WiFi" — proven on
  a phone-as-Group-Owner project). BLE sidesteps all of it and costs no network config.
- **Wi-Fi Direct P2P** (the phone-as-Group-Owner pattern) — excellent for a phone, but
  **no browser can drive Wi-Fi Direct from JS**, so it can't serve desktop control. Parked unless a
  bulk-transfer need ever appears.

**The BLE control surface (GATT) — one service, a few characteristics:**
- `load`   — write a **signed** module/script blob; chunked (offset + len + CRC; BLE MTU ~180–512 B).
- `run`    — trigger a stored module by id, or run an inline one-shot script.
- `status` — notify progress / output / errors back to the controller.
- `info`   — device identity, firmware version, loaded-module list, trust state.

Throughput is modest (tens of KB/s) — fine for KB-scale script modules + status. Big transfers
(firmware images) are out of scope for BLE; see the OTA note in §2a.

## 4. Backbone: Pangolin-primary, pluggable

The VPN/mesh backbone is an interface, **not hard-wired to Tailscale**:
- **Pangolin (primary):** enrollment installs the **Olm** client on the host and provisions it via the
  Pangolin **admin API** (create client, grant site resources), joining the asmltr org/site. Gives
  cross-platform reachability. **Shipped 2026-10-19:** asmltr provisions its own Pangolin mesh —
  `asmltr mesh` (org/OIDC/admin→vault, site enroll, host-mode resources, device install-command
  generation) lives in the main repo (`mesh/`), and the asmltr server is the first node. The portal's
  enroll/teardown drive that tooling rather than re-implementing it. (Known footguns, all now encoded:
  a host-mode resource needs a non-empty `alias` or it never routes; Windows `newt` must run as
  SYSTEM; Olm `-override-dns` DNS blackout — see mesh/README + 3DPGH notes.)
- **Tailscale (legacy/fallback):** pre-auth key join. Kept as an option, not the default.

The portal holds short-lived, scoped, **revocable** enrollment credentials (not long-lived secrets);
the asmltr server mints per-enrollment tokens on phone-home.

## 5. Phone bridge (asmltr app)

A "field access" mode in the asmltr app bridges to the portal over **BLE** (§3) and provides:
- **Live status / control** of an enrollment in progress; approval surface for escalations.
- **Wireless KVM** — portal presents as USB HID **keyboard + mouse** (composite HID+CDC, §2a); the phone
  sends key/mouse events → the portal injects them. Drive a headless box from your phone. **Two input
  routes, auto-selected (decided 2026-10-20):**
  - **No remote-desktop session yet** (headless / pre-enroll): *blind* USB-HID injection — keystrokes/
    mouse go in, but there's no screen feedback on the phone.
  - **A remote-desktop session is live for this device** (post-enroll, §6): input is routed *through* that
    session, so the phone shows the host's screen while you drive. This is the "can it take input / is it
    hooked up for remote desktop" detection the operator described — keyed on whether the device has a live
    `rd` session in the Fleet, not on probing USB.
- **Auto-connect (decided 2026-10-20):** the dongle is a BLE *peripheral* and can't dial the phone, so the
  asmltr app runs a lightweight **background service** that auto-connects to a *paired* portal whenever it
  sees it advertise — so a module that needs phone support (e.g. escalate-to-assistant, KVM) works even if the
  app wasn't open when the dongle was plugged in. Must be battery-cheap: opportunistic scan on the OS
  callback, no tight polling. **Fallback:** the install script phones asmltr → asmltr push-notifies the
  phone → tap to open + connect (no background drain, always reliable).
- **Escalate-to-assistant** — on an unknown/failed target, the portal hands observed data to the assistant through the
  app; she probes live, improvises, and the fix becomes a new profile.

## 6. Remote-desktop tie-in (the "circular pie")

"See & drive the headless host's screen on my phone" = the existing remote-desktop work, bootstrapped
by the portal. Honest mechanism: **USB can't read the host's framebuffer** — so the portal doesn't
capture video. Instead, once enrolled over the backbone, the agent streams it over that link: console
via SSH (trivial); GUI via a remote-desktop/VNC relay (spin up a virtual framebuffer if the host has a
GUI but no display) → phone viewer. The portal provisions the backbone + the remote-access agent;
the remote-desktop feature is the viewer. One integrated system to test end-to-end.

**Enroll's victory lap (decided 2026-10-20):** the *final* step of `asmltr mesh enroll` is a proof that the
new link actually works — asmltr **kicks off a session/instance that connects back to the just-enrolled
device over the mesh** and paints a **"SUCCESS" animation on the host's own screen**: via GUI tooling if a
desktop is present, else simple **console ASCII / control-sequence injection** over the SSH session if it's
headless. The enrollment proves itself by *driving the target it just provisioned* — closing the loop
visibly, on the target's display, not just on the dongle's.

## 6a. Generic one-off access — the CDC loop (no install) (decided 2026-10-21)

Beyond the installer, the Portal is a **generic, ephemeral remote-access device**: plug it into any
computer and asmltr gets hands (and, through a clever trick, eyes) on it with **nothing installed** —
unplug and it's gone. The server has no BLE, so the **phone app relays**: server → app → BLE → Portal.

**The feedback loop (the hard part) closes through the dongle itself — no camera, no agent:**
the dongle is a composite HID **+ CDC serial**, so the host already sees a COM/tty that *is* the dongle.
After a terminal is open, a typed command redirects its output to that port; the dongle reads its
CDC-RX and relays it up over BLE. **Anything that serializes to bytes comes back — including a
screenshot** (a typed one-liner captures → downscales → JPEG → writes to the port). Throughput reality:
BLE via the phone is ~10–30 KB/s, so text is instant and screen captures are **few-second snapshots**
(downscaled/JPEG), not live video — live screen is what the post-enroll mesh RDP is for.

**Getting to a terminal reliably (the one blind step), in three parts:**
1. **Smart OS detection — automatic, never manual.** Two stages: (a) at USB enumeration the dongle
   fingerprints the host (Windows reliably requests the `0xEE` Microsoft-OS string descriptor;
   non-Windows doesn't), giving Windows-vs-Unix-like; (b) the CDC probe then refines it exactly
   (`ver`/`uname`). The dongle shows the detected host OS on its screen.
2. **Open a terminal with the OS's reliable entry** — Windows `Win+R → powershell`, macOS
   `Cmd+Space → Terminal`, Linux the common binds.
3. **Confirm via the CDC loop before acting** — the first thing typed writes a marker to the dongle
   (found by its `303A:4002` VID/PID, not a guessed COM number). Marker received → terminal confirmed;
   otherwise retry. The return channel closes the loop on the blind step itself — never act on faith.

**The typed session bridge (the clean target).** Instead of typing every command blind, blind-type one
short **bootstrap REPL** that bridges the dongle's serial to the shell. After that, commands *and*
screenshots flow over the reliable CDC channel (phone-relayed), not the keyboard. Nothing is installed;
it runs in the open terminal and **dies when the window closes** — a clean, ephemeral one-off shell on
any machine. The OS installer profiles become just one kind of script that rides on this bridge.

**Android is different — be honest about it.** The HID layer is universal (Android accepts the dongle
as a USB keyboard/mouse, so blind navigation + typing works), and OS-detection should recognize Android.
But the CDC-return trick needs a shell redirecting to the serial port, which **stock Android doesn't
offer** — so the elegant text/screenshot loop is a *desktop* capability (Windows/macOS/Linux). Driving
Android is blind HID now; its richer feedback path is **ADB** (roadmap R8), a distinct mechanism, not the
CDC bridge. Design keeps the HID layer universal and branches the feedback strategy by detected OS.

## 7. On-device UI (screen + BOOT button)

The ST7789 172×320 screen is the visible half of the "magic trick" — live, legible narration.
- **States:** boot/identity → menu → confirm → working (step text + progress bar + state color) →
  done (green check) / error. WS2812 LED mirrors state (idle/working/done).
- **BOOT button combos:** single = next menu item, **hold = select/confirm**; double / triple reserved
  for shortcuts (e.g., quick-enroll, quick-teardown). Menu: **Install / Uninstall / Status**. Screen
  is the confirm; on commit it flips to the progress view.

## 8. Security & trust (it's a credential)

- **Module load/run is trust-gated — this is the BadUSB line.** A dongle that runs scripts sent over
  BLE is a weapon unless gated: modules are **signed by the asmltr identity**, and only a **paired,
  trusted principal** (Cast/trust) may `load` or `run`. Unsigned or untrusted → refused. The signing
  key is asmltr's SSH/agent identity (`mesh/sshkey`). The engine also enforces a watchdog + resource
  caps so even a *trusted-but-buggy* module can't brick the device. This gate is what keeps the portal
  a provisioning tool for your own/authorized devices, not a drop-and-own gadget.
- Secrets **encrypted at rest** (ESP32-S3 flash encryption + secure boot + eFuse) — a stolen portal
  doesn't spill.
- **Ephemeral, scoped, revocable** enrollment credentials; server-minted per enrollment.
- **Mutual auth** to the asmltr server (the portal proves it's a trusted provisioner); every
  enrollment **logged + attributable**; ties into the asmltr **Cast/trust** model and the asmltr-as-IdP
  direction (epic #27). Same device could later be a **FIDO2 authenticator** for asmltr itself.
- **Consent-forward:** operates on unlocked hosts, narrates what it's doing, one clear elevation prompt.

### 8b. Portal-as-vault-key — the physical credential kill-switch (decided 2026-10-20)

A Portal can hold an asmltr user's secrets **on the device**, encrypted at rest (flash-encryption +
secure boot + eFuse), unlocked only with a password sent over BLE/CDC. The point that matters here is
**physical presence as a control**: with the crown-jewel keys living *only* on the dongle, **unplugging it
makes those credentials unavailable to the assistant** — a hard, human, offline kill-switch. If the operator is away and can't
watch every channel (Discord, etc.), pulling the drive guarantees nothing that needs a credential can run,
no matter what anyone asks over any channel. This is trust-protocol made physical.

- **Not the only way, a clear upgrade path.** Default stays the **server-side TRUST vault (a Self silo)**.
  A Portal is an *option* a user can adopt for extra security: a **"dongle-only" credential tier** whose
  secrets never live online — present the dongle (unlocked) to use them, unplug to revoke. The rest of the
  vault keeps working server-side.
- **Mechanism:** the dongle-only tier is an encrypted partition on the 16 MB flash; `ctx.secrets.get()`
  resolution checks the live, unlocked Portal first for keys in that tier and **fails closed** (credential
  simply unavailable) when it's absent — exactly the desired behavior. Ties into the TRUST vault broker,
  the Cast/trust model, and the FIDO2-authenticator direction (§8).

## 8a. asmltr integration — register / discover / control from the web GUI

The portal is not a separate universe; it lives inside asmltr's existing device model (`/v2/devices`,
`core/src/devices/`), so nothing is reinvented:
- **The dongle is a device** (`kind: appliance`) with a new **`ble` transport**. It registers through
  the existing device-enrollment flow (one-time code → vault-stored credential), owned by a principal,
  with the usual per-capability grants (view/control/shell/file/wake).
- **A provisioned target is a device too** — with `ssh`/`rd` transports whose address is its mesh
  alias (e.g. `host-ssh.mesh`). Portal enrollment and the `/v2/devices` registry **unify**: enrolling
  a target via the portal creates/updates its device row + its mesh resources in one flow.
- **Control is direct, peer-to-peer:** the web GUI talks to the dongle **over BLE** (native BLE in the
  asmltr app; Web Bluetooth in Chrome/Edge). asmltr core/registry provides identity, **module signing**,
  and discovery metadata — it does **not** relay the live control (consistent with "the dongle never
  needs WiFi / works in range offline").
- **Web GUI surface** (insights/dashboard — the same Vue app the asmltr Android app wraps): a Portal
  area to **register** a dongle, **discover** in-range dongles (BLE scan), show **status**, **trigger**
  provisioning of the plugged-in target, and **manage the module library** (push/sign/remove loaders).
  Any device running the asmltr web GUI, in BLE range, can drive a dongle.

## 9. Scope

**In (v1 target):** portal UI (screen + button menu), **BLE control link + loader engine** (signed
script-modules), Pangolin provisioning (via `mesh/`), profiles for **Linux / Windows / Android
(consented)**, consented one-click privilege elevation, setup **and** teardown, phone-bridge basics,
remote-desktop tie-in.

**Out:** **iOS as a provisioning *target*** (no USB provisioning path — Apple's design). *(iOS as a
**controller** — the asmltr app driving a dongle over BLE — is in-scope; BLE is why.)* **Lock-screen /
authentication bypass** (defeating auth = the intrusion line; unneeded for owned/consented hosts).
**Exploit/CVE-based access** is *not core* — only ever an explicit, authorized-engagement-only future
module, never the default path. **SoftAP / WiFi / USB-net connectivity** — deferred (see §3).

## 10. Toolchain
ESP-IDF 5.5.6, target esp32s3. Build → flash → verify: see [build.md](build.md).
