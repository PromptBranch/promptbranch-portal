# syntax=docker/dockerfile:1
# Build context is the REPO ROOT (pnpm workspace).

FROM node:26-alpine AS deps
RUN npm install -g pnpm@11.7.0
# better-sqlite3 compiles from source when no musl prebuild matches.
RUN apk add --no-cache python3 make g++
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/share/package.json packages/share/
COPY apps/portal/package.json apps/portal/
RUN pnpm install --frozen-lockfile --filter "@promptbranch/portal..."

FROM deps AS build
# portal and share tsconfigs extend ../../tsconfig.base.json.
COPY tsconfig.base.json ./
COPY packages/share packages/share
COPY apps/portal apps/portal
RUN pnpm --filter @promptbranch/portal build

# --- Team services (P9): worker, migrations job and backup/restore tooling.
# The worker runs team-server's compiled jobs graph directly (no bundler),
# so this stage builds the package and prunes its runtime dependencies.
FROM deps AS team-build
COPY tsconfig.base.json ./
COPY packages/share packages/share
COPY packages/team-server packages/team-server
RUN pnpm --filter @promptbranch/team-server build \
 && pnpm --filter "@promptbranch/team-server..." deploy --prod /deploy \
 && cp -R packages/team-server/dist /deploy/dist \
 && cp -R packages/team-server/migrations /deploy/migrations \
 && cp -R scripts /deploy/scripts

FROM node:26-alpine AS team-runtime
# postgresql-client + openssl: pg_dump/pg_restore and stream encryption for
# the nightly backup run inside this container.
RUN apk add --no-cache postgresql18-client openssl
ENV NODE_ENV=production
WORKDIR /app
COPY --from=team-build /deploy ./
USER node
CMD ["node", "scripts/team-worker.mjs"]

FROM node:26-alpine AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
# Standalone tracing root is the repo root, so the layout mirrors it.
COPY --from=build /repo/apps/portal/.next/standalone ./
COPY --from=build /repo/apps/portal/.next/static ./apps/portal/.next/static
COPY --from=build /repo/apps/portal/public ./apps/portal/public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "apps/portal/server.js"]
