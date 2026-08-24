# Reasoning engines

<p class="asmltr-gradient" style="font-size:1.2rem;font-weight:800;margin-top:-0.4rem">The assistant's "brain" is a swappable part. Run it on Claude, Gemini, Codex, or your own self-hosted model — the choice is one setting, and it applies everywhere.</p>

A **reasoning engine** is the agentic backend that actually runs a turn: it reads the prompt, decides
what to do, calls tools, and produces the reply. asmltr treats this as a **pluggable layer** rather
than a hard dependency on any one provider.

!!! abstract "The one thing to know"
    Every channel — Discord, Telegram, email, GitHub, the web, your terminal — funnels through **one**
    pipeline. So whichever engine you pick as the **default**, *all* of those channels run on it. Set
    the default to Gemini and your whole assistant thinks with Gemini; set it to a self-hosted model and
    everything runs locally. The core only loads the engine you actually use, so a Gemini-only or
    Codex-only box never touches the Claude SDK.

## The engines

| Engine | Harness | Default auth | Notes |
|--------|---------|--------------|-------|
| **Claude** | Claude Code (local Agent SDK) | your Claude subscription | The default. Runs on your machine with full filesystem + project context + skills. **Never** uses an API key here (that would bypass your subscription). |
| **Gemini** | Gemini CLI | Google login **or** API key | Google deprecated the free login tier, so an **API key** is the practical path today. |
| **Codex** | Codex CLI | ChatGPT login **or** API key | Also the vehicle for **[self-hosted models](#self-hosted-models)**. |
| **Grok** | Grok Build CLI | your xAI subscription | Official CLI (`curl https://x.ai/cli/install.sh`). **Never** uses `XAI_API_KEY` here. Login: `grok login --device-auth`. |

Everything below lives in **Settings → Engines** in the dashboard (one card per engine), and is
mirrored by the `asmltr` CLI + a shared settings manifest, so the terminal TUI stays in sync.

## Pick a default

The default engine (marked **★**) is what the `<assistant-name>` terminal command and every new session
use. Any installed engine can also be launched directly from the terminal:

```bash
asmltr claude          # a wrapped, monitored, takeover-able Claude session
asmltr gemini
asmltr codex
asmltr grok
```

Changing the default in the GUI re-points the `<assistant-name>` alias automatically.

## Install & keep engines current

Each engine card shows whether the harness is installed and its version. If one's missing, **Install**
runs `npm i -g <package>` for you; if a newer version exists, an **Update** button appears. Turn on
**Auto-update** and asmltr checks npm every 6 hours and upgrades that harness in place — so it never
silently goes stale (the same guarantee the Claude Agent SDK already had, now per-engine).

## Choose a model

Each engine exposes **its own** model list (Claude → Opus/Sonnet/Haiku, Gemini → 2.5 Pro/Flash, Codex →
gpt-5-codex/o-series, …). Pick one per engine, or type a full model id. Your choice is per-engine, so
setting Gemini's model never touches Claude's.

## Connect a provider — subscription or API key

Each engine's **Connection** section offers two modes:

=== "Subscription (OAuth)"

    The harness uses its **own login** — nothing is stored by asmltr. If a session reports it isn't
    authenticated, run the harness's login once in a terminal (`claude`, `gemini`, or `codex login`).
    This is the default for Claude and the recommended path when you have a subscription.

=== "API key"

    For metered billing. Paste the provider's API key and asmltr stores it **only in the
    [TRUST vault](security/trust-vault.md)** (never on disk) — `engines.json` keeps just a "key present"
    flag. At launch the key is injected as the harness's expected env var (`GEMINI_API_KEY`,
    `OPENAI_API_KEY`). Remove it any time; the vault secret is deleted and the engine reverts to
    subscription mode.

!!! warning "Claude is subscription-only here"
    asmltr refuses API-key mode for the Claude engine on purpose: an `ANTHROPIC_API_KEY` execution path
    would bypass your subscription and switch to metered, sandboxed billing with no local filesystem or
    project context. That's the project's one hard rule.

## Self-hosted models

Point the **Codex** engine at any endpoint that speaks the OpenAI **Responses** API — a local
[vLLM](https://docs.vllm.ai/) or [LiteLLM](https://docs.litellm.ai/) server, a gateway, or another
provider — and its turns route there instead of OpenAI.

!!! info "Why Codex is the vehicle"
    Codex is the OpenAI-compatible harness. asmltr defines a custom Codex *provider* pointing at your
    URL, so you get the full Codex agent loop against your own model. (Modern Codex only supports the
    **Responses** wire protocol for custom providers — plain chat-completions was dropped — so your
    server must expose `/responses`. vLLM and most gateways do.)

**Setup (dashboard):**

1. **Settings → Engines → Codex → Custom endpoint.** Enter your base URL, e.g. `http://localhost:8000/v1`, and **Save**. A green badge shows it's active.
2. Set the **Connection** to **API key** and paste your server's key (or any placeholder if it needs none). It's stored in the vault and injected as `OPENAI_API_KEY`.
3. Set the **Model** to whatever your server serves (type the id in the custom field).
4. Optionally make Codex the **default** so every channel uses your self-hosted model.

**Setup (API):**

```bash
# point codex at your endpoint (validated: must be http/https)
curl -X POST 127.0.0.1:3023/v2/engines/codex/base-url \
  -H 'content-type: application/json' -d '{"url":"http://localhost:8000/v1"}'

# store the key in the vault + switch to api_key mode
curl -X PUT 127.0.0.1:3023/v2/engines/codex/apikey \
  -H 'content-type: application/json' -d '{"value":"sk-your-server-key"}'
```

To go back to hosted OpenAI, clear the custom endpoint (empty the field, or `POST …/base-url {"url":""}`).

## Give every engine your tools (MCP)

Whatever engine runs, it can share the same set of tools. asmltr keeps **one MCP registry** and
provisions it into each harness at launch — including a built-in **toolbelt** that exposes asmltr's own
cross-session tools (list sessions, send a message out any channel, post an announcement, browse
uploads) to Claude, Gemini, Codex, and Grok alike. → **[MCP tools registry](engines-mcp.md)**

## See also

- **[MCP tools registry](engines-mcp.md)** — declare tools once, get them in every engine.
- **[Reasoning engines — the design](REASONING-ENGINES.md)** — the engine interface, the headless
  adapters, event normalization, and how capabilities are derived at runtime.
- **[TRUST vault](security/trust-vault.md)** — where API keys are stored.
