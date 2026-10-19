# asmltr Pangolin Backbone — Design

The self-hosted mesh that connects an asmltr instance to all its devices, replacing the Tailscale
dependency. Ships with core; the asmltr Portal (`../../asmltr-portal/`) provisions devices onto it.

Status: design (2026-10-19). Not yet deployed — asmltr currently rides Tailscale.

---

## 1. Decisions (locked)

- **Control plane lives on the asmltr node** — wherever the main asmltr server is installed. That node
  is the first Pangolin node and runs the control plane (dashboard + Gerbil/WireGuard + Traefik).
- **Provisioned at install**, as a new `setup.d/` step (asmltr already has the step-runner + updater).
  The **updater offers/stands up Pangolin** for existing installs that don't have it yet.
- **Backbone-agnostic in code, Pangolin-primary.** Tailscale demoted to legacy/fallback.
- **Ops burden is Eve's** — accepted; Eve operates the backbone.

## 2. Topology

```
            PUBLIC endpoint (domain + WG UDP + HTTPS)
                        │
   ┌────────────────────┴─────────────────────┐
   │  asmltr node: Pangolin control plane      │   (dashboard + Gerbil WG + Traefik)
   │  org per instance (e.g. org "asmltr")     │
   └───────┬───────────────────────┬───────────┘
           │ Olm clients            │ Newt site-connectors
     devices (Yoga, laptops,   whole private networks
      the Portal itself)        (home LAN, an org's net)
```

- **Olm** = individual-device client (the common case; what the Portal installs).
- **Newt** = site connector for a whole network.
- Clients bind to **site-resources** (specific host:port services), not whole sites — least-privilege.

