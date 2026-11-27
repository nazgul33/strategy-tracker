# strategy-tracker

## Important Directive for Agents.
- You must respond exclusively in English. Never use Chinese (Hanzi) or Russian (Cyrillic) characters under any circumstances, even for code comments or proper nouns.
- You can use English and/or Korean for UX string resources.
- You shouldDefault to subagent development with dedicated worktree unless instructed otherwise
- Never write any file or run destructive commands outside of git protected directories without asking.

## Project overview

Self-hosted stock trade strategy tracker (Bun + TypeScript monorepo). Tracks mean-reversion and Value Rebalancing (VR) strategy runs, captures mean-reversion and VR fills via screenshots, and manages sell orders. See `docs/superpowers/specs/2026-11-10-strategy-tracker-design.md` and, for VR, `docs/superpowers/specs/2026-11-25-vr-core-design.md`. VR fills are typed in or arrive by screenshot (a Telegram photo or a web upload). Screenshot fills wait on the VR run page's Pending tab until they are confirmed or rejected, and waiting fills hold the next cycle step. VR screenshot intake: `docs/superpowers/specs/2026-11-26-vr-capture-design.md`. The Dashboard page (`#/dashboard`, the page the app opens on) shows, per strategy, the value of its active and paused runs at the last stored close plus cash (`GET /api/dashboard`); design: `docs/superpowers/specs/2026-11-26-runs-dashboard-design.md`.

## Repo map

