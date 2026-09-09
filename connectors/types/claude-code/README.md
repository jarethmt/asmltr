# claude-code connector

Makes **interactive Claude Code terminal sessions** first-class asmltr sessions — with a generated
title, a live "what it's doing" overview, token/tool counts, and attach info in the dashboard —
using Claude Code's native **hooks**, not pane-scraping or polling.

This folder is **Claude Code only** (`claude` binary / `~/.claude/settings.json`). It is not a
startable Node connector (no `index.js`) — the manager skips it on boot.

Other reasoning engines — do **not** copy this hook into Grok `--prompt-file` or the Claude SDK:

| Engine | Interactive CLI | Binary | Native hooks like this file |
| --- | --- | --- | --- |
| Grok | `asmltr grok` | `grok` (`~/.grok/bin/grok`) | Not wired. Dashboard card is `grok-cli` via `asmltr-engine.js`. |
| Gemini | `asmltr gemini` | `gemini` | **Must be added by a Gemini implementer** if they want SessionStart/Stop → collector. |
| Codex | `asmltr codex` | `codex` | **Must be added by a Codex implementer** if they want SessionStart/Stop → collector. |

## How it works

`hook.py` is a Claude Code hook. Claude fires it with a JSON payload on stdin; the script turns each
event into the same shared event every other connector emits and POSTs it to the collector `/ingest`:

| Claude hook        | asmltr event   | effect                                             |
|--------------------|----------------|----------------------------------------------------|
| `SessionStart`     | `session-start`| registers the session + working dir + pane (attach) |
| `UserPromptSubmit` | `inbound`      | drives the **title** + **overview** generation      |
| `PostToolUse`      | `tool`         | tool count + refines the overview                   |
| `Stop`             | `outbound`     | the assistant's reply (recovered from the transcript) |
| `SessionEnd`       | `session-end`  | marks the session ended                             |

The collector's existing title/activity generators pick these up automatically (a claude-code
`inbound` event is treated exactly like a Discord/Telegram message).

**Session identity:** a claude session lives in a screen/tmux pane you attach to, so it's keyed by
the multiplexer session name (from `$STY` / `tmux display-message -p '#S'`) when present — which
unifies it with the tracker + `asmltr claude` wrapper — otherwise the claude session UUID.

The hook is passive (no stdout), non-blocking (2s timeout, fire-and-forget), never fails the session
(all errors swallowed), and **skips the asmltr core's own SDK turns** (guards on `IS_SANDBOX`), which
are already tracked as their real channel session.

## Install

Add to `~/.claude/settings.json` (a project `.claude/settings.json` also works). `CMD` =
`python3 <repo>/connectors/types/claude-code/hook.py`:

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "CMD" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "CMD" }] }],
    "PostToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "CMD" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "CMD" }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "CMD" }] }]
  }
}
```

Merge (don't overwrite) with any existing hooks. Takes effect for new sessions.

## Config

The hook reads the collector token/port from the repo `.env` (env vars win):

- `ASMLTR_INSIGHTS_TOKEN` — bearer for `/ingest`
- `ASMLTR_INSIGHTS_PORT` (default `3017`) or `ASMLTR_INSIGHTS_URL`
- `ASMLTR_TRACKER_IDENTITY` — identity label for these sessions (default `$USER` / `root`)

## Backfilling pre-existing sessions

Sessions already running before the hook was installed won't have fired `SessionStart`.
`scripts/backfill-screen-sessions.js` scans live screen panes running claude and writes them to the
tracker file (`ASMLTR_TRACKER_PATH`) using the same pane-name id — so once such a session is used,
its hook events land on the same row.
