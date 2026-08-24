# Cross-channel send (copy & redirect)

A session that came in over one channel can deliver output through **any other channel** —
answer a Discord message but drop the file in a Telegram chat, mirror a status update to a
team channel, or reroute the whole reply somewhere else. This is the assistant's outbound
control plane: one unified `POST /send` on the connector manager that routes to whichever
connector owns the destination, and one CLI verb (`asmltr send`) that the agent can call from
inside a turn.

!!! note "How this differs from an inject"
    Cross-channel send is something **the session itself does** during a turn (it runs
    `asmltr send` as a tool call). An [operator inject](injection.md) is something an
    outside operator does *to* a session. Both ultimately hit the same `POST /send`, but the
    trigger is different.

## The unified `POST /send` (connector manager, `127.0.0.1:3024`)

Every connector type that can emit messages exposes an `/out` endpoint and advertises
`meta.outbound` in its type metadata. The manager's `POST /send` is a channel-agnostic front
door over all of them: you name a destination and a payload, and it forwards to the right
connector's `/out`.

```jsonc
// request — pick a destination by channel OR by a specific instance_id
{ "channel": "discord",            // connector TYPE; first enabled instance of it is used
  "instance_id": "…",              // OR target one specific connector instance directly
  "target": "123456789",           // channel/chat id (or an alias the connector understands)
  "kind": "text",                  // "text" | "file"
  "text": "shipping now",          // for kind:"text"
  "path": "/root/report.pdf",      // for kind:"file" — absolute path on the host
  "caption": "the report" }        // optional caption for a file

// response
{ "ok": true, "via": "discord:main", "…": "connector-specific result fields" }
```

Resolution rules (from `deliver()` in `connectors/manager/server.js`):

- `instance_id` wins if present; otherwise `channel` selects the **first enabled** instance of
  that type (falling back to the first instance of the type if none are enabled).
- The type must declare `meta.outbound`, and the instance must have an `http_port` — otherwise
  you get a `400` explaining which is missing. An unreachable connector returns `502`.
- `GET /send/targets` lists every outbound-capable destination (channel, instance id, name,
  enabled flag) — handy for a dashboard picker.

!!! tip "Attachments are channel-gated"
    `kind: "file"` only works on connectors whose type advertises attachment support
    (surfaced to the agent as `supports_attachments_out`). Text sends work on any
    outbound-capable connector.

