# The `asmltr` CLI

`asmltr` is the host-local terminal client for the assistant backend. It observes
every agent session the collector records, coordinates messages **out** through any
connector, takes over a running channel session, and launches monitored interactive
sessions — all from one binary.

Run with no arguments to open the [live TUI dashboard](#the-tui); otherwise it's a
set of one-shot subcommands.

```
asmltr                 live TUI dashboard
asmltr ask "<text>"    one local turn with the default engine (ivy: grok)
asmltr chat            local readline REPL over the same session (resume UUID)
asmltr ls              list active sessions
asmltr map             active sessions grouped by working dir (collision radar)
asmltr who <path>      which sessions recently touched a file/dir
asmltr brief           compact summary
asmltr events [..]     recent events  (--surface --identity --session --limit)
asmltr tail            live global event stream
asmltr watch <key>     live stream for one session
asmltr system          current system metrics
asmltr send <ch> <target> "<text>"   deliver a message OUT through any connector
asmltr announce "<text>" [--to T]    post a cross-session announcement
asmltr announcements                 list live announcements
asmltr attach <key>    claim a channel session + resume it in tmux
asmltr release <key>   end a takeover; channel resumes
asmltr kill <id>       SIGTERM an ephemeral session's pid
asmltr stop <id>       SIGINT an ephemeral session
asmltr diff <id>       git diff of a session's worktree
asmltr claude [args]   launch a monitored session on the Claude engine
asmltr gemini [args]   … on the Gemini engine
asmltr codex  [args]   … on the Codex engine
asmltr grok   [args]   … on the Grok engine
asmltr version         installed + per-service versions; whether an update is available
asmltr update          pull + install the latest & restart (verifies; auto-rolls-back)
```

!!! tip "Reasoning engines"
    `asmltr claude|gemini|codex|grok` each launch a wrapped, monitored, takeover-able session on that
    [reasoning engine](REASONING-ENGINES.md) (whichever CLI harnesses are installed). The `<agent-name>`
    command points at the **default** engine, chosen in Settings → Engines. `asmltr silo`, `asmltr backup`,
    and `asmltr vault` round out the toolbelt.

!!! note "Where it points"
    Every command talks to one of three host-local services. Defaults assume the
    standard host layout; override with env vars (see [Environment](#environment)).

    | Service | Default | Used by |
    |---|---|---|
    | collector | `http://127.0.0.1:3017` | reads (`ls`, `brief`, `events`, `tail`, `watch`, `system`, `map`, `who`) + control (`kill`, `stop`, `diff`) |
    | core | `http://127.0.0.1:3023` | takeover (`attach`, `release`) + `announce` / `announcements` + `ask` / `chat` |
    | connector manager | `http://127.0.0.1:3024` | `send` (outbound to any channel) |

---

## Observe

Read-only views over the collector's live session and event stream.

### `asmltr` (TUI) & `asmltr ls`

`asmltr` with no arguments opens the [TUI dashboard](#the-tui). For a quick
non-interactive snapshot, `asmltr ls` lists every active session.

```bash
asmltr ls
```

Prints a table — surface, kind, age, idle time, total tokens, multiplexer, and the
task/session key — one colour-coded row per active session, with a total at the foot.

### `asmltr brief`

```bash
asmltr brief
```

Renders the compact summary (the same JSON that backs the morning brief): active
session count, tokens burned in the last 24h broken down by surface, and a short
list of the currently-active sessions. Returns the `/api/brief` payload rendered for
the terminal.

### `asmltr events`

Recent events, newest last, with optional filters.

```bash
asmltr events --surface discord --identity someuser --limit 40
asmltr events --session discord:guild:123
```

| Flag | Meaning |
|---|---|
| `--surface <s>` | only events from one connector (`discord`, `telegram`, `github`, `mcp`, …) |
| `--identity <i>` | only events for one resolved identity |
| `--session <key>` | only events for one session key |
| `--limit <n>` | how many events (default `40`) |

Each line shows the timestamp, surface, event type, identity, a detail snippet, and
token counts when present.

### `asmltr tail` & `asmltr watch <key>`

Live event streams over the collector's socket.

```bash
asmltr tail                       # every event, every session
asmltr watch discord:guild:123    # one session only
```

`tail` prints the global event stream as it happens; `watch` filters to a single
`session_id`. Both run until `Ctrl-C`.

!!! tip
    `watch` needs `socket.io-client`. If it isn't installed, run
    `npm install` in the CLI directory as the error message instructs.

### `asmltr system`

```bash
asmltr system
```

The most recent host sample: CPU %, load 1/5, memory used/total, and disk
used %/free GB.

### `asmltr map` — collision radar

```bash
asmltr map
```

Shows **where sessions are actually working**, grouped by git repo. The collector
derives location from **real tool activity** — it reads file paths out of recent tool
events (last 30 min) and resolves each to its enclosing **git repo root** — *not* the
directory a session was spawned in. A session only appears once it touches files.

Repos with more than one active session are flagged
`⚠ N sessions — possible collision`, making it a fast way to catch two agents about
to step on each other in the same tree. Under each repo, sessions list their surface,
title, age, and the specific sub-directories they've hit.

### `asmltr who <path>`

```bash
asmltr who /root/projects/personal/asmltr/core
```

The inverse of `map`: given a file or directory, list every session that has
**touched that path** recently. The collector scans tool events (last 6h) whose
payload references the path, grouping by session with a hit count, age, and a sample
of what the session did there. Useful before editing a shared file — check nobody
else is in it.

### `asmltr announcements`

```bash
asmltr announcements
```

Lists live cross-session announcements (see [`announce`](#asmltr-announce) below)
with their id, timestamp, target, urgency, and expiry.

---

## Coordinate

Push messages **outward** through the running connectors, or broadcast context to
other sessions.

### `asmltr send`

Deliver a message out through **any** connector — cross-channel, from the terminal.

```bash
# text
asmltr send discord 123 "shipping now"

# a file attachment (image / PDF / anything the channel supports)
asmltr send discord 123 --file /root/report.pdf --caption "the report"
```

Usage:

```
asmltr send <channel> <target> "<text>"
asmltr send <channel> <target> --file <path> [--caption "<text>"]
```

- `<channel>` — connector name (`discord`, `telegram`, …).
- `<target>` — channel-specific destination id.
- Text mode posts the message; `--file` mode uploads a file, with an optional
  `--caption` (falls back to any trailing text).

Posts to the connector manager's `/send`; prints `✓ sent …` with the delivery route
on success, or the error on failure.

### `asmltr announce`

Post a **cross-session announcement** — a note delivered into *other* sessions'
context on their next turn.

```bash
asmltr announce "deploying to prod in 5 — hold merges" --to surface:discord
asmltr announce "incident: API down" --urgent --ttl 3600
```

Usage:

```
asmltr announce "<text>" [--to <target>] [--urgent] [--ttl <seconds>]
```

| Flag | Meaning |
|---|---|
| `--to <target>` | who sees it — `*` (all, default), a session id, `surface:discord`, or `identity:someuser` |
| `--urgent` | mark it urgent |
| `--ttl <sec>` | expire after N seconds |

Returns the announcement id, resolved target, and creation time. List live ones with
[`asmltr announcements`](#asmltr-announcements).

---

## Control / takeover

Reach into a running session — claim it, stop it, or inspect its changes.

### `asmltr attach <key>` / `asmltr release <key>`

Claim a live **channel** session and resume it interactively in **tmux**, so you can
drive it hands-on and detach without ending it.

```bash
asmltr attach discord:guild:123
# … work in the resumed claude session …
# detach with the tmux prefix + d; the channel stays paused
asmltr release discord:guild:123
```

`attach`:

1. Claims the conversation via the core (`/v2/claim`) — the channel is **paused** so
   the connector stops answering while you're in control.
2. Resumes the session's engine id in a fresh tmux session (`claude --resume …`) in
   the session's own working directory, then attaches your terminal to it.
3. On detach the session stays alive (re-attach with `asmltr attach` again). When
   `claude` exits, the channel is automatically **released**.

`release` kills the tmux session (if any) and releases the claim so the channel
resumes normally. With no TTY, `attach` creates the session and tells you to
`tmux attach -t <name>` manually.

!!! note "Takeover mechanics"
    This is the CLI face of session steering/injection. For the full model — how the
    reply routes back to the origin channel vs. types into the tmux pane — see
    [Session steering & injection](coordination/injection.md).

### `asmltr kill <id>` / `asmltr stop <id>`

Signal an ephemeral session's process directly (privileged — needs the control
token).

```bash
asmltr stop discord:guild:123          # SIGINT the process
asmltr kill discord:guild:123          # SIGTERM the pid
asmltr kill discord:guild:123 --hard   # SIGKILL after a grace period
```

- `stop` sends `SIGINT` (interrupt the current turn).
- `kill` sends `SIGTERM`; `--hard` escalates to `SIGKILL` after a grace period.

Both print the affected pid on success.

### `asmltr diff <id>`

```bash
asmltr diff discord:guild:123
```

Prints the `git diff` of a session's worktree — what the session has changed on disk
so far — or `(no changes)`.

---

## Sessions

### `asmltr claude [args]`

Launch an **interactive** Claude Code session that's wrapped for monitoring and
takeover. Everything after `claude` is passed straight through to the underlying
launcher.

```bash
asmltr claude
asmltr claude --resume
```

The session runs as a real interactive `claude` TUI (in a multiplexer, screen by default or tmux via
`ASMLTR_MULTIPLEXER=tmux`), while its events flow
to the collector like any other session — so it shows up in `ls`, `map`, `who`, the
TUI, and the dashboard, and can be steered/taken over. See the
[CLI-sessions connector](https://github.com/jarethmt/asmltr/blob/main/connectors/cli.md) for how these sessions are wired in.

---

## Update

Report the installed version and pull the latest, from the terminal.

### `asmltr version`

```bash
asmltr version
```

Prints the installed version, sha, and channel, then each host service's own version
(core, collector, manager), then whether an update is available. When the install is
behind, it reports how many commits and the `asmltr update` command to run; when it's
current it says so for the active channel.

### `asmltr update`

Fetch and install the latest, restart the services, and verify — the deterministic
updater, no LLM in the loop.

```bash
asmltr update                      # update on the current channel
asmltr update --dry-run            # print the plan + resolved target, change nothing (also -n)
asmltr update --channel stable     # newest release tag vX.Y.Z
asmltr update --channel edge       # origin/main
asmltr update --agent              # hand the update to a detached LLM session (fallback)
```

It runs in the foreground with `stdio: 'inherit'`, so the whole pipeline streams to your
terminal: preflight, lock, snapshot a rollback point, fetch, resolve the channel target,
git checkout, run the setup steps, reconcile `.env`, `npm install` on the root workspace,
rebuild the Docker dashboard, then restart all three services and check `/health` and the
`/version` sha. A failed verify rolls the update back on its own.

| Flag | Meaning |
|---|---|
| `--dry-run`, `-n` | resolve the target and print the step plan; stop before changing anything |
| `--channel stable\|edge` | `stable` = newest release tag `vX.Y.Z`; `edge` = `origin/main` (also `--stable` / `--edge`) |
| `--force` | reinstall the target even when already up to date (skip the short-circuit) |
| `--agent` | run the LLM escape-hatch updater, detached via core; watch it in the dashboard |

Exit codes: `0` ok, `1` preflight or usage, `2` rolled back, `3` manual intervention
needed, `4` already up to date, `5` another update is running, `6` externally managed.

---

## Environment

`asmltr` reads its endpoints and tokens from the environment. Defaults suit the
standard single-host layout.

| Variable | Default | Purpose |
|---|---|---|
| `ASMLTR_COLLECTOR_BASE` | `http://127.0.0.1:3017` | collector base URL (reads + control) |
| `ASMLTR_CORE_BASE` | `http://127.0.0.1:3023` | core base URL (`attach`/`release`, `announce`) |
| `ASMLTR_MANAGER_BASE` | `http://127.0.0.1:3024` | connector manager base URL (`send`) |
| `ASMLTR_INSIGHTS_TOKEN` | — | bearer for collector reads + socket auth |
| `ASMLTR_INSIGHTS_CONTROL_TOKEN` | — | bearer for privileged control (`kill`, `stop`, `diff`) |
| `ASMLTR_MANAGER_TOKEN` | — | bearer for the manager's `/send` |

!!! warning "Dev mode"
    With no `ASMLTR_INSIGHTS_TOKEN` set, the collector runs auth-disabled (dev
    mode) and the CLI's help footer shows `(no token — dev mode)`. In production
    the collector sits behind a reverse proxy and these tokens are required.

    If a command fails with a connection error, check the collector is running at
    the address shown in the footer.

---

## The TUI

Run `asmltr` with no arguments for the full-screen cockpit — an active-sessions
table, a live CPU chart, and a global event log, all updating in real time over the
collector's socket.

**Dashboard keys** (session table focused):

| Key | Action |
|---|---|
| `↑` / `↓` | select a session |
| `Enter` | open the **watch** view for the selected session |
| `k` / `x` | kill the selected session (with a confirm dialog) |
| `s` | open **connector settings** |
| `q` / `Ctrl-C` / `Esc` | quit |

### Watch view

`Enter` on a session opens a full-screen live stream of just that session — seeded
with recent history, then live-appended. Long tool output is preserved in full;
scroll with `↑↓`/`PgUp`/`PgDn`.

| Key | Action |
|---|---|
| `i` | **steer** — open a text box; the message is injected into the session and the reply routes back to its origin channel (or is typed into the tmux pane for CLI sessions) |
| `k` | **stop** the in-flight turn (the session survives and stays resumable) |
| `Esc` | back to the dashboard |

See [Session steering & injection](coordination/injection.md) for what `i` and `k`
do under the hood.

### Connector settings (`s`)

`s` opens a drill-down settings overlay with three levels:

1. **Instances** — every connector instance (● enabled / ○ disabled), by name and
   type.
2. **Instance** — one connector's interactive **panels** plus its config fields.
   Toggle booleans with `SPACE`, edit scalars with `ENTER`. A config change is
   validated against the connector's schema and **restarts** that connector.
3. **Panel** — a connector-declared panel. The built-in **Channels** panel is a
   live per-channel enable/disable list: `SPACE`/`ENTER` toggles a channel, `d`
   flips the default (listen-everywhere vs. allowlist), `r` reloads. Toggles take
   effect immediately — no restart.

`Esc` steps back a level (and closes at the top); `r` reloads the current level.
