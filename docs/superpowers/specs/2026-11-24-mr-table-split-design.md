# Split shared tables from mean-reversion tables (`mr_` prefix) — Design

Date: 2026-11-24
Status: approved (2026-11-24)

## Intent and why

The owner wants to add Value Rebalancing (VR) as a second strategy, and later Infinite Buy (IB).
The current schema and code are mean-reversion (MR) shaped: every booking table carries a bucket
index, and `strategy_runs` mixes fields every strategy has (name, ticker, status) with MR-only
ones (pool, gaps, cut-loss, bucket state).

The owner's direction, settled in conversation:

- Each strategy keeps **its own tables and its own screens**. No generic strategy engine.
- Strategy-specific tables carry a prefix: `mr_` (mean reversion), `vr_` (value rebalancing),
  `ib_` (infinite buy).
- The same ticker may be traded by runs of different strategies at the same time.

This document covers **piece 1 of 3**: make the shared/MR boundary explicit in the database and
in the repository layer, with no change in behaviour. It exists so that piece 2 (VR) can add
`vr_*` tables and VR rows in `strategy_runs` without the MR code noticing.

Roadmap, for context only:

1. **This piece** — `mr_` rename and a thin shared run record.
2. **VR** — cycle maths, `vr_*` tables, two-week order ladder in Telegram, fill booking, VR
   screens. On a Telegram screenshot the bot asks which strategy it belongs to. There is no
   automatic cross-strategy routing by ticker; when one brokerage account serves several
   strategies, the owner deletes the entries that belong elsewhere.
3. **All-runs dashboard** — one performance view across strategies.

## Goals

- Every MR-specific table is named `mr_*`.
- `strategy_runs` holds only fields every strategy has.
- All existing data survives exactly: same rows, same ids, same values.
- No change to HTTP response shapes, Telegram texts, or the web app.
- MR code reads only MR runs, by construction, so a future non-MR row in `strategy_runs` is
  invisible to the morning pipeline, screenshot routing, `/status`, `/orders` and the runs list.
- A deploy that dies part-way through the migration is fixed by starting the server again.

## Non-goals

- Any VR or IB table, code or screen.
- The dashboard.
- Moving existing server or web files into `mr/` folders. VR code will live in its own folders;
  relocating MR files is a separate mechanical change that can happen at any time.
- Renaming domain types, repository names, HTTP routes, i18n keys or web components
  (`RunRow`, `runRepo`, `/api/runs`, ... keep their names).
- A strategy plug-in interface.
- A shared (strategy-agnostic) screenshot confirmation flow.

## Anti-goals

- Lost or altered booking data.
- A half-migrated production database that needs hand-written SQL to boot.
- A schema that drifts from drizzle's snapshot, so the next `db:generate` emits surprise SQL.

## Constraints

- MariaDB only; MariaDB-specific SQL is acceptable. Both `docker-compose.yml` and the
  production compose file (`docker-compose.prod.yml`, gitignored) pin `mariadb:11.4`, which
  supports the `IF EXISTS` rename forms and atomic multi-table rename. Production runs the
  database in the `mariadb_st_prod` container with the app user created by the official image
  (`MARIADB_USER` on `MARIADB_DATABASE`), which holds all privileges on that database.
  Checked on 2026-11-24: the running `mariadb_st_prod` container reports MariaDB 11.4.13.
- MariaDB commits implicitly on every DDL statement, so a migration cannot be rolled back.
- Migrations are applied automatically at server start by drizzle's migrator
  (`applyMigrations` in `apps/server/src/db/client.ts`).
- Repo conventions in `AGENTS.md`: no source file over ~300 lines, hand-written migration
  statements are pinned in `apps/server/test/migration-sql.test.ts`.

## Approaches considered

**A. Rename only.** Prefix the bucket-bound tables and leave `strategy_runs` as it is. Smallest
and safest (one atomic rename, no data moved), but a VR run would have to store dummy values in
`pool_cents`, the gap columns and `state_json`. Rejected: it keeps the mixed table.

**B. Thin shared run, everything bucket-bound becomes `mr_` — CHOSEN by the owner.**
`strategy_runs` keeps only shared fields; MR settings and state move to a new `mr_runs`. The
booking tables, the simulator tables and the screenshot confirmation tables (`pending_fills`,
`fill_corrections`, `vision_reviews`) all become `mr_*`. VR will build its own confirmation
tables and screen. Chosen because it matches "separate tables and screens per strategy", changes
no behaviour, and avoids designing a shared confirmation flow from a single example.

**C. Thin shared run, shared screenshot confirmation.** As B, but the pending, correction and
review tables stay shared with the bucket choice pulled out of them. One Pending screen for all
strategies. Rejected for now: much larger, and it guesses VR's needs before VR is designed. If
duplication hurts once IB exists, extract then with three real cases.

