# Integrations — what they are, and what they are not

> **Status:** architecture. Defines the boundary between core, connectors and integrations, and the
> schema every integration follows. The remote-desktop move (below) is the reference implementation.

## The definition

> **An integration is an OPTIONAL, per-install capability the agent reaches outward to use.**
> If asmltr requires it to function, it is core — regardless of which way it points.

Both halves are load-bearing, and a thing must pass both:

1. **Outward capability.** The agent initiates contact with something external in order to *do*
   something it otherwise could not.
2. **Optional.** asmltr runs correctly without it. It is configuration an individual operator adds
   for their own setup, and it differs between installs.

### The test is purpose, not socket direction

The naive reading — "who opens the connection" — fails immediately and would have us re-litigating
every case. The GitHub connector polls outward; a remote-desktop host agent dials out to the broker.
Neither fact decides anything. What decides it is **why**: GitHub carries a conversation (someone is
talking to the agent), remote desktop carries a capability (the agent is reaching a machine).

Ask: *does the agent initiate this to gain a capability?* Not: *which end opened the socket?*

### The corollary that settles most arguments

**Choosing a provider for a required subsystem is configuration, not integration.**

Swapping one speech provider for another is config — the speech layer exists either way, and
removing the choice does not remove a capability, it breaks a subsystem. Adding a remote storage
backend *is* an integration — without it nothing is missing, because local storage is the default.

This is why reasoning engines and the speech layer are **core** even though both reach outward and
both are configured per install. The agent cannot think without an engine. That is not optional, so
it is not an integration.

## Why the line matters

It is not tidiness. Getting this wrong put a screen-sharing broker into `connectors/types/`, where
it had to declare `outbound: { kinds: [] }` and document itself as "conversation-less: this is infra
signaling, not a chat channel." When a component has to announce that it is not what its category
says it is, the category is wrong.

It landed there for a mechanical reason, not a conceptual one: **connectors were the only place with
process supervision.** That is the actual defect this document fixes.

## Two orthogonal axes

Conflating "what capability does this give me" with "who runs it" is what forced the mistake. They
are separate questions and get separate fields.

### `kind` — what capability it yields

| kind | what it gives the agent | examples |
|---|---|---|
| `storage` | files | WebDAV/Nextcloud, S3, SFTP |
| `tools` | callable functions in a turn | MCP servers the agent calls, REST APIs |
| `transport` | access to a machine | remote desktop (WebRTC), SSH, ADB, serial |

A `transport` integration is distinguished by binding to a **device** in the registry: it is *how*
a machine is reached, and it is the only kind whose use is authorized per-device (see
[Device registry](DEVICE-REGISTRY.md)).

### `lifecycle` — who runs it

| lifecycle | meaning |
|---|---|
| `passive` | config plus a driver loaded on demand. Nothing runs until something opens it. This is what every integration does today. |
| `supervised` | a long-running process. Registered with the existing supervisor — reusing that machinery is the point; it is only the *taxonomy* that was wrong, not the supervision. |

With `lifecycle` expressed, a supervised service no longer has to masquerade as a channel to get
restarted when it dies.

## Schema

Integrations keep the registry's existing shape and conventions — this adds two fields, it does not
replace the model:

```jsonc
{
  "id": "int_ab12cd34",
  "type": "remote-desktop",      // driver id under integrations/types/
  "kind": "transport",           // storage | tools | transport
  "lifecycle": "supervised",     // passive | supervised
  "name": "Remote desktop broker",
  "config": {
    "http_port": 3028,
    "stun_urls": ["..."],
    "turn_secret_ref": "rd_turn_secret"   // *_ref = a VAULT KEY NAME, never a value
  }
}
```

The `*_ref` convention is unchanged and non-negotiable: any field ending in `_ref` holds a vault key
name, resolved at open time and never persisted in the clear.

## Where things live

