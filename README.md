# strategy-tracker

Self-hosted tracker for a mean-reversion basket strategy: it books fills from
screenshots (via your own vision model), seeds next-day sell orders, and runs
the daily calendar-driven jobs — all behind a password, on a single small
server with MariaDB.

Design: [`docs/superpowers/specs/2026-11-10-strategy-tracker-design.md`](docs/superpowers/specs/2026-11-10-strategy-tracker-design.md)
— the numbered rulings in
[`.superpowers/sdd/2026-11-10-strategy-tracker/plan.md`](.superpowers/sdd/2026-11-10-strategy-tracker/plan.md)
take precedence over it (and
`task-15-brief.md` §"Rulings that override the plan" overrides those).

## Quickstart with Docker (recommended)

Requirements: Docker with Compose v2. A host port **8080** (or whatever you
change `ports:` to).

1. Copy the example env and fill it in:

   ```sh
   cp .env.example .env
   ```

   - `MARIADB_ROOT_PASSWORD` — password for the database container (compose
     interpolates it into `DATABASE_URL` for the app).
   - `APP_PASSWORD` — login password for the web UI.
   - `SESSION_SECRET` — any long random string, e.g. `openssl rand -hex 32`.
   - Optional Telegram capture (bot commands + screenshot → pending fills):
     set `TELEGRAM_BOT_TOKEN` **and all four** companions
     (`TELEGRAM_ALLOWED_CHAT_IDS`, `VISION_BASE_URL`, `VISION_API_KEY`,
     `VISION_MODEL`). Without a token the app runs HTTP-only — web UI and API
     still work, no bot and no cron jobs.

2. Build and start (compose waits for MariaDB's healthcheck, then the app
   applies migrations itself at startup):

   ```sh
   docker compose up -d --build
   ```

3. Open <http://localhost:8080>, log in with `APP_PASSWORD`, create a run,
   paste a fill screenshot into the run's "Capture fill" box — or message the
   screenshot to your Telegram bot with the run id (`/capture 1 <photo>`).

Health check: `curl localhost:8080/api/health` → `{"ok":true}` (the only
unauthenticated API route; every other `/api/*` route needs the login cookie
or an `Authorization: Bearer <APP_PASSWORD>` header).

Logs / stop:

```sh
docker compose logs -f app
docker compose down          # keeps the dbdata volume (your data survives)
```

## Local development

Requirements: [Bun](https://bun.sh) ≥ 1.3, Docker (for the test DB).

```sh
bun install
bun run dev                        # API on :8080 + Vite dev server on :5173
```

`bun run dev` needs a local MariaDB (the vite proxy talks to the API at
127.0.0.1:8080) — the easiest one is `docker compose up -d db` with a `.env`
providing `MARIADB_ROOT_PASSWORD`; point the server at it with a root `.env`
(`DATABASE_URL=mysql://root:devpw@127.0.0.1:3306/st`). The dev server proxies
`/api/*` to `http://127.0.0.1:8080` — see `apps/web/vite.config.ts` (W10).

### Tests

```sh
docker run -d --name st-mariadb-test -e MARIADB_ROOT_PASSWORD=test \
  -e MARIADB_DATABASE=st_test -p 127.0.0.1:3307:3306 mariadb:11
TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test   # full suite (sqlite-only tests skip without it)
bun test                                                             # suite without DB-backed tests
bun run typecheck
```

## Configuration reference (`.env`)

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | MySQL/MariaDB connection string, e.g. `mysql://root:devpw@127.0.0.1:3306/st` |
| `APP_PASSWORD` | yes | Web UI login password (also the Bearer token) |
| `SESSION_SECRET` | yes | Cookie signing secret — long random string |
| `PORT` | no (8080) | HTTP port |
| `DIGEST_LANG` | no (`en`) | Telegram digest language: `en` or `ko` |
| `TELEGRAM_BOT_TOKEN` | no | Enables the Telegram bot + cron jobs; then the four vars below are also required |
| `TELEGRAM_ALLOWED_CHAT_IDS` | with token | Comma-separated chat ids allowed to talk to the bot |
| `VISION_BASE_URL` | with token | OpenAI-compatible chat-completions base url for fill extraction |
| `VISION_API_KEY` | with token | Its key |
| `VISION_MODEL` | with token | Model name, e.g. `gpt-4o` |

Startup validation (zod): a missing required var fails startup naming **all**
missing variables in one message.

## Repo layout & commands

Monorepo map and the canonical command list live in
[`AGENTS.md`](AGENTS.md): `bun install` / `bun test` / `bun run typecheck` /
`bun run dev` / `docker compose up`.
