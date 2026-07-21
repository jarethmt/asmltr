# Installing asmltr — instructions for an AI coding agent

**You are an AI coding agent (e.g. Claude Code) running on the machine where asmltr will live.**
Follow these steps in order to install, configure, and start asmltr. Wherever you see **⛏ ASK USER**,
stop and ask the human for that value before continuing — never invent secrets or identifiers.
Run commands from the repo root unless told otherwise. If a step fails, stop and report the exact error.

asmltr = one AI-assistant backend behind Discord / Telegram / MCP / GitHub, plus a monitoring
collector. Execution uses the **local Claude Agent SDK on the user's Claude subscription** — there is
**no `ANTHROPIC_API_KEY`**. Read `README.md` for architecture if you need context.

---

## 0. Preflight — verify the environment

Run these and confirm each; if any fails, tell the user what to install and stop:

```bash
node --version          # must be >= 24 (see .nvmrc; `nvm use` picks it up)
claude --version        # Claude Code CLI must be installed AND logged in (this is the brain)
pm2 --version           # process manager; if missing: npm i -g pm2
git --version
ffmpeg -version | head -1   # ONLY needed if the user wants Discord voice mode
```

**⛏ ASK USER** (decide scope up front — it shapes the rest):
1. What should the assistant be called? (→ `ASSISTANT_NAME`)
2. Which channels do they want now? (any of: **discord, telegram, mcp, github**)
3. How should secrets be provided? (recommended: **put them directly in `.env`**; advanced: a vault command)

---

## 1. Clone + install dependencies

asmltr is a monorepo of **separate npm packages — you MUST install ALL of them**, not just the one for
your channel. `core`, `connectors`, `insights/collector`, and `cli` are all required:

```bash
git clone <REPO_URL> asmltr && cd asmltr
for d in core connectors insights/collector cli; do
  echo "installing $d…"; (cd "$d" && npm install) || { echo "FAILED: $d"; exit 1; }
done
# add insights/dashboard to that list too ONLY if the user wants the web dashboard
```

Confirm every component installed — each dir below must now have a `node_modules`:
```bash
for d in core connectors insights/collector cli; do [ -d "$d/node_modules" ] && echo "OK $d" || echo "MISSING $d — re-run npm install there"; done
```

---

## 2. Configure `.env`

```bash
cp .env.example .env
```

Edit `.env` and set:
- `ASSISTANT_NAME` — from step 0.
- The secret keys for the chosen channels/features. **⛏ ASK USER** for each needed value:
  - `OPENAI_API_KEY` — required (moderation; Discord voice STT).
  - `ELEVENLABS_API_KEY` — only if Discord voice mode is wanted.
  - `DISCORD_BOT_TOKEN` / `TELEGRAM_BOT_TOKEN` — for those channels.
  - For GitHub: a PAT env var, e.g. `MY_GITHUB_PAT` (you'll reference its lowercase name as the connector's `pat_bws_key`).
- `ASMLTR_ADMIN_ALERT_CMD` — optional; a command run on blocked/errored requests (`{msg}` = text). Leave unset to disable.

If the user chose a vault instead of inline secrets, set `ASMLTR_SECRET_CMD` (a shell template where
`{key}` is replaced with the secret key name) and leave the key values out of `.env`. See the header of
`shared/secrets.js` for the resolution order.

---

## 3. Seed the trust store (DEFAULT-DENY — nobody has access until you do this)

```bash
cp core/src/trust/seed.example.json core/src/trust/seed.json
```

Edit `seed.json`. **⛏ ASK USER** for their own identifiers on each channel they'll use, and make them
the `owner` principal with `bypass_moderation: true`:
- discord → their numeric Discord user ID
- telegram → their Telegram username
- mcp → the `identity.username` you'll assign their OAuth client in step 4
- github → their GitHub login

Then seed:
```bash
node core/src/trust/seed.js
```
Add teammates as additional principals (optionally with a limited `role_id`) — but only people the user names.

---

## 4. Per-channel setup