| Core — required, every install | Integration — optional, per install |
|---|---|
| reasoning engines | storage backends (WebDAV/S3/SFTP) |
| speech layer (TTS/STT) | MCP servers the agent **calls** |
| TRUST vault | remote-desktop broker + host agents |
| trust store, the cast | SSH / ADB / serial transports |
| **device registry** (`devices`, `device_transports`, grants, sessions) | REST API tool links |
| connectors (channels) | |

Two placements deserve their reasoning stated, because both look ambiguous:

- **The device registry is core; the transports are integrations.** Every install has the registry —
  it is a data structure, and the Fleet surface renders it. *How* a given machine is reachable is
  optional and differs per setup. The registry describes machines; integrations supply the wires.
- **"MCP" names two opposite things.** `connectors/types/mcp` is where MCP *clients* reach the
  agent — inbound conversation, and it stays a connector. The MCP servers the agent *calls* are
  outbound optional tooling, and they are integrations. Same word, opposite directions.

## The symmetry worth keeping

- **Connectors + trust** govern the inbound question: *who may reach me, and what may they ask of me?*
- **Integrations + device grants** govern the outbound question: *what may I reach, and what may I do to it?*

Per-device grants were the first instance of outbound authorization. This gives them a home rather
than leaving them a device-shaped special case, and it is where any future outbound policy belongs.

## Guarding the definition

The failure mode is "integration" decaying into a junk drawer. The optionality half is the guard —
it is a hard filter, not a matter of vigilance. Anything that must exist for asmltr to work is core,
and no argument about it reaching outward changes that.

## Migration principle — never a big bang

Several things that *are* integrations by this definition are wired into the turn pipeline today
(the MCP servers the agent calls, in particular). Relocating them for tidiness risks live behaviour
for no functional gain.

1. Define the contract, add `kind` + `lifecycle` to the registry.
2. Move **remote-desktop** first — already misplaced, touches nothing conversational, and is the
   reference implementation for a `supervised` `transport`.
3. Absorb the rest opportunistically, each when it is being worked on anyway.

A thing in the wrong drawer that works is not an emergency. A thing moved carelessly that breaks a
live channel is.

---

# Implementation plan

Four stages. The last one — forwarding a live session into the mobile app as an interstitial — is
deliberately out of scope here and gets its own design.

## T0 — the integration platform

**Done means:** an integration can declare what it yields and who runs it, and a supervised one no
longer has to pretend to be a channel.

| Action | File |
|---|---|
| edit | `integrations/registry.js` — add `kind` + `lifecycle`, validate both, filter `list()` by either |
| edit | the supervisor — accept a `role` (`channel` \| `service`) so a supervised integration reuses the existing crash-restart machinery without being offered as an outbound channel |
| edit | `core/src/server.js` — `/v2/integrations` carries `kind`/`lifecycle`; `?kind=` filter |
| edit | dashboard Integrations view — group by kind, show lifecycle and health |

The supervisor change is the whole unlock, and it is small: supervision was always the right
mechanism, it was only ever labelled wrong.

## T1 — remote desktop becomes an integration (reference implementation)

**Done means:** the broker is a `transport`/`supervised` integration, and `connectors/types/` holds
only things that carry conversation.

| Action | File |
|---|---|
| move | `connectors/types/remote-desktop/` → `integrations/types/remote-desktop/` — the `meta` + `start(ctx)` contract is unchanged, so the supervisor keeps working as-is |
| edit | registry migration: create the integration entry from the existing instance config on first boot, so nothing needs re-registering by hand |
| edit | drop `outbound: { kinds: [] }` — the opt-out that revealed the miscategorisation is no longer needed |
| none | Traefik: same port, same public path — routing does not move |

## T2 — watch what the agent is doing (the headline)

**Done means:** when the agent drives a machine, an operator can open the web console and watch that
session live; and a human can drive from the browser without a phone.

