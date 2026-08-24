# asmltr — guidance for AI coding agents

One channel-agnostic backend behind every chat surface for a single AI assistant. See
[README.md](README.md) for the full architecture. This file is the fast orientation for working
in the repo. Per-install private notes live in `CLAUDE.local.md` (gitignored).

## The non-negotiables (violating these breaks the model)

1. **No `ANTHROPIC_API_KEY` execution path.** All agent execution goes through the local Agent SDK
   (`@anthropic-ai/claude-agent-sdk` — the programmatic `query()` API; `@anthropic-ai/claude-code`
   became CLI-only at 2.x) on the user's Claude subscription. An API key silently switches to metered
   billing and a sandbox with no local FS / project-context / skills. Verify: nothing in `core/` reads
   `ANTHROPIC_API_KEY`. Set the model with `ASMLTR_MODEL` (alias like `opus` tracks the latest tier).
2. **`core/` and `insights/collector/` run on the HOST under PM2**, never Docker — they spawn the
   local `claude` binary and signal host pids. Connectors may be containerized (reach the host via
   `host.docker.internal`).
3. **Bind `127.0.0.1`.** Only a reverse proxy faces the internet.
4. **Root auth quirk:** as root the modern CLI rejects `--dangerously-skip-permissions`. The working
   full-autonomy equivalent is `permissionMode: 'bypassPermissions'` (`core/src/runner.js`) **plus
   `IS_SANDBOX=1`** (set in `core/src/server.js` — must be `'1'`, not `'true'`). Never pass the raw
   `dangerously-skip-permissions` flag via `extraArgs`; the modern CLI fatals on it as root.
5. **This repository is public. No personal or install-specific data in tracked files.** Never
   commit household / family / staff names, personal or work emails, phone numbers, Discord
   snowflakes, internal hostnames, live vhosts, home-directory paths, per-box bind ports,
   backup clocks, or staff directories. Local notes go in `CLAUDE.local.md` (gitignored), the
   live `.env`, or the Self silo — never in `docs/`, examples, tests, unit files, or anything
   else that gets pushed. A real address that the code needs (e.g. owner-from email) is an
   env var, not a string in git.

## Architecture in one breath

Adapter (thin I/O) → normalized **envelope** → core: `resolveIdentity(trust) → buildSystemPrompt →
moderate → conversation_key→session → run via SDK → redact public output → outbound actions`. The
core emits the shared event stream (`shared/events.js`) to the collector; dashboard + `asmltr` CLI read it.

## Where things live

- `core/src/` — `server.js` (pipeline), `runner.js` (SDK), `moderation.js`, `sessions.js`, `trust/`.
- `connectors/types/<type>/` — one adapter per channel (`meta.configSchema` + `start(ctx)`).
- `connectors/manager/` — supervisor + config API; spawns each instance as a child (`runtime/run-instance.js`).
- `shared/` — `secrets.js` (provider), `loadenv.js` (.env), `events.js` (contract), `redact.js` (output masking).

## Conventions

- **Secrets** always resolve via `shared/secrets.js` (`ctx.secrets.get(key)` in connectors) — never
  hardcode values or vault-specific commands. Config that carries secrets is gitignored with an `.example` twin.
- **Paths** come from config/env with portable defaults (`~/.asmltr/...`) — never hardcode host paths.
- **Identity** is `process.env.ASSISTANT_NAME`; never hardcode the assistant's name in strings/prompts.
- **Public tree:** no PII, no this-install internals. If it would help an attacker or identify a household, it does not go in git.
- **New env var?** Add it to `.env.example`. **New secret-bearing file?** Gitignore it + commit `<name>.example`.

## Dev loop

- Syntax check: `node --check <file>`.
- Restart host services: `pm2 restart asmltr-core asmltr-connector-manager asmltr-insights-collector`.
- Reload one connector instance without restarting the manager:
  `curl -X POST 127.0.0.1:3024/instances/<id>/restart`; tail it via `GET /instances/<id>/logs`.
- Update an instance's config: `PATCH /instances/<id>` with the **full** merged `config` (it's validated against the schema).
