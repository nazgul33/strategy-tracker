# syntax=docker/dockerfile:1

# ---- web: build the SPA (needs network for bun install) ----
FROM oven/bun:1 AS web
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY packages/calendar/package.json packages/calendar/
RUN bun install --frozen-lockfile --filter '@st/web...'
COPY packages/calendar packages/calendar
COPY apps/web apps/web
RUN bun --cwd apps/web run build

# ---- api: runtime image (production deps only) ----
FROM oven/bun:1
ENV NODE_ENV=production
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/calendar/package.json packages/calendar/
COPY packages/market-data/package.json packages/market-data/
COPY packages/strategies/package.json packages/strategies/
COPY packages/ingest/package.json packages/ingest/
COPY packages/telegram/package.json packages/telegram/
COPY apps/server/package.json apps/server/
RUN bun install --frozen-lockfile --production --filter '@st/server...'
COPY packages packages
COPY apps/server apps/server
# Serve the pre-built SPA from a fixed root (never a path outside the image).
COPY --from=web /app/apps/web/dist apps/web/dist
EXPOSE 8080
# Migrations run in-process at startup (applyMigrations) — never drizzle-kit:
# it is a devDependency and this image installs production deps only.
CMD ["bun", "apps/server/src/main.ts"]
