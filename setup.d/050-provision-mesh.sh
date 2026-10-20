#!/usr/bin/env bash
# Provision the asmltr networking plane (Pangolin mesh) if it is configured for this install.
# Idempotent + best-effort: ensures the server admin (→ TRUST vault), org, and asmltr-OIDC IdP (SSO →
# Admin). No-op unless ASMLTR_MESH_DASHBOARD_URL is set. A non-zero here is non-fatal to setup/update.
# Exit 0 = provisioned/ensured, 75 = skipped/not-applicable (retry next update).
set -uo pipefail
REPO="${ASMLTR_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
command -v node >/dev/null 2>&1 || { echo "no node — skip" >&2; exit 75; }
[ -f "$REPO/cli/asmltr.js" ] || { echo "no cli — skip" >&2; exit 75; }

# Only run when the mesh is configured (keeps setup a no-op for installs that don't use the mesh).
if ! grep -q '^ASMLTR_MESH_DASHBOARD_URL=' "$REPO/.env" 2>/dev/null \
   && [ -z "${ASMLTR_MESH_DASHBOARD_URL:-}" ]; then
  echo "mesh not configured — skip" >&2; exit 75
fi

if node "$REPO/cli/asmltr.js" mesh provision; then
  exit 0
fi
echo "mesh provision not applicable (vault sealed? control plane down?) — skip" >&2
exit 75