## The table map

### Shared — names unchanged

| Table | Note |
| --- | --- |
| `strategy_runs` | trimmed, see below |
| `captures` | one row per screenshot per run; keeps `captures_run_hash_unique` |
| `capture_images` | screenshot bytes |
| `notifications` | |
| `settings` | |
| `price_history` | |
| `bar_coverage` | |

`strategy_runs` after this piece:

| Column | |
| --- | --- |
| `id` | unchanged |
| `strategy_key` | unchanged; every existing row is `mean-reversion` |
| `ticker` | unchanged |
| `name` | unchanged, still unique across all strategies |
| `cost_ppm` | stays shared (designer's call: the broker's fee rate applies to any strategy) |
| `status` | unchanged |
| `created_at` | unchanged |

### Renamed

| Old | New |
| --- | --- |
| `pool_edits` | `mr_pool_edits` |
| `buckets` | `mr_buckets` |
| `orders` | `mr_orders` |
| `fills` | `mr_fills` |
| `ledger` | `mr_ledger` |
| `pending_fills` | `mr_pending_fills` |
| `fill_corrections` | `mr_fill_corrections` |
| `vision_reviews` | `mr_vision_reviews` |
| `sim_runs` | `mr_sim_runs` |
| `sim_days` | `mr_sim_days` |

Indexes whose name embeds a renamed table are renamed to match (designer's call, so names do
not lie): `orders_run_trade_date_idx`, `orders_trade_date_idx`,
`vision_reviews_pending_fill_unique`, `vision_reviews_capture_idx`, `fill_corrections_fill_idx`,
`sim_runs_draft_created_idx`, `sim_days_sim_run_trade_idx` each gain the `mr_` prefix.

Columns, types, defaults and row ids of the renamed tables do not change.

### New — `mr_runs`

One row per MR run, holding what moved off `strategy_runs`.

| Column | From |
| --- | --- |
| `run_id` (primary key, equals `strategy_runs.id`) | — |
| `pool_cents` | `strategy_runs.pool_cents` |
| `buy_gap_ppm` | `strategy_runs.buy_gap_ppm` |
| `sell_gap_ppm` | `strategy_runs.sell_gap_ppm` |
| `cut_loss_ppm` | `strategy_runs.cut_loss_ppm` |
| `state_json` | `strategy_runs.state_json` |

Types, nullability and defaults are carried over as they are today. The five source columns are
dropped from `strategy_runs` once copied.

Invariant: a `strategy_runs` row has an `mr_runs` row if and only if it is an MR run. The schema
keeps the project's existing style of no foreign-key constraints.

## Code changes

### Schema (`apps/server/src/db/schema.ts`)

