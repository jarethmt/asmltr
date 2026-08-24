# Device registry & canvas — design

> **Status:** **P0 SHIPPED** (registry + vault-backed credentials). P1–P3 planned below; P4–P5 are
> roadmap only. This is the scoping document for the arc that turns the shipped remote-desktop
> capability (v0.13.0) into a general **device control plane**, and adds a **canvas** render surface
> on top of it.

## The distinction this arc is built on

asmltr already has registries for **services** — things it talks to over an API:

| Registry | What it holds | Where |
|---|---|---|
| Connector instances | Discord/Telegram/GitHub/MCP/email channels | manager SQLite + supervisor |
| Integrations | storage backends, API credentials | integrations registry + GUI |
| MCP registry | MCP servers the engine can call | `shared/mcp-registry.js` |
| Trust store | principals, identifiers, relationships, grants | `core/src/trust/store.js` |
| Vault | the secrets behind all of the above | TRUST Protocol vault |

There is **no registry for machines** — the things asmltr *drives* rather than *calls*. That is a
different category with different properties:

- **Service control** = an API call. Stateless, idempotent-ish, credential = one API key, blast
  radius = one vendor account.
- **Device control** = a session on somebody's actual computer. Stateful, long-lived, credential =
  a key that opens a shell or a mouse, blast radius = *everything on that machine*.

Remote desktop was the first device-control transport we shipped. SSH, ADB, serial and
wake-on-LAN are the same category. They all need the same thing underneath: a durable record of
**which machines exist**, **how to reach each one**, **whose credential opens it**, **who is
allowed to do what on it**, and **one place to take that away again**.

## Where the shipped remote desktop actually stands

What works today (proven end-to-end, `docs/REMOTE-DESKTOP.md`):

- Signaling broker (`connectors/types/remote-desktop/`) — SSE + POST signaling, own STUN, optional
  TURN, `/rd/{stream,msg,ice-config,cast,devices,health}`.
- Native Go host agent (`agents/host-remote-desktop/`) — screen capture, H.264, Pion WebRTC,
  `SendInput` injection, single self-contained binary.
