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
package.json  bun.lock  tsconfig.json  tsconfig.base.json  .env.example  .gitignore  .dockerignore  AGENTS.md  README.md
Dockerfile  docker-compose.yml
prod_helpers/      build_and_push.sh run_prod_container.sh
resources/trade_images/   sample broker screenshots (mpop/)
docs/superpowers/  specs/ plans/ followups/ decisions/  (design specs, implementation plans, followup lists, decision logs)
packages/          each package also has package.json tsconfig.json
  core/src/        money.ts domain.ts fills.ts index.ts      (+ core/test/*)
  calendar/src/    index.ts nyse-data.ts crosscheck.ts       (+ calendar/test/*)
  market-data/src/ yahoo.ts                                  (+ market-data/test/*)
  strategies/src/  index.ts mean-reversion.ts                (+ strategies/test/*)
  ingest/src/      extract.ts prompt.ts                      (+ ingest/test/*)
  telegram/src/    digest.ts bot.ts i18n.ts                  (+ telegram/test/*)
apps/server/       drizzle.config.ts package.json tsconfig.json
  src/
    main.ts
    db/schema.ts db/client.ts db/db-type.ts db/repos.ts db/repos-bars.ts db/repos-sim.ts db/repos-vision.ts
    domain/booking.ts domain/confirm-pending.ts domain/capture-claim.ts domain/capture-corrections.ts domain/capture-dedup.ts domain/booking-notify.ts domain/capture-image.ts domain/correction-types.ts domain/corrections.ts domain/order-ops.ts domain/ppm.ts domain/recompute.ts domain/repo-types.ts domain/require-run.ts domain/run-lock.ts domain/sell-match.ts domain/vision-review.ts
    wire/deps.ts wire/capture.ts wire/booking-notifier.ts wire/boot-sweeps.ts wire/send.ts
    pipeline/day.ts pipeline/wire.ts
    market/bars.ts
    sim/sim.ts sim/serialize.ts
    http/app.ts http/auth.ts http/booking-deps.ts http/params.ts http/routes/{runs,fills,pending,corrections,sim,settings,vision-review}.ts
  db/              README.md
  db/migrations/   0000_fantastic_thunderbolts.sql … 0009_living_lenny_balinger.sql (+ meta/)
  test/            *.test.ts per area (booking, rebooking, sell-attribution, sell-matching, sell-bucket-override, http-bucket-override, booking-notifier, vision-review, capture-claim, capture-image, corrections, fake-corrections, recalc, run-lock-writers, ppm, bars, bars-chunking, bars-db, boot-sweeps, send, calendar-2028, day, migration-sql, sim, wire, http-*, db*, confirm-keep-order, refreeze-kept, main-boot-order, repo-surface-types) + fake-corrections.ts http-fakes.ts booking-fakes.ts bars-fakes.ts sell-fixture.ts type-assert.ts
apps/web/          package.json tsconfig.json index.html vite.config.ts tailwind.config.ts postcss.config.js .gitignore
apps/web/src/      main.tsx App.tsx style.css api.ts api.sim.ts api.types.ts autofee.ts defaultcost.ts format.ts pendingvalues.ts viewmodels.ts cutloss.ts gaps.ts priceHistory.ts simconfig.ts simerrors.ts simview.ts usd.ts visionreviewerrors.ts (+ colocated *.test.ts(x))
  testing/{fetchStub,holdFetch,pendingRow,visionReview}.ts   (shared test fixtures, no DOM needed at import time; fetchStub.test.ts)
  components/{Layout,ThemeLangToggle,BucketBoard,OrderTable,FillTable,SimReplay,NoticeList,PriceChart,RecalcSummary,RunPanels,RunHistory,ScreenshotLink,VisionReviewEntry,Modal,hooks,ui,forms/*}
  components/forms/{BucketSelect,CorrectionList,CreateRunForm,DefaultFeePrompt,EditRunModal,FillDeleteStep,FillDialog,KeepImagePrompt,KeepNotices,PendingReviewDialog,PendingRow,PendingTable,SimConfigFields,SimConfigPanel,pendingHints}
  pages/{RunsList,RunDetail,Sim,SimRun,Settings,Login,Pending,VisionReview}.tsx
  i18n/catalog.ts i18n/index.tsx i18n/en.json i18n/ko.json
scripts/           e2e.ts e2e-ctx.ts e2e-cutloss.ts e2e-sim-drafts.ts e2e-vision-review.ts tsconfig.json
                   — operator smoke on a scratch DB (see Test matrix); e2e.ts sets up and drives the step modules in order
                   (e2e-ctx.ts = shared ctx incl. the `photo` capture helper; e2e-vision-review.ts = screenshot retention)
```

## Commands

- `bun install`
- `bun test`
- `bun run typecheck` (packages + apps/server incl. test/ via `tsc -b`; apps/web + scripts directly)
- `bun run dev` is a pointer, not a server — run `bun run --cwd apps/server dev` (or `bun run --cwd apps/web dev`)
- `docker compose up` (app listens on 127.0.0.1:8080 by default)
- E2E smoke (see Test matrix for the scratch DB): `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`
- Drizzle migrations: edit `apps/server/src/db/schema.ts`, then `bun run --cwd apps/server db:generate` (writes SQL + `meta/` snapshots into `apps/server/db/migrations/`). They are applied automatically at server startup (`applyMigrations` in `db/client.ts`, resolves from `process.cwd()` — hence all entry points run from the repo root); `db:migrate` exists for a manual apply.

## Test matrix

| What | Needs DB | Command |
| --- | --- | --- |
| Unit suites (`packages/*/test`, `apps/server/test/*` except `apps/server/test/db*.test.ts` and `bars-db.test.ts`, `apps/web`) | no | `bun test` — the DB-gated files (`apps/server/test/db*.test.ts` and `bars-db.test.ts`) each self-skip without `TEST_DATABASE_URL` (their DB tests skip) |
| DB integration | yes | `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` |
| Operator E2E smoke | yes | `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts` (run from repo root) |

`scripts/e2e.ts` never touches the `st_test` tables: it creates a fresh `st_e2e_*` scratch DB, runs migrations on it, drives the real HTTP app + capture pipeline against it (fake vision endpoint on 127.0.0.1), and always drops the scratch DB — including on failure. (The DB suite likewise creates and drops its own scratch databases: `st_janitor_*` in `apps/server/test/db-vision-janitor.test.ts` and `st_simlist_*` in `apps/server/test/db-sim-list.test.ts`.) Bars, closes and the calendar cross-check are injected, so it works offline.

- Test DB: `docker run -d --name st-mariadb-test -e MARIADB_ROOT_PASSWORD=test -e MARIADB_DATABASE=st_test -p 127.0.0.1:3307:3306 mariadb:11`

## Calendar data maintenance

The NYSE calendar is committed static data (`NYSE_YEARS` in `packages/calendar/src/nyse-data.ts`, currently 2025–2028; add the next year as plain entries — holidays carry `en`/`ko` names, early closes carry ET times). Outside the covered years `dayInfo()` degrades to weekends-only, so every weekday looks open. There is no regen script; edit the table by hand and extend `packages/calendar/test/calendar.test.ts`. The app nudges allowed chats every Dec 1 (cron in `apps/server/src/pipeline/wire.ts`), and the morning pipeline cross-checks against `howmanytradingdays.com` (`packages/calendar/src/crosscheck.ts`) as a second line of defense.

## Conventions

- No source file > ~300 lines; split by responsibility; no flat god-modules.
- `packages/*` never import `apps/*`.
- Money via `@st/core/money` bigint myriadths — never float; cost in integer ppm.
- All user-facing copy via en/ko catalogs.
- Schedules in `America/New_York`.
- `fetch` always injectable for tests.
- Commit style: `feat|fix|docs|test|refactor|chore:`.
