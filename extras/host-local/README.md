# extras/host-local — optional localhost MCP wrappers

Stdio MCP servers the Grok engine can call via `~/.asmltr/mcp.json` and `grok mcp add`.
They do **not** fork `grok.js`. Secrets stay out of git. Eve: skip unless you want the same extras.

| Server | Talks to | Tools |
| --- | --- | --- |
| `corona` | localhost API (`CORONA_URL`, default `http://127.0.0.1:12701`) | `corona_health`, `corona_recipe`, `corona_cigars`, `corona_cooking` (no `/say`) |
| `onenote` | Graph, creds in `~/.asmltr/onenote/{token.json,.client.json}` mode 600 | `onenote_health`, `onenote_login`, notebooks/sections/pages/get/create/update |

Contacts are **gworkspace** People API (`~/.asmltr/host-local/gworkspace/`), not Rolodex. Do not register a Rolodex MCP. Host JSON dumps under `~/.asmltr/rolodex-cache/` may sit on disk; the assistant does not read them.

## Install

```bash
cd /path/to/asmltr
bash extras/host-local/register.sh
```

`register.sh` creates `extras/host-local/.venv`, merges `~/.asmltr/mcp.json` (corona + onenote only), and runs `grok mcp add`. It does **not** add Rolodex or enable a rolodex sync timer.

## Test

```bash
curl -sf "${CORONA_URL:-http://127.0.0.1:12701}/health"
grok mcp list
stat -c '%a %n' ~/.asmltr/onenote/token.json ~/.asmltr/onenote/.client.json
# expect 600 — do not cat
```

Do not commit `token.json`, `.client.json`, cache JSON, `.venv`, or any live nginx `server_name`.
