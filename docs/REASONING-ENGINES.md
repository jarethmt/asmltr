# Reasoning engines — the design

!!! tip "Looking for setup instructions?"
    This page is the **design deep-dive** — the engine interface, the headless adapters, event
    normalization, and how capabilities are derived at runtime. For *how to pick and configure* an
    engine (models, connection, self-hosted, auto-update), see the **[Reasoning engines guide](engines.md)**;
    for the shared tools layer, see the **[MCP tools registry](engines-mcp.md)**.

> Status: **engine-abstracted end to end.** The engine **registry**, the `asmltr claude|gemini|codex`
> **terminal commands**, a configurable **default engine**, per-engine **model / connection / auto-update**
> settings, AND the **channel/web runner** are all engine-pluggable (see [Using it today](#using-it-today)).
> The core no longer imports the Claude SDK at boot — it is loaded lazily only when a Claude turn runs — so
> **a Gemini-only or Codex-only install runs with the Claude SDK absent.** Every connector (Discord, Telegram,
> email, GitHub, web, voice) funnels through one pipeline → the configured default engine, so **any session
> from any connector runs entirely on whichever single engine is selected**, via subscription or API key.
> Still ahead: per-session (not just default) engine selection in the new-session UI, and richer
> Gemini/Codex resume + streaming (see [Adapters](#adapter-status)).

## How the runner is abstracted

`core/src/runner.js` is a thin dispatcher; each engine implements the same contract in `core/src/engines/`:

```
runTurn(opts) → { text, segments, engineSessionId, tools, usage, isError }
complete({prompt, model}) → string      // cheap one-shot for the title/status/self-assessment labelers
```

- **claude.js** — the LOCAL Agent SDK (`query()`), lazily required so it never loads at boot.
- **codex.js** — headless `codex exec --json`; native resume via the assigned `thread_id`; `OPENAI_API_KEY`
  injected from the vault (api_key mode).
- **gemini.js** — headless `gemini -p -o stream-json --skip-trust`; `GEMINI_API_KEY` from the vault.
- **self-hosted** — Codex is the OpenAI-compatible vehicle: set a **custom endpoint** (Settings → Engines →
  Codex → Custom endpoint, or `POST /v2/engines/codex/base-url`) and its turns route to that base URL via a
  codex custom provider (`-c model_providers.asmltr_custom.base_url=… wire_api=responses`). The endpoint must
  speak the OpenAI **Responses** API (vLLM, LiteLLM, a gateway); use api_key mode with the server's key.

## MCP tools — declared once, provisioned into every engine

`shared/mcp-registry.js` is the single place to declare MCP servers (`~/.asmltr/mcp.json`, gitignored).
Each engine gets them at launch in its own shape:
- **Claude** — the SDK `mcpServers` option.
- **Codex** — per-launch `-c mcp_servers.<name>.{command,args,env|url}` flags.
- **Gemini** — reconciled into gemini's own config via `gemini mcp add` (once per process; re-synced on change).

A built-in **`asmltr-toolbelt`** stdio server (`mcp/toolbelt-server.js`, zero-dep newline-JSON-RPC) is always
included unless disabled — it exposes asmltr's own cross-session tools (`asmltr_sessions`, `asmltr_send`,
`asmltr_announce`, `asmltr_uploads`) to **every** harness, so the toolbelt that used to be a Claude-only
system-prompt cheatsheet is now real, structured tools any engine can call. Manage from Settings → Engines →
MCP tools, or `GET/POST /v2/mcp`, `DELETE /v2/mcp/:name`, `POST /v2/mcp/:name/toggle`.

`core/src/engines/index.js` maps id → impl lazily; `runner` routes each turn to `opts.engine || default`.

### Adapter status
- **Claude** — production (unchanged behaviour; live-verified).
- **Codex** — spawn/JSONL-parse/resume-id/abort verified; a live turn needs OpenAI auth (subscription or key).
- **Gemini** — spawn/parse/env verified; **stateless per turn** for now (the CLI's resume is index-based, not
  id-addressable — `--session-file` continuity is the planned follow-up). Google deprecated the free OAuth
  tier, so Gemini's practical path is an **API key** (Settings → Engines → Gemini → API key).

## Using it today

asmltr ships a **registry** of known agentic-CLI harnesses — **Claude Code, Gemini CLI, Codex CLI** — and
detects which are installed (with versions). From the terminal:

```bash
asmltr claude [args…]     # launch a wrapped, monitored, takeover-able session on any engine
asmltr gemini [args…]     # (Gemini CLI)
asmltr codex  [args…]     # (Codex CLI)
```

Each launches that harness inside a multiplexer, tracked in the dashboard (Live) and attachable — exactly
like the original `asmltr claude`.

- **Default engine.** Settings → **Engines** lists every known harness (installed? version? default?) and lets
  you pick the **default** — which is what the `<agent-name>` terminal command points at (so the
  `<agent-name>` shim ≡ `asmltr <default>`). Also `POST /v2/engines/default`.
- **Install / update / auto-update from the GUI.** The Engines tab shows each harness's installed version,
  checks npm for a newer one, and offers a one-click **Install** (if missing) or **Update** button
  (`npm i -g <pkg>@latest`). Each engine also has an **Auto-update** toggle — a 6-hourly background sweep
  (`POST /v2/engines/:id/auto-update`, `engines.autoUpdateAll()`) upgrades it in place so it never goes stale.
- **Per-engine cards.** The Engines tab renders one card per harness, each with its own **model**, **connection**,
  and (Claude only) **runtime** settings — so every engine is configured at once. The default (★) is what the
  `<agent-name>` command uses, but any configured engine is invokable directly (`asmltr <engine>` / per-session).
  Model choice is per-engine (`PATCH /v2/engines/:id { model }`); each harness exposes its own model list.
- **Connection.** Each engine picks **Subscription (OAuth)** — the harness's own login, nothing stored — or
  **API key** for metered billing. API keys are written **only to the TRUST vault** (`engine_<id>_api_key`,
  SACRED); `engines.json` keeps just an `apiKeyStored` flag. At launch, api-key mode injects the key as the
  harness's env var (`GEMINI_API_KEY`, `OPENAI_API_KEY`). Endpoints: `POST /v2/engines/:id/auth`,
  `PUT|DELETE /v2/engines/:id/apikey`. **Claude is subscription-only** — api-key billing is refused, since it
  bypasses the subscription (the project's core non-negotiable).
- **Install / update + runtime** (the former Runtime tab — Agent SDK version/update, permission mode) live under
  Engines too; runtime settings show on the Claude card (they govern the SDK web runner).
- **Config** lives in `~/.asmltr/engines.json` (default + per-engine settings; never secrets); override a harness
  binary with `ASMLTR_<ENGINE>_BIN`.

The design below is the full plan the foundation is being built out toward.

Today, one thing in asmltr knows it's talking to Claude: **`core/src/runner.js`** (the Agent-SDK `query()`
call + a little in `shared/runtime.js` and the `IS_SANDBOX`/`permissionMode` setup). Everything else —
connectors, identity, the Cast, silos, moderation, trust, dashboard, auth — is already engine-agnostic. So
the whole abstraction is: **turn `runner.js` into the `claude` implementation of an `Engine` interface**,
and let sessions pick which engine runs them.

## The key idea: an engine is a *harness + a provider*

Two things vary, and it's worth separating them:

- **Harness** — the agentic loop (tools, sub-agents, session handling): Claude Code, Gemini CLI, Codex CLI,
  or an open harness like OpenCode / Goose / Aider.
- **Provider / model** — the reasoning itself: Anthropic, Google, OpenAI, or a **self-hosted** model behind
  an OpenAI-compatible endpoint (Ollama / vLLM / llama.cpp).

Some harnesses are locked to a provider (Claude Code → Anthropic; Gemini CLI → Google); others are
provider-flexible (Codex and most open harnesses can point at *any* OpenAI-compatible base URL). That gives
a clean unification:

| Engine | Harness | Provider | Self-hosted? |
|--------|---------|----------|--------------|
| `claude` | Claude Code (SDK) | Anthropic (subscription) | no |
| `gemini` | Gemini CLI | Google | no |
| `codex` | Codex CLI | OpenAI **or a custom base URL** | **yes** (custom endpoint) |
| `opencode` / `goose` / `aider` | open harness | any OpenAI-compatible | **yes** |

**Self-hosted models are not a separate engine — they're a provider config on a provider-flexible harness.**
Point Codex (or an open harness) at your Ollama/vLLM endpoint and it's just another engine instance.

## The Engine interface

Mirrors the connector pattern (`connectors/types/<type>/`) — a thin adapter + a `meta` manifest:

```
core/src/engines/types/<id>/index.js
  meta = {
    id, label,
    kind: 'sdk' | 'cli',                       // driven in-process, or a subprocess
    capabilities: { … },                        // see below
    models,                                     // static list or a discovery fn
    configSchema,                               // keys (vault-backed), model, base_url, cwd, sandbox…
  }
  async provisionMcp(servers, ctx)              // materialize asmltr's MCP registry into this harness
  async run({ prompt, systemPrompt, resume, cwd, images, mcp, onEvent, abortController })
     → { engineSessionId, reply }               // events normalized to shared/events.js
```

`run()`'s only real job beyond invoking the harness is **normalizing its output into asmltr's existing
event contract** — the same `system` / `assistant(text·tool_use·thinking)` / `result` / `stream_event`
shape `runner.js` already emits. The core, collector, dashboard, and CLI don't change.

## The capability manifest (your idea — and it's the right call)

asmltr already thinks this way: connectors carry `capabilities` (`supports_attachments_out`, …) and the
console-manifest drives "declare a field → GUI + TUI adapt." Engines do the same. Each declares:

```
capabilities: {
  tools, subagents, skills, localFs, vision, mcp, thinking, streaming,
  sessionResume: 'native' | 'replay' | 'none',
}
```

The core **capability-gates features** instead of forcing a lowest common denominator:

- Session cards show the engine badge + which capabilities are live.
- The **SELF SILO / toolbelt** prompt injections (which assume a Bash tool) only fire when `localFs` is true.
- No `skills` → skills aren't injected. No `subagents` → no Task tool. Graceful degradation, per engine.

## Divergent features: normalized model → negotiate → adapter serializes

Harnesses implement the same feature differently (Claude's image handling takes `detail` + more formats
than Codex; one engine caps images at 8, another at 100). The core **never speaks a harness's dialect** — it
works in asmltr's own *normalized* feature model, and three pieces bridge the gap:

1. **Rich capability descriptors, not booleans.** A capability declares the feature's *shape* — allowed
   values + limits — so the runtime knows what each engine will actually accept:
   ```js
   // claude
   vision: { supported: true, formats: ['png','jpeg','webp'], maxImages: 100, detail: ['low','high','auto'], maxBytes: 5e6 }
   // codex
   vision: { supported: true, formats: ['png','jpeg'],        maxImages: 8,   detail: false }
   ```
2. **A negotiation pass.** Before dispatch, a shared `negotiate(request, capability) → { request, dropped,
   warnings }` validates the normalized request against the *target* engine's descriptor and applies one
   uniform degrade policy — clamp counts, drop unsupported fields (e.g. `detail`), downscale/reject oversized
   images — returning warnings. Same logic for every adapter, so degrade behavior is consistent and the
   warnings surface (to the session + the dashboard).
3. **The adapter serializes** the negotiated request into valid harness commands. That's the **only** place
   harness-specific flags exist (the anti-corruption layer).

The runtime is "aware" because the manifest is **machine-readable**: the GUI hides the image-`detail`
control on a session whose engine has `detail: false`; the core can warn ("this engine caps images at 8 —
3 dropped") or route an image-rich task to a vision-strong engine. For genuinely irreducible harness-specific
nuance, an opt-in per-engine passthrough — `engineOptions: { claude: {…}, codex: {…} }` — is merged by the
adapter *after* negotiation. **Normalize first; reach for passthrough only for the long tail.**

## Tools across engines — normalize events, not names; derive the inventory from the harness

Ask two engines "find the three largest files on my system" and they take different paths with differently
*named* tools (Claude's `Bash` vs Codex's `shell`) and different event schemas. asmltr **does not unify tool
names** — it unifies the tool-call **event shape**. Each adapter maps its harness's tool events into the one
[event contract](architecture.md) (`{ type:'tool', engine, tool:<rawName>, category, detail }`), so the
dashboard timeline renders both the same way (**🔧 shell · `find / …`**) with the raw name on hover. Same
substrate → same answer; two trails, both captured.

**"Which tools does this engine allow?" — derive it from the harness.** Three sources, best-first:

1. **Runtime introspection (authoritative).** The harness reports its toolset at session start — the Claude
   SDK's `system` init event carries `tools` + `mcp_servers` + `model`; Codex/Gemini expose the same via
   their handshake or a list-tools call. So asmltr records exactly what *this* session can do, **including the
   MCP servers it just injected**, reflecting the harness version/config.
2. **A curated static tool list per engine** — for pre-session display (the Engines page shows the harness's
   built-ins before anything runs). The coarse fallback.
3. **asmltr's own MCP tools** — stable names/args everywhere, because asmltr defines them.

Each tool carries an asmltr **category** (`shell`, `fs`, `web`, `memory`, `message`, `subagent`) so tools
are comparable across engines even when named differently — for *display + reasoning*, never for invocation.

This is a **different layer** from the coarse capability manifest:

- **Capability manifest** (static, coarse): *does* the engine do vision / subagents / skills / localFs / mcp?
  → drives UI gating + `negotiate()`.
- **Tool inventory** (static + runtime, fine): the actual *named* tools this session has → drives the Engines
  page + timeline labels.

## Sessions — where silos pay off

- **`native`** (Claude SDK assigns + resumes ids; Codex has session ids): store `engineSessionId`, pass `resume`.
- **`replay`** (stateless CLIs): asmltr already owns the transcript (sessions DB + the Self silo's
  `memory/transcripts`), so it replays history as context. **Because silos abstracted storage, replay-resume
  is uniform across every engine that lacks native resume.**

## Config, accounts & selection

- **Per-engine config** as its own registry (like `integrations`): model, `base_url`, cwd, sandbox mode,
  and **keys resolved through the vault** (`*_ref`), never in config. Multiple instances of one harness are
  allowed (e.g. two `codex` engines on different self-hosted endpoints).
- **Selection**: a default engine + a **per-session override** (start a session on a chosen engine). Because
  sessions are already keyed independently, **simultaneous sessions on different engines fall out for free** —
  the headline demo.
- **GUI**: Settings → **Engines** (add / configure / enable / set default), and an engine picker when
  starting a web session; the Live view shows each session's engine.

## Per-engine integration notes

> Exact headless flags / event schemas below are **to confirm during implementation** — the CLIs evolve.

- **`claude`** (SDK, present: `claude` 2.1.211) — the reference impl; native resume, full capabilities
  (tools, subagents, skills, localFs, mcp, thinking, streaming). Just move `runner.js` behind the interface.
- **`gemini`** (CLI, **already installed: `gemini` 0.25.0**) — drive its non-interactive/headless mode;
  parse output → events. Resume likely `replay` (or its checkpoint/save mechanism). Caps: tools + MCP +
  vision; streaming granularity TBD. Natural **first non-Claude target** since it's on the box.
- **`codex`** (CLI, not yet installed) — `codex exec` has a structured/JSON mode → clean event mapping;
  native session resume; MCP; and **custom model providers via config (base URL + key)** → this engine
  *doubles as the self-hosted path*. Map its sandbox/approval modes to asmltr's autonomous intent.
- **self-hosted** — start by reusing `codex` with a custom `base_url` (Ollama/vLLM/OpenAI-compatible). If a
  more general harness is wanted, add an `opencode` / `goose` / `aider` engine (all point at arbitrary
  endpoints; trade-offs differ — Aider is edit-centric, OpenCode/Goose are general agents).

## Levels of control (substrate first — not tool interception)

A wrapped harness runs its *own* agentic loop with its *own* native tools, and a model **will prefer its
native tools** over anything we bolt on for overlapping jobs (it'll use native `Write`, not our `silo_put`).
So asmltr does **not** try to win that fight. Control is layered, cheapest-first:

| Level | Mechanism | What it guarantees | Cost |
|-------|-----------|--------------------|------|
| **Substrate** | cwd + sandbox = the silo; vault brokers creds; moderation/redaction at the boundary | *where* files land (native file tools write into the silo anyway — the filesystem is the abstraction); that raw creds never exist to route around; that I/O is screened | free — already built |
| **+ Additive MCP tools** | expose capabilities the harness *lacks* (send, cross-silo memory recall, vault-brokered API calls) | the model uses them because there's **no native competitor** to fall back to | small |
| **+ Tool gating** | *disable* the native tools you want to own (Claude Code `allowedTools`/`disallowedTools`; per-harness) | forces routing to your tool for overlapping jobs — without rebuilding the loop | small, per-harness (manifest declares support) |
| **Own the loop** | asmltr runs the agentic loop: model → tool call → **asmltr executes** → result back | every tool call, uniform semantics across all models | large (Phase 5 — and the *only* option for self-hosted models with no CLI) |

**The plan relies on Substrate + Additive, escalating to Gating/Own-the-loop only where you must** — not on
persuading a model to prefer our tools over its own.

## MCP — one registry, every harness (the additive tool layer)

asmltr owns a single **MCP registry** (server definitions: stdio `command`/`args`/`env` or HTTP/SSE
`url`/`headers`, plus a trust scope). Each engine adapter **provisions those servers into its harness at
session start** — so a server defined once in asmltr is callable by *any* MCP-capable engine.

Provisioning is per-harness but the registry is shared:

- **Claude (SDK)** — pass the resolved servers as `mcpServers` in the `query()` options. **In-process, nothing
  on disk.**
- **CLI harnesses (Codex, Gemini, …)** — the adapter **generates that harness's native MCP config into an
  ephemeral per-session home/cwd** (`config.toml` under a temp `CODEX_HOME`; `.gemini/settings.json` in the
  session cwd) and invokes. Same registry, translated per harness.

So the `Engine` interface gains one method — `provisionMcp(servers, ctx)` — and the core is responsible for:

- **Which servers** a session gets — filtered by the [trust model](security/trust.md) (per principal/scope)
  and the engine's `mcp` capability + supported transports.
- **Secrets** — MCP server credentials are resolved from the [vault](security/trust-vault.md) at session
  start and injected into the generated config (ephemeral, `0600`, cleaned up) or passed in-memory (Claude).
  This stays consistent with use-but-never-see: the secret goes to the *MCP server process*, not the model.

**asmltr's own capabilities as MCP tools — additive, not a replacement.** asmltr exposes the things a
harness *can't* do — `send`, cross-silo memory recall, uploads, vault-brokered credential use — as an MCP
server. The model reaches for these because there's **no native competitor** (see
[Levels of control](#levels-of-control-substrate-first-not-tool-interception)). This is *not* an attempt to
replace native file/bash tools — overlapping ops are handled by the substrate (cwd/sandbox = the silo), and
if you truly need to own an overlapping op, use **tool gating**, not MCP. (Prose — "run `asmltr silo …`" —
stays a fallback for engines without MCP but with a shell.)

## Cross-cutting concerns
- **Sandbox / permissions** — each harness has its own autonomy model (Claude `bypassPermissions`+`IS_SANDBOX`;
  Codex sandbox/approval modes; Gemini's yolo/non-interactive). The adapter maps asmltr's "run autonomously" to each.
- **Skills** — Claude Code skills are Claude-specific. Other engines get none until (later) skills are lifted
  into an asmltr registry (silo-backed) and injected as prompt + tools. The manifest says who has them.
- **Streaming granularity + the voice fast-path** — CLIs may stream coarser than the SDK; the `streaming`
  capability + the low-latency voice path adapt per engine.
- **Economics** — Claude rides the subscription (no metered path — a *Claude-specific* rule). Other engines
  may be metered (API keys) or subscription (ChatGPT/Gemini accounts) or free (self-hosted). It's a per-engine
  config choice, surfaced in the manifest, not a global constraint.

## How it ages (durability as harnesses update)

The CLIs churn fast. The design holds up because it's weighted toward **deriving over declaring**, with a
small, contained maintenance surface:

| Layer | On a harness update | Maintenance |
|-------|---------------------|-------------|
| **Derived at runtime** — tool inventory, model id, MCP list (from the harness handshake) | **auto-updates** (a new/renamed tool just appears) | **none** |
| **Substrate** — cwd/sandbox=silo, vault brokering, boundary moderation | **immune** (OS + vault, not the harness API) | **none** |
| **Adapter parse/serialize** — event schema + flags, in `engines/types/<id>/` | may break **that one adapter** | the real surface — contained to one file, core never moves |
| **Normalized model + GUI** for a brand-new modality | ignored until taught | additive, rare (true of any abstraction) |

**The highest-velocity thing (toolsets) is derived, not maintained** — that's the crux of why it scales.

Guardrails that keep the adapter surface from becoming a treadmill:

- **Stable machine contracts, never TUI scraping** — versioned SDK (Claude), `exec --json` (Codex). Don't parse human output.
- **Version-pin + `tested_versions` in the manifest + adapter self-check on startup** (`--version` / list-tools):
  a harness outside the tested range makes that engine **degrade loudly** in the dashboard ("⚠ codex 0.x untested")
  instead of silently corrupting sessions. Breakage becomes a visible, contained signal.
- **Contract / golden-transcript tests per adapter** so schema drift fails CI, not production.
- **Defensive parsing** (the current runner already does "field names defensive across SDK versions").
- **asmltr's own tools ride MCP with asmltr-controlled names** → they never drift; only *native* tools drift, and those are merely *displayed* (derived), not depended on.

**Precedent + pressure valve.** This ages like the [connector layer](connectors/discord.md) already has — churning
third-party APIs absorbed one adapter at a time, core unmoved. And if any single CLI's churn becomes untenable,
that provider can move to the **own-the-loop** path (Phase 5) where there's no harness to track — so no one
backend can hold the system hostage.

## Phased plan

| Phase | Scope | Risk |
|-------|-------|------|
| **0 — Abstraction** | Define the `Engine` interface + capability manifest; move `runner.js` → `engines/types/claude/`; core selects an engine per session (default `claude`); **no behavior change**. | Low — pure refactor, the enabling move |
| **1 — Registry + selection + GUI** | Engine config registry (vault-backed keys), Settings → Engines, per-session override, engine badge + capabilities on session cards. Still Claude-only, but multi-engine plumbing. | Low |
| **2 — Codex engine** | Wrap `codex exec --json`; native resume; sandbox mapping; MCP. Highest-value 2nd engine (clean JSON + it's the self-hosted vehicle). | Medium |
| **3 — Gemini engine** | Wrap the installed Gemini CLI headless; replay resume; caps manifest. | Medium |
| **4 — Self-hosted** | A Codex (or open-harness) engine instance pointed at a custom OpenAI-compatible `base_url` (Ollama/vLLM). Mostly config on Phase 2/3. | Medium |
| **5 — (someday) own harness** | asmltr's own Cursor-style tool loop over any model — only if CLI-wrapping proves limiting. Reuses a unified tool schema + silo-backed skills. | Large, optional |

**Phase 0 is the whole unlock** — once the seam exists, each engine is an additive adapter, and mixed-engine
sessions work immediately.

## Open questions

- Exact headless invocation + streaming-event schema for Gemini CLI and Codex `exec` (verify in Phase 2/3).
- ~~Do we bridge asmltr's MCP tools into every engine?~~ **Decided: yes** — asmltr owns the MCP registry and
  provisions it per harness at runtime (see [MCP — one registry, every harness](#mcp-one-registry-every-harness)),
  and exposes its *own* toolbelt (silos/send/creds) as an MCP server so every MCP-capable engine gets it natively.
- Skills: leave Claude-only for now, or make lifting skills into an asmltr registry a Phase-1.5? (An
  asmltr *skills-as-MCP* server would ride the same bridge.)
- Per-engine cost/telemetry — surface metered vs subscription usage distinctly in the Usage view.

## See also

- [Architecture](architecture.md) · [How it works](how-it-works.md) — the pipeline the engine plugs into.
- [Data silos](silos.md) — why replay-resume is uniform (silos own transcripts).
- [Connectors](connectors/discord.md) — the adapter+manifest pattern this mirrors.