```
package.json  bun.lock  tsconfig.json  tsconfig.base.json  .env.example  .gitignore  .dockerignore  AGENTS.md  README.md
Dockerfile  docker-compose.yml
prod_helpers/      build_and_push.sh run_prod_container.sh
resources/trade_images/   sample broker screenshots (mpop/, mpop/stop/ = stop-order samples)
docs/superpowers/  specs/ plans/ followups/ decisions/  (design specs, implementation plans, followup lists, decision logs)
packages/          each package also has package.json tsconfig.json
  core/src/        money.ts domain.ts fills.ts index.ts      (+ core/test/*)
  calendar/src/    index.ts nyse-data.ts crosscheck.ts       (+ calendar/test/*)
  market-data/src/ yahoo.ts                                  (+ market-data/test/*)
  strategies/src/  index.ts mean-reversion.ts value-rebalancing.ts (+ strategies/test/*)
  ingest/src/      extract.ts mask-key.ts prompt.ts          (+ ingest/test/*)
  telegram/src/    digest.ts bot.ts i18n.ts vr.ts            (+ telegram/test/*)
apps/server/       drizzle.config.ts package.json tsconfig.json
  src/
    main.ts
    db/schema.ts db/client.ts db/db-type.ts db/repos.ts db/repos-mr-runs.ts db/repos-bars.ts db/repos-sim.ts db/repos-vision.ts db/schema-vr.ts db/repos-vr.ts db/repos-capture-choice.ts
    domain/booking.ts domain/confirm-pending.ts domain/capture-claim.ts domain/capture-choice.ts domain/capture-corrections.ts domain/capture-dedup.ts domain/booking-notify.ts domain/capture-image.ts domain/correction-types.ts domain/corrections.ts domain/dashboard.ts domain/notice-feed.ts domain/order-ops.ts domain/order-type.ts domain/pending-flags.ts domain/pool-edit.ts domain/ppm.ts domain/recompute.ts domain/repo-types.ts domain/require-run.ts domain/retire-legs.ts domain/run-lock.ts domain/sell-attribute.ts domain/sell-match.ts domain/vision-review.ts domain/vr/{repo-types,view,booking,runs,capture,capture-match,pending}.ts
    wire/deps.ts wire/capture.ts wire/capture-pending-message.ts wire/capture-bad-extract-message.ts wire/booking-notifier.ts wire/broadcast.ts wire/boot-sweeps.ts wire/send.ts wire/capture-route.ts wire/vr-status.ts wire/capture-choice.ts wire/vr-capture-message.ts
    pipeline/day.ts pipeline/vr-day.ts pipeline/close.ts pipeline/close-catchup.ts pipeline/evening-closes.ts pipeline/notify.ts pipeline/wire.ts
    market/bars.ts
    sim/sim.ts sim/serialize.ts
    http/app.ts http/auth.ts http/booking-deps.ts http/params.ts http/routes/{runs,fills,pending,corrections,sim,settings,notifications,vision-review,captures,vr,vr-entries,vr-pending,dashboard}.ts
  db/              README.md
  db/migrations/   0000_fantastic_thunderbolts.sql … 0018_vr_order_price.sql (+ meta/)
  test/            *.test.ts per area (booking, booking-* [guards, capture-*, confirm-overrides, sell-legs, sell-cancel, sell-notify, future-date, order-type, buy-merge], rebooking, rebooking-* [delete, legs, delete-legs, buy-merge], retire-legs, sell-attribution, sell-attribute, sell-attribute-cases, sell-matching, order-type, pending-flags, pool-edit, sell-bucket-override, http-bucket-override, booking-notifier, broadcast, vision-review, vision-review-* [fee, reject], notice-feed, capture-bad-extract-message, capture-claim, capture-image, capture-replies, capture-route, capture-route-vr, vr-capture, vr-capture-match, vr-pending, vr-fakes, corrections, fake-corrections, recalc, run-lock-writers, ppm, bars, bars-chunking, bars-db, boot-sweeps, send, calendar-2028, day, day-notices, day-failures, day-unconfirmed, day-data-error, day-run-lock, day-close-catchup, evening-closes, pipeline-jobs, vr-day, vr-day-schedule, vr-day-hold, vr-view, dashboard, wire-vr-status, wire-vr-capture-message, migration-sql, sim, sim-cut-loss, sim-run, wire, wire-capture-* [photo, routing, confirm, status, choice, question, question-failures], http-* [incl. runs-fills-gaps, runs-cutloss, fill-edit-legs, fill-delete-legs, future-date, captures, vr-runs, vr-fills, vr-cash, vr-pending, dashboard], db* [incl. db-mr-split, db-run-scope, db-vr, db-vr-pending, db-pool-edit], confirm-keep-order, refreeze-kept, main-boot-order, repo-surface-types) + fake-corrections.ts fake-sim.ts http-fakes.ts booking-fakes.ts bars-fakes.ts sell-fixture.ts sell-attribute-fixture.ts wire-capture-fakes.ts rebooking-fixture.ts vision-review-fixture.ts mr-split-fixture.ts sim-fixture.ts day-fakes.ts vr-fakes.ts vr-http-fixture.ts vr-day-fixture.ts capture-choice-fakes.ts wire-capture-question-fixture.ts type-assert.ts
apps/web/          package.json tsconfig.json index.html vite.config.ts tailwind.config.ts postcss.config.js .gitignore
apps/web/src/      main.tsx App.tsx style.css api.ts api.call.ts api.sim.ts api.notices.ts api.types.ts api.pending.types.ts api.captures.types.ts api.vr.ts api.vr.types.ts api.dashboard.ts autofee.ts defaultcost.ts errortext.ts format.ts pendingchoice.ts pendingvalues.ts viewmodels.ts cutloss.ts gaps.ts paging.ts priceHistory.ts simconfig.ts simerrors.ts simview.ts uploadlines.ts uploadpick.ts usd.ts visionreviewerrors.ts (+ colocated *.test.ts(x), incl. AppVr.test.tsx, api.dashboard.test.ts, uploadlines.vr.test.ts, pages/Dashboard.test.tsx, pages/VrRunPending.test.tsx, pages/VrRunUpload.test.tsx)
  testing/{dom,fetchStub,fillDialog,holdFetch,offline,pendingRow,pendingTable,runDetail,scrollShim,upload,visionReview,vr,vrDialog}.ts   (shared test fixtures, no DOM needed at import time; fetchStub.test.ts)
  components/{Layout,ThemeLangToggle,BucketBoard,OrderTable,FillTable,SimReplay,NoticeList,Pager,SystemNotices,PriceChart,RecalcSummary,RunHeader,RunPanels,RunHistory,ScreenshotLink,VisionReviewEntry,Modal,inert,hooks,ui,forms/*,vr/*}
  components/vr/{VrCashDialog,VrCashPanel,VrConfirmAllSummary,VrCreateForm,VrCyclesPanel,VrDeleteStep,VrFillDialog,VrFillsPanel,VrLadders,VrPanelState,VrPendingDialog,VrPendingPanel,VrSettingsModal,VrSummary,vrFillChecks,vrText}   (+ colocated tests)
  components/forms/{BucketSelect,CorrectionList,CreateRunForm,DefaultFeePrompt,EditRunModal,FillDeleteStep,FillDialog,KeepImagePrompt,KeepNotices,PendingReviewDialog,PendingRow,PendingTable,SimConfigFields,SimConfigPanel,UploadDialog,UploadPicker,UploadResults,pendingHints}
  pages/{Dashboard,RunsList,RunDetail,Sim,SimRun,Settings,Login,Pending,VisionReview,VrRuns,VrRun}.tsx
  i18n/catalog.ts i18n/index.tsx i18n/en.json i18n/ko.json
scripts/           e2e.ts e2e-ctx.ts e2e-cutloss.ts e2e-dashboard.ts e2e-order-type.ts e2e-sim.ts e2e-sim-drafts.ts e2e-vr.ts e2e-vr-capture.ts e2e-vision-review.ts e2e-web-upload.ts tsconfig.json
                   — operator smoke on a scratch DB (see Test matrix); e2e.ts sets up and drives the step modules in order
                   (e2e-ctx.ts = shared ctx incl. the `photo` capture helper and the shared `ok` counter; e2e-vision-review.ts = screenshot retention; e2e-order-type.ts = order-type attribution + future-dated fill;
                   e2e-sim.ts = deterministic sim fixtures + step; e2e-web-upload.ts = multipart uploads through POST /api/captures;
                   e2e-vr.ts = Value Rebalancing run: buy instruction, cycle 1 and its ladder, books, pause and close;
                   e2e-vr-capture.ts = VR screenshots: a pinned upload, the duplicate refusal, confirm / reject / edit, the cycle-1 hold, a second same-day screenshot matched by order price, a ticker shared by an MR and a VR run;
                   e2e-dashboard.ts = the dashboard: every row and total recomputed from the run lists and the stored closes; a paused VR run's missing close stored by the morning catch-up; the evening job stores the day's close, and `closesBehind` follows the injected clock)
```

