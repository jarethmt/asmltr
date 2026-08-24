# Secrets & configuration

Secrets never live in the repo. They resolve at runtime through a **pluggable secret
provider** (`shared/secrets.js`). Config files that carry secrets are gitignored and commit
only an `.example` twin.

## The secret provider

A "secret **key**" is a logical name — `openai_api_key`, `discord_bot_token`,
`my_github_pat`. Connectors and the core resolve it with `ctx.secrets.get(key)` (or
`require('shared/secrets').get(key)`), never by hardcoding a value or a vault-specific
command. Resolution order (first hit wins, cached):

1. **Environment** — `process.env[key]`, then `process.env[UPPER_SNAKE(key)]`. The portable,
   12-factor default: put secrets in the environment or a `.env` file. (`openai_api_key`
   resolves `OPENAI_API_KEY`.)
2. **Secrets file** — a JSON `{ "<key>": "<value>" }` at `ASMLTR_SECRETS_FILE`.
3. **TRUST vault** — once `ASMLTR_VAULT_URL` **and** `ASMLTR_VAULT_AGENT_KEY` are set, the
   [TRUST vault](trust-vault.md) is the primary store: `get()` resolves a credential from it
   before the command provider. This is how a fully migrated install resolves *everything*
   (connector tokens, voice keys, integration creds) with no external secret manager. Opt-in
   — skipped entirely when the vars are unset, so it never changes an install that hasn't
   adopted it.
4. **Command provider** — `ASMLTR_SECRET_CMD`, a shell template run once per key. `{key}` in
   the template is replaced with the (validated) key; trimmed stdout is the value. Good for a
   Bitwarden / Vault wrapper:

   ```bash
   ASMLTR_SECRET_CMD='vault-read {key}'
   ```

The vault sits *before* the command provider so you can migrate at your pace: copy each secret
into the vault, verify it resolves, then disable the old provider. `get()` returns `null` when
a key can't be resolved and never throws.

!!! tip "`*_bws_key` / `pat_bws_key` are NAMES, not tokens"
    Connector config fields such as `bot_token_bws_key`, `pat_bws_key`, and
    `elevenlabs_key_name` hold the **name of a secret** (a key the provider resolves), never
    the token itself. The literal token stays in your environment / secrets file / vault — so
    the connector config is safe to store and inspect. The `bws` in the name nods to
    Bitwarden Secrets Manager but works with any provider.

## Gitignored config (and their `.example` twins)

These files carry secrets or personal identifiers. They are **gitignored**; commit only the
`.example` version, and copy + edit the real one locally.

| Gitignored file | Committed twin | Holds |
|---|---|---|
| `.env` | `.env.example` | Assistant name, ports, secret values / provider config, tokens. |
| `connectors/types/mcp/clients.json` | `clients.example.json` | Pre-registered OAuth 2.1 MCP clients; each maps to a trust `identity`. |
| `connectors/types/openai/keys.json` | `keys.example.json` | Bearer API keys → trust identities for the OpenAI-compatible connector. |
| `core/src/trust/seed.json` | `seed.example.json` | Trust store seed (principals, identifiers, grants). |
| `connectors/types/discord/channel-aliases.json` | `channel-aliases.example.json` | Real Discord channel ids ↔ aliases (e.g. `alerts`). |
| `~/.asmltr/tool-policy.json` | `shared/tool-policy.example.json` | Per-principal stills/video/code allowlists (`photoAllow`, `videoAllow`, `codeAllow`). Live file is under the home dir, not the repo. |

Local data stores (SQLite DBs under `*/data/`, `*.db`, JSONL event logs), the dashboard
`dist/`, and per-install notes (`CLAUDE.local.md`) are also gitignored.

## Public tree — no personal or install-specific data

This repository is public. Tracked files must not contain:

- Household, family, or staff names
- Personal or work emails, phones, Discord snowflakes
- Internal hostnames, live vhosts, home-directory paths, per-box bind ports, backup clocks

A value the running install needs (owner-from email, host paths, unit files) lives in the live
`.env`, `CLAUDE.local.md`, or systemd copies under `~/.config` — never as a literal in git.
`.example` twins use placeholders (`Owner`, `owner@example.com`, `/path/to/asmltr`, `%h`).

## `.env`

Every entrypoint loads `<repo>/.env` first via `shared/loadenv.js` (a zero-dependency
loader). Real environment / PM2 env **take precedence** over the file, so production can set
values without editing it. Copy the example to start:

```bash
cp .env.example .env    # then edit ASSISTANT_NAME, ports, secrets
```

!!! danger "Add every new secret to `.env.example`"
    When you introduce a new environment variable, add it to `.env.example`. When you
    introduce a new secret-bearing file, gitignore it and commit a `<name>.example` twin.
    This keeps a fresh clone's onboarding complete and prevents secrets from being committed.

## Moderation keys and the API-key firewall

The moderation classifier may use an API key (OpenAI by default, or Anthropic). It resolves
that key **through the secret provider** by name (`ASMLTR_MODERATION_KEY`, default
`openai_api_key` / `anthropic_api_key`) — **not** from `ANTHROPIC_API_KEY`.

!!! danger "Never set `ANTHROPIC_API_KEY`"
    The core deletes `ANTHROPIC_API_KEY` from its process environment at startup so agent
    execution can never silently go metered. If you use the Anthropic moderation provider,
    store its key via `ASMLTR_SECRETS_FILE` or `ASMLTR_SECRET_CMD` — do **not** export it as
    `ANTHROPIC_API_KEY`.

For the full moderation configuration (provider, model, alert routing) see the
[moderation guide](moderation.md) and [Configuration & environment](../reference/config.md).

## See also

- [Trust & permissions](trust.md) — how identities and grants work.
- [Configuration & environment](../reference/config.md) — the full env var table.
