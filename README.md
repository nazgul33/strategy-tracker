# strategy-tracker

A personal, self-hosted tool that **guides** daily stock trading and keeps the books. Orders are
placed manually on 삼성증권 mPOP (Korean mobile app, US stocks); this app computes what to order,
sends daily Telegram digests per strategy run, reads mPOP fill screenshots back via Telegram,
extracts the fills with a configurable OpenAI-compatible vision endpoint, and books them only after
explicit confirmation. It never touches a brokerage API or places anything. A web UI tracks
progress per run (buckets, entry price, age, P&L), simulation mode replays historical trading days
through the same engine, and all copy ships in English and Korean. Full design:
[`docs/superpowers/specs/2026-11-10-strategy-tracker-design.md`](docs/superpowers/specs/2026-11-10-strategy-tracker-design.md).

Built as a Bun + TypeScript monorepo: pure domain packages in `packages/`, one server process in
`apps/server` (HTTP API + SPA static serving + Telegram long-polling bot + in-process cron jobs),
React UI in `apps/web`. Repo map and conventions: [`AGENTS.md`](AGENTS.md).

## Prerequisites

- [Bun](https://bun.sh) 1.x — the runtime for server and tests (containers use `oven/bun:1`).
- Docker + `docker compose` — for the MariaDB database and for deployment.

## Dev quickstart

```sh
bun install

# throwaway test/dev MariaDB on 127.0.0.1:3307
docker run -d --name st-mariadb-test \
  -e MARIADB_ROOT_PASSWORD=test -e MARIADB_DATABASE=st_test \
  -p 127.0.0.1:3307:3306 mariadb:11

cp .env.example .env   # then fill in DATABASE_URL, APP_PASSWORD, SESSION_SECRET
```

For the DB above, `DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test`. `APP_PASSWORD` and
`SESSION_SECRET` are any non-empty strings in dev.

Run the server (Bun auto-loads `.env` from the project root):

```sh
bun apps/server/src/main.ts
```

DB migrations apply automatically at startup — there is no manual migrate step. The app listens on
`PORT` (default 8080) and serves the built SPA from `apps/web/dist` when it exists; without a web
build it is API-only. `GET /api/health` is public; every other `/api` route needs login with
`APP_PASSWORD` (`POST /api/login`, session cookie or `Authorization: Bearer`).

Web UI during development (hot reload, proxies `/api` to `localhost:8080`):

```sh
bun run --cwd apps/web dev   # http://localhost:5173
```

Or build it into the binary's static reach: `bun run --cwd apps/web build`.

## Environment variables

Validation lives in `apps/server/src/wire/deps.ts` (`parseEnv`): it is hand-rolled on purpose so a
failure lists **every** offending variable name in one message. Blank/whitespace values count as
unset.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | `mysql://…` connection string |
| `APP_PASSWORD` | yes | — | web login password |
| `SESSION_SECRET` | yes | — | HMAC secret for session tokens |
| `PORT` | no | `8080` | HTTP port |
| `DIGEST_LANG` | no | `en` | `en` or `ko` |
| `TELEGRAM_BOT_TOKEN` | no | unset | unset ⇒ bot disabled; every send falls back to a console log line |
| `TELEGRAM_ALLOWED_CHAT_IDS` | when token set | — | comma-separated Telegram chat IDs |
| `VISION_BASE_URL` | when token set | — | OpenAI-compatible vision endpoint base URL |
| `VISION_MODEL` | when token set | — | model name for fill extraction |
| `VISION_API_KEY` | no | empty | can also be set later in the web Settings page |

Settings stored in the DB `settings` table **override the env values** for vision base URL, model,
and digest language at boot, and the vision **API key is re-read from the DB on every capture**, so
changes made in Settings apply without a restart (`apps/server/src/main.ts`,
`apps/server/src/wire/capture.ts`).

## Deployment

Put a root `.env` file with at least these three (docker compose interpolates them):
`MARIADB_ROOT_PASSWORD`, `APP_PASSWORD`, `SESSION_SECRET`. Optionally set `DIGEST_LANG` (defaults
to `en`) and the `TELEGRAM_*` / `VISION_*` vars (empty/unset ⇒ bot disabled, sends logged).

```sh
docker compose up -d --build
```

The app serves on `127.0.0.1:8080` — compose binds the port to localhost only, so remote access
means putting a TLS reverse proxy on the host in front of it (the Telegram bot uses long-polling
and needs no inbound endpoint). DB migrations are applied in-process at startup
(`applyMigrations` in `apps/server/src/db/client.ts`); no manual step. Data persists in the
`st-data` volume.

## Schedules

All jobs run on croner with timezone `America/New_York` (`apps/server/src/pipeline/wire.ts`), Mon–Fri
only — nothing on weekends:

| When (ET) | Job |
| --- | --- |
| 07:30 Mon–Fri | Morning pipeline: digest with buy/sell LOCs, forced sells, notices. On an NYSE holiday it sends a "market closed" note instead of a digest. |
| 16:05 Mon–Fri | Fill-capture reminder (skipped on market holidays). |
| Dec 1, 08:00 | Calendar-maintenance nudge (see caveat below). |

Manual trigger for the morning pipeline: `POST /api/trigger/morning` (authenticated).

## Calendar caveat (NYSE data)

The NYSE holiday/early-close calendar is committed **static data covering 2025–2027**
(`NYSE_YEARS` in `packages/calendar/src/nyse-data.ts`). For a year outside that range `dayInfo()`
knows only weekends — every weekday counts as a trading day, so holidays would be missed silently.
That is why the app sends a "December — time to load next year's NYSE calendar" nudge to all allowed
chats every **December 1st**: before the next year arrives, add its schedule to `nyse-data.ts`.

As a second line of defense, the morning pipeline cross-checks the day's open/closed status against
a remote calendar API (`howmanytradingdays.com`, `packages/calendar/src/crosscheck.ts`) before
sending anything. A disagreement sends a warning to every allowed chat and aborts that morning's
digest — a loud conflict, never a silent failure. (If the remote API itself is unreachable, the run
proceeds with the local calendar.)

## Testing

```sh
bun test                                   # unit + HTTP suites; DB suites self-skip without TEST_DATABASE_URL
bun run typecheck
```

Integration gate (requires the test DB from the quickstart running on 127.0.0.1:3307):

```sh
TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test
```