!!! warning "Public Discord denies `asmltr send`"
    Even the owner cannot `asmltr send` from a public Discord channel (no email, no Telegram, no
    other Discord servers). Same-server posting is a separate verb: `asmltr guild-post` (Access
    cards tier 1–5 or owner). See [Discord → Same-guild post](../connectors/discord.md#same-guild-post-asmltr-guild-post).

## The agent verb: `asmltr send`

Inside a turn, the session reaches this through the `asmltr` CLI (via the Bash tool). The core
tells every session about it in the [ASMLTR TOOLBELT](awareness.md#the-toolbelt-in-every-system-prompt)
block of its system prompt, so it knows the verb exists without being told each time.

```bash
# text to another channel
asmltr send <channel> <target> "<text>"
asmltr send discord 123456789 "shipping now"

# a file/attachment (image, PDF, any file) on a channel that supports it
asmltr send <channel> <target> --file <abs-path> [--caption "…"]
asmltr send discord 123456789 --file /root/report.pdf --caption "the report"
```

`asmltr send` (see `cmdSend` in `cli/asmltr.js`) is a thin wrapper: it parses `--file` /
`--caption`, builds the `{ channel, target, kind, text|path, caption }` body, and `POST`s it to
the manager's `/send` (attaching `ASMLTR_MANAGER_TOKEN` as a bearer if set). On success it
prints `✓ sent … (<via>)`; on failure it prints the error the manager returned.

## Two patterns: copy vs. redirect

The channel where a message *arrived* replies automatically at the end of a turn — the core
turns the model's final text into a `reply` action for that connector. `asmltr send` posts
**elsewhere**. Combining the two gives you two distinct behaviours:

### Copy — post here **and** there

Run `asmltr send`, then reply normally **immediately and end the turn**. The `send` delivers
to the other channel; the origin-channel reply is the confirmation the person is staring at
(Discord "email sent", not a six-minute Working spinner). Do not wait on another session to
compose the mail. Do not poll. Do not send the same email again to "make sure" — if you are
unsure it arrived, say so here and wait for them to tell you. `--force` is only for "I never
got it." Same To + subject inside 30 minutes is refused as `already sent`.

```text
User (in Discord): "let the team channel know the build passed"

Agent:
  1. Bash: asmltr send discord <team-channel-id> "✅ build passed"
  2. Reply normally: "Done — I posted it to the team channel."
```

Result: the team channel gets the announcement **and** the user sees a confirmation where they
asked.

### Redirect — post **only** there

Run `asmltr send`, then end the turn with exactly `[[NO_REPLY]]`. The core recognizes that
sentinel and returns **no actions**, so the origin connector stays silent — the answer lives
only on the channel you redirected to.

```text
User (in Telegram): "put the full report in the #reports Discord channel"

Agent:
  1. Bash: asmltr send discord <reports-channel-id> --file /root/report.pdf --caption "monthly report"
  2. Reply with exactly: [[NO_REPLY]]
```

Result: the file lands in Discord; nothing is echoed back into Telegram.

!!! note "`[[NO_REPLY]]` is universal"
    The sentinel is handled in the core's `handle()` pipeline, not in any one connector:

    ```js
    if (/\[\[NO_REPLY\]\]/i.test(result.text || '')) return [];
    ```

    Because it short-circuits to an empty action list, **every** connector stays quiet — not
    just Discord. It's the general "I already delivered my answer elsewhere, post nothing here"
    signal. (An operator-aborted turn returns `[]` the same way — see
    [Session steering & injection](injection.md).)

## Making the agent aware it *can* attach here

When the **origin** channel itself supports attachments, the core adds an explicit note to the
system prompt with the exact command (pre-filled with this channel's id):

```text
ATTACHMENTS: THIS channel supports sending files. To attach a file HERE, write/produce it to a
path, then run `asmltr send <channel> <this-channel-id> --file <abs-path> [--caption "…"]`.
Do NOT tell the user you can't attach files here …
```

So on an attachment-capable channel the agent uses `asmltr send` to attach *to the current
conversation* too — it never has to claim it can't send a file or fall back to another channel.

## Gating

Cross-channel awareness is part of the toolbelt block, controlled by the same switches:

| Env var | Effect |
|---|---|
| `ASMLTR_SELF_AWARE` | `off` removes the whole ASMLTR TOOLBELT block (including the `asmltr send` instructions) from every system prompt. Any other value (or unset) keeps it on. |
| `ASMLTR_CROSS_CHANNEL` | Intended gate for cross-channel routing; keep it enabled where you want sessions to route out through other connectors. |
| `ASMLTR_MANAGER_TOKEN` | Bearer required by `POST /send` when set; `asmltr send` attaches it automatically. |

!!! warning "Redaction still applies to the origin reply"
    `asmltr send` payloads go straight through the manager to the target connector. The
    **origin-channel** reply (the normal text, or its absence under `[[NO_REPLY]]`) still passes
    through the core's output redaction layer like any other reply. Prefer `[[NO_REPLY]]` +
    `asmltr send` when you want a single clean delivery rather than a copy on both surfaces.

## Where it lives

| Piece | File |
|---|---|
| Unified `POST /send` → connector `/out` | `connectors/manager/server.js` (`deliver()`) |
| `GET /send/targets` (outbound destinations) | `connectors/manager/server.js` |
| `asmltr send` CLI verb | `cli/asmltr.js` (`cmdSend`) |
| `[[NO_REPLY]]` sentinel + toolbelt prompt | `core/src/server.js` (`handle()`) |

## See also

- [Cross-session announcements](announcements.md) — awareness notes between sessions (no
  channel side effects).
- [Session awareness (ls / map / who)](awareness.md) — see what other sessions are doing before
  duplicating work.
- [Session steering & injection](injection.md) — an operator reaching into a live session.
