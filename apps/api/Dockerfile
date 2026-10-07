# syntax=docker/dockerfile:1
#
# apps/api — NestJS. Build context is the REPO ROOT (npm workspaces + the
# contracts package live above apps/api):
#
#   docker build -f apps/api/Dockerfile -t kobolink-api .
#
# Three stages: `build` compiles contracts + api with every dev dependency;
# `deps` installs production dependencies only; `runtime` is node + those
# production deps + the compiled output. Nothing from the build toolchain
# (typescript, drizzle-kit, vitest, swc, ...) reaches the final image.
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
COPY apps/api apps/api
RUN npm run build -w apps/api

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# No typescript in a production install, so contracts' `prepare` (tsc), which
# npm runs even with --ignore-scripts, would fail; it is already built in the
# `build` stage and copied from there, so drop it from this throwaway stage.
RUN npm pkg delete scripts.prepare -w packages/contracts \
 && npm ci --omit=dev --ignore-scripts -w apps/api -w packages/contracts \
 && npm cache clean --force

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/apps/api
COPY --from=deps /app/node_modules /app/node_modules
# node_modules/@kobolink/contracts is a symlink to packages/contracts.
COPY --from=build /app/packages/contracts/package.json /app/packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist /app/packages/contracts/dist
COPY --from=build /app/apps/api/package.json ./package.json
COPY --from=build /app/apps/api/dist ./dist
# The SQL migrations + journal; `node dist/db/migrate.js` (the Fly
# release_command) reads them from ../../drizzle relative to dist/db.
COPY --from=build /app/apps/api/drizzle ./drizzle
# The `node` user ships with the base image (uid 1000).
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3001/api/health || exit 1
CMD ["node", "dist/main.js"]
