#!/usr/bin/env bash
# Install optional localhost MCP servers and register them.
# Does not touch corona.service or rolodex.service. Does not print secrets.
set -euo pipefail

REPO="${ASMLTR_REPO:-$HOME/src/asmltr}"
IVY="${IVY_LOCAL:-$REPO/extras/ivy-local}"
NODE="${ASMLTR_NODE:-$HOME/.local/bin/node}"
GROK_BIN="${ASMLTR_GROK_BIN:-$HOME/.grok/bin/grok}"
MCP_FILE="${ASMLTR_MCP_FILE:-$HOME/.asmltr/mcp.json}"
ONENOTE_HOME="${ONENOTE_HOME:-$HOME/.asmltr/onenote}"
CACHE_DIR="${ROLODEX_CACHE:-$HOME/.asmltr/rolodex-cache}"

echo "== ivy-local register as $(whoami) =="
test -d "$IVY" || { echo "NEED $IVY"; exit 1; }
export PATH="$HOME/.local/bin:$HOME/.grok/bin:$PATH"

echo "== venv =="
if [[ ! -x "$IVY/.venv/bin/python" ]]; then
  python3 -m venv "$IVY/.venv"
fi
"$IVY/.venv/bin/pip" -q install -r "$IVY/requirements.txt"
"$IVY/.venv/bin/python" -c "from mcp.server import MCPServer; print('mcp ok')"

echo "== onenote creds (mode only, no print) =="
mkdir -p "$ONENOTE_HOME" "$CACHE_DIR" "$CACHE_DIR/backups" "$HOME/.asmltr"
chmod 700 "$ONENOTE_HOME" "$CACHE_DIR" "$CACHE_DIR/backups" "$HOME/.asmltr" || true
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
if [[ -f "$HOME/.asmltr/rolodex.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  . "$HOME/.asmltr/rolodex.env"
  set +a
fi

echo "== ~/.asmltr/mcp.json =="
"$IVY/.venv/bin/python" - "$MCP_FILE" "$IVY" << 'PY'
import json
import os
import sys
from pathlib import Path

mcp_path = Path(sys.argv[1])
ivy = Path(sys.argv[2])
servers = {
    "corona": {
        "type": "stdio",
        "command": str(ivy / "corona" / "run.sh"),
        "args": [],
        "env": ({"CORONA_URL": os.environ["CORONA_URL"]} if os.environ.get("CORONA_URL") else {}),
    },
    "rolodex": {
        "type": "stdio",
        "command": str(ivy / "rolodex" / "run.sh"),
        "args": [],
        "env": ({"ROLODEX_URL": os.environ["ROLODEX_URL"]} if os.environ.get("ROLODEX_URL") else {}),
    },
    "onenote": {
        "type": "stdio",
        "command": str(ivy / "onenote" / "run.sh"),
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
  for pair in "corona:corona" "rolodex:rolodex" "onenote:onenote"; do
    name="${pair%%:*}"
    dir="${pair##*:}"
    add_args=("$name")
    if [[ "$name" == corona && -n "${CORONA_URL:-}" ]]; then
      add_args+=(-e "CORONA_URL=${CORONA_URL}")
    fi
    if [[ "$name" == rolodex && -n "${ROLODEX_URL:-}" ]]; then
      add_args+=(-e "ROLODEX_URL=${ROLODEX_URL}")
    fi
    if "$GROK_BIN" mcp add "${add_args[@]}" -- "$IVY/$dir/run.sh"; then
      echo "grok mcp added $name"
    else
      echo "WARN: grok mcp add $name failed"
    fi
  done
  "$GROK_BIN" mcp list || true
else
  echo "WARN: grok not at $GROK_BIN — skip grok mcp add"
fi

echo "== rolodex timer =="
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
cp -f "$IVY/systemd/ivy-rolodex-sync.service" "$UNIT_DIR/ivy-rolodex-sync.service"
cp -f "$IVY/systemd/ivy-rolodex-sync.timer" "$UNIT_DIR/ivy-rolodex-sync.timer"
# Template in git uses a placeholder path. Point ExecStart at this clone.
sed -i "s|^ExecStart=.*|ExecStart=$IVY/rolodex/sync.sh|" "$UNIT_DIR/ivy-rolodex-sync.service"
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user enable --now ivy-rolodex-sync.timer
  systemctl --user --no-pager --full status ivy-rolodex-sync.timer | sed -n '1,16p' || true
else
  echo "WARN: systemctl missing — timer files copied only"
fi

echo "== first rolodex cache sync =="
if "$IVY/rolodex/sync.sh"; then
  echo "rolodex cache ok"
else
  echo "WARN: first sync failed (timer will retry on its next schedule)"
fi

echo "== smoke (localhost APIs, no secrets) =="
CORONA_SMOKE="${CORONA_URL:-http://127.0.0.1:12701}"
ROLODEX_SMOKE="${ROLODEX_URL:-http://127.0.0.1:12702}"
curl -sf --max-time 5 "${CORONA_SMOKE}/health" && echo || echo "WARN: Corona /health failed"
curl -sf --max-time 5 "${ROLODEX_SMOKE}/health" && echo || echo "WARN: Rolodex /health failed"
if [[ -e "$ONENOTE_HOME/token.json" && -e "$ONENOTE_HOME/.client.json" ]]; then
  echo "onenote creds files exist (not printed)"
fi

echo "DONE. Test:"
echo "  grok mcp list"
echo "  grok mcp test corona   # or: asmltr ask 'use corona_health'"
echo "  $IVY/rolodex/sync.sh && $IVY/rolodex/run.sh  # stdio; use grok to call tools"
echo "  systemctl --user list-timers ivy-rolodex-sync.timer"
