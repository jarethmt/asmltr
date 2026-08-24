#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
PYTHON="${IVY_LOCAL_PYTHON:-$ROOT/.venv/bin/python}"
if [[ ! -x "$PYTHON" ]]; then
  echo "ivy-local venv missing. Run extras/ivy-local/register.sh" >&2
  exit 1
fi
exec "$PYTHON" "$DIR/server.py" "$@"
