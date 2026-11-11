# syntax=docker/dockerfile:1

# ---- build stage: install + vite build the SPA ----
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
# hoisted linker keeps node_modules a plain tree — no symlink surprises across COPY layers
RUN bun install --frozen-lockfile --linker=hoisted
RUN bun run --cwd apps/web build

# ---- runtime stage ----
FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
USER bun
EXPOSE 8080
CMD ["bun", "run", "apps/server/src/main.ts"]
