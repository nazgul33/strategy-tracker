# MR Table Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the ten mean-reversion tables to `mr_*`, move the mean-reversion run fields off `strategy_runs` into a new `mr_runs`, and keep every behaviour, API shape and row of data exactly as it is.

**Architecture:** Three hand-written, re-runnable MariaDB migration files (rename, create-and-copy, drop columns). The repository interfaces do not change: `runRepo` reads become an inner join of `strategy_runs` with `mr_runs`, so mean-reversion code sees mean-reversion runs only. Nothing above the `db/` layer changes behaviour.

**Tech Stack:** Bun, TypeScript, drizzle-orm 0.44 (mysql2), drizzle-kit 0.30, MariaDB 11.

**Spec:** `docs/superpowers/specs/2026-11-24-mr-table-split-design.md`

## Global Constraints

- Work only in the worktree `/Users/nazgul33/.local/share/opencode/worktree/c34a7d/mr-table-split`, branch `refactor/mr-table-split`. Run commands from the worktree root unless a step says otherwise (`applyMigrations` resolves the migrations folder from the current directory).
- **Never run anything against `st_test`.** Every DB-gated command on this branch uses `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_mrsplit`.
- **Never touch production.** The containers `mariadb_st_prod` (port 3308) and `stratagy_tracker_prod` run on this machine. Do not connect to, restart, or deploy to them.
- Migration files `0000`–`0012` and their snapshots are never edited.
- Every statement in the new migration files is safe to execute twice (`IF EXISTS` / `IF NOT EXISTS` / `INSERT IGNORE`). The copy into `mr_runs` and the column drop are in different files.
- `apps/server/src/domain/repo-types.ts` does not change: repository interfaces and row shapes stay as they are.
- No file under `apps/web/src` changes.
- If a file under `apps/server/src/{domain,pipeline,wire,http,sim,market}` or `packages/` needs more than an import or identifier touch-up, stop and report it; the design has been misread.
- No source file over ~300 lines.
- English only in code, comments and commit messages; no Hanzi or Cyrillic characters.
- Commit style: `feat|fix|docs|test|refactor|chore:`.

## Review Focus

