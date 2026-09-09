#!/usr/bin/env bash
# Install optional localhost MCP servers and register them.
# Does not touch corona.service. Does not register Rolodex. Does not print secrets.
set -euo pipefail

REPO="${ASMLTR_REPO:-$HOME/src/asmltr}"
HOST="${HOST_LOCAL:-$REPO/extras/host-local}"
GROK_BIN="${ASMLTR_GROK_BIN:-$HOME/.grok/bin/grok}"
MCP_FILE="${ASMLTR_MCP_FILE:-$HOME/.asmltr/mcp.json}"
ONENOTE_HOME="${ONENOTE_HOME:-$HOME/.asmltr/onenote}"

echo "== host-local register as $(whoami) =="
test -d "$HOST" || { echo "NEED $HOST"; exit 1; }
export PATH="$HOME/.local/bin:$HOME/.grok/bin:$PATH"

echo "== venv =="
if [[ ! -x "$HOST/.venv/bin/python" ]]; then
  python3 -m venv "$HOST/.venv"
fi
"$HOST/.venv/bin/pip" -q install -r "$HOST/requirements.txt"
"$HOST/.venv/bin/python" -c "from mcp.server import MCPServer; print('mcp ok')"

echo "== onenote creds (mode only, no print) =="
mkdir -p "$ONENOTE_HOME" "$HOME/.asmltr"
chmod 700 "$ONENOTE_HOME" "$HOME/.asmltr" || true
if [[ -e "$ONENOTE_HOME/token.json" ]]; then
  chmod 600 "$ONENOTE_HOME/token.json"
  echo "onenote token.json present"
else
  echo "WARN: $ONENOTE_HOME/token.json missing"
fi
if [[ -e "$ONENOTE_HOME/.client.json" ]]; then
  chmod 600 "$ONENOTE_HOME/.client.json"
  echo "onenote .client.json present"
else
  echo "WARN: $ONENOTE_HOME/.client.json missing"
fi

if [[ -f "$HOME/.asmltr/corona.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  . "$HOME/.asmltr/corona.env"
  set +a
fi

echo "== ~/.asmltr/mcp.json =="
"$HOST/.venv/bin/python" - "$MCP_FILE" "$HOST" << 'PY'
import json
import os
import sys
from pathlib import Path

mcp_path = Path(sys.argv[1])
host = Path(sys.argv[2])
servers = {
    "corona": {
        "type": "stdio",
        "command": str(host / "corona" / "run.sh"),
        "args": [],
        "env": ({"CORONA_URL": os.environ["CORONA_URL"]} if os.environ.get("CORONA_URL") else {}),
    },
    "onenote": {
        "type": "stdio",
        "command": str(host / "onenote" / "run.sh"),
        "args": [],
        "env": {},
    },
}
cfg = {"servers": {}}
if mcp_path.is_file():
    try:
        cfg = json.loads(mcp_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        cfg = {"servers": {}}
if not isinstance(cfg, dict):
    cfg = {"servers": {}}
cfg.setdefault("servers", {})
if not isinstance(cfg["servers"], dict):
    cfg["servers"] = {}
for name, spec in servers.items():
    prev = cfg["servers"].get(name) or {}
    disabled = bool(prev.get("disabled")) if isinstance(prev, dict) else False
    entry = dict(spec)
    prev_env = prev.get("env") if isinstance(prev, dict) else None
    if isinstance(prev_env, dict) or entry.get("env"):
        entry["env"] = {**(prev_env if isinstance(prev_env, dict) else {}), **(entry.get("env") or {})}
    if disabled:
        entry["disabled"] = True
    cfg["servers"][name] = entry
mcp_path.parent.mkdir(parents=True, exist_ok=True)
tmp = mcp_path.with_name(f"{mcp_path.name}.tmp.{os.getpid()}")
tmp.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
os.chmod(tmp, 0o600)
os.replace(tmp, mcp_path)
os.chmod(mcp_path, 0o600)
print("wrote", mcp_path, "servers:", ", ".join(sorted(cfg["servers"])))
PY

if [[ -x "$GROK_BIN" ]]; then
  echo "== grok mcp add =="
  for pair in "corona:corona" "onenote:onenote"; do
    name="${pair%%:*}"
    dir="${pair##*:}"
    add_args=("$name")
    if [[ "$name" == corona && -n "${CORONA_URL:-}" ]]; then
      add_args+=(-e "CORONA_URL=${CORONA_URL}")
    fi
    if "$GROK_BIN" mcp add "${add_args[@]}" -- "$HOST/$dir/run.sh"; then
      echo "grok mcp added $name"
    else
      echo "WARN: grok mcp add $name failed"
    fi
  done
  "$GROK_BIN" mcp list || true
else
  echo "WARN: grok not at $GROK_BIN — skip grok mcp add"
fi

echo "== smoke (localhost APIs, no secrets) =="
CORONA_SMOKE="${CORONA_URL:-http://127.0.0.1:12701}"
curl -sf --max-time 5 "${CORONA_SMOKE}/health" && echo || echo "WARN: Corona /health failed"
if [[ -e "$ONENOTE_HOME/token.json" && -e "$ONENOTE_HOME/.client.json" ]]; then
  echo "onenote creds files exist (not printed)"
fi

echo "DONE. Test:"
echo "  grok mcp list"
echo "  grok mcp test corona   # or: asmltr ask 'use corona_health'"
