# mesh — asmltr's self-hosted networking plane

asmltr reaches the devices it manages over its own mesh instead of depending on a third-party VPN.
The mesh is [Pangolin](https://github.com/fosrl/pangolin) (control plane) + gerbil (WireGuard) +
`olm`/`newt` device clients. This module turns the one-time setup and ongoing device enrollment into
idempotent, scriptable operations so nothing has to be done by hand.

The control plane itself rides your existing reverse proxy (external-Traefik mode) and binds nothing
new to the public internet except the two WireGuard UDP ports. asmltr core ships **no** reverse proxy
of its own — the mesh is the networking plane, not a competing ingress.

## Configure (env)

The mesh is **off** unless `ASMLTR_MESH_DASHBOARD_URL` is set. See `.env.example`:

```
ASMLTR_MESH_DASHBOARD_URL=https://mesh.<base-domain>   # Pangolin control-plane origin (DNS-only → real IP; WG is UDP)
ASMLTR_MESH_BASE_DOMAIN=<base-domain>                  # admin becomes admin@<base-domain> (random pw → TRUST vault)
ASMLTR_MESH_ORG=<assistant-slug>                       # Pangolin org id (default: slug of ASSISTANT_NAME)
ASMLTR_MESH_SUBNET=10.200.0.0/20                       # overlay subnet — keep clear of Tailscale/Docker/host ranges
```

> **DNS:** the dashboard hostname must resolve to the host's **real** IP (grey-cloud / A record), not a
> CDN proxy — WireGuard is UDP and a proxy that only forwards HTTP will black-hole the data plane while
> the control plane (443) still works. That failure looks exactly like "connected but nothing routes".

## Commands

```
asmltr mesh provision                 # one-time bootstrap: server admin → vault, org, asmltr-OIDC IdP (SSO → Admin)
asmltr mesh status                    # live sites / clients / resources
asmltr mesh host-client [name]        # the olm client the asmltr host uses to REACH devices
asmltr mesh enroll <device> --os windows|linux
                                      # register a device as a newt site; prints its install command
asmltr mesh resource <device> <name> --tcp <ports> [--to <dest>] [--client <name>]
                                      # expose a private service on a site to a client (SSH, RDP, …)
asmltr mesh sshkey [status|create]    # the host's main SSH identity — the key the Portal installs on
                                      # a target's authorized_keys so asmltr can SSH in afterwards
```

`provision` is also run by `setup.d/050-provision-mesh.sh` during install/update (no-op when the mesh
isn't configured). Every operation is idempotent — safe to re-run.

Admin credentials and per-device `newt`/`olm` secrets are stored in the TRUST vault
(`shared/vault.js`, SACRED), never in env or on disk in plaintext.

## Two lessons encoded here (so you never debug them again)

1. **A host-mode site-resource needs a non-empty `alias`.** Pangolin only builds the alias→destination
   routing target (the thing that puts the resource's address into the client's WireGuard `allowedIPs`)
   when `alias` is set. Empty alias ⇒ the address never routes and every packet is silently dropped.
   `pangolin.addSiteResource()` refuses an empty alias; the CLI auto-derives `<name>.mesh`.

2. **A Windows device's `newt` must run as SYSTEM.** Launched as a normal user the WireGuard adapter is
   created but never transmits — the tunnel sits one-way. `deviceinstall.newtWindows()` registers a
   SYSTEM scheduled task (`RunLevel Highest`) so it works and persists across reboots.

A co-resident Linux `olm` client also gets its own interface name (`olm-<org>`, to avoid colliding with
any other Pangolin/Tailscale membership on the host), `-override-dns=false`, and a `ts-input` firewall
punch — all in `deviceinstall.olmLinux()`.

## Files

| file | purpose |
|------|---------|
| `config.js` | resolve mesh config from env; vault key names; subnet math |
| `pangolin.js` | authenticated Pangolin API client (static-CSRF header, cookie jar, typed ops) |
| `index.js` | `provision` / `ensureHostClient` / `enrollSite` / `addResource` / `status` |
| `deviceinstall.js` | generate device install commands (Windows SYSTEM task, Linux systemd olm/newt) |
| `sshkey.js` | detect / create the host's main SSH identity; expose its public key (never the private) |
