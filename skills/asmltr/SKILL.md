---
name: asmltr
description: How to drive asmltr — the assistant's own multi-channel backend on this machine. Use whenever you need to proactively notify/reach the owner (`asmltr notify` — read-aloud/push/text ladder, e.g. from a scheduled prompt), send/route a message to any channel (Discord, Telegram, email, …), attach or find a file, read or browse email, approve held replies, post cross-session awareness, monitor/take over other sessions, or bounce/restart asmltr services. One CLI (`asmltr`) is the front door to all of it.
---

# asmltr — your backend across every channel

asmltr is the assistant's own backend running on this machine: every chat surface (Discord,
Telegram, email, MCP, GitHub, an OpenAI-compatible API) is a **connector** feeding one core that
runs the local Agent SDK, plus a collector + dashboard for monitoring. You drive all of it with the
**`asmltr` CLI** (run `asmltr help` for the authoritative, always-current list; `asmltr <cmd>` prints
per-command usage).

This skill is your high-level map. Reach for it when a task means "get this OUT to a channel",
"find/attach a file", "read my email", "approve a reply", "make the other sessions aware",
"watch / take over a session", or "bounce / restart asmltr".

## The one rule that trips people up

- **Replying to a conversation you're already in** (a Discord/Telegram/email message you're
  answering) → just **output your reply text**. The connector delivers it. Do NOT use `asmltr send`.
- **`asmltr send` is for INITIATING or REDIRECTING** — messaging a channel you're not currently in,
  or routing your answer somewhere else.

## Messaging out (any channel)

```bash
asmltr send <channel> <target> "<text>"                 # discord/telegram/email/…
asmltr send <channel> <target> --file <abs-path> [--caption "..."]   # attach a file
asmltr send email <addr> "<body>" --subject "<subj>" [--file <path>] # email w/ subject + attachment
```
- **target** is channel-specific: a Discord channel id/alias, a Telegram chat (omit for default),
  an email address. `asmltr send/targets` (via the manager) lists live outbound connectors and,
  per connector, whether it supports **attachments** and is **readable**.
- Only connectors that declare attachment support accept `--file` — others return a clean error.
- To attach something a user sent you elsewhere, find it first with `asmltr uploads` and pass its
  stored path to `--file`.

## Reaching the user proactively (notify)

To REACH the human owner out-of-band — a scheduled brief, a "your build is done", an alert while
they're away from any chat — use **`asmltr notify`**. It runs a delivery **ladder** so the message
actually lands: read aloud on a connected assistant device → push notification → text fallback,
honoring quiet hours.

```bash
asmltr notify "<text>" [--title "<t>"] [--force] [--silent]
```
- `--force` ignores quiet hours; `--silent` (aka `--no-speak`) skips the spoken step (text only).
- This is **the** way to proactively notify the owner — **including from a scheduled prompt** (a
  schedule that says "notify me / send me a message" means `asmltr notify`). Prefer it over any
  host-specific notification or TTS scripts: `asmltr notify` supersedes them and is what the ladder
  calls internally.
- Different targets, different verbs: `asmltr notify` → the **owner** (out-of-band); `asmltr send`
  → a **specific channel**; `asmltr announce` → the other **sessions**.

## Email (send · browse · read)

Email is a full channel — send *and* read:
```bash
asmltr send email <addr> "<body>" --subject "<subj>" [--file <path>]
asmltr mail                        # inbox, newest first (● = unread)
asmltr mail list -n 30 --unseen    # more / only unread
asmltr mail read <uid> [--seen]    # full body; saves attachments to the upload area + prints paths
asmltr mail search "<query>"       # from / subject / body
```
Inbound mail is handled automatically per the email connector's `approval_policy` (full-trust →
auto-reply; others → a **draft** for approval). Any install-specific rules — the identity/signature
to send as, which senders are trusted — live in this machine's own agent docs (e.g. `CLAUDE.md`),
not in this generic skill.

## Files across channels

```bash
asmltr uploads [search]            # every file a user sent on ANY channel (--channel --since 2h|1d --sender)
asmltr uploads get <id>            # print one upload's stored path (to Read it / --file it back out)
```
When a user says "the file/recording/doc I sent you" — even from another app — check here first.

## Held replies (approval queue)

```bash
asmltr drafts                      # replies any connector held for your approval
asmltr drafts show <id> · send <id> · discard <id>
```
Also visible on the dashboard **Drafts** tab.

## Cross-session awareness (you are one of several sessions)

```bash
asmltr ls                          # active sessions
asmltr map                         # sessions grouped by working dir (collision radar)
asmltr who <path>                  # which sessions recently touched a file/dir
asmltr announce "<text>" [--to <target>] [--urgent] [--ttl <sec>]   # awareness note into other sessions
asmltr announcements               # live announcements
```
Check `map`/`who` before duplicating work another session is already doing.

## Monitoring & takeover

```bash
asmltr                             # live TUI dashboard
asmltr tail | watch <key> | events | system | brief
asmltr attach <key>                # claim a channel session + resume in tmux (attach/detach)
asmltr release <key>               # end takeover; channel resumes
asmltr kill <id> | stop <id> | diff <id>
```

## Bounce (restart services)

A bounce kills the process running **this turn**. Doing it mid-checklist, or before the
connector has posted the reply, hangs Discord on **Working** / **Still working** forever.

```bash
asmltr bounce              # queue until THIS turn ends, then restart core+manager+collector
asmltr bounce --dry-run    # print the plan, change nothing
```

Rules:

- Bounce is **last**. Queue it, reply (or `[[NO_REPLY]]`), stop. No more tools after it.
- If bounce is on a checklist, do every other item first. Do not bounce then verify — that is the next turn, after you come back.
- **Never** `systemctl restart` / `pm2 restart` asmltr-core (or manager/collector) from a live turn. A PATH shim rewrites those to `asmltr bounce`, but do not rely on it.
- `--now` is for a human at a real terminal. Inside a turn it is refused and queued after the turn instead.
- Only core, manager, and collector. Do not restart unrelated units.

## Keeping asmltr current

```bash
asmltr version                     # installed version + sha + channel, each service's version, and whether an update is available
asmltr update                      # fetch + install the latest, restart the three services, verify, auto-roll-back on failure
asmltr update --dry-run            # print the plan + resolved target and change nothing (also: -n)
asmltr update --channel stable     # target the newest release tag; --channel edge tracks origin/main
```
`asmltr version` prints the running sha against its channel and, when you're behind, the number of
commits and the exact `asmltr update` line to run. `asmltr update` runs the deterministic updater in
the foreground, so every step streams to your terminal: it snapshots a rollback point, checks out the
target, reinstalls, rebuilds the dashboard, then restarts and checks `/health` and the `/version` sha
before it declares success. A failed verify rolls the whole update back on its own. `--dry-run` stops
right after it resolves the target. `--agent` is the fallback: it hands the update to an LLM session
run detached through core, which you watch in the dashboard.

## Don't

- Don't hit connector HTTP endpoints or SMTP/IMAP directly — go through `asmltr` so everything stays
  one observable control plane.
- Don't hardcode ports/paths — `asmltr` already knows where the core/collector/manager are.
- Don't re-derive the command list from memory — `asmltr help` is authoritative and current.