## Commands

- `bun install`
- `bun test`
- `bun run typecheck` (packages + apps/server incl. test/ via `tsc -b`; apps/web + scripts directly)
- `bun run dev` is a pointer, not a server — run `bun run --cwd apps/server dev` (or `bun run --cwd apps/web dev`)
- `docker compose up` (app listens on 127.0.0.1:8080 by default)
- E2E smoke (see Test matrix for the scratch DB): `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`
- Drizzle migrations: edit `apps/server/src/db/schema.ts`, then `bun run --cwd apps/server db:generate` (writes SQL + `meta/` snapshots into `apps/server/db/migrations/`). They are applied automatically at server startup (`applyMigrations` in `db/client.ts`, resolves from `process.cwd()` — hence all entry points run from the repo root); `db:migrate` exists for a manual apply. Hand-appended statements (the backfills in 0007 and 0010) are pinned in `apps/server/test/migration-sql.test.ts`, because regenerating a migration drops them. Migrations `0013`–`0015` (the `mr_` split) are hand-written (created with `drizzle-kit generate --custom`) and pinned in `apps/server/test/migration-sql.test.ts`; the `0015` snapshot was aligned with `schema.ts` by hand. `0016_vr_tables.sql` (the `vr_` tables, defined in `db/schema-vr.ts` and re-exported from `schema.ts`) is plain `drizzle-kit generate` output. `0017_vr_capture.sql` (`vr_pending_fills` in `db/schema-vr.ts`, `capture_choices` in `schema.ts`) is plain `drizzle-kit generate` output. `0018_vr_order_price.sql` (`order_price` on `vr_fills` and `vr_pending_fills`) is plain `drizzle-kit generate` output.

## Test matrix