**MCP only** — pre-register OAuth clients:
```bash
cp connectors/types/mcp/clients.example.json connectors/types/mcp/clients.json
```
**⛏ ASK USER** for each client (e.g. their Claude web app, a teammate's Claude Code CLI). For each, set a
`client_id`, a strong random `client_secret`, the correct `redirect_uris`, and an `identity.username` that
matches a principal you seeded in step 3. Also set `BASE_URL` in `.env` to the public URL where the MCP
server will be reached.

**GitHub only** — the connector acts as the PAT's own account. Make sure the PAT env var from step 2 is
set; you'll pass its key name as `pat_bws_key` when you create the instance in step 6.

---

## 5. Start the host services

```bash
pm2 start core/ecosystem.config.js
pm2 start insights/collector/ecosystem.config.js
pm2 start connectors/manager/ecosystem.config.js
pm2 save        # persist across reboots (optional; also run `pm2 startup` and follow its instructions)
```

Verify:
```bash
curl -s 127.0.0.1:3023/health          # → {"status":"ok",...}
curl -s 127.0.0.1:3024/types | head    # manager lists available connector types
```

---

## 6. Add each channel instance

The connector **manager** (`127.0.0.1:3024`) owns instances. `GET /types` returns each type's full
config schema — consult it for all options. Create one instance per channel the user wants. Examples:

```bash
# Discord
curl -s -X POST 127.0.0.1:3024/instances -H 'Content-Type: application/json' -d '{
  "type":"discord","name":"main","enabled":true,
  "config":{"bot_token_bws_key":"discord_bot_token","dm_allowed_user_id":"<owner discord id>"}
}'

# Telegram
curl -s -X POST 127.0.0.1:3024/instances -H 'Content-Type: application/json' -d '{
  "type":"telegram","name":"main","enabled":true,
  "config":{"bot_token_bws_key":"telegram_bot_token"}
}'

# GitHub (start dry_run:true to observe before it posts)
curl -s -X POST 127.0.0.1:3024/instances -H 'Content-Type: application/json' -d '{
  "type":"github","name":"main","enabled":true,
  "config":{"pat_bws_key":"my_github_pat","repos":[{"full":"owner/repo","pat_bws_key":"my_github_pat"}],"dry_run":true}
}'

# MCP
curl -s -X POST 127.0.0.1:3024/instances -H 'Content-Type: application/json' -d '{
  "type":"mcp","name":"main","enabled":true,
  "config":{"port":3019,"base_url":"https://mcp.example.com"}
}'
```

Note on secret key names: a `*_bws_key` / `pat_bws_key` value is the **name of a secret** the provider
resolves (e.g. `discord_bot_token` → env `DISCORD_BOT_TOKEN`), never the token itself.

---

## 7. Install the monitoring CLI / TUI (required — this is part of a complete install)

Set up the `asmltr` terminal client so the user can watch live sessions and events. Do NOT skip this:

```bash
chmod +x cli/asmltr.js
# put `asmltr` on PATH (use sudo if /usr/local/bin isn't writable):
ln -sf "$(pwd)/cli/asmltr.js" /usr/local/bin/asmltr 2>/dev/null \
  || sudo ln -sf "$(pwd)/cli/asmltr.js" /usr/local/bin/asmltr 2>/dev/null \
  || echo "couldn't symlink onto PATH — run the CLI as: node $(pwd)/cli/asmltr.js"
asmltr ls      # list active sessions (or: node cli/asmltr.js ls)
```

`asmltr` (no args) opens the full live TUI dashboard (sessions + event log + system); `asmltr --help`
lists commands. Confirm `asmltr ls` runs without error before moving on.

### 7b. Install the asmltr agent skill (so THIS machine's agent knows how to drive asmltr)

The repo ships a generic, identity-neutral skill at `skills/asmltr/` that teaches an AI coding agent
the whole `asmltr` command surface (send/route, email send+browse, uploads, drafts, announce,
monitor, takeover). Symlink it into the agent's skills directory so it's always in sync with the repo:

```bash
# Claude Code default skills dir is ~/.claude/skills — adjust if this agent uses another path.
mkdir -p ~/.claude/skills
ln -sfn "$(pwd)/skills/asmltr" ~/.claude/skills/asmltr
```

Do NOT create per-capability skills for individual channels (email, send, …) — this one generic
skill covers them all and is updated in lockstep with the code. Any **install-specific** policy
(the identity/signature to send as, which senders are trusted) belongs in this machine's own agent
context (e.g. `CLAUDE.md`), NOT in the shipped skill.

### 7c. Provision the agent-name alias (type the assistant's name to launch a session)

So the operator can start a monitored session by just typing the assistant's name (e.g. `aria`
instead of `asmltr claude`):

