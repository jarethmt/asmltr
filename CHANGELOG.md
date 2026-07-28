# Changelog

All notable changes to asmltr are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and asmltr uses [Semantic Versioning](https://semver.org/).

Releases are git tags `vX.Y.Z`. The `stable` update channel tracks the latest tag; the `edge`
channel tracks `origin/main`. See [docs/UPDATER-DESIGN.md](docs/UPDATER-DESIGN.md).

## [Unreleased]

### Added

- Always-on **CURRENT SPEAKER** line in every turn's system prompt — authoritatively names the
  current sender (even without a cast profile) so an assistant on a shared, multi-person channel
  doesn't confuse who it's talking to or default to the box owner.

### Changed

- **Inject-once system prompt on history-retaining engines** — the composed system prompt (identity,
  trust/authz, channel-awareness, toolbelt, …) is now split into a STABLE block (changes only when a
  store/state changes) and a small VOLATILE tail (who's speaking, their authz, per-turn context). On an
  engine whose resume replays prior turns (codex), the stable block is folded into the user turn **once**
  and only the volatile tail is re-sent on resumes — instead of prepending the whole multi-thousand-token
  block to every turn (which the `composePrompt` fix for codex/gemini would otherwise do). Re-injection is
  keyed on a sha256 of the stable block, so an identity edit, trust change, vault lock/unlock, or silo-path
  change re-sends it automatically. The Claude engine is unchanged (its append lands on a cached system
  channel); the full prompt is byte-identical to before. Kill-switch: `ASMLTR_INJECT_ONCE=off`.

### Fixed

- **Core system prompt was silently dropped on the Claude engine.** `options.appendSystemPrompt` is
  a no-op in `@anthropic-ai/claude-agent-sdk`'s `query()`; the engine now passes
  `options.systemPrompt = { type: 'preset', preset: 'claude_code', append }`. Identity, trust/authz,
  channel-awareness, cast, and toolbelt instructions reach the model again (regression since the
  agent-SDK migration — the assistant had been running on `CLAUDE.md` alone).

## [0.7.0] - 2026-07-21

asmltr 0.7.0 — Reasoning engines (Claude/Gemini/Codex/self-hosted), MCP tools registry, guarded backup restore + import, and connector-resilience fixes (#30/#33/#35).

### Added
- **Reasoning engines — pluggable agentic backends.** The channel/web runner is now engine-abstracted
  (`core/src/engines/`): a turn routes to the configured default engine — **Claude Code, Gemini CLI, or
  Codex CLI**. The Claude SDK is loaded lazily, so a Gemini-only or Codex-only install runs without it,
  and every connector (Discord/Telegram/email/GitHub/web/voice) runs on whichever single engine is
  selected. Per-engine model, **connection** (subscription OAuth or a vault-stored API key), one-click
  **install/update + auto-update**, and `asmltr claude|gemini|codex` terminal commands. Settings → Engines.
- **Self-hosted models.** Point the Codex engine at any OpenAI **Responses-API** endpoint (self-hosted
  vLLM/LiteLLM, a gateway, another provider) via a custom base URL; the key is vault-stored.
- **MCP tools registry.** Declare MCP servers once (`~/.asmltr/mcp.json`) and asmltr provisions them into
  every harness (Claude SDK `mcpServers` / Codex `-c` / Gemini `mcp add`). Includes a built-in
  **asmltr-toolbelt** stdio MCP server exposing asmltr's own tools (sessions/send/announce/uploads) to
  every engine. Settings → Engines → MCP tools.
- **Guarded backup restore + import in the dashboard.** Restore is no longer CLI-only: preview (dry-run)
  → type-to-confirm → a detached runner that survives the core restart, with a live progress log. Import
  a `.asmltrbk` archive straight from the browser.
- **Connector liveness heartbeat** (#29, #35). A connector emits a heartbeat from its active I/O path;
  the manager surfaces a deaf-but-alive instance as `healthy:false / heartbeat:stale` on `GET /instances`
  without killing it — closing the "reports running while its I/O loop is dead" gap. `ASMLTR_HEARTBEAT_STALE_MS`.
- **`ASMLTR_ANNOUNCE_FILE`** override for the manager announcements path (#29, #30).
- Loading spinners on every async action button across Settings.

### Changed
- **Docs.** README rewritten plain-language-first with a developer gateway into the deeper docs; new
  Reasoning-engines guide + MCP-registry pages; nav restructured (engines promoted to their own section,
  shipped systems separated from roadmap).
- Model & runtime settings are now **per-engine** (each harness exposes its own model list).

### Fixed
- **SDK auto-update split-brain** (#31, #33). `updateSdk()` now restarts all three PM2 services in
  lockstep, so a bump can't advance `asmltr-core` onto a new sha while the manager & collector run old code.
- **Telegram EFATAL silent death** (#32, #33). A fatal polling error now exits the connector so the
  supervisor respawns a fresh poller, instead of the process staying up and deaf.

## [0.6.0] - 2026-07-16

### Added
- **Self silo (P3).** A directory becomes a silo via a `.silo/manifest.json` marker (git-style); the
  filesystem is the schema, structure comes from a template at creation (no enforced zones). The **Self
  silo** is the assistant's memory + the default home for artifacts — the core ensures it at boot and
  injects a SELF-SILO awareness block into every session. Layered search (filename + full-text, ripgrep
  with a pure-JS fallback). New `asmltr silo <overview|ls|tree|find|get|put|…>` CLI. `shared/silo.js`.
- **Silos GUI.** A file-explorer plane — silo rail (add / select / delete-with-confirm), breadcrumb
  browser, file preview + editor, layered search, new-folder + upload, and a Settings modal to edit the
  manifest. `/v2/silos*` endpoints. A relationship-graph teaser scaffolds the future node graph.
- **Backups (P4).** `scripts/backup.js` — consistent SQLite online-backup snapshots + config + identity
  + silos → gzipped tar, **AES-256-GCM under a scrypt(passphrase) key, vault-independent** (a vault loss
  is itself recoverable). Streamed encrypt/decrypt; `asmltr backup <create|list|verify|restore>` (restore
  stashes overwritten files); auto-snapshot before every self-update. **Remote destinations** push the
  encrypted archive to a storage integration (webdav/s3/local). **Scheduled backups** with retention
  (frequency / max stored / max age) run in-process in the core. Settings → Backups GUI.
- **`asmltr vault init` (P2).** Guided one-command bootstrap — health-check → optional unseal → register
  the identity as a SACRED agent → write `ASMLTR_VAULT_*` to `.env` → verify a store→proxy-fetch→delete
  roundtrip. Plus `asmltr vault <status|unseal|seal>` and a passphrase-unseal form in the Vault GUI when
  the vault is sealed (`POST /v2/vault/unseal`).

### Changed

### Fixed

## [0.5.0] - 2026-07-16

### Added
- **TRUST vault integration (hard dependency).** asmltr now depends on the
  [TRUST Protocol](https://github.com/jarethmt/trust-protocol) for secrets. `shared/vault.js` is the
  client; the assistant registers as a SACRED agent under its identity name. `GET /v2/vault/status`
  reports reachable/sealed for a degraded-but-loud UI. Contributed the **KMS** (envelope encryption —
  `generate`/`wrap`/`unwrap`) *to* TRUST Protocol for encryption-at-rest.
- **Storage substrate + drivers.** `shared/storage.js` — a backend-agnostic driver contract
  (put/get/stat/list/remove/move/mkdir/mint) behind both data silos and backups. Drivers: built-in
  **local**, **WebDAV** (Nextcloud, verified), and **S3-compatible** (AWS/B2/Spaces/R2/MinIO, presigned
  `mint`). **EncryptedStorage** wraps any driver with AES-256-GCM — the per-silo data key comes from the
  vault's KMS (master key never leaves the vault; the key lives only in the runtime crypto layer, never
  in model context, zeroed after use).
- **Integrations framework.** A registry (`integrations/registry.js`) of third-party service links whose
  secret fields are `*_ref` vault key names, resolved from the vault only at open. Core
  `/v2/integrations` endpoints (list/create/update/delete/test).
- **GUI: Vault + Integrations planes.** A **Vault** view (key management — status banner, keys with
  tier + access count, add/delete; values are write-only) and an **Integrations** view (add/configure/
  test storage integrations; creds stored in the vault).

### Changed
- **De-BWS — asmltr's runtime no longer depends on Bitwarden.** `shared/secrets.js` resolves from the
  TRUST vault; all runtime secrets (connector tokens + voice keys) migrated BWS→vault and the BWS
  command provider disabled. Only the vault's own access keys remain in `.env` (the bootstrap root).
- **Vocabulary + GUI rename:** *connector* = an I/O channel to a human; *integration* = a link to a
  third-party service. The old "Integrations" view (connector instances) → **Connectors**.

## [0.4.0] - 2026-07-16

### Added
- **Aesthetic identity facets** — a free-text *aesthetic* sensibility + an ordered *signature palette*
  (primary/secondary/tertiary; names and/or hex), injected into the anchor every session sees, so an
  agent leans on its own colors/style when building assets and no other cue is given. Editable in
  Settings → Identity (GUI + TUI via the manifest).
- **Live UI theming from the palette** — the dashboard's brand accent, gradients, background glow,
  pills, **nav logo** (now inline SVG), and **browser tab favicon** (regenerated data-URI) all retint
  in real time when the signature palette is saved. Falls back to the built-in violet/pink.
- **Discord server invite + membership management** — a *Servers* button on the Discord instance card
  opens a modal with the copyable OAuth invite URL (to add the bot to a new server) and the list of
  servers it's in, each with a *Leave* button. New connector `/servers` control endpoint + manager
  proxy generalization; documented in `docs/connectors/discord.md`.

### Fixed
- **Self-goal extractor no longer gives up** (issue #16) — the reflector now climbs to the loosest
  honest through-line (shared subject/domain/mode/direction; a single part's aim *is* the goal)
  instead of defaulting to "no single goal — the parts are unrelated," which is now a rare last resort.

## [0.3.1] - 2026-07-15

### Added

### Changed
- **Standardized on Node 24 LTS** (issue #21). `engines.node` raised to `>=24.0.0` across the root +
  every workspace, a root `.nvmrc` pinning `24`, and the dashboard build image bumped
  `node:20-alpine → node:24-alpine`. Clears the `EBADENGINE` from `@discordjs/voice@0.19.2`
  (needs `>=22.12`); docs updated from ">= 18".
- **Turn-complete notification toggle moved to Settings → Notifications.** The sidebar header no
  longer carries the toggle; it lives in a GUI-only Settings tab (with permission state + a link to
  the history page). The ✦ Notifications nav item still shows notification history.

### Fixed
- **Documented `ASMLTR_UPDATE_MANAGED` in `.env.example`** (issue #23) — the managed-mode work (#18)
  added the variable but not the example entry CLAUDE.md calls for.

## [0.3.0] - 2026-07-15

### Added
- **Persistent update progress (GUI + TUI).** The updater writes `~/.asmltr/update-status.json`
  through every phase (fetch → install → restart → verify); core exposes `GET /v2/update/progress`.
  The GUI shows a persistent progress panel at the top of every page that survives the mid-update
  service restart (spinner, phase, log tail, terminal result + dismiss); the TUI shows a matching
  overlay reading the status file directly. Triggered from both the banner and Settings → Updates.
- **Agent-name brand + browser tab title.** The header shows the configured agent name with an
  "asmltr control plane" subtext; the running version sits by the collector-live pill; the tab title
  is `<Agent> · <focused session, else active view>`.
- **claude-code sessions now show the assistant's replies.** The connector recovers the reply from
  the transcript on the `Stop` hook and emits it as an `outbound` event (previously only inbound/tool
  events reached the dashboard). Requires wiring the `Stop` hook (README updated).
- **Committed lockfile + `npm ci`** (issue #17): a root `package-lock.json` pins the whole transitive
  tree (incl. native modules); the updater prefers `npm ci` (exact-match) with an `npm install` fallback,
  and `release.js` regenerates the lock per tag so every release ships a matching lock.
- **Externally-managed update mode** (issue #18): `ASMLTR_UPDATE_MANAGED=<manager>` / a `~/.asmltr/managed`
  flag makes the updater step aside cleanly (distinct exit code 6, `getUpdateStatus.managed`,
  `/v2/update/run` refuses) on package/image/config-managed installs instead of crash-looping.
- **The cast (Access-evolution Phase 0)** — the identity/relationship layer, built on the existing
  trust store (no second store). New `principal_profile` (who a member is + how to relate), pairwise
  directional `relationships`, per-scope `engagement` (engage|observe|ignore, retiring per-connector
  bot lists), and `verification_strength` on identifiers. `resolve()` now returns a member's profile,
  ALL cross-channel identities, the self→them relationship, and engagement policy. `buildRelationshipPrompt`
  injects into the system prompt: who you're talking to, their **cross-channel identity** (one person
  across all their channels), your relationship, and the peer agents present (recognition without
  per-channel config). `/trust/{profiles,relationships,engagement}` endpoints. Roadmap: docs/ACCESS-EVOLUTION.md.
- **Cross-session send with assimilation** (`POST /v2/send`, channel-agnostic). An agent in any
  session can post into another channel AND the destination session folds the message into its own
  context (it was posted under its name from a parallel session). Connectors' `/out` now return the
  destination `conversation_key` (Discord + Telegram) so core can route the assimilation. `asmltr send`
  goes through core (falls back to the manager if core is down).

### Fixed
- **Multi-agent no-reply reliability.** When the model decides a message isn't for it, it should emit
  the bare `[[NO_REPLY]]` token — but it often prose-refuses instead ("That's addressed to Moneo, not
  me…"), which got posted as spam. Core now detects that short meta-refusal and stays silent (channel-
  agnostic; length-capped + adjacency-specific to avoid suppressing real replies that merely mention
  who a message was addressed to).
- **Discord reply threading.** A message that uses Discord's reply feature now carries "↩ in reply to
  <author>: …" into the prompt (both addressed and observed paths), so in a busy multi-agent channel
  the agent can tell WHAT a peer replied to instead of losing the reference.
- **Interrupted / empty turns no longer emit a canned greeting.** An empty reply (interrupt,
  tool-only turn, or a deliberate non-answer) now posts nothing instead of "I'm here — what would
  you like to know?", which on multi-agent channels was noise other agents kept answering.
- **Multi-agent self/other attribution.** The observed-activity catch-up now states that other
  participants' "I/my" refers to the named speaker (not the reading agent), and the Discord identity
  line tells the agent its own handle — so an agent stops mistaking peers' first-person messages, or
  its own earlier ones, for something newly said to it.

### Added
- **Full-autonomy terminal sessions**: `asmltr claude` (and dashboard takeovers) launch in
  bypass-permissions mode by default (`--permission-mode bypassPermissions` + `IS_SANDBOX=1`).
  GUI/TUI-toggleable via Settings → Runtime and `/v2/runtime/cli-permission-mode`.
- **Downloadable artifacts in chat**: the GUI auto-detects local file paths in an assistant's reply
  and renders a download chip that streams the file through `GET /v2/file` (Authelia-gated).

## [0.2.0] - 2026-07-15

First deterministic-updater release: LLM-free versioned self-update, pinned releases, stable/edge channels, self-healing setup steps.

### Added
- **Deterministic installer + updater** (no LLM on the happy path): `scripts/update.js` runs the
  full update as a scripted, verified pipeline (fetch → resolve channel target → setup-steps →
  npm install → dashboard build → restart-with-rollback → announce). The agent-driven updater
  remains only as an escape hatch when the deterministic path fails.
- **Semantic versioning + pinned releases**: `VERSION`, this changelog, git tags, and a `scripts/release.js`
  release cutter. Services report `{ version, channel, sha }` from `/version`.
- **Self-healing setup steps**: `setup.d/` numbered idempotent steps + an applied-ledger, so a
  bespoke install picks up any newly-required install step on its next update.
- **Update channels**: `stable` (latest release tag) vs `edge` (origin/main), selectable per install.

## [0.1.0] - 2026-07-15
- Baseline: the pre-versioning state of asmltr (core pipeline, connectors, insights dashboard + TUI,
  shared console manifest, unified speech layer, PWA). First tagged release.
