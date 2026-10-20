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
FROM node:24-alpine AS build
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
