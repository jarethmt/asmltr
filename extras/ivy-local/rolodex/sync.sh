#!/usr/bin/env bash
# Refresh Ivy's separate Rolodex cache from localhost GET /export.
# Writes ONLY contacts.json. Never creates, reads, or overwrites aliases.json.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$HOME/.asmltr/rolodex.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$HOME/.asmltr/rolodex.env"
  set +a
fi
CACHE_DIR="${ROLODEX_CACHE:-$HOME/.asmltr/rolodex-cache}"
DEST="${CACHE_DIR}/contacts.json"
TMP="${DEST}.tmp.$$"
EXPORT_URL="${ROLODEX_EXPORT_URL:-${ROLODEX_URL:-http://127.0.0.1:8081}/export}"
CURL_MAX_TIME="${ROLODEX_SYNC_TIMEOUT:-180}"
BACKUP_PY="${DIR}/backup.py"

umask 077
mkdir -p "$CACHE_DIR/backups"
chmod 700 "$CACHE_DIR" "$CACHE_DIR/backups" || true

cleanup() {
  rm -f "$TMP"
}
trap cleanup EXIT

if ! curl -sS --fail --max-time "$CURL_MAX_TIME" "$EXPORT_URL" > "$TMP"; then
  echo "sync failed: curl error (cache left untouched)" >&2
  exit 1
fi

COUNT="$(python3 - "$TMP" << 'PY'
import json
import sys

path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
except (OSError, json.JSONDecodeError) as exc:
    print(f"sync failed: invalid JSON ({type(exc).__name__})", file=sys.stderr)
    sys.exit(2)

if not isinstance(data, dict):
    print("sync failed: export JSON is not an object", file=sys.stderr)
    sys.exit(2)
if "error" in data and "results" not in data:
    print("sync failed: export returned an error payload", file=sys.stderr)
    sys.exit(2)
results = data.get("results")
if not isinstance(results, list):
    print("sync failed: export JSON missing results list", file=sys.stderr)
    sys.exit(2)
for row in results:
    if not isinstance(row, dict) or not row.get("resourceName"):
        print("sync failed: a result is missing resourceName", file=sys.stderr)
        sys.exit(2)
print(len(results))
PY
)" || {
  echo "sync failed: refusing to replace contacts.json" >&2
  exit 2
}

chmod 600 "$TMP"
mv -f "$TMP" "$DEST"
trap - EXIT
echo "synced ${COUNT} contacts -> ${DEST}"
if [[ -f "$BACKUP_PY" ]]; then
  if ! python3 "$BACKUP_PY" snapshot; then
    echo "backup snapshot failed (contacts.json still updated)" >&2
  fi
fi
