FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/calendar/package.json packages/calendar/
COPY packages/market-data/package.json packages/market-data/
COPY packages/strategies/package.json packages/strategies/
COPY packages/ingest/package.json packages/ingest/
COPY packages/telegram/package.json packages/telegram/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile --linker=hoisted
COPY packages ./packages
COPY apps ./apps
ENV NODE_ENV=production
RUN cd apps/web && bun run build

# Runtime image: production dependencies only — the web toolchain (vite,
# typescript, drizzle-kit, react) never lands here.
FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Manifests first so the dependency layer survives source edits; apps/web is
# intentionally absent (bun.lock is not workspace-scoped) — only its prebuilt
# dist is shipped.
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/calendar/package.json packages/calendar/
COPY packages/market-data/package.json packages/market-data/
COPY packages/strategies/package.json packages/strategies/
COPY packages/ingest/package.json packages/ingest/
COPY packages/telegram/package.json packages/telegram/
COPY apps/server/package.json apps/server/
RUN bun install --frozen-lockfile --production --linker=hoisted
COPY packages ./packages
COPY apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
USER bun
EXPOSE 8080
CMD ["bun", "run", "apps/server/src/main.ts"]