```bash
asmltr provision-alias      # ASSISTANT_NAME=Aria → an `aria` shim → `asmltr claude`
```

It derives the command from `ASSISTANT_NAME`, **conflict-checks** it (refuses to shadow an existing
command — pick a different name or pass `--force`), and drops an executable shim onto a PATH bin dir.
Remove it later with `asmltr unalias`.

## 8. Verify it's live end-to-end

```bash
# each instance should report started/online in its logs:
for id in $(curl -s 127.0.0.1:3024/instances | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>JSON.parse(s).instances.forEach(i=>console.log(i.id)))"); do
  echo "== $id =="; curl -s 127.0.0.1:3024/instances/$id/logs | tail -c 400; echo
done
```

Then have the user send a real message on one channel (from their owner identity) and confirm a reply.

---

## 9. Web GUI (insights dashboard) — OFFER IT; help set up authenticated access

`insights/dashboard` is a Vue observability GUI over the collector (live sessions, events, tokens,
system). **You must raise this with the user — do not silently skip it.**

**⛏ ASK USER:** "Do you want the web dashboard? If so — **local-only** (you reach it over an SSH tunnel),
or **public access on a domain**? Public access will be put behind authentication so only you can reach it."

If they decline, skip this section (the `asmltr` TUI from step 7 already gives full local monitoring) and
note in your final report that the GUI is **not enabled** — it can be turned on later.

### 🔒 Non-negotiable security rule
The dashboard's nginx also reverse-proxies the **control plane** — the connector **manager** (`/manager`
→ 3024) and the core **trust/access** API (`/trust` → 3023). Exposing it to the internet WITHOUT
authentication hands anyone your control plane. **If it is reachable publicly, it MUST sit behind an
authenticator that restricts access to the specific user(s).** If you cannot set that up, deploy local-only.

### Build the SPA (both options need this)
```bash
(cd insights/dashboard && npm install && npm run build)
```

### Option A — local-only (no domain, no proxy)
Run the dashboard bound to loopback and have the user tunnel in. Simplest, always available:
```bash
# serve dist/ on 127.0.0.1 only, e.g. via the container with a loopback publish, or any static server:
ASMLTR_NGINX_LISTEN=127.0.0.1:8091 ASMLTR_UPSTREAM_HOST=127.0.0.1 \
  docker compose -f insights/docker-compose.yml up -d --build   # (see note below on the compose)
```
Tell the user to reach it via: `ssh -L 8091:127.0.0.1:8091 <server>` then open `http://localhost:8091`.

### Option B — public, authenticated (walk the user through it)

**1. Detect what's already on the box — don't assume.**
```bash
docker ps --format '{{.Names}}\t{{.Image}}' | grep -iE 'traefik|nginx|caddy|authelia|oauth2-proxy|authentik'
```
Determine: is there a **reverse proxy** (Traefik / nginx / Caddy / none) and an **auth layer** (Authelia /
Authentik / oauth2-proxy / Cloudflare Access / nginx basic-auth / none)?

**2. ⛏ ASK USER** for the **domain/subdomain** (e.g. `asmltr.example.com`) and **which identity** should be
allowed in. If there is **no reverse proxy or no auth layer**, ask whether they want you to **install and
configure one** (Traefik + Authelia is a common pairing), or to **fall back to local-only (Option A)**.
Follow their choice — do not expose it publicly without auth.

**3. DNS.** Point the hostname at this server's public IP (`curl -s https://api.ipify.org`). If you hold
credentials for their DNS provider, offer to create the record; otherwise give them the exact record and
wait until it resolves (`dig +short <host>`). If DNS is behind a proxying CDN, use **DNS-only** (or an
origin cert) so the TLS/ACME challenge can complete.

