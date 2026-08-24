# HTTP endpoints

Three host services expose HTTP APIs. **All bind `127.0.0.1`**. Ports are configurable (see
[Configuration & environment](config.md#ports-inter-service-urls)); defaults are shown below.

Core `/v2` HTTP is only a security boundary when it stays on loopback. It has no caller auth.
**Do not expose it** (no public bind, no unauthenticated reverse-proxy). If you front manager or
collector, put auth on that proxy — never punch a hole to core `/v2`.

| Service | Default | Source | Auth |
|---|---|---|---|
| **core** | `127.0.0.1:3023` | `core/src/server.js` | none (localhost only) |
| **manager** | `127.0.0.1:3024` | `connectors/manager/server.js` | `Bearer $ASMLTR_MANAGER_TOKEN` (if set) |
| **collector** | `127.0.0.1:3017` | `insights/collector/server.js` | reads/ingest: `Bearer $ASMLTR_INSIGHTS_TOKEN`; control: `Bearer $ASMLTR_INSIGHTS_CONTROL_TOKEN` |

When a token is unset the service warns at boot and runs open (dev mode).

---

## core — `127.0.0.1:3023`

The pipeline entrypoint plus session takeover/steer primitives and the trust framework CRUD.

### Message handling

| Method & path | Body | Returns |
|---|---|---|
| `POST /v2/handle` | an inbound **envelope** | `{ actions: OutboundAction[] }` |
| `POST /query` | `{ message, sessionId?, userId?, username?, platform?, apiKey? }` | `{ response, sessionId }` — back-compat shim for unmigrated channels |
| `GET /health` | — | `{ status, service, active }` |
| `GET /events/stream` | — | SSE feed of telemetry events (dashboard/CLI live view) |

`POST /v2/handle` runs the full pipeline (identity → prompt → moderate → session → SDK turn →
redact) under a global concurrency slot and a per-`conversation_key` lock. It returns an empty
`actions` array (connector posts nothing) when the turn is aborted or ends with `[[NO_REPLY]]`.

### Titles & announcements

| Method & path | Body | Returns |
|---|---|---|
| `POST /v2/title` | `{ text }` | `{ ok, title }` — cheap no-tools title (429 if one is already running) |
| `POST /v2/announce` | `{ text, target?, priority?, from?, ttl? }` | `{ ok, id, created_at, target }` — queue a cross-session awareness note |
| `GET /v2/announcements` | — | `{ announcements }` — currently-live announcements |

Announcements are a cross-session mailbox: a note is delivered into a target session's context
at the start of its next turn (`target` = `*`, a `conversation_key`, `surface:<channel>`, or
`identity:<key>`).

### Session takeover & steer

| Method & path | Body | Returns |
|---|---|---|
| `GET /v2/session/:key` | — | the session row, or 404 |
| `POST /v2/claim` | `{ conversation_key, by? }` | claims the session for a terminal (channel pauses; needs an engine id) |
| `POST /v2/release` | `{ conversation_key }` | releases a claim |
| `POST /v2/abort` | `{ conversation_key }` | aborts the in-flight turn (session survives + is resumable) |
| `POST /v2/inject` | `{ conversation_key, text, by?, interrupt? }` | **steer**: resume the session with operator text, route the reply back to the origin channel via the manager's `/send`; `interrupt:true` aborts the running turn first |

`/v2/inject` bypasses moderation (the operator is trusted) and redacts on the way out like any
public reply. See the [injection guide](../coordination/injection.md).

### Trust framework

The dashboard **Access** page drives these. `/trust/resolve` is also used by connectors to
authorize owner-only actions.

| Method & path | What |
|---|---|
| `POST /trust/resolve` | Resolve an envelope-shaped body to effective trust (`{ channel, sender, context }`) |
| `GET /trust/principals` · `GET /trust/principals/:id` | List / fetch principals |
| `POST /trust/principals` · `PATCH /trust/principals/:id` · `DELETE /trust/principals/:id` | Create / update / remove a principal |
| `POST /trust/principals/:id/identifiers` | Add an identifier (`{ surface, value }`) |
| `DELETE /trust/identifiers/:iid` | Remove an identifier |
| `GET /trust/roles` · `POST /trust/roles` · `DELETE /trust/roles/:id` | List / upsert / remove a role |
| `POST /trust/principals/:id/grants` · `DELETE /trust/grants/:gid` | Create / remove a grant |

See [Trust & permissions](../security/trust.md) for the model.

---

## manager — `127.0.0.1:3024`

Connector registry + supervisor + the unified outbound plane. All routes except `/health`
require `Bearer $ASMLTR_MANAGER_TOKEN` when a token is set.

### Types & instances

| Method & path | What |
|---|---|
| `GET /health` | `{ status, service, types }` (unauthenticated) |
| `GET /types` | Available connector types with their `configSchema` + `outbound` capability |
| `GET /instances` | All instances + live runtime status |
| `GET /instances/:id` | Instance detail + recent logs |
| `GET /instances/:id/logs` | Recent logs for one instance |
| `POST /instances` | Create `{ type, name, config, enabled? }` — validated against the type schema; started if `enabled` |
| `PATCH /instances/:id` | Update `{ config?, name?, enabled? }` — pass the **full merged** `config`; restarts if running |
| `DELETE /instances/:id` | Stop + remove |

### Lifecycle & per-channel toggles

| Method & path | What |
|---|---|
| `POST /instances/:id/start` | Enable + spawn |
| `POST /instances/:id/stop` | Disable + stop |
| `POST /instances/:id/restart` | Restart the child process |
| `GET /instances/:id/channels` | List channels the connector can reach (proxied to its own `/channels`) |
| `POST /instances/:id/channels` | Toggle whether a channel relays to core (no restart) |

### Unified outbound

| Method & path | Body | What |
|---|---|---|
| `POST /send` | `{ channel\|instance_id, target, kind?, text?, path?, caption? }` | Route a message OUT through a connector instance (resolves the instance, POSTs its `/out`) |
| `POST /announce` | `{ channel\|instance_id, target, text }` | Queue a deferred announcement, delivered after the next (re)start once the connector reconnects |
| `GET /send/targets` | — | List outbound-capable destinations `{ instance_id, channel, name, enabled, outbound }` |

Only connector types whose `meta.outbound` is set can receive `/send` (discord, telegram, mcp,
github; `openai` is request/response and has no push channel).

---

## collector — `127.0.0.1:3017`

Ingests the shared event stream, serves the read API, and hosts the privileged control plane.
Reads + ingest require `Bearer $ASMLTR_INSIGHTS_TOKEN`; control routes require
`Bearer $ASMLTR_INSIGHTS_CONTROL_TOKEN` (and, at the edge, an admins group).

### Ingest & reads

| Method & path | What |
|---|---|
| `POST /ingest` | Producers post one event or an array (shared-contract shape); returns `{ ingested }` |
| `GET /health` | `{ status, service }` |
| `GET /api/sessions` | Reconciled sessions (`?active=1` for live only, `?limit=`) |
| `GET /api/events` | Filtered event feed (`?surface=&identity=&session=&since=&limit=`) |
| `GET /api/usage` | Hourly token/attribution rollup (`?since=`) |
| `GET /api/system` | System metric samples (`?since=&limit=`) |
| `GET /api/notifications` | Sent notifications (`?limit=`) |
| `GET /api/brief` | Compact summary — active sessions + 24h token totals by surface (the morning-brief JSON) |
| `GET /api/search` | Which sessions have event text matching `?q=` (`?since=`); returns hit counts + snippets |
| `GET /api/who` | Which sessions recently touched `?path=` (`?since=`) — collision radar |
| `GET /api/map` | Where each active session is working, derived from recent tool file paths → git repo root (`?since=`) |

### Control plane (privileged)

| Method & path | Body | What |
|---|---|---|
| `POST /api/control/kill` | `{ session_id, hard? }` | Terminate a session's host process |
| `POST /api/control/stop` | `{ session_id }` | Stop a session's in-flight work |
| `POST /api/control/send-keys` | `{ session_id, text?, keys?, enter? }` | Type keys into a tmux-backed `asmltr claude` session (steer / interrupt) |
| `GET /api/control/diff` | `?session_id=` | Working-tree diff for a session |
| `POST /api/control/restart-daemon` | `{ target }` | Restart a supervised daemon |
| `GET /api/control/audit` | `?limit=` | Recent control-action audit (read-gated, not control-gated) |

### socket.io

The collector broadcasts over socket.io for live UIs:

- `event` — each ingested telemetry event
- `system-sample` — each metric sample
- `sessions-changed` — the reconciled session list changed
- `control` — a control action fired