Table names change as mapped above, `mrRuns` is added, `strategyRuns` is trimmed. The exported
schema identifiers take the `mr` prefix too (`mrBuckets`, `mrOrders`, ...), so the code reads
true (designer's call).

### Repositories

The repository **interfaces and row shapes do not change**. `RunRow` keeps all of today's fields.

- `runRepo.list / get / getMany` return the join of `strategy_runs` with `mr_runs`. Because it
  is an inner join, they return MR runs only. This is the mechanism behind the "MR code reads
  only MR runs" goal: the morning pipeline, screenshot routing, `/status`, `/orders`, the notice
  feed and `GET /api/runs` all go through these methods and need no edit.
- `runRepo.create` writes the `strategy_runs` row and the `mr_runs` row in one transaction, as
  it already does for the initial bucket state.
- `runRepo.updatePool` and `updateOrderShaping` write `mr_runs`.
- `runRepo.updateStatus` and `updateStatusMany` write `strategy_runs`.
- `bucketRepo.loadState / saveState / saveStateWithOrders` read and write `mr_runs.state_json`.
- Every other repository only follows the renamed schema identifiers.

No domain, pipeline, wire, HTTP, Telegram or web source file should need more than an import or
identifier touch-up. If one needs a behavioural edit, that is a sign the design has been
misread; stop and raise it.

### Tests and scripts

- Raw SQL in the DB-gated tests names old tables (`pending_fills`, `fills`, `sim_runs`,
  `sim_days`, `orders` in `db.test.ts`, `db-capture.test.ts`, `db-vision-review.test.ts`,
  `db-sim-list.test.ts`, `db-migration-0007.test.ts`, `db-migration-0010.test.ts`); update to the
  new names.
- `db-migration-0007.test.ts` and `db-migration-0010.test.ts` replay a statement taken verbatim
  from an old migration file against the fully migrated database. Those statements name the old
  tables, so the replay needs adapting (for example by rewriting the table name before running
  it). The old migration files themselves are never edited.
- The pins in `migration-sql.test.ts` that match text in migrations 0007–0010 stay valid, since
  those files do not change.

## The migration

Hand-written SQL in new migration files after `0012`. Exact file split is the builder's, within
these rules:

1. **Rename all ten tables in one `RENAME TABLE` statement.** MariaDB applies a multi-table
   rename atomically.
2. **Create `mr_runs` and copy** one row per existing `strategy_runs` row (all are MR).
3. **Drop the five moved columns** from `strategy_runs` in one `ALTER TABLE`.
4. **Rename the seven indexes.**

**Re-runnable after a crashed boot.** drizzle's MySQL migrator records one row per migration
file, after that file's last statement, and on the next boot skips recorded files and replays
unrecorded ones whole. So the states to recover from are exactly these: all earlier new files
recorded, and the current file's statements applied up to any boundary without the file being
recorded. From every such state, a normal `applyMigrations` must complete and produce the same
schema and data as a clean run. To get there:

- Every statement is safe to execute a second time, using MariaDB's `IF EXISTS` /
  `IF NOT EXISTS` forms and `INSERT IGNORE` for the copy.
- The copy and the column drop sit in **different migration files**, so a replayed copy never
  reads dropped columns.

Statements run by hand outside the migrator, with nothing recorded, are out of scope
(builder-check call: only a crashed boot can produce a partial state in normal operation).

**Snapshot in step.** After the work, `bun run --cwd apps/server db:generate` reports nothing to
generate. How the snapshot gets there (interactive drizzle-kit rename prompts, a custom
migration, or a hand-aligned snapshot) is the builder's call.

**Pinned.** Every hand-written statement is pinned in `migration-sql.test.ts`, following the
existing 0007 and 0010 pins.

## Verification

**Do not run this branch against `st_test`.** Every DB-gated test migrates the database named in
`TEST_DATABASE_URL`, and `st_test` is shared with other checkouts and used as the dev database.
This migration is the first one older code cannot run on top of. Until the change is merged, all
DB-gated runs and the e2e smoke on this branch use a separate database on the test MariaDB
container (for example `st_test_mrsplit`), created for the purpose and dropped when the branch
is done (builder-check call).

- **Data survival test (DB-gated, own scratch database, dropped afterwards).** Bring a scratch
  database to the pre-split schema (migrations through `0012`), insert representative rows into
  `strategy_runs` (non-default pool, gaps, cut-loss, a real `state_json`) and into each of the
  ten tables, then apply the new migrations. Assert: every row is present under the new name
  with identical values and ids; each run has an `mr_runs` row carrying its five values;
  `strategy_runs` no longer has the five columns; a new insert into a renamed table continues
  the old auto-increment sequence.
- **Re-run test (DB-gated, own scratch database).** The crashed-boot property above, exercised
  for each statement boundary of each new file.
- **Join scoping test.** A `strategy_runs` row with no `mr_runs` row (a stand-in for a future VR
  run) is absent from `runRepo.list`, `get` and `getMany`.
- The existing unit suite, DB integration suite and `scripts/e2e.ts` pass unchanged in intent.
- `bun run typecheck` passes.
- No file under `apps/web/src` changes.

## Operations

- **Back up before deploying.** The migration cannot be rolled back. Add a short "before you
  deploy this version" note to `apps/server/db/README.md` with a `mariadb-dump` command for the
  production database container (`mariadb_st_prod`), using the env variable names and no secret
  values. No automatic backup is added to the server.
- **After merge.** The first DB-gated run or dev-server start on `main` migrates `st_test`
  forward. Any checkout still on a pre-split commit then fails on missing tables until it is
  rebased or `st_test` is recreated. Say so in the same README note.
- Update `AGENTS.md` (repo map: migration range, schema note on the `mr_` prefix convention and
  which tables are shared) in the same change.

## Known seams for piece 2 (recorded, not built here)

These work today because every run is an MR run. Piece 2 must handle them when VR rows appear:

- The notice feed names a notice's run through `runRepo.getMany`; a VR run's notices would look
  like notices for a deleted run until a shared run reader exists.
- `runRepo.updateStatus / updateStatusMany` write by id without checking the strategy.
- The capture-image sweep decides when a screenshot can be discarded by looking at
  `mr_pending_fills`; VR pending rows will live elsewhere.
- Run names are unique across all strategies, because the unique index is on `strategy_runs`.
- `GET /api/runs` and the web runs list show MR runs only.

## Left to the builder

- How the migration is split into files, within the rules above.
- Whether `repos.ts` (259 lines today) is split to stay under the ~300-line convention, and
  where the MR run queries live.
- How the drizzle snapshot is brought in step.
- Fixture and helper design for the new DB tests.
- Exact wording of the README backup note.
