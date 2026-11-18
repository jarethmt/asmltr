# asmltr-insights dashboard — multi-stage: build the Vite SPA, serve via nginx.
# nginx also reverse-proxies /api + /socket.io to the host collector (127.0.0.1:3017
# reached as host.docker.internal) and /manager to the connector manager
# (127.0.0.1:3024), injecting the read + manager service bearers so the tokens
# never reach the browser. Authelia 2FA is enforced at the Traefik edge.
# Set ASMLTR_INSIGHTS_TOKEN and ASMLTR_MANAGER_TOKEN at container start.
#
# BUILD CONTEXT IS THE REPO ROOT (see compose `context: ..`) — the SPA imports the repo's
# shared/ tree via the @shared alias (../../shared), so the build needs shared/ present. All
# COPY paths below are therefore repo-root-relative, and the build/serve happen in the
# insights/dashboard subtree. (.dockerignore keeps node_modules/dist/APKs out of the context.)
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /app
# package manifests first so `npm install` layer-caches across source edits
COPY insights/dashboard/package*.json insights/dashboard/
RUN cd insights/dashboard && npm install --no-audit --no-fund
# the rest of the repo (shared/ included; node_modules excluded by .dockerignore)
COPY . .
RUN cd insights/dashboard && npm run build

FROM nginx:alpine
# The official entrypoint envsubsts only real env vars (e.g. ${ASMLTR_INSIGHTS_TOKEN}),
# leaving nginx runtime vars like $http_upgrade untouched.
COPY insights/dashboard/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/insights/dashboard/dist /usr/share/nginx/html
EXPOSE 80

# ---- CVE-2026-111497 (brotli decoder out-of-bounds write) -------------------
# Alpine ships the REAL upstream release (it does not backport into the version string the way
# Debian/Ubuntu do), so grading by upstream version is correct here. Fixed releases are
# 1.0.10 / 1.1.1 / 1.2.1. This ASSERTS the result and FAILS THE BUILD if the base image ever
# stops shipping a fixed brotli-libs, so a future rebuild cannot silently reintroduce the bug.
# Pure shell arithmetic deliberately — no python, no nested quoting. Added 2026-11-11.
RUN set -eux; \
    apk update; \
    apk upgrade --no-cache brotli-libs; \
    V="$(apk info -v | grep '^brotli-libs-' | head -1 | sed 's/^brotli-libs-//')"; \
    UP="${V%%-r*}"; MAJ="${UP%%.*}"; _R="${UP#*.}"; MIN="${_R%%.*}"; PAT="${_R#*.}"; \
    OK=0; \
    if [ "$MAJ" = 1 ]; then \
      case "$MIN" in \
        0) [ "$PAT" -ge 10 ] && OK=1 ;; \
        1) [ "$PAT" -ge 1 ]  && OK=1 ;; \
        2) [ "$PAT" -ge 1 ]  && OK=1 ;; \
      esac; \
    fi; \
    [ "$OK" = 1 ] || { echo "ASSERT FAILED: brotli-libs $V is not a fixed release"; exit 1; }; \
    echo "ASSERT OK: brotli-libs $V (CVE-2026-111497 fixed upstream release)"
# ----------------------------------------------------------------------------
