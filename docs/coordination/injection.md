# Session steering & injection

asmltr lets an **operator reach into a live, running session** — stop what it's doing and/or inject a
message to steer it — from the `asmltr` TUI or the web dashboard. This is "background session
injection": the session keeps running on the host (behind a channel, or in a tmux pane), and you
redirect it out-of-band without being the one who originally started the conversation.

There are **two mechanisms**, chosen automatically by session type. They feel the same in the UI but
work very differently underneath.

| | **SDK / channel sessions** | **CLI sessions** |
|---|---|---|
| Examples | discord, telegram, mcp, github | `asmltr claude` (interactive Claude Code in tmux) |
| Runs as | the core's local Agent SDK turn | a real interactive `claude` TUI process |
| Inject via | **core** `POST /v2/inject` (resume-with-text) | **collector** `POST /api/control/send-keys` (types into the pane) |
| Stop via | `POST /v2/abort` (abort the in-flight turn) | send-keys `Escape` / `C-c` (interrupt) |
| The reply | routed back to the **origin channel** | appears in the session's own terminal |
| Full takeover | — (steer only) | `tmux attach -t <target>` (grab the live terminal) |
| Identified by | `multiplexer` ≠ `tmux` | `multiplexer === 'tmux'` (+ a `tmux_target`) |

Both are exposed the same way in the clients:
- **TUI** (`asmltr`): open a session's **watch** view → `i` to steer (inject), `k` to stop.
- **Dashboard**: click a session card → the **conversation-details pane** → type + **Send**, or **Stop/Interrupt**.

---

## 1. SDK / channel sessions — steer via the core

A discord/telegram/mcp/github conversation is a **core session**: `conversation_key → engine_session_id`
in the `sessions` table, run through the local Agent SDK. To steer it you resume that same session with
your text and let the reply flow back out to wherever it came from.

### The reply needs to know where to go: the outbound route

The connector that *started* the conversation is the thin I/O layer — the core normally replies by
returning text to the connector that called it. But an **inject arrives out-of-band** (from the TUI /
dashboard, not from the channel), so the core has to remember the return address.

Every time a turn runs, `handle()` records the session's **outbound route** onto its row:

```
outbound_instance_id  ← the connector instance   (parsed from conversation_key, e.g. discord:<instanceId>:channel:<id>)
outbound_target       ← the channel/chat id       (from channel_context.channelId || chatId || target)
```

(`sessions.setOutboundRoute(key, instance_id, target)`.) That's the address a later inject replies to.

### `POST /v2/inject` (core, `127.0.0.1:3023`)

```jsonc
// request
{ "conversation_key": "discord:<instanceId>:channel:<id>",
  "text": "also cover the pricing angle",
  "by": "dashboard",
  "interrupt": false }               // optional; default false — see step 1

// response
{ "ok": true,
  "reply": "Sure — here's the summary…",
  "delivered": true,                 // was the reply POSTed to the origin channel?
  "deliverErr": null,                // or e.g. "no stored outbound route for this session"
  "route": { "instance_id": "…", "target": "…" } }
```

What it does, in order:

1. **Queue behind the current turn (default) — don't abandon in-progress work.** A steer does **not**
   abort a running turn by default: `withKeyLock` serializes per session, so the current turn *finishes*
   and the steer runs *next*, continuing from it. That's why you don't lose in-progress research. Pass
   **`interrupt: true`** to abort the running turn first and redirect immediately (abandoning it).
2. **Resume + run, framed as steering.** `resolveForTurn(key)` gives the `resume` id. When the session was
   mid-task, the text is wrapped as *operator steering* — "incorporate this into the work you're already
   doing and continue; don't restart or answer it in isolation" — so the model course-corrects instead of
   treating your note as a brand-new question. `runTurn({ prompt, resume, cwd })` runs it as the next turn
   of that same session. Tool / thinking / tool-result events stream to the collector so the pane stays live.
3. **Redact + record.** The reply passes through `redactSecrets()` (same masking as any public output) and
   is logged as an `outbound` event with `injected: true`.
4. **Route it home.** If the session has a stored outbound route, the core POSTs the reply to the manager
   `POST /send { instance_id, target, text }`, which forwards to that connector's `/out` — so it lands in
   the original Discord channel / Telegram chat / etc. `delivered` reports whether that succeeded.

