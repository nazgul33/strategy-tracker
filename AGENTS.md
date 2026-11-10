# strategy-tracker

## Project overview

Self-hosted stock trade strategy tracker (Bun + TypeScript monorepo). Tracks mean-reversion strategy runs, captures fills via screenshots, and manages sell orders. See `docs/superpowers/specs/2026-11-10-strategy-tracker-design.md`.

## Repo map

```
package.json  tsconfig.base.json  .env.example  .gitignore  AGENTS.md
Dockerfile  docker-compose.yml
packages/
  core/src/        money.ts domain.ts fills.ts index.ts      (+ core/test/*)
  calendar/src/    index.ts nyse-data.ts crosscheck.ts       (+ calendar/test/*)
  market-data/src/ yahoo.ts                                  (+ market-data/test/*)
  strategies/src/  mean-reversion.ts                         (+ strategies/test/*)
  ingest/src/      extract.ts prompt.ts                      (+ ingest/test/*)
  telegram/src/    digest.ts bot.ts                          (+ telegram/test/*)
apps/server/src/
  main.ts
  db/schema.ts db/client.ts db/repos.ts
  domain/booking.ts
  pipeline/day.ts
  sim/sim.ts
  http/app.ts http/auth.ts http/routes/{runs,fills,pending,sim,settings}.ts
apps/server/test/  booking.test.ts day.test.ts sim.test.ts http.test.ts
apps/web/src/      main.tsx App.tsx api.ts i18n.ts viewmodels.ts
  components/{Layout,ThemeLangToggle,BucketBoard,OrderTable,FillTable,SimReplay,forms/*}
  pages/{RunsList,RunDetail,Sim,Settings}.tsx
  i18n/en.json i18n/ko.json
```

## Commands

- `bun install`
- `bun test`
- `bun run typecheck`
- `bun run dev`
- `docker compose up`

## Conventions

- No source file > ~300 lines; split by responsibility; no flat god-modules.
- `packages/*` never import `apps/*`.
- Money via `@st/core/money` bigint myriadths — never float; cost in integer ppm.
- All user-facing copy via en/ko catalogs.
- Schedules in `America/New_York`.
- `fetch` always injectable for tests.
- Commit style: `feat|fix|docs|test|chore:`.
