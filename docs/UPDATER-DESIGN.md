# Versioning, releases & the deterministic updater

asmltr updates itself **without an LLM on the happy path**. The update is a scripted, verified
pipeline; the old agent-driven update session is kept only as an escape hatch for the rare bespoke
case the script can't handle.

## Versioning

- **Version** = the semver in the repo-root [`VERSION`](../VERSION) file (mirrored into every
  `package.json`). Every service reports it at `GET /version` alongside its git sha:
  `{ service, version, channel, sha, ... }`. The `sha` is captured at process start, so it proves a
  restart actually landed (a stale process reports its old sha).
- **Releases** are git tags `vX.Y.Z`. Cut one with `node scripts/release.js <major|minor|patch>`:
  it bumps `VERSION` + all `package.json`s, rolls `CHANGELOG.md`'s `[Unreleased]` into a dated
  section, commits `release: vX.Y.Z`, and tags. Add `--push` to publish, `--gh` for a GitHub release.
- **Channels** decide what "latest" means:
  - **`stable`** — the newest release tag. Downstream installs pin here.
  - **`edge`** — `origin/main`. Dev / self-hosted installs (like the maintainer's) track this.
  - Set per install: `asmltr` CLI, the dashboard Settings → Updates toggle, or
    `POST /v2/update/channel`. Persists in `~/.asmltr/update-channel` (env `ASMLTR_UPDATE_CHANNEL` wins).

## The updater ([`scripts/update.js`](../scripts/update.js))

Spawned **detached** (survives the restart it triggers). Phases, in order:

1. **preflight + lock** — refuse to run if another update holds `~/.asmltr/update.lock`.
2. **snapshot** — record the current sha as the rollback point.
3. **fetch** — `git fetch --tags origin main`.
4. **resolve target** by channel (`stable` → newest `vX.Y.Z` tag; `edge` → `origin/main`; `--ref` pins).
   If already there → nothing to do.
5. **checkout** — `git reset --hard origin/main` (edge) or `git checkout` the target (stable/ref).
   Gitignored config + data survive untouched.
6. **setup steps** — run [`scripts/run-setup-steps.js`](../scripts/run-setup-steps.js) (below).
7. **env reconcile** — [`scripts/reconcile-env.js`](../scripts/reconcile-env.js) surfaces newly-added
   `.env.example` keys into `.env` as commented placeholders (never touches existing values).
8. **install** — deps at the repo root (core/connectors/cli/collector are npm **workspaces**; the
   dashboard is built in Docker). Prefers **`npm ci`** from the committed `package-lock.json` — a
   clean, exact-match install that pins the whole transitive tree incl. native modules (better-sqlite3,
   opus, porcupine); falls back to `npm install` if there's no lock or `npm ci` fails on drift. Every
   release regenerates the lockfile, so a tag's lock matches its manifests. If install fails, the code
   is rolled back **before** any service restarts.
9. **dashboard** — if a compose file + Docker are present: `docker compose up -d --build`
   (separate lifecycle; best-effort, doesn't gate the core update).
10. **restart + verify + auto-rollback** — hands off to
    [`scripts/restart-with-rollback.sh`](../scripts/restart-with-rollback.sh): `pm2 restart` the three
    host services, then verify each `/health` **and** that `/version` sha matches the on-disk HEAD. On
    mismatch it `git reset`s to the rollback sha, reinstalls, restarts, and re-verifies.

Progress streams to the collector under a `self-update:<ts>` session, so it appears live on the
dashboard exactly like the old agent session.

**Exit codes:** `0` ok · `2` rolled back (new build failed verify) · `3` manual intervention · `4`
already up to date · `5` another update running · `6` externally managed (see below).

## Externally-managed installs

The updater assumes asmltr lives in a **writable git checkout it can `git reset` + install into** —
true for the PM2-on-the-host default. It is **false** for package-based, image-based/read-only, or
config-management (Ansible, golden-image) deploys, where updating in place fights the platform.

Signal it with **`ASMLTR_UPDATE_MANAGED=<manager>`** (e.g. `apt`, `docker`, `host`) or a
`~/.asmltr/managed` flag file whose contents name the manager. Then:

- `asmltr update` / `scripts/update.js` exit early with a distinct **code 6** and a clear line
  (`updates managed by <manager>; not updating in place`) — never the ambiguous "cannot update".
- `GET /v2/update/status` reports `managed: true` + the manager (it still shows how far behind you are
  for telemetry; the dashboard shows "managed by &lt;x&gt;" instead of an Update button).
- `POST /v2/update/run` refuses and returns `{ managed: true, manager }` rather than spawning a process
  that dies one line in.

Updates on a managed install are the platform's job (pull a new package/image); asmltr steps aside.

## Self-healing setup steps ([`setup.d/`](../setup.d/))

The deterministic answer to "a bespoke install missed a new install step." `setup.d/` holds numbered,
**idempotent** steps (`NNN-name.sh|js`); each runs at most once per install, tracked in
`~/.asmltr/applied-steps.json`. Adding a newly-required install action → drop in one idempotent
numbered step → **every install picks it up on its next update.** A step exits `0` (applied), `75`
(not applicable here — skip, retry later), or non-zero (failed; logged, non-fatal — setup is
best-effort environment wiring and never rolls back the code).

Seed steps: link the CLI onto PATH, link the agent skill, provision the assistant alias.

## Triggering an update

- **CLI:** `asmltr update [--dry-run] [--stable|--edge] [--force]` (runs the updater in the
  foreground); `asmltr update --agent` for the escape hatch; `asmltr version` shows local + per-service
  versions and update availability.
- **Dashboard:** Settings → Updates (channel toggle, auto-install, "Update now").
- **API:** `POST /v2/update/run` (deterministic; `?mode=agent` for the escape hatch),
  `GET /v2/update/status`, `GET|POST /v2/update/channel`, `GET|POST /v2/update/auto`.
- **Auto:** the collector checks every 15 min; if `available` and auto-install is on, it triggers the
  deterministic updater.

## The LLM escape hatch

The agent update session ([`scripts/run-update-session.js`](../scripts/run-update-session.js) driving
[`UPDATE-WITH-AGENT.md`](../UPDATE-WITH-AGENT.md)) remains, reachable via `mode=agent` /
`asmltr update --agent`. Use it only when the deterministic path fails on a genuinely novel install —
you keep the "wild install" adaptability without depending on an LLM for routine updates.

## What is never touched on update

Gitignored config + all runtime state: `.env`, `core/src/trust/seed.json`,
`connectors/types/mcp/clients.json`, `connectors/types/discord/channel-aliases.json`,
`connectors/types/openai/keys.json`, `insights/docker-compose.<instance>.yml`, `CLAUDE.local.md`, the SQLite
databases (`core/data`, `connectors/manager/data`, `insights/collector/data`, `data/trust.db`),
`~/.asmltr/`, and the GitHub worktree cache. `git reset --hard` leaves gitignored paths alone by design.
