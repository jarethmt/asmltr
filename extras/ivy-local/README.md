# extras/ivy-local — optional localhost MCP wrappers

Stdio MCP servers the Grok engine can call via `~/.asmltr/mcp.json` and `grok mcp add`.
They do **not** fork `grok.js`. Secrets stay out of git. Eve: skip unless you want the same extras.

| Server | Talks to | Tools |
| --- | --- | --- |
| `corona` | localhost API (`CORONA_URL`, default `http://127.0.0.1:12701`) | `corona_health`, `corona_recipe`, `corona_cigars`, `corona_cooking` (no `/say`) |
| `rolodex` | cache `~/.asmltr/rolodex-cache` (source `ROLODEX_URL/export`); writes hit `ROLODEX_URL` live | `rolodex_health`, `rolodex_search`, `rolodex_get`, `rolodex_alias`, `rolodex_sync`, `rolodex_create`, `rolodex_add_phone`, `rolodex_delete`, `rolodex_backups`, `rolodex_restore` |
| `onenote` | Graph, creds in `~/.asmltr/onenote/{token.json,.client.json}` mode 600 | `onenote_health`, `onenote_login`, notebooks/sections/pages/get/create/update |

Rolodex uses two files in the cache dir: `contacts.json` (daily dump) and `aliases.json` (static nicknames; sync must never overwrite). People cards stay relationship memory. Rotating copies of `contacts.json` live in `~/.asmltr/rolodex-cache/backups/` (one per local day, max 5) — copies, not a lookup store. Prefer an alias hit. A phone number is not permission to text.

## Install

```bash
cd /path/to/asmltr
bash extras/ivy-local/register.sh
```

`register.sh` creates `extras/ivy-local/.venv`, merges `~/.asmltr/mcp.json`, runs `grok mcp add`, enables `ivy-rolodex-sync.timer`, and does one cache sync.

## Test

```bash
curl -sf "${CORONA_URL:-http://127.0.0.1:12701}/health"
curl -sf "${ROLODEX_URL:-http://127.0.0.1:12702}/health"
grok mcp list
stat -c '%a %n' ~/.asmltr/onenote/token.json ~/.asmltr/onenote/.client.json
# expect 600 — do not cat
systemctl --user list-timers ivy-rolodex-sync.timer
```

Do not commit `token.json`, `.client.json`, cache JSON, `.venv`, or any live nginx `server_name`.
