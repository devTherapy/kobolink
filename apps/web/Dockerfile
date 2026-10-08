# syntax=docker/dockerfile:1
#
# apps/web — Next.js (screens, server-rendered /l/[code], the /.well-known/*
# route handlers). Build context is the REPO ROOT:
#
#   docker build -f apps/web/Dockerfile \
#     --build-arg API_ORIGIN=http://kobolink-api.internal:3001 -t kobolink-web .
#
# Next's `output: 'standalone'` (enabled by NEXT_OUTPUT below, see
# apps/web/next.config.ts) traces only the files the server needs, so the
# final image carries no devDependencies and no full node_modules.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
# The whole contracts package (not just its package.json) is copied before
# `npm ci`: npm runs the workspace's `prepare` script (tsc) while installing,
# even with --ignore-scripts, and tsc needs the sources and tsconfig.
COPY packages/contracts packages/contracts
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts
RUN npm run build -w packages/contracts
COPY apps/web apps/web

# BUILD-TIME configuration. Next freezes the /api/* rewrite destination
# (API_ORIGIN) and inlines every NEXT_PUBLIC_* variable during `next build`;
# setting them only at runtime would silently do nothing. fly.toml's
# [build.args] supplies them on a real deploy. The default is the local dev
# value, never a production address.
ARG API_ORIGIN=http://localhost:3001
ARG NEXT_PUBLIC_DASHBOARD_HEARTBEAT_MS=
ARG NEXT_PUBLIC_IOS_APP_STORE_ID=
ENV API_ORIGIN=$API_ORIGIN \
    NEXT_PUBLIC_DASHBOARD_HEARTBEAT_MS=$NEXT_PUBLIC_DASHBOARD_HEARTBEAT_MS \
    NEXT_PUBLIC_IOS_APP_STORE_ID=$NEXT_PUBLIC_IOS_APP_STORE_ID \
    NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
# Fonts are self-hosted (src/app/fonts/, next/font/local): the build fetches
# nothing from Google. Next bundles the woff2 files into .next/static/media,
# which the runtime stage copies below.
RUN npm run build -w apps/web

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# With outputFileTracingRoot at the repo root the standalone server lives at
# apps/web/server.js. It does not copy .next/static or public/; do that here.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1
CMD ["node", "apps/web/server.js"]