Today there is **no viewer in the web console at all** — every line of viewer/controller logic lives
in `mobile/www/remote-desktop.js`. The fix is not a second implementation.

| Action | File |
|---|---|
| new | `shared/rtc/viewer.js` — the WebRTC viewer/controller lifted out of the mobile page: signaling, ICE, track handling, control channel. Framework-free; takes a video element plus callbacks, so both surfaces mount the same code |
| edit | `mobile/www/remote-desktop.js` — consume the shared module (no behaviour change; this is the regression risk to watch) |
| new | dashboard viewer panel in the Fleet row — view, and control when the grant allows |
| edit | broker — report per-host viewer count and live sessions so the GUI can offer "Watch" on a session already in progress |
| edit | `Fleet.vue` — a live session (including one owned by the agent) is clickable: **Watch** joins as an additional view-only viewer |

**Agent-owned sessions are already modelled.** P1 writes a `device_sessions` row for every
connection with the principal that opened it, so a session the agent opened is simply one whose
principal is `self`. Watching is joining that host as a second viewer — no new session concept, and
the audit trail records the observer separately from the driver.

**Concurrency is real but wasteful.** The host agent keys sessions in a map and its capture guard is
per-session, so N viewers genuinely work today — but each spawns its **own ffmpeg**, so watching the
agent means encoding the same screen twice. Ship it this way, then optimise: one capture fanned out
to N tracks. Worth doing before this is habitual, not before it works.

## T3 — SSH as a transport, and mirroring a shell

**Done means:** the agent can work in a shell on a registered machine, and that shell is watchable
live in the web console — the terminal equivalent of T2.

| Action | File |
|---|---|
| new | `integrations/types/ssh/` — `passive` lifecycle, credentials as `*_ref` vault keys, resolved at open |
| edit | device registry — `ssh` transport rows bind a device to that integration; the `shell` capability already exists in the resolver and is enforced unchanged |
| new | a session broker that owns the PTY and **fans out**: the agent's tool loop on one side, any watching web clients on the other. One shell, many observers |
| new | web terminal panel in Fleet, rendering the same stream |
| new | `device_shell` tool so the capability is engine-agnostic |

**Use-but-never-see is mandatory here.** SSH keys resolve through the vault at open time and are
never surfaced into a model's context. This is the reason the shell transport was sequenced after
per-device revocation existed, and that ordering still holds.

The fan-out shape is not new: asmltr already lets an operator watch and steer a live *conversation*
session. This is the same idea pointed at a machine session — and the two should feel alike.

## T4 — forwarding into the mobile app (separate design)

Pushing a live session to the phone as an interstitial builds on the same shared viewer module and
the existing `open-remote-desktop` push. Deliberately not specified here.

---

# T4 — one account, two uses: mail as an integration with an optional channel

> **Status:** architecture, agreed with the operator 2026-11-18. Extends the definition above; does
> not amend it. Email is the first case the original document did not consider, and it is not
> mentioned anywhere above.

## The case the definition did not cover

The test above is purpose: *does the agent initiate this to gain a capability?* It resolves GitHub
(conversation) against remote desktop (capability) cleanly, because those are different things.

It does not answer what happens when **one external account yields both.** A mailbox is:

- a **capability** — search it, read it, send from it, reach its calendar and contacts, on demand,
  mid-task, with no process running; and
- a **channel** — mail arrives unbidden and the agent may answer it.

Same credential. Same account. Both at once. The same is true of Discord (a conversation *and* guild
administration — `POST /channels`, `POST /servers` already live on the connector) and of Google
(mail, calendar, contacts, tasks under a single OAuth grant).

## The resolution: the integration is the base; the channel is optional and references it

**The authenticated link to an external account is an integration.** It is optional, per-install,
and the agent reaches outward through it. That is true of every mailbox we hold, including ones that
will never speak.

**A channel is an optional behaviour layered on top of one**, expressed as a connector instance that
**references** its integration by `integration_id`:

```jsonc
// integrations.json — the account link. No process. Always required first.
{ "id": "int_mail_jareth", "type": "mail", "kind": "tools", "lifecycle": "passive",
  "name": "jareth@thoughtspacedesigns.com",
  "config": { "imap_host": "…", "smtp_host": "…",
              "user_ref": "asmltr_mail_jareth_tsd",
              "password_ref": "asmltr_mail_jareth_tsd_password" } }

// connectors — ONLY for a mailbox that should answer on its own.
{ "type": "email", "integration_id": "int_mail_jareth", "enabled": true,
  "config": { "approval_policy": "auto_send_full_trust" } }
```

**It is a reference, not nesting.** That matters for three reasons, and it is the one place the
operator's framing ("the connector rides along inside the integration") is worth refining:

1. The document above places **connectors in core** and integrations in optional, and makes them
   symmetric — connectors+trust govern inbound, integrations+grants govern outbound. Nesting a core
   subsystem inside an optional record inverts that. A reference preserves it.
2. **The supervisor does not change.** A connector instance remains exactly what it is today, with
   its own health, restart and logs. Only its credentials now come from somewhere shared.
3. It still gives the operator the behaviour they asked for: the listener is **enabled or disabled
   from the Connectors pane**, independently of the account link, because it is a separate record.

This mirrors the reasoning already used above for devices: *the device registry is core; the
transports are integrations — the registry describes machines, integrations supply the wires.* Here:
**connectors describe channels; integrations supply the account.**

## What this deletes

`connectors/types/email` grew an **`ingest_only`** flag (2026-11-17) whose only job is to suppress
the thing that makes a connector a connector. Six mailboxes run supervised IMAP IDLE processes and
are forbidden from ever answering.

That flag is the smell this stage removes. Those six are integrations that were forced into a
connector costume because **a connector was the only way to attach a mailbox at all** — the same
mechanical reason that once put a screen-sharing broker in `connectors/types/`. The pathology
repeated; the document predicted it.

## Do they need a daemon at all? No.

Worth stating plainly, because it is the real prize. A passive mail integration runs **no process**.

Every operation performed across a full triage session on 2026-11-17 — inventory 927 messages,
classify, forward receipts, archive, read threads, send replies — was done with **on-demand IMAP
from a script**. The six supervised connectors contributed nothing to any of it. They were running
IDLE loops, writing thread state and staging attachments for mail nobody had asked about yet.

So the default is: **ingest nothing until asked.** Seven supervised email processes become **one**
(`eve@`, which genuinely answers), and six passive links that cost nothing until a session opens
them. That also removes a standing context-consumption risk — work was being done per inbound
message regardless of whether anyone wanted it.

A listener is justified when something must happen *without being asked*: answering mail, or a push
notification. Indexing "in case" is not that.

## Trust and audit

These live on the **integration**, not on a separate account object. An earlier draft of this stage
proposed an `account` layer above both; the operator rejected it correctly — many integrations are
not account-shaped at all (a backup target, a WebDAV root), so hoisting "account" to the base would
fit mail and misfit half the registry. The integration record is already the thing with an identity,
a credential and a lifecycle. Outbound authorization belongs there, next to the device grants that
the document above already places on that side of the symmetry.

## Staging — per the migration principle above

Never a big bang. `eve@` is a live channel and the six carry real client mail.

1. **Mail integration type**, passive. Prove it against a mailbox read-only.
2. **`integration_id` on connector instances**; credential resolution falls back to inline config so
   every existing connector keeps working untouched.
3. **Migrate the six** to integration-only. Their connectors stop; nothing else changes. Delete
   `ingest_only`.
4. **`eve@` last** — an integration plus a connector that references it. This is the only one where
   a mistake silences a working channel.
5. **Google** as a `mail` + `caldav` + `carddav` integration triple on one OAuth grant.
