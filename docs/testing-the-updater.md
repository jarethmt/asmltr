# Testing the deterministic updater

A safe, ordered way to exercise the LLM-free updater on a **throwaway / isolated box** (ideal — if it
wedges, rollback catches it, and worst case you re-provision). See
[Versioning & updates](UPDATER-DESIGN.md) for how it works.

## Prerequisites on the test box

- An asmltr install (via the README steps or `INSTALL-WITH-AGENT.md`) with the three host services
  running under PM2 as `asmltr-core`, `asmltr-insights-collector`, `asmltr-connector-manager` on the
  default ports (3023 / 3017 / 3024). The updater verifies these; non-standard names/ports will trip
  the health check and trigger a rollback.
- Its own secrets/connectors (the updater itself needs **no** external credentials — just git / npm /
  pm2 / docker).
- `node >= 24`, `git`, `npm`, `pm2` on PATH. `docker` only if the box runs the dashboard.

## 1. Baseline

```bash
asmltr version          # local + per-service versions, and whether an update is available
```

## 2. Dry-run (no changes)

```bash
asmltr update --dry-run            # prints the plan for the current channel
asmltr update --dry-run --stable   # confirm it resolves the newest release tag
```

## 3. Put the box *behind* so there's something to update

There's little to test if you're already current. Move to an older commit, then bring services up:

```bash
cd <asmltr-repo>
git log --oneline -8                      # pick a commit a few back
git checkout <older-sha>
cd <repo> && npm install --no-audit       # match deps to that commit
pm2 restart asmltr-core asmltr-insights-collector asmltr-connector-manager
asmltr version                            # should now show it's behind
```

## 4. The real update

```bash
asmltr update            # edge (origin/main). Or: asmltr update --stable
```

Watch it live: the dashboard shows a `self-update` session, or `tail -f ~/.asmltr/update.log`.
It runs: fetch → checkout → setup-steps → `npm install` (root workspace) → dashboard rebuild →
`pm2 restart` → **verify /health + /version sha** → auto-rollback on any failure.

## 5. Confirm

```bash
asmltr version           # new version; all three services healthy and on the new sha
```

Success exit is `0`. `2` = it rolled back (new build failed verify — services healthy on the old
build). `3` = both failed; check `~/.asmltr/update.log`.

## Escape hatch

If the deterministic path chokes on something bespoke:

```bash
asmltr update --agent    # runs the LLM update session instead
```

## What it never touches

`.env`, trust seed, connector configs, `docker-compose.<instance>.yml`, `CLAUDE.local.md`, the SQLite
databases, and `~/.asmltr/` all survive — `git reset --hard` leaves gitignored paths alone.
