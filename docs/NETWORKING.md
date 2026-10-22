# Networking plane & remote devices

asmltr reaches the machines and devices it manages over its **own** networking plane rather than
depending on a third-party VPN. This page is the map; each area has a deeper doc.

```
                         ┌──────────────────────────────────────────┐
   control (you) ──────▶ │  asmltr instance                          │
                         │   • device registry  (/v2/devices)        │
                         │   • mesh control plane (Pangolin + gerbil)│
                         └───────┬───────────────────────┬──────────┘
                                 │ WireGuard mesh         │ BLE (via the app)
                         ┌───────▼────────┐        ┌──────▼───────┐
                         │ enrolled hosts │        │ Portal dongle │──USB──▶ target
                         │ (ssh / rd …)   │        │ (asmltr-portal-*)      device
                         └────────────────┘        └──────────────┘
```

## The mesh (Pangolin networking plane)

A self-hosted [Pangolin](https://github.com/fosrl/pangolin) control plane + gerbil (WireGuard) + per-device
`olm`/`newt` clients. It rides your existing reverse proxy (external-Traefik mode) and binds nothing new to
the internet except the two WireGuard UDP ports. **asmltr ships no reverse proxy of its own** — the mesh is
the networking plane, not a competing ingress.

- **Design deep-dive:** [Pangolin backbone](PANGOLIN-BACKBONE-DESIGN.md).
- **Tooling:** `mesh/` in the repo — see its [README](https://github.com/jarethmt/asmltr/blob/main/mesh/README.md).
  Off unless `ASMLTR_MESH_DASHBOARD_URL` is set (see `.env.example`).

### `asmltr mesh` CLI

```
asmltr mesh provision                 # one-time bootstrap: server admin → TRUST vault, org, asmltr-OIDC IdP (SSO → Admin)
asmltr mesh status                    # live sites / clients / resources / the host SSH identity
asmltr mesh host-client [name]        # the olm client the asmltr host uses to REACH enrolled devices
asmltr mesh enroll <device> --os windows|linux    # register a device as a newt site; prints its install command
asmltr mesh resource <device> <name> --tcp <ports> [--to <dest>] [--client <name>]   # expose a private service (SSH, RDP…)
asmltr mesh sshkey [status|create]    # the host's main SSH identity — the key the Portal installs on a target's authorized_keys
```

`provision` also runs from `setup.d/050-provision-mesh.sh` during install/update (no-op when the mesh
isn't configured). Every operation is idempotent. Admin + per-device credentials live in the TRUST vault.

Two gotchas worth keeping (both encoded in the tooling): a **host-mode site-resource needs a non-empty
`alias`** or it never routes; a **Windows `newt` must run as SYSTEM** or its WireGuard never transmits.

## The device registry

Every managed machine — an enrolled mesh host, a Portal dongle, a workstation — is a row in
`/v2/devices` with pluggable **transports** (`rd | ssh | adb | device-gw | serial | http | ble`),
one-time enrolment codes → vault-stored credentials, owner principals, and per-capability grants
(view / control / shell / file / wake). See [Device registry](DEVICE-REGISTRY.md) and the
[device gateway connector](connectors/device.md). The dashboard **Fleet** view is the UI.

## Remote devices

- **Portal (BLE dongle):** discover / connect / register / (soon) provision a device from the app over
  Bluetooth LE. See [Portal](portal/index.md).
- **Remote desktop:** screen + input to an enrolled host. See [Remote desktop](REMOTE-DESKTOP.md).

## Identity & trust

Reaching a device is gated by the [Cast / trust](CAST.md) model and authenticated through asmltr's own
[identity provider](AUTH.md). The mesh dashboard logs in via asmltr SSO (which maps to an Admin role);
Portal modules are signed by the asmltr SSH identity and only a paired, trusted principal may load/run them.