**Prerequisite (the one real cost):** the asmltr node needs a **publicly reachable endpoint** — a
domain/subdomain, the WireGuard UDP port open, and HTTPS for the dashboard (via the node's Traefik).
Verify at deploy: node public IP/reachability, chosen subdomain, WG port.

## 3. Provisioning contract (Portal ↔ asmltr ↔ Pangolin)

Reuses the proven 3DPGH admin-API pattern (`reference_pangolin_machine_client_provisioning`):

1. **Portal → asmltr enrollment endpoint** with a **scoped, short-lived token** (+ detected OS, desired
   node name).
2. **asmltr → Pangolin admin API** (org-scoped key, in BWS — never root):
   - `GET /v1/org/{org}/pick-client-defaults` → `olmId`, `olmSecret`, free `subnet`.
   - `PUT /v1/org/{org}/client` → **machine** client (`type=olm`, `userId:null`). Returns `clientId`.
   - `POST /v1/client/{clientId}/site-resources` → grant the services the agent needs (SSH 22, RDP 3389,
     remote-desktop relay). Client `sites` are derived from granted resources.
3. **asmltr → Portal**: returns Olm config (`OLM_ID`/`OLM_SECRET`, endpoint), the agent's SSH pubkey,
   node name, and the resource list.
4. **Portal/host**: installs Olm + applies config as a service; configures access (see §4).
5. **Confirm**: host appears on the overlay → asmltr verifies reachability → `asmltr notify`.
6. Creds stored in BWS as `pangolin_<node>-mc_olm_id/secret`; **ephemeral/revocable** — teardown
   deletes the client + grants.

**Footgun mitigations (baked in):** run Olm **without `-override-dns`** (it claims `~.` → DNS blackout)
+ `/etc/hosts` pin for resource names; watch for WG-peer-wedge (restart peer). Both learned on 3DPGH.

## 4. Enrollment payload per OS (SSH **and** remote desktop)

Enrollment sets up **both** reachability and the agent's access methods:
- **Windows** (first dogfood target — the Yoga): Olm Windows service; enable/configure **RDP** (native,
  port 3389) + **SSH** (OpenSSH; Yoga already has it). Grant site-resources for 3389 + 22.
- **Linux**: Olm systemd unit (static binary, `HOME=/opt/olm/data`); SSH key install; remote-desktop via
  the asmltr remote-desktop path (console over SSH; GUI via VNC/virtual-framebuffer relay over the overlay).
- **macOS**: later.

Remote desktop ties into the existing asmltr remote-desktop work — the Portal provisions the backbone +
access; that work is the viewer (the "circular pie").

## 5. Manual Yoga (Windows) validation — DO THIS BEFORE AUTOMATING

Prove the whole chain by hand before wrapping it in a Portal profile:
1. Stand up the asmltr Pangolin control plane on the asmltr node (public endpoint, org, admin key in BWS).
2. Create an Olm **machine** client for the Yoga via the admin API; grant site-resources 3389 (RDP) + 22 (SSH).
3. Install Olm on the Yoga (Windows service), apply creds, join the overlay (no override-dns).
4. Verify from Eve: SSH to the Yoga **over the Pangolin overlay** (not Tailscale); then **RDP** / the
   remote-desktop relay → confirm live screen. This also finally tests the untested remote-desktop path.
5. Only then: encode the exact sequence as the Portal's **Windows profile** + teardown.

## 6. Federation (future — "cross-join")

Most asmltr instances will already run their own Pangolin. Federation = **peering two existing networks**
(a cross-join), not nesting one inside the other. Parked until single-instance + Portal enrollment is solid.

## 7. Auth tie-in (see §9.3 — now core, not future)

Pangolin can act as/integrate an OIDC IdP (`reference_pangolin_oidc_idp_setup`), which dovetails with the
asmltr-as-IdP direction (epic #27) and a future Portal-as-FIDO2-key. Downstream of the above.

## 8. Open items to confirm at deploy
- asmltr node public reachability + chosen subdomain + WG UDP port.
- Pangolin deploy method/version on the node (Docker compose; align with 3DPGH's).
- Org naming (single `asmltr` org vs per-instance).
- Windows Olm packaging (service install, static olm.exe).

---

## 9. Product integration — shipped in asmltr core (not a one-off)

This is a first-class asmltr feature in the main repo, wired into the existing systems.

### 9.1 Install / update / wizard
- New **`setup.d/050-pangolin.*`** step: detects reachability (see §9.2), and — if the user opts in —
  deploys the Pangolin control plane (Docker: pangolin + gerbil + traefik), creates the `asmltr` org,
  stores the admin API key in the TRUST vault / BWS, and registers Pangolin behind asmltr auth (§9.3).
  Idempotent: re-running (the **updater**) detects an existing/absent Pangolin and **offers to stand it
  up** for installs that predate the feature — exactly the "update handles it" requirement.
- The step is **opt-in and flag-gated** (consistent with `ASMLTR_AUTH`'s additive philosophy): a install
  that doesn't want a bundled mesh is never forced into one.
- Config lands in `.env` via `reconcile-env.js` (e.g. `ASMLTR_PANGOLIN=on`, derived URL, org name, ports).
- **Wizard-aware:** the agent-driven install (`INSTALL-WITH-AGENT.md`) and any future first-run GUI wizard
  surface the mesh decision (enable? domain? reachability tier?) rather than silently choosing.

### 9.2 Domain & reachability tiers (asmltr may have no domain)
Pangolin's cross-network magic needs a reachable endpoint; the installer detects which tier applies and
configures accordingly — never assuming a domain:
- **Tier A — public domain** pointed at the node: derive a **subdomain from the user's chosen domain**
  (e.g. `mesh.<their-domain>`), real Let's Encrypt TLS, full public overlay + dashboard. Ideal.
- **Tier B — public IP, no domain:** use an IP-literal host or a wildcard-DNS helper (`sslip.io`/`nip.io`)
  so TLS still works; WireGuard rides IP:port. Full function, slightly rougher URL.
- **Tier C — no public reachability (local/LAN only):** the mesh still links devices that can reach the
  node, but "join from anywhere" is unavailable; documented as degraded/local-only, with a clear prompt to
  add a domain/public endpoint later to unlock full function. (The Portal's BLE-tether/host-internet paths
  can still bootstrap a device onto a locally-reachable control plane.)
- The subdomain is **always derived from whatever the user actually has**, computed at setup — never
  hard-coded, never assumed.

### 9.3 Auth — tie into asmltr's own identity plane
asmltr already is/【becomes】a **forward-auth gate + full OIDC provider** (`docs/AUTH.md`). The bundled
Pangolin **reuses it** — single sign-on, no second credential store:
- **Dashboard gating:** put the Pangolin web UI behind asmltr **forward-auth** (the reverse proxy calls
  `/v2/auth/verify`) — the parity path, works with no per-app integration. Where richer SSO is wanted,
  register Pangolin as an **OIDC client** of asmltr's provider (Pangolin supports OIDC IdP integration —
  see `reference_pangolin_oidc_idp_setup`). Either way asmltr is the IdP.
- Identities map to the existing **Cast/trust** principals, so "who can provision / reach what over the
  mesh" is governed by the same trust model as everything else in asmltr.
- The Portal's enrollment token is minted by asmltr auth and scoped — the Portal authenticates *as a
  trusted provisioner* via the same plane (and the future Portal-as-FIDO2-key logs in through it too).

### 9.4 GUI awareness + link
Add a **Network / Mesh** view to the Vue dashboard (`insights/dashboard`, alongside Integrations/Silos):
- Shows Pangolin status (running / not deployed / degraded-tier), node count, and health.
- A **"Open Pangolin" button** linking to the configured dashboard URL (from §9.2), shown only when a
  Pangolin is present. If not deployed, the view offers to stand one up (calls the setup step).
- A global hint if the mesh is in a degraded tier (e.g. "add a domain to enable join-from-anywhere").

### 9.5 Repo layout (where it lives)
- `setup.d/050-pangolin.*` (provision/offer), `scripts/` helpers for admin-API client minting (shared by
  the Portal), `core/` endpoints for enrollment + status, `insights/dashboard/src/views/Mesh.vue` + route,
  `docs/PANGOLIN-BACKBONE-DESIGN.md` (this), config in `.env.example`/`reconcile-env.js`. All in the main
  asmltr repo — a shipped capability, versioned with core.