1. **Journal timestamps out of order.** drizzle skips any migration whose journal `when` is not greater than the last applied one, so a new file with a stale `when` is silently never run on a database that already has `0012`. Expected: the three new files always run. Pinned in Task 1 (journal test).
2. **Second boot after a finished migration.** Expected: a no-op, same schema, no error. Pinned in Task 1 (fresh-database test).
3. **Runs that are paused or closed.** Expected: their pool, gaps, cut-loss and state move to `mr_runs` exactly like active ones. Pinned in Task 1 (seed has all three statuses).
4. **Run order.** `runRepo.list()` has no `ORDER BY` today and returns rows in id order; a join can change that and reorder the morning digests. Expected: ascending id. Pinned in Task 2 (run-scope test).
5. **A server that died between two migration files.** Expected: the next boot continues from the next file. Pinned in Task 1 (crash-replay scenarios with zero statements of a file applied).

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/server/db/migrations/0013_mr_rename_tables.sql` (create) | rename ten tables and seven indexes |
| `apps/server/db/migrations/0014_mr_runs.sql` (create) | create `mr_runs`, copy from `strategy_runs` |
| `apps/server/db/migrations/0015_strategy_runs_trim.sql` (create) | drop the five moved columns |
| `apps/server/db/migrations/meta/*` (generated, then `0015_snapshot.json` aligned) | drizzle journal and snapshots |
| `apps/server/db/README.md` (modify) | backup-before-deploy and after-merge notes |
| `apps/server/test/mr-split-fixture.ts` (create) | scratch-database, seed and dump helpers for the migration tests |
| `apps/server/test/db-mr-split.test.ts` (create) | data survival, fresh database, crash replay |
| `apps/server/test/migration-sql.test.ts` (modify) | pins for the new SQL and the journal order |
| `apps/server/src/db/schema.ts` (modify) | new table names, `mrRuns`, trimmed `strategyRuns` |
| `apps/server/src/db/repos-mr-runs.ts` (create) | `runRepo` and `bucketRepo` (run row join, state load/save) |
| `apps/server/src/db/repos.ts`, `repos-sim.ts`, `repos-vision.ts` (modify) | follow renamed schema identifiers |
| `apps/server/test/db-run-scope.test.ts` (create) | join scoping, list order, where writes land |
| `apps/server/test/{db,db-capture,db-vision-review,db-sim-list,db-migration-0007,db-migration-0010}.test.ts`, `vision-review-fixture.ts` (modify) | raw SQL and type imports follow the new names |
| `AGENTS.md` (modify) | repo map and the prefix convention |

---

### Task 1: Migration files and their tests

**Files:**
- Create: `apps/server/db/migrations/0013_mr_rename_tables.sql`, `0014_mr_runs.sql`, `0015_strategy_runs_trim.sql` (+ generated `meta/` entries)
- Create: `apps/server/test/mr-split-fixture.ts`, `apps/server/test/db-mr-split.test.ts`
- Modify: `apps/server/test/migration-sql.test.ts`, `apps/server/db/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the three migration files; `mr-split-fixture.ts` exports (used only by `db-mr-split.test.ts`):

```ts
export const PRE_SPLIT_COUNT = 13            // migrations 0000..0012
export const RENAMES: readonly (readonly [from: string, to: string])[]                 // the ten pairs below
export const INDEX_RENAMES: readonly (readonly [table: string, from: string, to: string])[]  // the seven below
export const MOVED_COLUMNS = ['pool_cents', 'buy_gap_ppm', 'sell_gap_ppm', 'cut_loss_ppm', 'state_json'] as const
export type ScratchDb = Awaited<ReturnType<typeof getDb>>
export function allMigrations(): MigrationMeta[]                                       // readMigrationFiles on apps/server/db/migrations
export function migrateThrough(db: ScratchDb, count: number): Promise<void>            // applies AND records the first `count` files
export function withScratch<T>(tag: string, fn: (db: ScratchDb) => Promise<T>): Promise<T>
export function rows(db: ScratchDb, q: string): Promise<Record<string, unknown>[]>
export function seedPreSplit(db: ScratchDb): Promise<void>
export function dumpSchema(db: ScratchDb): Promise<Record<string, string>>
export function dumpData(db: ScratchDb): Promise<Record<string, unknown[]>>
```

While this task is in progress and until Task 2 lands, the rest of the DB-gated suite is expected to fail (old `schema.ts` against renamed tables). Run only the files named in each step.

- [ ] **Step 1: Create the branch test database**

```bash
docker exec st-mariadb-test mariadb -uroot -ptest -e "CREATE DATABASE IF NOT EXISTS st_test_mrsplit"
export TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_mrsplit
```

- [ ] **Step 2: Write the failing SQL pins in `migration-sql.test.ts`** (append; leave the existing describes alone)

Add `describe('mr split migrations')` with these tests. Split each file on `--> statement-breakpoint` and trim, as the existing tests do.

- `journal timestamps strictly increase`: every entry of `meta/_journal.json` has `when` greater than the entry before it, and the last three tags are `0013_mr_rename_tables`, `0014_mr_runs`, `0015_strategy_runs_trim`.
- `0013 renames ten tables in one statement, then seven indexes`: exactly 8 statements. Statement 0 starts with ``RENAME TABLE IF EXISTS`` and contains each ``` `from` TO `to` ``` pair. Statements 1–7 each equal ``ALTER TABLE `<table>` RENAME INDEX IF EXISTS `<from>` TO `<to>`;`` for one index pair.
- `0014 creates mr_runs and copies with INSERT IGNORE`: exactly 2 statements. Statement 0 starts with ``CREATE TABLE IF NOT EXISTS `mr_runs` ``. Statement 1 starts with ``INSERT IGNORE INTO `mr_runs` `` and contains ``FROM `strategy_runs` ``.
- `0015 drops the five moved columns in one statement`: exactly 1 statement, starting with ``ALTER TABLE `strategy_runs` ``, containing ``DROP COLUMN IF EXISTS `<col>` `` for each of the five columns.
- `no new file both copies into mr_runs and drops a column`.

Table pairs: `pool_edits`, `buckets`, `orders`, `fills`, `ledger`, `pending_fills`, `fill_corrections`, `vision_reviews`, `sim_runs`, `sim_days`, each to `mr_<name>`.

Index pairs (table after rename, old name, new name = `mr_` + old):

| Table | Old index |
| --- | --- |
| `mr_orders` | `orders_run_trade_date_idx` |
| `mr_orders` | `orders_trade_date_idx` |
| `mr_vision_reviews` | `vision_reviews_pending_fill_unique` |
| `mr_vision_reviews` | `vision_reviews_capture_idx` |
| `mr_fill_corrections` | `fill_corrections_fill_idx` |
| `mr_sim_runs` | `sim_runs_draft_created_idx` |
| `mr_sim_days` | `sim_days_sim_run_trade_idx` |

- [ ] **Step 3: Run the pins to see them fail**

Run: `bun test apps/server/test/migration-sql.test.ts`
Expected: the five new tests FAIL (no `0013_*` file); the existing ones PASS.

- [ ] **Step 4: Generate the three empty migrations**

```bash
cd apps/server
bunx drizzle-kit generate --custom --name=mr_rename_tables
bunx drizzle-kit generate --custom --name=mr_runs
bunx drizzle-kit generate --custom --name=strategy_runs_trim
cd ../..
```

Expected: `0013_mr_rename_tables.sql`, `0014_mr_runs.sql`, `0015_strategy_runs_trim.sql`, snapshots `0013`–`0015`, and three new journal entries. The snapshots are copies of `0012` for now; Task 2 aligns the last one. These commands ask no questions; if one prompts, stop and report.

- [ ] **Step 5: Write the SQL** (replace each generated file's whole content; statements separated by `--> statement-breakpoint` as in the existing files)

`0013_mr_rename_tables.sql`: one `RENAME TABLE IF EXISTS` listing all ten pairs, then the seven `ALTER TABLE ... RENAME INDEX IF EXISTS ... TO ...;` statements in the table order above.

`0014_mr_runs.sql`:

```sql
CREATE TABLE IF NOT EXISTS `mr_runs` (
	`run_id` int NOT NULL,
	`pool_cents` int NOT NULL,
	`buy_gap_ppm` int NOT NULL DEFAULT 0,
	`sell_gap_ppm` int NOT NULL DEFAULT 0,
	`cut_loss_ppm` int NOT NULL DEFAULT 0,
	`state_json` text NOT NULL,
	CONSTRAINT `mr_runs_run_id` PRIMARY KEY(`run_id`)
);
--> statement-breakpoint
INSERT IGNORE INTO `mr_runs` (`run_id`, `pool_cents`, `buy_gap_ppm`, `sell_gap_ppm`, `cut_loss_ppm`, `state_json`)
SELECT `id`, `pool_cents`, `buy_gap_ppm`, `sell_gap_ppm`, `cut_loss_ppm`, `state_json` FROM `strategy_runs`;
```

`0015_strategy_runs_trim.sql`: one `ALTER TABLE `strategy_runs`` with five comma-separated `DROP COLUMN IF EXISTS` clauses.

- [ ] **Step 6: Run the pins to see them pass**

Run: `bun test apps/server/test/migration-sql.test.ts`
Expected: all PASS.

- [ ] **Step 7: Write `mr-split-fixture.ts`**

Decisions the signatures do not carry:

- `withScratch` follows `db-vision-janitor.test.ts`: database name `st_mrsplit_<tag>_<Date.now() base36>_<pid base36>`, validated against `/^st_mrsplit_[a-z0-9_]+$/` before use, created from `TEST_DATABASE_URL`, always dropped in `finally`, both pools ended.
- `migrateThrough` calls drizzle's own recorder, so files are recorded exactly as a real boot records them: `db.dialect.migrate(allMigrations().slice(0, count), db.session, { migrationsFolder })` (both members are internal; cast).
- `seedPreSplit` uses **raw SQL only** (it must keep working after `schema.ts` changes) against the pre-split schema, and sets **every timestamp column explicitly**, so two seeded databases are identical. It inserts:
  - three `strategy_runs` rows, one per status (`active`, `paused`, `closed`). The active one has `pool_cents 1234500`, `cost_ppm 70`, `buy_gap_ppm 10000`, `sell_gap_ppm 20000`, `cut_loss_ppm 150000` and `state_json` `{"buckets":[{"index":0,"state":"held","shares":3,"buyPrice":"512300","buyFeeCents":2,"filledOn":"2026-02-10"}],"cashCents":1080810,"closed":[],"ages":{"0":4}}`. The other two keep the gap and cut-loss defaults.
  - at least two rows in each of the ten tables in `RENAMES`, with every nullable column non-null in at least one row;
  - three `fills` rows, then deletes the one with the highest id (auto-increment continuity check);
  - one `captures` row.
- `dumpSchema` returns `SHOW CREATE TABLE` text per table of the current database, with `AUTO_INCREMENT=<n>` removed, excluding `__drizzle_migrations`.
- `dumpData` returns `SELECT *` per table ordered by its first column, excluding `__drizzle_migrations`.

- [ ] **Step 8: Write the failing tests in `db-mr-split.test.ts`**

Gate with `process.env.TEST_DATABASE_URL ? describe : describe.skip`. Give every test a 120 s timeout. Each test gets its own `withScratch` database.

`existing rows survive under the new names`:
1. `migrateThrough(db, PRE_SPLIT_COUNT)`, `seedPreSplit(db)`.
2. Record `before[from] = rows('SELECT * FROM <from> ORDER BY id')` for each pair and `runsBefore = rows('SELECT * FROM strategy_runs ORDER BY id')`.
3. `applyMigrations(db)` (the real boot path).
4. Assert, for each pair: `rows('SELECT * FROM <to> ORDER BY id')` equals `before[from]`, and `SHOW TABLES LIKE '<from>'` is empty.
5. Assert `rows('SELECT * FROM mr_runs ORDER BY run_id')` equals `runsBefore` mapped to `{ run_id: id, pool_cents, buy_gap_ppm, sell_gap_ppm, cut_loss_ppm, state_json }` (three rows).
6. Assert `strategy_runs` rows equal `runsBefore` with the five `MOVED_COLUMNS` removed, and the sorted `SHOW COLUMNS FROM strategy_runs` field names equal sorted `['id','strategy_key','ticker','name','cost_ppm','status','created_at']`.
7. Assert, for each index triple: `SHOW INDEX FROM <table>` key names include `to` and not `from`.
8. Insert one row into `mr_fills`; its id is 4.
9. Assert the `captures` row is unchanged.

`a fresh database ends at the split schema and a second boot changes nothing`:
1. `applyMigrations(db)` on an empty scratch database.
2. Assert no table named in `RENAMES[*][0]` exists; every `RENAMES[*][1]` and `mr_runs` exist.
3. `const first = await dumpSchema(db)`; `applyMigrations(db)` again; `dumpSchema(db)` equals `first`; `SELECT COUNT(*) FROM __drizzle_migrations` equals `allMigrations().length` both times.

`a boot that died mid-migration is finished by the next boot` — one reference database plus one database per scenario:
- Reference: `migrateThrough(PRE_SPLIT_COUNT)`, `seedPreSplit`, `applyMigrations`; keep `dumpSchema` and `dumpData`.
- Scenarios `(fileIndex, k)`: `k` statements of file `fileIndex` applied by raw `db.execute` and **not** recorded, all earlier files recorded. File 13: `k = 1..8`. File 14: `k = 0..2`. File 15: `k = 0..1`. (13 scenarios.)
- Each scenario: `migrateThrough(PRE_SPLIT_COUNT)`, `seedPreSplit`, `migrateThrough(fileIndex)`, execute the first `k` statements of `allMigrations()[fileIndex].sql`, then `applyMigrations(db)`. Assert `dumpSchema` and `dumpData` equal the reference and `__drizzle_migrations` has `allMigrations().length` rows.

- [ ] **Step 9: Run them**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_mrsplit bun test apps/server/test/db-mr-split.test.ts`
Expected: all PASS (the SQL from Step 5 already exists). To see the tests bite, temporarily remove `IF EXISTS` from one index rename and confirm the crash-replay test fails, then restore it.

Also confirm no scratch database is left behind:
`docker exec st-mariadb-test mariadb -uroot -ptest -e "SHOW DATABASES LIKE 'st_mrsplit%'"` prints nothing.

Then run `bun run typecheck` and `bun test` (no database). Expected: typecheck clean, 0 fail.

- [ ] **Step 10: Add the deploy note to `apps/server/db/README.md`**

A section "Before deploying the `mr_` split (migrations 0013–0015)" saying, in this order: the migration cannot be rolled back; take a dump first with

```bash
docker exec mariadb_st_prod sh -c 'exec mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction "$MARIADB_DATABASE"' > st_db-before-mr-split.sql
```

if the server dies during the migration, start it again and it continues; and after this change reaches `main`, the first DB-gated test run or dev-server start migrates `st_test`, so any checkout on an older commit must be rebased or have `st_test` recreated.

- [ ] **Step 11: Commit**

```bash
git add apps/server/db apps/server/test/mr-split-fixture.ts apps/server/test/db-mr-split.test.ts apps/server/test/migration-sql.test.ts
git commit -m "feat: migrations that rename mean-reversion tables to mr_ and move run fields to mr_runs"
```

---

### Task 2: Schema, repositories, and the tests that name tables

**Files:**
- Modify: `apps/server/src/db/schema.ts`, `repos.ts`, `repos-sim.ts`, `repos-vision.ts`
- Create: `apps/server/src/db/repos-mr-runs.ts`, `apps/server/test/db-run-scope.test.ts`
- Modify: `apps/server/db/migrations/meta/0015_snapshot.json`
- Modify: `apps/server/test/db.test.ts`, `db-capture.test.ts`, `db-vision-review.test.ts`, `db-sim-list.test.ts`, `db-migration-0007.test.ts`, `db-migration-0010.test.ts`, `vision-review-fixture.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: the migrations from Task 1.
- Produces:
  - schema exports `strategyRuns` (trimmed), `mrRuns`, `mrPoolEdits`, `mrBuckets`, `mrOrders`, `mrFills`, `mrLedger`, `mrPendingFills`, `mrFillCorrections`, `mrVisionReviews`, `mrSimRuns`, `mrSimDays`; shared exports `captures`, `captureImages`, `notifications`, `settings`, `priceHistory`, `barCoverage` unchanged.
  - `getMrRunRepos(db: Db): { runRepo: RunRepo; bucketRepo: { loadState(runId: number): Promise<RunState>; saveState(runId: number, state: RunState): Promise<void>; saveStateWithOrders(runId: number, state: RunState, orders: NewOrder[]): Promise<void> } }` in `repos-mr-runs.ts`.
  - `getRepos(db)` returns the same keys as today.

- [ ] **Step 1: Write the failing test `db-run-scope.test.ts`** (DB-gated, on `TEST_DATABASE_URL`, `applyMigrations` in `beforeAll` and the `selectRows` helper as in `db-migration-0007.test.ts`)

```ts
test('a strategy_runs row without an mr_runs row is invisible to runRepo', async () => {
  const uniq = Date.now()
  const mrId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'SC' + uniq, name: 'scope-mr-' + uniq, poolCents: 1000, costPpm: 10 })
  const [res] = await db.execute(sql`INSERT INTO strategy_runs (strategy_key, ticker, name, cost_ppm) VALUES ('value-rebalancing', 'TQQQ', ${'scope-vr-' + uniq}, 10)`) as unknown as [{ insertId: number }, unknown]
  const otherId = res.insertId
  try {
    expect(await repos.runRepo.get(otherId)).toBeNull()
    expect((await repos.runRepo.getMany([mrId, otherId])).map((r) => r.id)).toEqual([mrId])
    expect((await repos.runRepo.list()).some((r) => r.id === otherId)).toBe(false)
  } finally {
    await db.execute(sql`DELETE FROM strategy_runs WHERE id = ${otherId}`)
  }
})

test('list returns runs in ascending id order', async () => {
  const ids = (await repos.runRepo.list()).map((r) => r.id)
  expect(ids).toEqual([...ids].sort((a, b) => a - b))
})

test('create writes both tables; pool and order shaping land in mr_runs; a run row keeps every field', async () => {
  const uniq = Date.now()
  const id = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'SW' + uniq, name: 'scope-w-' + uniq, poolCents: 5000, costPpm: 33, buyGapPpm: 1, sellGapPpm: 2, cutLossPpm: 3 })
  await repos.runRepo.updatePool(id, 7000)
  await repos.runRepo.updateOrderShaping(id, { buyGapPpm: 11, sellGapPpm: 12, cutLossPpm: 13 })
  expect(await selectRows(sql`SELECT pool_cents, buy_gap_ppm, sell_gap_ppm, cut_loss_ppm FROM mr_runs WHERE run_id = ${id}`))
    .toEqual([{ pool_cents: 7000, buy_gap_ppm: 11, sell_gap_ppm: 12, cut_loss_ppm: 13 }])
  const row = (await repos.runRepo.get(id))!
  expect(Object.keys(row).sort()).toEqual(['buyGapPpm', 'costPpm', 'createdAt', 'cutLossPpm', 'id', 'name', 'poolCents', 'sellGapPpm', 'stateJson', 'status', 'strategyKey', 'ticker'])
  expect(row).toMatchObject({ id, strategyKey: 'mean-reversion', poolCents: 7000, costPpm: 33, buyGapPpm: 11, sellGapPpm: 12, cutLossPpm: 13, status: 'active' })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_mrsplit bun test apps/server/test/db-run-scope.test.ts`
Expected: FAIL (old schema against the migrated database).

- [ ] **Step 3: Update `schema.ts`**

- Rename the ten table names and their exported identifiers as listed under Interfaces. Rename the seven index names to their `mr_` forms. `captures_run_hash_unique` stays.
- Trim `strategyRuns` to `id`, `strategyKey`, `ticker`, `name`, `costPpm`, `status`, `createdAt`.
- Add `mrRuns`: `runId: int('run_id').primaryKey()`, `poolCents` (`int`, not null), `buyGapPpm` / `sellGapPpm` / `cutLossPpm` (`int`, not null, default 0), `stateJson` (`text`, not null).

- [ ] **Step 4: Move the run and state repositories into `repos-mr-runs.ts`**

Move `serializeState`, `StoredBucket`, `StoredClosed`, `saveStateWith`, `runRepo` and `bucketRepo` out of `repos.ts` into `getMrRunRepos(db)`; `getRepos` takes them from it and returns the same keys as before. Behaviour to implement:

- `list / get / getMany` select from `strategyRuns` **inner join** `mrRuns` on `mrRuns.runId = strategyRuns.id`, returning an object with exactly the `RunRow` keys, in this order: `id, strategyKey, ticker, name, poolCents, costPpm, buyGapPpm, sellGapPpm, cutLossPpm, status, stateJson, createdAt`. `list` adds `orderBy(strategyRuns.id)`.
- `create`, in one transaction: insert `strategyRuns` (`strategyKey, ticker, name, costPpm`), then `mrRuns` (`runId`, `poolCents`, the three ppm values defaulting to 0, `stateJson`), then the bucket rows when `initialRunState` is given, exactly as today.
- `updatePool` and `updateOrderShaping` update `mrRuns` by `runId`.
- `updateStatus` and `updateStatusMany` update `strategyRuns`, unchanged.
- `saveStateWith` writes `mrRuns.stateJson`; `loadState` reads it.

- [ ] **Step 5: Follow the renamed identifiers** in `repos.ts`, `repos-sim.ts`, `repos-vision.ts` and `apps/server/test/vision-review-fixture.ts` (`pendingFills` type import becomes `mrPendingFills`). No query logic changes.

- [ ] **Step 6: Update raw SQL in the DB tests**

| File | Change |
| --- | --- |
| `db.test.ts` | `UPDATE fills` → `UPDATE mr_fills` |
| `db-capture.test.ts` | `FROM pending_fills` → `FROM mr_pending_fills` |
| `db-vision-review.test.ts` | `from pending_fills` → `from mr_pending_fills` |
| `db-sim-list.test.ts` | both `UPDATE sim_runs` → `UPDATE mr_sim_runs` |
| `db-migration-0007.test.ts` | both `UPDATE sim_runs` → `UPDATE mr_sim_runs`; the replayed backfill keeps being found by its original regex in the `0007` file, then runs as ``backfill!.replace('`sim_runs`', '`mr_sim_runs`')`` |
| `db-migration-0010.test.ts` | `SHOW INDEX FROM mr_sim_days`; expect `mr_sim_days_sim_run_trade_idx` to cover `['sim_run_id','trade_date']` and `sim_days_sim_run_idx` to stay absent; both `FROM orders` → `FROM mr_orders`; the replayed backfill runs as ``backfill!.replace('`orders`', '`mr_orders`')`` |

Leave `strategy_runs`, `captures` and `capture_images` statements alone.

- [ ] **Step 7: Align the last drizzle snapshot with `schema.ts`**

```bash
cd apps/server && bun -e "
import { generateMySQLDrizzleJson } from 'drizzle-kit/api'
import * as s from './src/db/schema'
const path = './db/migrations/meta/0015_snapshot.json'
const old = await Bun.file(path).json()
const cur = await generateMySQLDrizzleJson(s)
await Bun.write(path, JSON.stringify({ version: cur.version, dialect: cur.dialect, id: old.id, prevId: old.prevId, tables: cur.tables, views: cur.views, _meta: { schemas: {}, tables: {}, columns: {} }, internal: cur.internal }, null, 2))
" && bun run db:generate < /dev/null; cd ../..
git status --short apps/server/db
```

Expected: `db:generate` prints `No schema changes, nothing to migrate`, and `git status` shows only `0015_snapshot.json` modified. If it asks a rename question or writes a `0016_*` file, the snapshot or `schema.ts` is wrong: delete what it wrote (and its journal entry) and fix the mismatch.

- [ ] **Step 8: Run everything**

```bash
bun run typecheck
bun test
TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_mrsplit bun test
```

Expected: typecheck clean; both test runs report 0 fail.

- [ ] **Step 9: Update `AGENTS.md`**

- Repo map: add `db/repos-mr-runs.ts`; migrations range ends at `0015_strategy_runs_trim.sql`; test list gains `db-mr-split`, `db-run-scope` and the fixture `mr-split-fixture.ts`.
- Test matrix paragraph: add `st_mrsplit_*` (from `db-mr-split.test.ts`) to the scratch databases the DB suite creates and drops.
- Drizzle migrations bullet: `0013`–`0015` are hand-written and pinned in `migration-sql.test.ts`.
- Conventions: add "Strategy-specific tables carry a prefix (`mr_` mean reversion; `vr_` and `ib_` reserved). Shared tables: `strategy_runs`, `captures`, `capture_images`, `notifications`, `settings`, `price_history`, `bar_coverage`. `runRepo` joins `mr_runs`, so it returns mean-reversion runs only."

- [ ] **Step 10: Commit**

```bash
git add -A apps/server AGENTS.md
git commit -m "refactor: read and write mean-reversion data through mr_ tables and mr_runs"
```

---

### Task 3: Whole-branch verification

**Files:** none (fix forward in the owning task's files if a check fails).

**Interfaces:** Consumes Tasks 1 and 2. Produces a report.

- [ ] **Step 1: Run the end-to-end smoke**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_mrsplit bun scripts/e2e.ts`
Expected: exits 0.

- [ ] **Step 2: Check what the branch touched**

```bash
git diff --stat main -- apps/web packages apps/server/src/domain apps/server/src/pipeline apps/server/src/wire apps/server/src/http apps/server/src/sim apps/server/src/market
git diff --stat main -- apps/server/db/migrations | grep -E "00(0[0-9]|1[0-2])_" 
wc -l apps/server/src/db/*.ts apps/server/test/mr-split-fixture.ts apps/server/test/db-mr-split.test.ts
```

Expected: the first command prints nothing; the second prints nothing; no file in the third is over ~300 lines.

- [ ] **Step 3: Check no scratch database is left and `st_test` was never migrated**

```bash
docker exec st-mariadb-test mariadb -uroot -ptest -e "SHOW DATABASES LIKE 'st_mrsplit%'; SHOW DATABASES LIKE 'st_e2e%'; SELECT COUNT(*) AS mr_tables_in_st_test FROM information_schema.tables WHERE table_schema = 'st_test' AND table_name LIKE 'mr\_%'"
```

Expected: no scratch databases; `mr_tables_in_st_test` is 0.

- [ ] **Step 4: Report**

State the results of Steps 1–3 and of Task 2 Step 8. Leave `st_test_mrsplit` in place (it is dropped after the branch is merged) and do not deploy.
