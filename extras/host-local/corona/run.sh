#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
if [[ -f "${HOME}/.asmltr/corona.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "${HOME}/.asmltr/corona.env"
  set +a
fi
PYTHON="${HOST_LOCAL_PYTHON:-$ROOT/.venv/bin/python}"
if [[ ! -x "$PYTHON" ]]; then
  echo "host-local venv missing. Run extras/host-local/register.sh" >&2
  exit 1
fi
exec "$PYTHON" "$DIR/server.py" "$@"
