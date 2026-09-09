#!/usr/bin/env bash
# Apply gaia localhost as systemd --user units (public example).
# Live ASSISTANT_NAME stays in off-git config. Do not change live systemd from this tree.
# Do not install pm2. Do not start Discord.
# Do not touch corona.service or rolodex.service. Do not push. Do not cat ~/.grok/auth.json.
set -euo pipefail

REPO="${ASMLTR_REPO:-$HOME/src/asmltr}"
NODE24="${ASMLTR_NODE:-$HOME/.local/bin/node}"
GROK_BIN="${ASMLTR_GROK_BIN:-$HOME/.grok/bin/grok}"
WITH_COLLECTOR="${WITH_COLLECTOR:-0}"

echo "== gaia apply as $(whoami) =="

export PATH="$HOME/.local/bin:$HOME/.grok/bin:$PATH"
unset XAI_API_KEY

test -x "$NODE24" || { echo "NEED Node 24 at $NODE24"; exit 1; }
ver="$("$NODE24" -v)"
echo "node $ver"
case "$ver" in v24.*|v2[5-9].*) ;; *) echo "NEED Node >= 24 (not system 18)"; exit 1 ;; esac
test -x "$GROK_BIN" || { echo "NEED grok at $GROK_BIN"; exit 1; }
"$GROK_BIN" --version
test -f "$HOME/.grok/auth.json" || { echo "NEED ~/.grok/auth.json (do not cat it)"; exit 1; }
stat -c '%a %n' "$HOME/.grok/auth.json"

cd "$REPO"
test -f core/src/engines/grok.js || { echo "NEED grok adapter in $REPO"; exit 1; }

if [[ ! -f .env ]]; then
  cp env.gaia.example .env
  echo "wrote .env from env.gaia.example"
else
  echo ".env already present — leaving it"
fi
chmod 600 .env || true
grep -q '^ASSISTANT_NAME=gaia' .env || echo "WARN: ASSISTANT_NAME is not gaia"
grep -q '^ASMLTR_WEB_OWNER_ID=owner' .env || echo "WARN: ASMLTR_WEB_OWNER_ID should be owner"

if [[ ! -f core/src/trust/seed.json ]]; then
  cp core/src/trust/seed.gaia.example.json core/src/trust/seed.json
  echo "wrote seed.json from seed.gaia.example.json"
fi

echo "== unit tests (no grok tokens) =="
"$NODE24" --test test/engine-grok-adapter.test.js test/engine-systemprompt.test.js test/engine-inject-once.test.js test/session-idle.test.js

echo "== seed trust (idempotent) =="
ASMLTR_TRUST_SEED="$REPO/core/src/trust/seed.json" "$NODE24" core/src/trust/seed.js

echo "== engines.json =="
test -f "$HOME/.asmltr/engines.json" && echo "engines.json present" || echo "WARN: ~/.asmltr/engines.json missing"

echo "== systemd --user asmltr-core (Linger already yes; do not touch corona/rolodex) =="
mkdir -p "$HOME/.config/systemd/user"
cp -f "$REPO/scripts/asmltr-core.user.service" "$HOME/.config/systemd/user/asmltr-core.service"
systemctl --user daemon-reload
systemctl --user enable --now asmltr-core.service
sleep 1
systemctl --user --no-pager --full status asmltr-core.service | sed -n '1,20p'
curl -sf http://127.0.0.1:3023/health && echo

if [[ "$WITH_COLLECTOR" = 1 ]]; then
  cp -f "$REPO/scripts/asmltr-collector.user.service" "$HOME/.config/systemd/user/asmltr-collector.service"
  systemctl --user daemon-reload
  systemctl --user enable --now asmltr-collector.service
  sleep 1
  curl -sf http://127.0.0.1:3017/health && echo || echo "WARN: collector /health failed"
fi

echo "== talk to gaia =="
echo "  $NODE24 $REPO/cli/asmltr.js ask \"Reply with exactly the word pong and nothing else.\""
echo "DONE. Do not start connector-manager. Do not git push. Do not install pm2."
echo "Optional Corona/OneNote wrappers: bash $REPO/extras/host-local/register.sh"