| What | Needs DB | Command |
| --- | --- | --- |
| Unit suites (`packages/*/test`, `apps/server/test/*` except `apps/server/test/db*.test.ts` and `bars-db.test.ts`, `apps/web`) | no | `bun test` — the DB-gated files (`apps/server/test/db*.test.ts` and `bars-db.test.ts`) each self-skip without `TEST_DATABASE_URL` (their DB tests skip) |
| DB integration | yes | `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` |
| Operator E2E smoke | yes | `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts` (run from repo root) |

`scripts/e2e.ts` never touches the `st_test` tables: it creates a fresh `st_e2e_*` scratch DB, runs migrations on it, drives the real HTTP app + capture pipeline against it (fake vision endpoint on 127.0.0.1), and always drops the scratch DB — including on failure. (The DB suite likewise creates and drops its own scratch databases: `st_janitor_*` in `apps/server/test/db-vision-janitor.test.ts`, `st_simlist_*` in `apps/server/test/db-sim-list.test.ts` and `st_mrsplit_*` in `apps/server/test/db-mr-split.test.ts`.) Bars, closes and the calendar cross-check are injected, so it works offline.

- Test DB: `docker run -d --name st-mariadb-test -e MARIADB_ROOT_PASSWORD=test -e MARIADB_DATABASE=st_test -p 127.0.0.1:3307:3306 mariadb:11`

## Calendar data maintenance

The NYSE calendar is committed static data (`NYSE_YEARS` in `packages/calendar/src/nyse-data.ts`, currently 2025–2028; add the next year as plain entries — holidays carry `en`/`ko` names, early closes carry ET times). Outside the covered years `dayInfo()` degrades to weekends-only, so every weekday looks open. There is no regen script; edit the table by hand and extend `packages/calendar/test/calendar.test.ts`. The app nudges allowed chats every Dec 1 (cron in `apps/server/src/pipeline/wire.ts`), and the morning pipeline cross-checks against `howmanytradingdays.com` (`packages/calendar/src/crosscheck.ts`) as a second line of defense.

## Conventions

- No source file > ~300 lines; split by responsibility; no flat god-modules.
- `packages/*` never import `apps/*`.
- Money via `@st/core/money` bigint myriadths — never float; cost in integer ppm.
- Strategy-specific tables carry a prefix (`mr_` mean reversion; `vr_` value rebalancing; `ib_` reserved). Shared tables: `strategy_runs`, `captures`, `capture_images`, `capture_choices`, `notifications`, `settings`, `price_history`, `bar_coverage`. `runRepo` joins `mr_runs`, so it returns mean-reversion runs only.
- `capture_choices` is a shared table (a parked Telegram question). A screenshot for a ticker with exactly one active MR run and one active VR run is asked about on Telegram and is "several active runs" on an un-pinned web upload.
- VR books (shares, Pool) are computed from `vr_fills` and `vr_cash_moves`, never stored; the ladder is computed, never stored. Screenshot fills wait in `vr_pending_fills` and become `vr_fills` (source `capture`) only when confirmed; a screenshot that produced rows for a run is never taken in again for that run. Buy rung prices are floored to the cent, sell rung prices ceilinged; at most 30 rungs a side, with the lot sized so they cover a 30% move.
- VR screenshot fills are matched against the run's booked, waiting and rejected fills by side, shares, price, date and the order price read from the screenshot (`domain/vr/capture-match.ts`); only drops use up an entry, marks never drop; mean reversion's matcher (`domain/capture-dedup.ts`) is not used by VR.
- The dashboard (`domain/dashboard.ts`, `GET /api/dashboard`) values active and paused runs at the newest stored close of their ticker; the morning job (`pipeline/close-catchup.ts`) stores the last close for every active or paused run's ticker that is behind, and the evening job (17:00 New York) stores the day's close.
- An evening job (`pipeline/evening-closes.ts`, 17:00 New York on trading days, again at 18:00 and 19:00) stores the day's close for every active or paused run's ticker; `price_history` may hold a row dated today only from that job; the bar cache never stores past the last finished trading day.
- Setting a mean-reversion run's pool (`domain/pool-edit.ts`) moves its stored cash by the pool difference under the run lock and books one `adjust` ledger row.
- All user-facing copy via en/ko catalogs.
- Schedules in `America/New_York`.
- `fetch` always injectable for tests.
- Commit style: `feat|fix|docs|test|refactor|chore:`.