> The operator is trusted, so an inject **bypasses moderation** — but the reply is still redacted on the
> way out, exactly like a normal channel reply.
>
> Because a default steer waits for the current turn, the HTTP call can take a while (it returns the
> steered reply when it's done). Use `interrupt: true`, or the **Stop** button, when you need *now*.

### `POST /v2/abort` (core)

```jsonc
{ "conversation_key": "discord:<instanceId>:channel:<id>" }   // → { "ok": true, "aborted": "<key>" }
```

Aborts the in-flight turn for that key. **The session is not killed** — its `engine_session_id` is
untouched, so the next message (or a later inject) resumes it. `404` if nothing is in flight.

The aborted turn is **silent**: `handle()` sees its own `AbortController` fire, recognizes the operator
stopped it, and returns **no actions** — so the connector posts *nothing* to the channel (no
"I hit an error"). The same is true for a steer sent with `interrupt: true`.

---

## 2. CLI sessions — send keys into the tmux pane

`asmltr claude` runs an interactive Claude Code TUI inside a **multiplexer** session — **screen** by
default, tmux via `ASMLTR_MULTIPLEXER=tmux` (see the launcher in `cli/asmltr-engine.js`, which
generalizes this to any reasoning-engine CLI). There is no SDK turn to resume — it's a live terminal
program. So "injection" here means literally **typing into its pane**, and "takeover" means
**attaching to that multiplexer session**.

How such a session gets on the dashboard in the first place:

- the wrapper registers it in a tracker (`~/.asmltr/cli-sessions.json`) that the collector's
  `reconcile.js` mirrors into the `sessions` table (with `multiplexer: 'tmux'` + a `tmux_target`);
- a **transcript tailer** (`cli/lib/claude-tailer.js`) streams the session's `~/.claude/**/*.jsonl`
  into the collector `/ingest` as inbound/thinking/tool/tool_result/outbound events — that's the live
  conversation you see in the details pane.

### `POST /api/control/send-keys` (collector, `127.0.0.1:3017`)

```jsonc
{ "session_id": "asmltr-cli-<id>", "text": "run the tests", "enter": true }   // type a line + press Enter
{ "session_id": "asmltr-cli-<id>", "keys": "Escape" }                          // interrupt the current turn
{ "session_id": "asmltr-cli-<id>", "keys": "C-c" }                             // send Ctrl-C
```

Backed by `control.sendKeys()`, which runs `tmux send-keys -t <tmux_target> …`. It refuses any session
without `multiplexer === 'tmux'` + a `tmux_target` (you can only send-keys into an `asmltr claude`
session), and every action is written to the control-plane audit log.

### Full takeover

The details pane shows the attach command; run it in any terminal to grab the live session:

```bash
tmux attach -t asmltr-cli-<id>
```

Detach again with `Ctrl-b d` and it keeps running + monitored. Quitting claude ends it.

---

## How the clients reach these endpoints

```mermaid
flowchart LR
  subgraph clients
    TUI[asmltr TUI]
    DASH[web dashboard]
  end
  subgraph host [host · 127.0.0.1]
    CORE["core :3023<br/>/v2/inject · /v2/abort"]
    COLL["collector :3017<br/>/api/control/send-keys"]
    MGR["connector manager :3024<br/>/send"]
    CONN["connector /out"]
    TMUX["tmux pane<br/>(claude TUI)"]
  end
  CH[(origin channel)]

  TUI -->|channel session| CORE
  DASH -->|channel session| CORE
  TUI -->|CLI session| COLL
  DASH -->|CLI session| COLL
  CORE -->|route reply| MGR --> CONN --> CH
  COLL -->|tmux send-keys| TMUX
```

- The **dashboard** is a static SPA; its nginx proxies `/v2/*` → core and `/api/control/*` → collector,
  injecting the right bearer server-side (see `insights/dashboard/nginx.conf.template`). Public access is
  gated by asmltr's [built-in auth](../AUTH.md) — every proxied backend path runs an `auth_request` to the
  core's `/v2/auth/verify`, so only a signed-in (login + 2FA) operator can steer. (An external
  authenticator like Authelia is optional — see [dashboard deployment](../deployment/dashboard.md).)
- The **TUI** calls the core (`ASMLTR_CORE_BASE`) and collector (`ASMLTR_COLLECTOR_BASE`) directly on
  localhost.

## Security notes

- `/v2/*` and `/api/control/*` are **localhost-only**; nothing binds a public interface. The dashboard is
  the only public door and it is gated by the built-in auth (`/v2/auth/verify`) to specific users.
- Control routes take the stronger **control token** when one is set (`ASMLTR_INSIGHTS_CONTROL_TOKEN`);
  the authenticated principal forwarded as `Remote-User` (from the built-in auth, or an external
  authenticator if one is in front) becomes the audit actor.
- Injection bypasses moderation (trusted operator) but SDK replies are still **redacted** before they
  leave the box. tmux send-keys goes straight to the terminal — treat it like typing at the keyboard.

## Where it lives in the code

| Piece | File |
|---|---|
| `/v2/inject`, `/v2/abort`, outbound-route capture | `core/src/server.js` |
| outbound route storage (`setOutboundRoute`) | `core/src/sessions.js` |
| unified outbound `POST /send` → connector `/out` | `connectors/manager/server.js` |
| `send-keys` control + audit | `insights/collector/control.js`, `server.js` |
| CLI launcher + transcript tailer + reconcile | `cli/asmltr-engine.js`, `cli/lib/claude-tailer.js`, `insights/collector/reconcile.js` |
| TUI steer/stop | `cli/tui.js` |
| dashboard conversation-details pane | `insights/dashboard/src/components/SessionDetail.vue` |
