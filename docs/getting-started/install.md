# Installation

This is the manual install. Prefer to let an AI coding agent do it for you? See [`INSTALL-WITH-AGENT.md`](https://github.com/jarethmt/asmltr/blob/main/INSTALL-WITH-AGENT.md) — `wget` it onto a box with Claude Code and the agent clones, installs, configures, seeds trust, and starts the services, prompting you for the values it needs.

!!! warning "Non-negotiables"
    - **Execution is local via the Agent SDK on your Claude subscription.** Do **not** introduce an `ANTHROPIC_API_KEY` execution path — it switches to metered billing and loses local filesystem, project-context, and skills access.
    - **The core and collector run on the host under PM2, not in Docker.** They spawn the local `claude` binary (which needs `~/.claude` auth + host FS + your project context) and signal host pids. Connectors may run in Docker and reach the host via `host.docker.internal`.
    - **Bind `127.0.0.1` only.** Put a reverse proxy with auth in front of anything you expose.

## Prerequisites

Verify each of these before starting:

```bash
node --version          # must be >= 18 (for global fetch / FormData / Blob)
claude --version        # Claude Code CLI, installed AND logged in — this is the assistant's brain
pm2 --version           # process manager; if missing: npm i -g pm2
git --version
ffmpeg -version         # ONLY needed for Discord voice mode
```

- **Node.js ≥ 24**
- **Claude Code CLI, installed and authenticated** (`claude` on PATH — the SDK uses its auth)
- **PM2** to run the host services (`npm i -g pm2`)
- **git**
- **ffmpeg** — only if you use the Discord voice mode
- API keys as needed: **OpenAI** (moderation; Discord voice STT), **ElevenLabs** (Discord voice TTS, optional), plus each channel's bot token / PAT.

## 1. Clone and install every package

asmltr is a monorepo of **separate npm packages — install ALL of them**, not just the one for your channel. `core`, `connectors`, `insights/collector`, and `cli` are all required:

```bash
git clone <your-fork-url> asmltr && cd asmltr

for d in core connectors insights/collector cli; do
  echo "installing $d…"; (cd "$d" && npm install) || { echo "FAILED: $d"; exit 1; }
done
# add insights/dashboard to that list ONLY if you want the web GUI
```

Confirm each directory now has a `node_modules`:

```bash
for d in core connectors insights/collector cli; do
  [ -d "$d/node_modules" ] && echo "OK $d" || echo "MISSING $d"
done
```

## 2. Configure `.env`

```bash
cp .env.example .env
```

Edit `.env` and set:

- `ASSISTANT_NAME` — what the assistant is called.
- Secret keys for the channels/features you enable:
    - `OPENAI_API_KEY` — required (moderation + picture-intent classify; Discord voice STT). If unset, picture-intent classify logs once and stays OFF; `image_gen` tools still work.
    - `ELEVENLABS_API_KEY` — only for Discord voice mode.
    - `DISCORD_BOT_TOKEN` / `TELEGRAM_BOT_TOKEN` — for those channels.
    - A GitHub PAT env var (e.g. `MY_GITHUB_PAT`) — you reference its lowercase name as a connector's `pat_bws_key`.
- `ASMLTR_ADMIN_ALERT_CMD` — optional; a command run on blocked/errored requests (`{msg}` = text). Leave unset to disable.

!!! tip "Secrets via a vault instead of inline"
    Secrets always resolve at runtime through the pluggable provider (`shared/secrets.js`), in order: **env → secrets file → command**. To use a vault, set `ASMLTR_SECRET_CMD` (a shell template where `{key}` is replaced with the secret key name) and leave the values out of `.env`. A `*_bws_key` / `pat_bws_key` config value is always the **name of a secret**, never the secret itself.

## 3. Seed the trust store (DEFAULT-DENY)

Nobody has access until you seed the trust store — trust is default-deny.

```bash
cp core/src/trust/seed.example.json core/src/trust/seed.json
```

Edit `seed.json` and add **yourself as the owner** principal with `bypass_moderation: true`, using your own identifier on each channel you'll use:

- discord → your numeric Discord user ID
- telegram → your Telegram username
- mcp → the `identity.username` you assign your OAuth client
- github → your GitHub login

Then seed:

```bash
node core/src/trust/seed.js
```

Add teammates as additional principals (optionally with a limited `role_id`). Anyone who should **same-guild Discord post** needs a trusted role or `resolve()` allow (`guild-post` / `send` / `*`). `default_tier` is a schema field, not the send gate. Stills/video/code example allowlists:

```bash
mkdir -p ~/.asmltr
cp shared/media-allow.example.json ~/.asmltr/media-allow.json   # edit locally; no real ids in git
```

## 4. Start the host services

```bash
pm2 start core/ecosystem.config.js
pm2 start insights/collector/ecosystem.config.js
pm2 start connectors/manager/ecosystem.config.js
pm2 save        # persist across restarts (optional; also run `pm2 startup` and follow its output)
```

This starts three PM2 processes:

| PM2 name | Port | Role |
|---|---|---|
| `asmltr-core` | `3023` | the pipeline |
| `asmltr-insights-collector` | `3017` | telemetry |
| `asmltr-connector-manager` | `3024` | connector supervisor + config API |

Verify:

```bash
curl -s 127.0.0.1:3023/health          # → {"status":"ok",...}
curl -s 127.0.0.1:3024/types | head     # manager lists available connector types
```

## 5. Install the `asmltr` CLI onto PATH

The CLI/TUI is part of a complete install — it's how you watch live sessions and events:

```bash
chmod +x cli/asmltr.js
ln -sf "$(pwd)/cli/asmltr.js" /usr/local/bin/asmltr 2>/dev/null \
  || sudo ln -sf "$(pwd)/cli/asmltr.js" /usr/local/bin/asmltr 2>/dev/null \
  || echo "couldn't symlink onto PATH — run as: node $(pwd)/cli/asmltr.js"

asmltr ls      # list active sessions (or: node cli/asmltr.js ls)
```

`asmltr` with no args opens the full live TUI (sessions + event log + system); `asmltr --help` lists commands. See the [CLI reference](../cli.md).

## Next steps

- [Quick Start](quickstart.md) — add your first channel and send a real message.
- [Connectors](https://github.com/jarethmt/asmltr/blob/main/connectors/index.md) — each channel's full config schema.
- [Deploying the web dashboard](../deployment/dashboard.md) — the optional observability GUI, behind auth.
