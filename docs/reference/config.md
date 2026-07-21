# Configuration & environment

All configuration is environment-driven and loaded from `<repo>/.env` by every entrypoint
via `shared/loadenv.js` (real env / PM2 env win over the file). Secret **values** resolve
through the [secret provider](../security/secrets.md); the variables below are non-secret
settings and pointers. Every variable has a sensible default — an unset install still runs.

## Assistant identity

| Variable | Default | What |
|---|---|---|
| `ASSISTANT_NAME` | `the assistant` | Name used in prompts, channel-awareness, and the Discord voice wake word. Never hardcoded in strings. |

## Ports & inter-service URLs

All services bind `127.0.0.1`. Front anything public with a reverse proxy.

| Variable | Default | What |
|---|---|---|
| `ASMLTR_CORE_PORT` | `3023` | core HTTP port |
| `ASMLTR_MANAGER_PORT` | `3024` | connector manager HTTP port |
| `ASMLTR_INSIGHTS_PORT` | `3017` | collector HTTP + socket.io port |
| `ASMLTR_CORE_URL` | `http://127.0.0.1:3023/v2/handle` | where connectors POST envelopes |
| `ASMLTR_COLLECTOR_URL` | `http://127.0.0.1:3017/ingest` | where producers POST events |
| `ASMLTR_CORE_BASE` | `http://127.0.0.1:3023` | core base (collector → `/v2/title`; CLI) |
| `ASMLTR_COLLECTOR_BASE` | `http://127.0.0.1:3017` | collector base (CLI / claude tailer) |
| `ASMLTR_MANAGER_BASE` | `http://127.0.0.1:3024` | manager base (CLI) |
| `ASMLTR_MANAGER_URL` | `http://127.0.0.1:3024` | manager base (core's operator-inject `/send` delivery) |

## Access tokens

Set these before exposing any service beyond localhost. When unset, the service warns at boot
and runs open (dev mode).

| Variable | Default | What |
|---|---|---|
| `ASMLTR_MANAGER_TOKEN` | — | Bearer token gating the manager API |
| `ASMLTR_INSIGHTS_TOKEN` | — | Bearer token gating collector read + `/ingest` |
| `ASMLTR_INSIGHTS_CONTROL_TOKEN` | — | Stronger bearer for the collector control plane (`/api/control/*`) |

## Core runtime

| Variable | Default | What |
|---|---|---|
| `ASMLTR_CORE_CONCURRENCY` | `6` | Max concurrent turns (global semaphore; turns on one `conversation_key` are also serialized) |
| `ASMLTR_CORE_REQUEST_TIMEOUT_MS` | `0` (unlimited) | HTTP request timeout for `/v2/handle` (agent turns can run minutes) |
| `ASMLTR_SESSION_CWD` | `os.homedir()` | Spawn/resume working dir for sessions (which `CLAUDE.md` hierarchy loads) |
| `ASMLTR_MAX_THINKING_TOKENS` | `4000` | Max thinking tokens per turn (`0` disables; adaptive — trivial turns don't think) |
| `ASMLTR_SELF_AWARE` | on (set `off` to disable) | Inject the "asmltr toolbelt" awareness (cross-session `asmltr` CLI ops) into the system prompt |
| `ASMLTR_CLAUDE_BIN` | auto-detected | Full path to the `claude` binary (used by `asmltr claude`) |

## Session titles

| Variable | Default | What |
|---|---|---|
| `ASMLTR_TITLE_MODEL` | `haiku` | Cheap model for the no-tools title-generation call (rides the subscription) |
| `ASMLTR_TITLE_REFRESH_TURNS` | `15` | Regenerate a session's title every N inbound turns |

## Moderation

The classifier resolves its key **by name** through the secret provider (never
`ANTHROPIC_API_KEY`). See [Secrets & configuration](../security/secrets.md#moderation-keys-and-the-api-key-firewall).

| Variable | Default | What |
|---|---|---|
| `ASMLTR_MODERATION_PROVIDER` | `openai` | `openai` or `anthropic` |
| `ASMLTR_MODERATION_MODEL` | `gpt-5-nano` (openai) / `claude-haiku-4-5-20251001` (anthropic) | Classifier model |
| `ASMLTR_MODERATION_KEY` | `openai_api_key` / `anthropic_api_key` | Secret **key name** for the classifier |
| `ASMLTR_MOD_LOG_DIR` | `core/data/moderation-logs` | Where moderation decisions are logged |

## Admin / security alerts

Fired on moderation errors and high-risk blocks. Configure any of these (each set one fires);
leave all unset to disable.

| Variable | What |
|---|---|
| `ASMLTR_ADMIN_ALERT_SEND` | Route through a connector: JSON `{"channel":"discord","target":"<id>"}`, or shorthand `telegram` / `discord\|<channelId>` |
| `ASMLTR_ADMIN_ALERT_CMD` | Shell command (`{msg}` = alert text) — good for email/webhooks/custom scripts |

## Secret provider

See [Secrets & configuration](../security/secrets.md) for how these compose.

| Variable | What |
|---|---|
| `ASMLTR_SECRETS_FILE` | Path to a JSON `{ key: value }` secrets file |
| `ASMLTR_SECRET_CMD` | Shell template run per key (`{key}` substituted); stdout is the value |
| `ASMLTR_ENV_FILE` | Override the `.env` path loaded by `shared/loadenv.js` |

## Data locations

Portable defaults; override to relocate the SQLite stores and workspaces.

| Variable | Default | What |
|---|---|---|
| `ASMLTR_CORE_DB` | `core/data/asmltr-core.db` | Sessions store |
| `ASMLTR_TRUST_DB` | `core/data/trust.db` | Trust store (principals/identifiers/roles/grants) |
| `ASMLTR_TRUST_SEED` | `core/src/trust/seed.json` | Trust seed file |
| `ASMLTR_INSIGHTS_DB` | `insights/collector/data/insights.db` | Collector telemetry store |
| `ASMLTR_CONNECTORS_DB` | `connectors/manager/data/connectors.db` | Connector instance registry |
| `ASMLTR_MCP_CLIENTS_FILE` | `connectors/types/mcp/clients.json` | MCP OAuth clients |
| `ASMLTR_GITHUB_WORKSPACE` | `~/.asmltr/github-repos` | GitHub connector clone workspace |

## Collector sampling & tailer

| Variable | Default | What |
|---|---|---|
| `ASMLTR_RECONCILE_MS` | `15000` | Session reconciliation interval |
| `ASMLTR_SAMPLE_MS` | `30000` | System metric sampling interval |
| `ASMLTR_TAIL_MS` | `5000` | JSONL log tail interval |
| `ASMLTR_ENABLE_TAILER` | on (set `0` to disable) | Ingest events from legacy JSONL proxy logs |
| `ASMLTR_TAILER_BACKFILL` | off (set `1` to enable) | Read historical JSONL on start (else tail only new lines) |
| `ASMLTR_TRACKER_PATH` | — | Host hook session tracker (screen-based, one identity) |
| `ASMLTR_TRACKER_IDENTITY` | `cli` | Identity for the host hook tracker |
| `ASMLTR_CLI_TRACKER_PATH` | `~/.asmltr/cli-sessions.json` | `asmltr claude` (tmux) session tracker |
| `ASMLTR_CLI_IDENTITY` | OS username | Identity used by the CLI / claude tailer |
| `ASMLTR_QUERY_LOG_DIR` | — | Optional legacy query-log dir the tailer reads |
| `ASMLTR_MOD_LOG_DIR_SRC` | — | Optional legacy moderation-log dir the tailer reads |

## MCP connector (only when running the `mcp` type)

| Variable | Default | What |
|---|---|---|
| `BASE_URL` | `https://mcp.example.com` | Public issuer URL for OAuth metadata |
| `TOKEN_EXPIRY_HOURS` | `720` | OAuth token lifetime |

## Per-connector config

Beyond the global env vars, each connector **instance** has its own config, validated against
that type's `meta.configSchema`. Discover every type's schema live:

```bash
curl -s 127.0.0.1:3024/types | jq '.types[] | {type, configSchema, outbound}'
```

or read `connectors/types/<type>/index.js`. Highlights (defaults shown):

| Type | Key config fields |
|---|---|
| `discord` | `bot_token_bws_key` (**required**), `http_port` (3016), `dm_allowed_user_id`, `channels_default`, `voice_id`, `elevenlabs_key_name`, autonomous-response limits |
| `telegram` | `bot_token_bws_key` (**required**), `allowed_chat_ids`, `http_port` (3008), `photo_dir` |
| `mcp` | `port` (3018), `bind_host` (127.0.0.1), `base_url` |
| `github` | `repos` + `pat_bws_key` (**required**), `mention` (`*<assistant-name>`), `poll_interval_ms`, `clone_repos`, `stream`, `dry_run` (default true) |
| `openai` | `port` (3025), `bind_host` (127.0.0.1), `model_name` (`asmltr`), `keys_file`, `require_key` (true) |

Config that carries secrets is stored as a **secret key name** (e.g. `bot_token_bws_key`,
`pat_bws_key`), never the token itself — see [Secrets & configuration](../security/secrets.md).
