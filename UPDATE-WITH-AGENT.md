# Updating asmltr — instructions for an AI coding agent

**You are an AI coding agent on a machine where asmltr is already installed and running.** Follow these
steps to pull the latest version and restart cleanly. If a step fails, stop and report the exact error.

Your configuration lives in **gitignored** files that a code update does NOT touch:
`.env`, `connectors/types/mcp/clients.json`, `core/src/trust/seed.json`,
`connectors/types/discord/channel-aliases.json`. They are untracked, so the git commands below leave
them intact. Do not delete or overwrite them.

---

## 0. Locate the install + record a rollback point

`cd` into the asmltr repo (where it was cloned). Record the current commit so you can roll back:

```bash
cd /path/to/asmltr            # the existing asmltr checkout
git rev-parse --short HEAD    # ← RECORD this; it's your rollback point
git status --porcelain        # should be empty. If you have local edits to TRACKED files, `git stash` them first.
```

---

## 1. Fetch + update the code (keeps your gitignored config)

```bash
git fetch origin
git reset --hard origin/main   # move tracked files to the latest release
```

`git reset --hard origin/main` updates tracked files only — it does **not** delete untracked files like
your `.env` or `clients.json`. (It's used instead of `git pull` because the public repo is published as a
clean single-commit history, which a plain `git pull` can refuse to merge. `reset --hard origin/main`
always works.)

---

## 2. Refresh dependencies (package.json may have changed)

```bash
for d in core connectors insights/collector cli; do
  echo "npm install $d…"; (cd "$d" && npm install) || { echo "FAILED: $d"; exit 1; }
done
```

---

## 3. Reconcile config with any new options

- **New env keys:** compare `.env.example` to your `.env` and add any new keys you actually need.
  `git diff <recorded-commit> HEAD -- .env.example` shows exactly what changed this update.
- **New/changed example files** (e.g. a connector gained a `*.example.json` or a new config field): check
  whether your gitignored copy needs a matching addition. Instance configs and the trust store migrate
  automatically — new fields default safely, so you do **not** re-seed trust unless a changelog note says to.

---

## 3b. Re-read `INSTALL-WITH-AGENT.md` — backfill any install-time pieces this machine is missing

A code update can introduce **new install-time steps** that a fresh install would perform but an
existing install has never run — a new agent skill to link, a new required CLI/symlink, a new service
or connector type, a new setup step. These won't appear from `git reset` alone.

**Every update, re-read `INSTALL-WITH-AGENT.md` and its Completion checklist, and reconcile:** for each
step/checklist item, confirm this machine already satisfies it; if something is new or missing, perform
it now (idempotently). See what changed since your last version to focus the diff:

```bash
git diff <recorded-commit> HEAD -- INSTALL-WITH-AGENT.md    # new/changed install steps this update
```

Common backfills:

```bash
# asmltr on PATH (step 7) — ensure it's still linked
command -v asmltr >/dev/null || ln -sf "$(pwd)/cli/asmltr.js" /usr/local/bin/asmltr

# asmltr agent skill (step 7b) — link/refresh so the agent has the current command surface
mkdir -p ~/.claude/skills && ln -sfn "$(pwd)/skills/asmltr" ~/.claude/skills/asmltr
```