- Mobile viewer + controller, dashboard host list, and **cast-to-device** (push a host's stream onto
  a connected phone via the android gateway's `open-remote-desktop` frame).
- Media flows **direct peer-to-peer** via ICE hole punching. The server never sees it.

That transport layer is sound and is not what this document changes. What it is missing is
everything *around* the transport:

### 1. The "registry" is a presence map, not a registry

The broker's host list is an in-process `Map`, populated only while an agent's SSE stream is open:

```js
const hosts = new Map();   // host_id → { res, name, identity, caps, since }
```

Consequences: a machine that is powered off simply **does not exist**; restarting the broker
forgets every machine; you cannot name, tag, annotate, pre-authorize, or audit a machine before it
connects; and the dashboard's "registry" can only ever show what is online this second.

### 2. Credentials live in a file, not the vault

Peer auth is a flat gitignored `keys.json` — `{ key, identity }` pairs, hand-edited, long-lived,
no expiry, no rotation, no issuance record. asmltr has had a hard dependency on the TRUST vault
since v0.5.0 and this bypasses it entirely. **Revoking a device today means editing a JSON file on
disk and restarting a connector.**

### 3. Grants are per-identity, not per-device

```js
view    = known principal && trust_tier >= 1
control = bypass_moderation          // full trust, globally
```

Both are properties of *the person*, evaluated once for the whole surface. There is no way to
express "this principal may control the workshop machine, view the lab machine, and not see the
client machine at all" — which is the normal shape of real device access, and the shape that makes
adding SSH safe.

### 4. Nothing exists below the screen

No SSH, no ADB, no serial, no wake-on-LAN — a repo-wide search finds no such transport anywhere.
Screen sharing is the *only* way asmltr can reach a machine, which means the only way to fix a
machine is to look at it and move its mouse.

### 5. Client config is device-local and manual

The app and the dashboard each hold a broker URL and a pasted token in `localStorage`. The phone
falls back to its device token; the dashboard is fed a token by an environment variable through a
gitignored compose file. Nothing about the fleet is *served* to a client — a client only knows what
it was configured with by hand.

### 6. Sessions are events, not an audit trail

Session open/close emit control events into the stream, but they are not anchored to a durable
device row, there is no per-device session history view, and there is no kill switch for a session
in flight.

### 7. The device-side gateways have the same gap

The android connector's device list is *also* an in-memory `Map` (`devices` + `controlDevices`).
So both directions — devices that talk to asmltr, and machines asmltr talks to — are ephemeral,
separately modelled, and unauditable. **They should be one table.**

## Proposal — endpoints as a first-class registry

### Data model

New tables, added to the existing trust database and keyed off `principals.id`. As with the cast,
**no second identity store** — a device's owner, and everyone granted access to it, are principals
that already exist.

- **`devices`** — `id`, `name`, `kind` (workstation · phone · sbc · appliance · printer),
  `platform`, `owner_principal_id`, `tags`, `notes`, `created_at`, `last_seen_at`, `status`.
  One row per machine, whether or not it is online, whether asmltr drives it or it drives asmltr.
- **`device_transports`** — `device_id`, `transport` (`rd` · `ssh` · `adb` · `device-gw` · `serial`
  · `http`), `address`, `params` (JSON), `credential_ref` (a **vault key**, never a value),
  `enabled`, `verified_at`. A machine can carry several: the same workstation is reachable by
  screen *and* shell.
- **`device_grants`** — `principal_id`, `device_id`, `transport`, `capability`
  (`view` · `control` · `shell` · `file` · `wake`), `expires_at`, `granted_by`, `revoked_at`.
  Same resolution semantics the trust store already uses: **default-deny, forbidden-wins**, union
  of matching grants.
- **`device_sessions`** — append-only: who, which device, which transport, which capability,
  start/end, originating surface. This is the audit trail *and* the thing a kill switch acts on.

### Credentials move into the vault

Every `credential_ref` resolves through `shared/vault.js`. Four wins that the current file cannot
give us:

1. **Issuance instead of hand-editing.** `asmltr device enroll` mints a one-time enrollment code;
   the agent (or phone, or desktop assistant) redeems it once for a per-device credential written
   to the vault. `keys.json` disappears.
2. **Revocation as one action.** Set `revoked_at` → the broker rejects the token, live sessions get
   `bye`, the SSH credential is rotated out. One click in the dashboard, one CLI verb.
3. **Use-but-never-see for shell credentials.** SSH keys go in as vault credentials the runtime
   proxies — the model never holds a private key in its context. This is a hard prerequisite for
   the SSH transport, not a nice-to-have.
4. **A registry read cannot leak a working credential.** *(Refined while building P0.)* The vault
   holds the value; the registry row stores only a **SHA-256** of it, next to the `credential_ref`.
   That is enough to VERIFY a presented token and not enough to reproduce one — so the hot path is a
   single indexed hash lookup with **no vault round-trip**, which is also what makes it fast enough
   to sit in front of every signaling message. Enrollment codes are stored hashed for the same
   reason.

### Per-device authorization

`resolveDeviceGrants(principal, device, transport)` replaces the two global booleans. The broker
keeps its defense-in-depth re-check on the agent side; the agent additionally refuses input
injection for a session the broker did not stamp. A principal with full trust is still not
automatically a controller of a machine that was never granted to them.

### Server-driven pass-through to clients

This is the piece that makes the phone robust rather than hand-configured. The app already holds
an authenticated link to its device gateway, so it should learn the fleet from the server:

```
GET /v2/devices?capability=rd
  → [{ id, name, kind, online, transports:[…], caps:{view,control} }, …]
     + a short-lived, single-session RD credential
```

No broker URL in `localStorage`, no pasted token, no stale config after a rotation, and a device
list that reflects *this principal's* actual grants. The same endpoint serves the dashboard, so the
gitignored-token injection currently propping up the dashboard view can retire too.

### Surfaces

- **Dashboard `Fleet.vue`** — absorbs `RemoteDesktop.vue`. Every machine (online *and* offline),
  its transports, who holds which grant, live sessions, per-session kill, per-device revoke,
  enrollment flow.
- **CLI** — `asmltr device ls | add | enroll | grant | revoke | sessions | cast | shell`.
- **MCP** — a `device_shell` tool alongside the existing phone-actuation tools, gated by the same
  grants, so the assistant's access is exactly the access the registry describes.

## Canvas — a render surface owned by the device

The second half of the ask. The goal is *not* an editor pane bolted onto a terminal: it is that
**any asmltr surface can be handed something visual to display**, and the surface decides how.

asmltr has already built this primitive twice without naming it:

- `kind:'file'` → a `media` frame the app renders **inline in the chat** (this is how screenshots
  already appear).
- `open-remote-desktop` → a frame that makes the app **navigate to a different surface** (the RD
  viewer, full-screen with its own controls).

**Canvas is the generalization of those two.** One frame kind, `canvas`, carrying a payload
(image · html · markdown · model preview · a live RD stream · a diff) plus a hint (`inline` ·
`window` · `fullscreen`). Each client honors it in its own idiom:

| Surface | Renders as |
|---|---|
| Mobile app | inline in the conversation, or its own activity for `fullscreen` |
| Desktop assistant | a borderless preview window beside the work |
| Dashboard | a canvas panel |
| Terminal/TUI | a link plus a one-line description (graceful degradation) |

**Targeting is a registry query, and that is the point.** "Open this on whichever device I'm
actually using" resolves as: the device with a live session → else the most recently active device
of this principal → else the dashboard → else a link. That is the same delivery-ladder shape
`asmltr notify` already uses for audio and text, applied to visual payloads — and it only works
because a device registry exists to rank against. Canvas is the feature that proves the registry is
modelled correctly.

## Desktop assistant — one binary, three roles

The existing desktop assistant predates asmltr entirely: a tray app with a global hotkey that posts
audio to an older voice endpoint. It should not be extended; it should be rebuilt against
`connectors/types/device`, which was written for exactly this ("a Pi kiosk, an ESP32, a desk buddy,
a custom appliance") and already carries turns, speech proxying, capability reporting, steer and
read-aloud.

The convergence worth noticing: on a workstation, **the assistant client, the remote-desktop host
agent, and the canvas window are the same program**. Today the first two would be two separate
binaries installed two different ways. One tray app that (a) is a device asmltr can converse with,
(b) is a host asmltr can view and drive, and (c) is a canvas sink asmltr can paint on, is both less
software and a better story. macOS is the same build target with a different capture and injection
backend.

Two carried-forward constraints for that build:

- **Screen capture must run in the interactive console session.** Launched from a service or an SSH
  session it captures an isolated blank desktop. The proven recipe is a scheduled task with an
  interactive principal.
- **Default the capture backend to the one that emits frames on a static screen.** GPU duplication
  only produces output when the screen *changes*, which reads as "connected but no video" on an idle
  desktop.

## Phasing

Ordered so that nothing dangerous ships before the thing that can revoke it.

| Phase | Scope | Why here |
|---|---|---|
| **P0** ✅ | `devices` + `device_transports` tables; enrollment; RD credentials migrated off `keys.json` into the vault | The foundation. Nothing else is safe or DRY without it. |
| **P1** | `device_grants` + `device_sessions`; revocation and session kill; `Fleet.vue`; `asmltr device` CLI | Per-device authorization and the one-click revoke that was explicitly asked for. |
| **P2** | Server-driven device list + short-lived session credentials to the app and dashboard | Removes hand-pasted config from every client. |
| **P3** | Canvas frame kind + app rendering + delivery ladder | First consumer of the registry beyond RD. |
| **P4** | SSH transport (vault use-but-never-see) + `device_shell` | Deliberately after P1 — a shell transport must never ship onto a system whose revocation story is "edit a file". |
| **P5** | Desktop assistant (device client + RD host + canvas window in one binary); ADB transport; wake-on-LAN; presence probing | The payoff surface. |

## Open questions

- ~~Does a device's *owner* get implicit full grants?~~ **Settled:** implicit, but written as a real
  grant row (`granted_by='owner-implicit'`) so it is visible and revocable rather than invisible
  policy in code.
- Should offline machines be probe-able (wake-on-LAN, ping, agent heartbeat), or is `last_seen_at`
  from the transports enough?
- Canvas payload ceiling — inline data for small images, upload-surface reference for anything
  larger. The upload surface already exists and should be reused rather than parallelled.
- Whether `device-gw` (the phone/kiosk direction) folds into the same table on day one or in P2.
  It should — one table is the whole DRY argument — but it touches a live channel.

---

# Implementation plan — P0 through P3

Concrete build plan for the first four phases. P4 (SSH) and P5 (desktop assistant, ADB) are out of
scope here by design: a shell transport must not ship before P1's revocation exists.

## Decisions to lock before any code

1. **One database, one identity store.** The device tables live in the existing trust database and
   reuse its handle (`require('../trust/store').db`). A device's owner and everyone granted access
   are `principals` rows that already exist. Same argument as the cast: no second identity store.
2. **One `devices` table for both directions.** A machine asmltr drives (screen, shell) and a device
   that drives asmltr (phone, kiosk, desk appliance) are the same row; `device_transports`
   distinguishes them. This is the whole DRY argument — but the *live* device gateway is not
   migrated until P2, because it touches a channel in active use.
3. **Vault key naming:** `device:<device_id>:<transport>`. The registry stores the reference; the
   value only ever lives in the vault.
4. **Owner grants — decide explicitly.** Either the owner of a device gets implicit full
   capabilities, or every capability is granted explicitly even to the owner. Recommendation:
   implicit for the owner, recorded as a real grant row with `granted_by='owner-implicit'`, so it is
   visible and revocable rather than invisible policy in code.

## P0 — registry + vault-backed credentials — **SHIPPED**

Two things came out different from the sketch below, both improvements found while building:

- **Token verification is a hash comparison, not a vault lookup.** `device_transports.token_hash`
  holds a SHA-256; the vault holds the value. This removed the performance risk flagged below *and*
  made a registry read incapable of leaking a credential.
- **Enrollment proxies through the broker** (`POST /rd/enroll`). The host agent can only reach the
  broker — core is not publicly exposed — so the broker forwards the redemption to core. It is the
  only `/rd` route reachable without a credential, necessarily, and is per-IP throttled.

**Done means:** a machine has a durable row whether or not it is powered on; its remote-desktop
credential is issued by asmltr into the vault; `keys.json` is gone.

| Action | File |
|---|---|
| new | `core/src/devices/store.js` — `devices` + `device_transports`, CRUD, additive-migration guard (mirrors `core/src/trust/store.js` structure exactly) |
| new | `core/src/devices/enroll.js` — mint a one-time enrollment code; redeem → per-device credential written via `vault.storeSecret()` |
| edit | `core/src/server.js` — `/v2/devices` CRUD, `/v2/devices/:id/enroll`, `/v2/devices/redeem` (code-authenticated, single use, short TTL) |
| edit | `connectors/types/remote-desktop/index.js` — replace `loadKeys()`/`keyEntry()` with a core-backed token lookup |
| edit | `agents/host-remote-desktop/config.go` — accept `--enroll <code>`, redeem once, persist the issued token; existing static `token` config keeps working |

**The one real engineering risk is the broker's auth hot path.** Today `auth()` reads a local file on
every SSE connect and every signaling POST. Replacing that with a network call to core would put a
round-trip in front of every ICE candidate. Mitigation: in-process cache keyed by a hash of the
token, ~60s TTL, negative results cached too, plus a `POST /rd/invalidate` that core pokes on revoke
so a revocation is not delayed by the TTL.

**Migration safety:** keep `keys.json` as a fallback that logs loudly when hit. Remove it only after
the enrolled path is proven.

**Verify:** create a row → enroll → redeem from the workstation → agent connects on the issued
credential → move `keys.json` aside → agent still connects → restart the broker → the row survives
and the host reappears on reconnect.

## P1 — grants, audit, revocation, surfaces

**Done means:** access is expressed per (principal × device × capability), one action revokes it,
and every session is on the record.

| Action | File |
|---|---|
| edit | `core/src/devices/store.js` — `device_grants`, `device_sessions`, and `resolveDeviceGrants(principal, device, transport)`: default-deny, forbidden-wins, expiry-aware — same semantics as `trust.resolve()` |
| edit | `core/src/server.js` — `/v2/devices/:id/grants` CRUD, `/v2/devices/:id/revoke`, `/v2/device-sessions` list + `DELETE /:sid` (kill) |
| edit | `connectors/types/remote-desktop/index.js` — the global `grants(identity)` becomes per-device; `list` returns only granted devices; `connect` checks the triple; open/close write `device_sessions`; `/rd/invalidate` drops live sessions with `bye` to both peers |
| new | `insights/dashboard/src/views/Fleet.vue` (+ router entry, redirect from `/remote-desktop`) — absorbs the existing cast UI, adds offline machines, grants, live sessions, revoke |
| edit | `insights/dashboard/src/services/api.js` — `devices.*` |
| edit | `cli/asmltr.js` — `asmltr device ls\|add\|enroll\|grant\|revoke\|sessions\|cast` |
| edit | `shared/console-manifest.js` — so the TUI and GUI settings both learn the new command from the one manifest |

**Verify by exercising the whole surface, not one happy path:** grant view-only on machine A to a
test principal → they can list and view A, control is refused, machine B is invisible; revoke mid-
session → the live session tears down; the audit rows exist and name the right principal.

## P2 — server-driven pass-through to clients

**Done means:** no client holds a hand-pasted broker URL or token, and the phone's own row is in the
same registry as everything else.

| Action | File |
|---|---|
| edit | `core/src/server.js` — `GET /v2/devices/for-me?capability=rd` → this principal's visible devices + a short-lived single-session credential (~5 min) |
| edit | `connectors/types/android/index.js` — expose it as `/gw/fleet` (the phone reuses its existing device token, so no new secret ships to the handset); register the device itself as a `devices` row with a `device-gw` transport |
| edit | `mobile/www/remote-desktop.js` — `loadCfg()` no longer requires a pasted token; fetch the fleet, use the ephemeral credential; keep manual entry only as out-of-band recovery |
| edit | `insights/dashboard/nginx.conf.template`, `gui-config.js` | retire the `ASMLTR_RD_TOKEN` injection; the dashboard uses its authenticated session |

**Verify:** wipe the phone's RD localStorage entirely → open the surface → hosts appear with nothing
pasted. Rotate a credential → the phone recovers on its own.

**Operational note:** this phase touches the live app channel. Every connector restart batches to the
very end of the working session.

## P3 — canvas

**Done means:** any surface can be handed something visual, and targeting resolves through the
registry.

| Action | File |
|---|---|
| new | `shared/canvas.js` — `canvas({ payload, hint, target })`; ladder = device with a live session → most-recently-active device of that principal → dashboard → link fallback. Structured like `shared/notify.js`, which already does exactly this for audio and text |
| edit | `connectors/types/android/index.js` — `/out` gains `kind:'canvas'` → pushes `{ type:'canvas', payload, hint }`, reusing the existing `registerMedia()` + `/gw/file` path for anything over the inline threshold |
| edit | `connectors/types/device/index.js` — same frame, so generic clients (and later the desktop assistant) get canvas for free |
| edit | `mobile/www/app.js` — handle `m.type === 'canvas'` beside `device_rpc` and `open-remote-desktop`; `inline` reuses `mediaBubble()`, `fullscreen` opens the new surface |
| new | `mobile/www/canvas.{html,js}` — the standalone renderer, same shape as `remote-desktop.html` |
| new | dashboard canvas panel |
| edit | `cli/asmltr.js` — `asmltr canvas <path\|-> [--hint inline\|window\|fullscreen] [--device <id>]` |
| edit | `mcp/toolbelt-server.js` — a `canvas_show` tool, so the capability is engine-agnostic |

**Reuse, don't parallel:** large payloads go through `shared/uploads.js`, which already exists, is
already token-scoped, and is already path-guarded. Canvas must not grow a second file path.

**Security — the one genuinely new exposure in this arc.** An `html` payload renders authored markup
on a trusted surface that holds device credentials. It must run in a sandboxed iframe
(`allow-scripts` **without** `allow-same-origin`), under a strict CSP, with no reach into the host
page's token or storage. Without that, canvas is an XSS vector straight into the assistant app.

**Verify:** phone in pocket, dashboard closed → lands on the phone inline. Phone idle, dashboard open
→ lands on the dashboard. Nothing reachable → returns a link rather than failing silently.

## Sequencing

P0 (~1 session) → P1 (1–2; this is the security core, do not compress it) → P2 (~1) → P3 (1–2).
Checkpoint before P1 and P2 — both rewrite live authentication paths.

Two things explicitly **not** done in this arc: no SSH transport until P1 has landed, and no
migration of the live device gateway's in-memory map until P2.
