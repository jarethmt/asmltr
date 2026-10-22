# Portal

A **Portal** is a physical key that manifests an asmltr agent on a device. Plug the USB dongle into a
machine, watch its screen narrate the process, and your assistant is enrolled onto that host and
reachable — no manual VPN setup, no hand-copied SSH keys. Pull it out, run teardown, and the link is
cleanly removed. A Portal is where an asmltr instance crosses into the real world on physical hardware.

Portals are first-class to an asmltr install: the firmware is tracked in the repo under
[`portal/firmware`](https://github.com/jarethmt/asmltr/tree/main/portal/firmware), and an asmltr
instance can **flash and provision a Portal straight from the dashboard** when one is plugged in — mint
its mesh identity, enroll it, and hand it its config in one step.

## The arc

1. **Plug in** to a target (your machine, or an authorized/consented host).
2. **Gets connectivity.** The Portal reaches the asmltr server over the **mesh** — directly over its own
   Wi-Fi when a known network is configured, or relayed through the paired phone app when it isn't.
   Either way the server sees one consistent mesh client.
3. **Detects the device** and runs the matching **profile** (Linux / Windows / Android / …).
4. **Enrolls the agent** — installs the assistant's access (SSH key / client) and registers the host.
   One clear, screen-narrated privilege prompt up front if elevation is needed.
5. **Confirms** — phones home, the screen shows a green check, the operator is notified.
6. **Teardown** (symmetric) — plug back in, pick Uninstall, the link is cleanly removed.

For unknown devices, the Portal makes its **deterministic attempts**; if they fail, it **escalates to the
assistant** live through the phone bridge, which improvises a way in — and that solution becomes a **new
profile in the library**.

## In this section

| Page | What's in it |
|------|--------------|
| [Hardware](hardware.md) | Verified Waveshare ESP32-S3 board pinout, specs, gotchas. |
| [Architecture](design.md) | Full design: profile/module system, connectivity stack, mesh backbone, phone bridge, screen+button UI, security/trust, scope. |
| [Build & flash](build.md) | Toolchain, build → flash → verify pipeline, staged roadmap. |
| [Control protocol](control-protocol.md) | The BLE GATT surface and the app's native bridge. |
| [Remote drive](drive.md) | How the assistant drives a host through a Portal (HID/CDC), status, headless default. |

## Principles

- **Authorization is the point.** Built for your gear and authorized/consented hosts; the operator owns
  the authorization call. Setup **and** clean teardown. Every enrollment logged and attributable.
- **Deterministic first, assistant for the unknown.** Canned profiles never "think"; the assistant is
  escalated to only for novel targets — and its solutions become deterministic profiles.
- **Mesh-native.** The Portal is a real node on the asmltr mesh (it speaks the Pangolin `olm` protocol
  natively in firmware), reached the same way regardless of which physical network carries it.
- **The screen is the magic trick.** Live, legible narration of exactly what's happening.