(The skill is a **symlink** into the repo, so its content updates for free with the code — you only need
to (re)create the link if it's missing.) Do this reconciliation on every update; treat the install doc's
checklist as the source of truth for "what a complete install has."

---

## 4. Restart the services — **detached** (do NOT restart inline)

> ⚠️ **Critical if you were asked to update yourself over a channel (Discord/Telegram/etc.).**
> Your work is running *as a turn inside this very asmltr install*. Restarting `asmltr-core`
> **kills the process executing this turn** — so an inline `pm2 restart` cuts the update off
> partway (npm install/connector-cycle/verify never finish). This is the #1 reason an update
> "runs" but the new behavior never appears.

First, **queue a completion announcement** so the assistant confirms success *in the channel* once
it's back up (the manager holds it and delivers it after the restart, so it survives your turn dying):

```bash
# target = the channel/chat you were invoked from. For Discord it's the channel id, shown in your
# DISCORD CONTEXT as "Channel: #name (id …)". For other channels use the appropriate target.
curl -s -X POST 127.0.0.1:3024/announce -H 'Content-Type: application/json' \
  -d '{"channel":"discord","target":"<CHANNEL_ID>","text":"✅ Update complete — back online on the latest."}'
```

Prefer **`asmltr bounce`** (queues until this turn ends, then restarts). If you must script it,
launch a **detached, delayed** restart that survives your turn ending and runs *after* you've
replied. Restarting the connector manager cleanly cycles every connector onto the new code — the
manager reaps its own child connectors on stop, so there is **no `pkill`** here. (An earlier version
of this guide ran `pkill -f "…run-instance.js"`, but inside a `bash -c` that pattern matches the
running shell's *own* argv and kills it before `pm2 restart` executes — a silent failure that left
stale code running. See issue #8.)

```bash
setsid bash -c 'sleep 8; pm2 restart asmltr-core asmltr-insights-collector asmltr-connector-manager' >/tmp/asmltr-update.log 2>&1 </dev/null &
```

Then **finish your reply** (e.g. "Pulled + installed the update — restarting now; I'll confirm here
when it's back"). The detached script does the actual restart independently, so your turn completes
cleanly and every connector comes back on the new code; the queued announcement then posts the ✅
confirmation to the channel.

> Tip: on Discord you can skip all of this — just have the owner run **`@<assistant> update-asmltr`**,
> which does the whole pull → install → detached-restart → confirm flow as a built-in command.

**Running the update from a plain shell** (a human, not through the assistant)? Then just restart directly:

```bash
pm2 restart asmltr-core asmltr-insights-collector asmltr-connector-manager
```

---

## 5. Verify

Don't stop at `/health` — it returns `200` even from a stale process that never actually restarted.
Confirm each service is running the **new code sha** by comparing its `/version` against on-disk HEAD:

```bash
WANT=$(git -C <repo> rev-parse --short HEAD)                    # the sha you just updated to
for hp in 3023 3024 3017; do
  echo -n "$hp → "; curl -s 127.0.0.1:$hp/version               # sha must equal $WANT
done
curl -s 127.0.0.1:3024/instances | head -c 400; echo            # instances still present
asmltr ls                                                       # CLI/TUI still works
```

If any `/version` sha ≠ `$WANT`, that service did **not** restart onto the new code — investigate
before declaring success (the automated path, `scripts/restart-with-rollback.sh`, makes exactly this
check and auto-rolls-back on a mismatch). Then have the user send a real test message on one channel
and confirm a reply.

---

## 6. Web GUI — rebuild it if present, or OFFER it if not

The optional web dashboard (`insights/dashboard`) isn't part of every install. Check whether it's deployed:

```bash
docker ps -a --format '{{.Names}}' | grep -q '^asmltr-insights-dashboard$' && echo PRESENT || echo ABSENT
```

**If PRESENT** — rebuild it so the GUI picks up this update, using the same compose/env/override the
install used:
```bash
(cd insights/dashboard && npm install)
docker compose -f insights/docker-compose.yml up -d --build   # + any -f override / env vars the install used
```
Then confirm it still loads — and, if it's public, that an unauthenticated request still redirects to the
login portal (auth didn't regress).

**If ABSENT** — the user has no web GUI. **⛏ ASK USER:** "You don't have the asmltr web dashboard set up —
want me to set it up now? Either **local-only** (SSH tunnel) or **public on a domain behind
authentication**." If yes, follow **§9 "Web GUI" in `INSTALL-WITH-AGENT.md`** (detect any reverse proxy +
auth layer already on the box, set up domain/DNS + TLS, and restrict access to their identity). If no,
continue and just remind them it can be enabled anytime.

> 🔒 Never bring the GUI up on a public interface without an authenticator in front restricting it to the
> specific user(s) — it also proxies the connector-manager + trust **control plane**. If you can't put auth
> in front of it, deploy local-only instead.

---

## 7. If something broke — roll back

```bash
git reset --hard <recorded-commit>          # from step 0
for d in core connectors insights/collector cli; do (cd "$d" && npm install); done
pm2 restart asmltr-core asmltr-connector-manager asmltr-insights-collector
```

Then report to the user what failed (with the error) and that you rolled back to the previous version.
