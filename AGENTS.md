# strategy-tracker

## Important Directive for Agents.
- You must respond exclusively in English. Never use Chinese (Hanzi) or Russian (Cyrillic) characters under any circumstances, even for code comments or proper nouns.
- You can use English and/or Korean for UX string resources.
- You shouldDefault to subagent development with dedicated worktree unless instructed otherwise
- Never write any file or run destructive commands outside of git protected directories without asking.

## Project overview

Self-hosted stock trade strategy tracker (Bun + TypeScript monorepo). Tracks mean-reversion strategy runs, captures fills via screenshots, and manages sell orders. See `docs/superpowers/specs/2026-11-10-strategy-tracker-design.md`.

## Repo map

```
package.json  tsconfig.base.json  .env.example  .gitignore  AGENTS.md  README.md
Dockerfile  docker-compose.yml
packages/
  core/src/        money.ts domain.ts fills.ts index.ts      (+ core/test/*)
  calendar/src/    index.ts nyse-data.ts crosscheck.ts       (+ calendar/test/*)
  market-data/src/ yahoo.ts                                  (+ market-data/test/*)
  strategies/src/  index.ts mean-reversion.ts                (+ strategies/test/*)
  ingest/src/      extract.ts prompt.ts                      (+ ingest/test/*)
  telegram/src/    digest.ts bot.ts i18n.ts                  (+ telegram/test/*)
apps/server/       drizzle.config.ts
  src/
    main.ts
    db/schema.ts db/client.ts db/repos.ts
    domain/booking.ts
    wire/deps.ts wire/capture.ts
    pipeline/day.ts pipeline/wire.ts
    sim/sim.ts
    http/app.ts http/auth.ts http/routes/{runs,fills,pending,sim,settings}.ts
  db/migrations/   0000_fantastic_thunderbolts.sql 0001_workable_spot.sql (+ meta/)
  test/            booking.test.ts day.test.ts sim.test.ts http.test.ts db.test.ts wire.test.ts
apps/web/src/      main.tsx App.tsx api.ts api.types.ts format.ts viewmodels.ts (+ colocated *.test.ts)
  components/{Layout,ThemeLangToggle,BucketBoard,OrderTable,FillTable,SimReplay,NoticeList,RunPanels,RunHistory,hooks,ui,forms/*}
  pages/{RunsList,RunDetail,Sim,SimRun,Settings,Login,Pending}.tsx
  i18n/en.json i18n/ko.json
scripts/           e2e.ts tsconfig.json — operator smoke on a scratch DB (see Test matrix)
```

## Commands

- `bun install`
- `bun test`
- `bun run typecheck` (packages via `tsc -b`, apps/web + scripts directly)
- `bun run dev` is a pointer, not a server — run `bun run --cwd apps/server dev` (or `bun run --cwd apps/web dev`)
- `docker compose up` (app listens on 127.0.0.1:8080 by default)
- E2E smoke (see Test matrix for the scratch DB): `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`
- Drizzle migrations: edit `apps/server/src/db/schema.ts`, then `bun run --cwd apps/server db:generate` (writes SQL + `meta/` snapshots into `apps/server/db/migrations/`). They are applied automatically at server startup (`applyMigrations` in `db/client.ts`, resolves from `process.cwd()` — hence all entry points run from the repo root); `db:migrate` exists for a manual apply.

## Test matrix

| What | Needs DB | Command |
| --- | --- | --- |
| Unit suites (`packages/*/test`, `apps/server/test/*` except `db.test.ts`, `apps/web`) | no | `bun test` — `apps/server/test/db.test.ts` self-skips without `TEST_DATABASE_URL` (skips 6) |
| DB integration | yes | `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` |
| Operator E2E smoke | yes | `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts` (run from repo root) |

`scripts/e2e.ts` never touches the `st_test` tables: it creates a fresh `st_e2e_*` scratch DB, runs migrations on it, drives the real HTTP app + capture pipeline against it (fake vision endpoint on 127.0.0.1), and always drops the scratch DB — including on failure. Bars, closes and the calendar cross-check are injected, so it works offline.

- Test DB: `docker run -d --name st-mariadb-test -e MARIADB_ROOT_PASSWORD=test -e MARIADB_DATABASE=st_test -p 127.0.0.1:3307:3306 mariadb:11`

## Calendar data maintenance

The NYSE calendar is committed static data (`NYSE_YEARS` in `packages/calendar/src/nyse-data.ts`, currently 2025–2027; add the next year as plain entries — holidays carry `en`/`ko` names, early closes carry ET times). Outside the covered years `dayInfo()` degrades to weekends-only, so every weekday looks open. There is no regen script; edit the table by hand and extend `packages/calendar/test/calendar.test.ts`. The app nudges allowed chats every Dec 1 (cron in `apps/server/src/pipeline/wire.ts`), and the morning pipeline cross-checks against `howmanytradingdays.com` (`packages/calendar/src/crosscheck.ts`) as a second line of defense.

## Conventions

- No source file > ~300 lines; split by responsibility; no flat god-modules.
- `packages/*` never import `apps/*`.
- Money via `@st/core/money` bigint myriadths — never float; cost in integer ppm.
- All user-facing copy via en/ko catalogs.
- Schedules in `America/New_York`.
- `fetch` always injectable for tests.
- Commit style: `feat|fix|docs|test|chore:`.