**4. Mind the network reachability gotcha.** The host services bind `127.0.0.1`, so a reverse-proxy
*container* cannot reach them directly. Pick one:
   - **Host-network dashboard (recommended when services are 127.0.0.1-only):** run the dashboard with
     `network_mode: host`, set `ASMLTR_NGINX_LISTEN` to a private interface the proxy can reach (e.g. the
     docker-bridge gateway like `172.18.0.1:8091`, **not** the public NIC) and `ASMLTR_UPSTREAM_HOST=127.0.0.1`.
     Point the proxy at `http://172.18.0.1:8091` via a file/dynamic route.
   - **`host.docker.internal`:** works on Docker Desktop; on Linux only if the services also listen on the
     bridge. Then the shipped compose's traefik-network + labels model works as-is.

**5. Configure env + run.** The compose/nginx read these (all optional, sane defaults):
`ASMLTR_INSIGHTS_HOST` (router hostname), `ASMLTR_NGINX_LISTEN`, `ASMLTR_UPSTREAM_HOST`,
`ASMLTR_INSIGHTS_TOKEN` + `ASMLTR_MANAGER_TOKEN` (only if you set tokens on the collector/manager).
The shipped `insights/docker-compose.yml` carries **Traefik docker-provider labels** (edit the Host rule or
set `ASMLTR_INSIGHTS_HOST`). If you chose host-network, or use a different proxy, don't fight the labels —
run the container your way and add a **proxy route** by hand instead.

**6. Auth — restrict to the user.**
   - **Authelia:** add its forward-auth middleware to the router, and an `access_control` rule allowing
     only the user's `subject` (with `two_factor`) **plus a deny for that domain otherwise**, placed
     **above** any broad catch-all so it matches first. Validate (`authelia validate-config`) and restart.
   - **oauth2-proxy / Authentik / Cloudflare Access / nginx basic-auth:** use that tool's allow-list for
     the single user. The requirement is the same: unauthenticated and other users must be denied.

**7. TLS.** Let the proxy issue the cert (Traefik `certresolver`, Caddy auto-HTTPS, Certbot for nginx).

**8. Verify end-to-end:** `dig +short <host>` resolves; `curl -sI https://<host>` **redirects to the login
portal** (not the app) when unauthenticated; after logging in as the allowed user you reach the dashboard;
any other/no user is denied.

**Record what you set up** (URL, proxy, auth tool, allowed identity) in your final report and in the
install's local notes, so the update guide can detect later whether public authenticated access exists.

---

## Completion checklist — do NOT report success until every box is true

- [ ] `node_modules` present in **core, connectors, insights/collector, cli** (step 1 verify)
- [ ] `.env` created with `ASSISTANT_NAME` + the secrets for the chosen channels
- [ ] trust store seeded — the owner principal resolves (`node core/src/trust/seed.js` ran without error)
- [ ] all three services online under PM2 (`pm2 ls` shows asmltr-core, asmltr-connector-manager, asmltr-insights-collector) and `curl 127.0.0.1:3023/health` is ok
- [ ] one instance per requested channel created, and its logs show started/online (step 8)
- [ ] **`asmltr ls` runs** (the CLI/TUI is installed and on PATH, or the fallback command is documented for the user)
- [ ] **asmltr agent skill linked** (step 7b: `~/.claude/skills/asmltr` → `skills/asmltr`) so the agent knows the command surface
- [ ] a real test message got a reply
- [ ] **web GUI decision made** (step 9): either deployed (local-only or public-behind-auth) or the user
      explicitly declined — never left publicly reachable without authentication

## 10. Troubleshooting

- **Connector logs "no bot token" / secret is null** → the secret key name in the instance config
  doesn't resolve. Check the matching `*_KEY`/token is in `.env` (UPPER_SNAKE of the key), or that
  `ASMLTR_SECRET_CMD` resolves it. Restart the instance: `curl -X POST 127.0.0.1:3024/instances/<id>/restart`.
- **Assistant replies but declines everything / "no access"** → the sender isn't a seeded principal, or
  their identifier for that surface is wrong. Fix `seed.json` and re-run `node core/src/trust/seed.js --force`.
- **Core exits immediately** → almost always the `claude` CLI isn't installed or not logged in. Run
  `claude` once interactively to confirm auth, then `pm2 restart asmltr-core`.
- **Update an instance's config** → `PATCH /instances/<id>` with the **full merged** `config` object
  (it's validated against the schema; partial configs are rejected).

Report back to the user: which channels are live, the owner principal you seeded, and anything you had to skip.
