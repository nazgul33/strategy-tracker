# Notice and digest follow-ups (#89, #90, #91, #92, #76) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The digest's "⚠️ N unconfirmed orders" line names every stale order exactly once, the reads behind that line and the System notices feed stop scanning whole tables, every "could not read fills" reply is recorded and never throws out of the photo handler, and a notice whose run is gone stays readable.

**Architecture:** Migration 0010 adds `orders.reported_at` (with a backfill for orders already stale) and swaps the `sim_days` index for a composite one. The morning pipeline reads "this run's stale orders with no `reported_at`" inside the run lock and stamps them after the digest broadcast, but only when `broadcastNotice` reports at least one recorded row. The feed route asks `runRepo.getMany` for just the run ids on the page. The three capture replies go through `broadcastNotice` with the asking chat as the only chat. The web panel renders a run-linked entry with `ticker === null` like a global notice.

**Tech Stack:** Bun + TypeScript, Hono, Drizzle + drizzle-kit (MariaDB 11), React + Tailwind, `bun:test` + happy-dom.

**Spec:** `docs/superpowers/specs/2026-11-23-notice-followups-design.md` (issues #89, #90, #91, #92, #76; read them with `gh issue view <n>`)

## Global Constraints

- Work only in this worktree (branch `fix/issues-89-92`). Run every command from the worktree root.
- Exactly one new migration, `0010`, produced by `bun run --cwd apps/server db:generate` plus one hand-appended statement. Never write a migration SQL file or a `meta/` snapshot by hand.
- Backfill, verbatim (drizzle quoting): ``UPDATE `orders` SET `reported_at` = NOW() WHERE `status` = 'stale';``
- New index: `sim_days_sim_run_trade_idx` on `(sim_run_id, trade_date)`; the old `sim_days_sim_run_idx` is dropped. No new index on `orders` (`orders_run_trade_date_idx` narrows by run).
- No `kind` column on `notifications`; the feed's grouping and paging are unchanged. No run deletion feature. No splitting of oversized test files.
- No new user-facing copy: `packages/telegram/src/i18n.ts` and `apps/web/src/i18n/{en,ko}.json` are not edited. The capture reply keeps the `capture-bad-extract` copy and the literal detail `no fills recognized`.
- `apps/server/src/pipeline/day.ts` keeps its `plan.notices.push({ code: 'unconfirmed', params: { count, date } })` line: `apps/web/src/catalog.test.ts` reads it from source. `count` = number of rows, `date` = oldest `tradeDate`.
- New tests go in new or small files. `apps/server/test/wire.test.ts` (1031 lines) gets only the lines Task 2 needs to typecheck.
- Money stays bigint myriadths; English only in code and comments (Korean only in catalog values and in test expectations of catalog output); never Chinese or Cyrillic characters.
- No source file over ~300 lines. Today: `apps/server/src/wire/capture.ts` 291, `apps/server/test/http-fakes.ts` 258, `apps/server/src/db/repos.ts` 249.
- Commit style `feat|fix|docs|test|refactor|chore:`.
- `bun test` and `bun run typecheck` both pass at the end of every task. Baseline before Task 1: 1661 pass, 72 skip, 0 fail.
- DB-backed tests self-skip without `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test`. The container `st-mariadb-test` was running when this plan was written (MariaDB 11.8). If it is not reachable, do **not** start or create it: stop and report.
- `st_test` is a shared, long-lived database. Once a DB-suite run has applied 0010 to it, a regenerated 0010 (new timestamp) would be applied a second time and fail on `DROP INDEX`. Generate 0010 once, append the backfill before the first DB-suite run that follows, and never delete or regenerate the file afterwards. If that seems necessary, stop and report. Other checkouts sharing `st_test` keep working once 0010 is applied (one extra nullable column, one index swapped).

## Decisions (the spec's "left to the builder" items)

- Repo method names: `orderRepo.listUnreportedStale(runId)`, `orderRepo.markReported(ids)`, `runRepo.getMany(ids)`.
- `OrderRecord` gains a required `reportedAt: string | null` (the real `select()` returns the column anyway). The web `OrderDto` is not touched; the extra JSON field is ignored.
- `RepoSurface.orderRepo` stays the full `OrderRepo`, so every `OrderRepo` fake gains the two methods: `http-fakes.ts`, `booking-fakes.ts`, `day.test.ts`, `wire.test.ts`.
- `RepoSurface.runRepo` keeps its pick unchanged: the feed route reads `HttpRepoSurface.runRepo`, which is already the full `RunRepo`, so only `http-fakes.ts` gains `getMany`.
- `broadcastNotice` resolves to `NoticeResult = { failed: number; recorded: number }`. `recorded` counts notification rows written, the web-only row included. `runReminder` and `runDecemberNudge` keep resolving to exactly `{ failed }`.
- The mark runs after the digest broadcast, outside the run lock, in its own `try`. A failure logs `console.error('mark reported failed:', { runId, ticker }, String(e))`; the run still counts as completed and gets no warning.
- `markReported` stamps the database clock (`now()`); the fakes stamp `FAKE_CREATED_AT`. `listUnreportedStale` returns lowest id first.
- The `stale` roll map is no longer threaded through `processRun` / `planRun`; `rollStale` still runs and its failure is still logged as `stale roll failed:`.
- Capture: one inner helper `tellBadExtract(chatId, detail)` in `makeCaptureHandlers`. Two of the three replies cannot be reached through the handlers (see Task 5), so their wiring is pinned on the source, as `main-boot-order.test.ts` does.
- The feed route always calls `getMany` with the page's distinct run ids (possibly empty); the repo runs no query for an empty list.
- Web: an entry is rendered inline (expand button) when `runId === null || ticker === null`.
- Test placement: `day-unconfirmed.test.ts` (pipeline), new `capture-replies.test.ts`, new `db-migration-0010.test.ts` and `db-order-reporting.test.ts`, existing `db-notifications.test.ts` (`getMany`), `http-notifications.test.ts`, `broadcast.test.ts`, `SystemNotices.test.tsx`.

## Review Focus

1. A web-only operator (no Telegram chat), or a morning when Telegram refuses every send: the digest row is still written, so the orders it names must be marked and must not come back every morning. Pinned in Task 3.
2. The first morning after deploy: orders already stale before the migration are not listed, while an order that was still open at deploy and turns stale afterwards is. Pinned in Tasks 1 and 2.
3. The digest could not be recorded for any chat, or the mark write fails: the orders are named again the next morning together with the newer ones, the run still counts as completed, and no "Morning pipeline error" warning is sent. Pinned in Task 3.
4. Telegram refuses the "could not read fills" reply, or the database refuses its row: the photo handler resolves, the other half still happens, and the reply goes only to the chat that sent the photo even when other chats are allowed. Pinned in Task 5.
5. A notice whose run is gone, shown between normal rows: it expands on its own (the other rows stay collapsed), a run that exists keeps its link, and the feed asks only for the runs on the page, giving `ticker: null` for an unknown run id. Pinned in Tasks 4 and 6.

---

## File Structure

| File | Responsibility in this plan |
| --- | --- |
| `apps/server/src/db/schema.ts`, `apps/server/db/migrations/0010_*.sql` (+ `meta/`) | `orders.reported_at`, backfill, `sim_days` composite index |
| `apps/server/src/domain/repo-types.ts`, `apps/server/src/db/repos.ts` | `OrderRecord.reportedAt`, `listUnreportedStale`, `markReported`, `getMany` |
| `apps/server/src/wire/broadcast.ts` | `NoticeResult` with the `recorded` count |
| `apps/server/src/pipeline/day.ts` | unconfirmed line from unreported stale orders; mark after a recorded digest |
| `apps/server/src/http/routes/notifications.ts` | ticker lookup through `getMany` |
| `apps/server/src/wire/capture.ts` | `tellBadExtract`: the three "could not read fills" replies through `broadcastNotice` |
| `apps/web/src/components/SystemNotices.tsx` | inline expand for a run-linked entry with no ticker |
| `apps/server/test/{http-fakes,booking-fakes}.ts`, `day.test.ts`, `wire.test.ts` | fakes follow the widened `OrderRepo` / `RunRepo` / `OrderRecord` |

---

### Task 1: Migration 0010 — `orders.reported_at` with backfill, `sim_days` composite index (#91, #76)

**Files:**
- Modify: `apps/server/src/db/schema.ts:39-53` (`orders`), `:193-202` (`simDays`)
- Create (generated): `apps/server/db/migrations/0010_<generated-name>.sql`, `apps/server/db/migrations/meta/0010_snapshot.json`
- Modify (generated): `apps/server/db/migrations/meta/_journal.json`
- Modify: `apps/server/test/migration-sql.test.ts`
- Create: `apps/server/test/db-migration-0010.test.ts`
- Modify: `AGENTS.md:39` (migration list ends at the new file name), `AGENTS.md:61` (one sentence, Step 6)

**Interfaces:**
- Consumes: nothing.
- Produces: drizzle column `s.orders.reportedAt` (`timestamp('reported_at', { mode: 'string' })`, nullable, no default; selected as `string | null`). Index `sim_days_sim_run_trade_idx` on `(sim_run_id, trade_date)`. No TypeScript interface changes in this task: `OrderRecord` gains its field in Task 2.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/migration-sql.test.ts` — add a describe (own `migrationsDir`, as the two existing ones) and change the index list:

```ts
// The backfill in 0010 is hand-appended, like 0007's: regenerating the migration drops it,
// and without it the first digest after deploy names every order that ever went stale.
describe('migration 0010 SQL', () => {
  test('there is exactly one 0010 migration', () => {
    expect([...new Bun.Glob('0010_*.sql').scanSync({ cwd: migrationsDir })]).toHaveLength(1)
  })

  test('marks every already-stale order as reported, after the column exists', async () => {
    const [file] = [...new Bun.Glob('0010_*.sql').scanSync({ cwd: migrationsDir })].sort()
    expect(file).toBeDefined()
    const chunks = (await Bun.file(migrationsDir + file).text()).split('--> statement-breakpoint').map((c) => c.trim())
    const add = chunks.findIndex((c) => /ALTER TABLE `orders` ADD `reported_at` timestamp;/.test(c))
    const backfill = chunks.findIndex((c) => /UPDATE\s+`orders`\s+SET\s+`reported_at`\s*=\s*NOW\(\)\s+WHERE\s+`status`\s*=\s*'stale'/.test(c))
    expect(add).toBeGreaterThan(-1)
    expect(backfill).toBeGreaterThan(add)
  })
})
```

In `the orders and sim sweep indexes exist`, replace the `sim_days_sim_run_idx` line of `want` with these two:

```ts
/CREATE INDEX `sim_days_sim_run_trade_idx` ON `sim_days` \(`sim_run_id`,`trade_date`\)/,
/DROP INDEX `sim_days_sim_run_idx` ON `sim_days`/,
```

`apps/server/test/db-migration-0010.test.ts` — `describeIf` + `beforeAll` as in `apps/server/test/db-day-plan.test.ts:7-15`, but keep `db` in a `let` for raw SQL:

```ts
// The driver returns [rows, fields] for a SELECT.
const rowsOf = async <T>(q: string) => ((await db.execute(sql.raw(q))) as unknown as [T[], unknown])[0]
const order = (runId: number, status: OrderStatus, bucketIdx: number): NewOrder =>
  ({ runId, tradeDate: '2026-02-10', kind: 'buy_loc', bucketIdx, limitPrice: 100n, shares: 1, status })

test('sim_days is indexed on (sim_run_id, trade_date) and the single-column index is gone', async () => {
  const idx = await rowsOf<{ Key_name: string; Seq_in_index: number; Column_name: string }>('SHOW INDEX FROM sim_days')
  const cols = (name: string) => idx.filter((r) => r.Key_name === name).sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index)).map((r) => r.Column_name)
  expect(cols('sim_days_sim_run_trade_idx')).toEqual(['sim_run_id', 'trade_date'])
  expect(cols('sim_days_sim_run_idx')).toEqual([])
})

// Careful: the backfill is an unscoped UPDATE, so replaying it stamps every stale order in the
// shared test database. Safe because bun runs test files one after another and every test
// creates the rows it asserts on. Keep this the last test in the file.
test('a new order has no reported_at; the backfill stamps stale orders only', async () => {
  const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'MG', name: `mg-${Date.now()}`, poolCents: 1000, costPpm: 10 })
  await repos.orderRepo.insertMany([order(runId, 'stale', 0), order(runId, 'open', 1), order(runId, 'filled', 2), order(runId, 'cancelled', 3)])
  const flags = async () => (await rowsOf<{ reported: number }>(`SELECT reported_at IS NOT NULL AS reported FROM orders WHERE run_id = ${runId} ORDER BY bucket_idx`)).map((r) => Number(r.reported))
  expect(await flags()).toEqual([0, 0, 0, 0])
  const migrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url))
  const [file] = [...new Bun.Glob('0010_*.sql').scanSync({ cwd: migrationsDir })].sort()
  const backfill = (await Bun.file(migrationsDir + file).text()).split('--> statement-breakpoint').map((c) => c.trim()).find((c) => /UPDATE\s+`orders`\s+SET\s+`reported_at`/.test(c))
  expect(backfill).toBeDefined()
  await db.execute(sql.raw(backfill!))
  expect(await flags()).toEqual([1, 0, 0, 0])
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/migration-sql.test.ts apps/server/test/db-migration-0010.test.ts`
Expected: FAIL — no `0010_*.sql` file; `Unknown column 'reported_at'`; `cols('sim_days_sim_run_trade_idx')` is `[]`.

- [ ] **Step 3: Edit the schema**

In `orders`, after `cancelReason`: `reportedAt: timestamp('reported_at', { mode: 'string' }),`. In `simDays`, replace the index entry with `simRunTradeIdx: index('sim_days_sim_run_trade_idx').on(t.simRunId, t.tradeDate),`.

- [ ] **Step 4: Generate 0010 (once)**

Run: `bun run --cwd apps/server db:generate`
Expected: no prompt and no database connection (checked when this plan was written: it runs with no TTY), ending `Your SQL migration file ➜ db/migrations/0010_<name>.sql`. The file holds exactly these three statements:

```sql
DROP INDEX `sim_days_sim_run_idx` ON `sim_days`;--> statement-breakpoint
ALTER TABLE `orders` ADD `reported_at` timestamp;--> statement-breakpoint
CREATE INDEX `sim_days_sim_run_trade_idx` ON `sim_days` (`sim_run_id`,`trade_date`);
```

If drizzle-kit asks a question or the statements differ, stop and report; do not answer a rename prompt and do not edit the snapshot.

- [ ] **Step 5: Hand-append the backfill** to the end of the generated SQL file (after the last statement, before any DB-suite run):

```sql
--> statement-breakpoint
-- Hand-appended backfill: every order already stale before this migration counts as reported, so the first digest after deploy does not name the whole history.
UPDATE `orders` SET `reported_at` = NOW() WHERE `status` = 'stale';
```

- [ ] **Step 6: Update `AGENTS.md`** — line 39 names the new last migration file; append to the "Drizzle migrations" bullet (line 61): hand-appended statements (the backfills in 0007 and 0010) are pinned in `apps/server/test/migration-sql.test.ts`, because regenerating a migration drops them.

- [ ] **Step 7: Run to verify they pass**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/migration-sql.test.ts apps/server/test/db-migration-0010.test.ts apps/server/test/db-sim-list.test.ts && bun test && bun run typecheck`
Expected: PASS, 0 fail (`db-sim-list.test.ts` applies every migration, backfill included, to a fresh scratch database); typecheck prints no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/db/migrations apps/server/test/migration-sql.test.ts apps/server/test/db-migration-0010.test.ts AGENTS.md
git commit -m "feat: migration 0010 with orders.reported_at, its backfill and the sim_days composite index (#91, #76)"
```

---

### Task 2: Order repo reads unreported stale orders and marks them reported (#91, orders half of #89)

**Files:**
- Modify: `apps/server/src/domain/repo-types.ts:57` (`OrderRecord`), `:61-70` (`OrderRepo`)
- Modify: `apps/server/src/db/repos.ts:100-131` (`orderRepo`; import `isNull`)
- Modify: `apps/server/test/http-fakes.ts:55-73`, `apps/server/test/booking-fakes.ts:85-105`, `apps/server/test/day.test.ts:34-43` (three stateful fakes)
- Modify: `apps/server/test/wire.test.ts:167-176` (two stub methods) and its five `OrderRecord` literals at lines 714, 910, 925, 941, 949
- Modify: `apps/server/test/repo-surface-types.test.ts` (`_orderPendingPins`)
- Create: `apps/server/test/db-order-reporting.test.ts`

**Interfaces:**
- Consumes: `s.orders.reportedAt` from Task 1.
- Produces (`apps/server/src/domain/repo-types.ts`):

```ts
export interface OrderRecord extends OrderRow { kind: OrderKind; status: OrderStatus; skipReason: string | null; cancelReason: string | null; reportedAt: string | null }

export interface OrderRepo {
  // ...existing methods unchanged
  /** The run's stale orders no recorded digest has named yet, lowest id first. */
  listUnreportedStale(runId: number): Promise<OrderRecord[]>
  /** Stamps reported_at on these orders; an empty list writes nothing. */
  markReported(ids: number[]): Promise<void>
}
```

- Fake behaviour later tasks rely on (`makeFakes()` in `http-fakes.ts`): `insertMany` stores `reportedAt: null`; `markReported` sets `reportedAt` to `FAKE_CREATED_AT` on the rows in `f.orders`; `listUnreportedStale` filters `f.orders` on `runId`, `status === 'stale'` and `reportedAt === null`.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/db-order-reporting.test.ts` — `describeIf` + `beforeAll` exactly as in `apps/server/test/db-day-plan.test.ts:7-15`:

```ts
let seq = 0
const newRun = () => repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'OR', name: `or-${Date.now()}-${seq++}`, poolCents: 1000, costPpm: 10 })
const order = (runId: number, tradeDate: string, status: OrderStatus, bucketIdx: number): NewOrder =>
  ({ runId, tradeDate, kind: 'buy_loc', bucketIdx, limitPrice: 100n, shares: 1, status })
const unreported = async (runId: number) => (await repos.orderRepo.listUnreportedStale(runId)).map((o) => [o.bucketIdx, o.tradeDate])
```

| Test name | Arrange and act | Assertions |
| --- | --- | --- |
| `listUnreportedStale returns only this run's stale orders, lowest id first` | run A: `('2026-02-09','stale',0)`, `('2026-02-10','stale',1)`, `('2026-02-10','open',2)`, `('2026-02-10','filled',3)`, `('2026-02-10','cancelled',4)`; run B: `('2026-02-10','stale',9)` | `unreported(a)` equals `[[0, '2026-02-09'], [1, '2026-02-10']]`; `unreported(b)` equals `[[9, '2026-02-10']]`; the first row of A has `reportedAt` `null` and `limitPrice` `100n` |
| `markReported stamps the orders and takes them out of the list` | run with two stale orders (buckets 0, 1); `markReported([first.id])` | `unreported` equals `[[1, '2026-02-10']]`; `typeof (await repos.orderRepo.get(first.id))!.reportedAt` is `'string'`; `(await repos.orderRepo.get(second.id))!.reportedAt` is `null` |
| `markReported with an empty list writes nothing` | run with one stale order; `await repos.orderRepo.markReported([])` | resolves; `unreported` still has 1 item |
| `an open order is not listed until it turns stale, and drops out again when it is filled` | run with `('2026-02-10','open',0)`; then `setStatus(id, 'stale')`; then `setStatus(id, 'filled')` | `unreported` is `[]`, then `[[0, '2026-02-10']]`, then `[]` |

`apps/server/test/repo-surface-types.test.ts`, in `_orderPendingPins`:

```ts
// @ts-expect-error markReported takes a list of order ids
await r.orderRepo.markReported(1)
// @ts-expect-error reportedAt is a timestamp string or null
const _ra: number = (await r.orderRepo.get(1))!.reportedAt
```

- [ ] **Step 2: Run to verify they fail**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db-order-reporting.test.ts; bun run typecheck`
Expected: FAIL — `repos.orderRepo.listUnreportedStale is not a function`; typecheck reports that `listUnreportedStale` and `markReported` do not exist on the order repo (in the new DB test).

- [ ] **Step 3: Widen the types and implement the real repo**

- `repo-types.ts`: the two changes in Interfaces.
- `db/repos.ts`: `listUnreportedStale` selects from `s.orders` where `run_id = runId`, `status = 'stale'` and `isNull(s.orders.reportedAt)`, ordered by `s.orders.id`. `markReported` returns at once for an empty list, otherwise one `update(s.orders).set({ reportedAt: sql`now()` }).where(inArray(s.orders.id, ids))`.

- [ ] **Step 4: Bring the fakes along**

- `http-fakes.ts`, `booking-fakes.ts`, `day.test.ts`: `insertMany` adds `reportedAt: null`; add

```ts
async listUnreportedStale(runId: number) { return orders.filter((o) => o.runId === runId && o.status === 'stale' && o.reportedAt === null).sort((a, b) => a.id - b.id) },
async markReported(ids: number[]) { for (const o of orders) if (ids.includes(o.id)) o.reportedAt = FAKE_CREATED_AT },
```

- `wire.test.ts`: `listUnreportedStale: async (_runId: number) => [] as OrderRecord[],` and `markReported: async (_ids: number[]) => {},` in `makeCaptureFakes`; add `reportedAt: null` to the five literals.
- `bun run typecheck` names any other literal that lacks the field: add `reportedAt: null` there.

- [ ] **Step 5: Run to verify they pass**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server && bun test && bun run typecheck`
Expected: PASS, 0 fail; typecheck prints no errors (the arity pins `_real`, `_realDay`, `_booking`, `_http`, `_day`, `_wire` cover the new methods).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/domain/repo-types.ts apps/server/src/db/repos.ts apps/server/test/http-fakes.ts apps/server/test/booking-fakes.ts apps/server/test/day.test.ts apps/server/test/wire.test.ts apps/server/test/repo-surface-types.test.ts apps/server/test/db-order-reporting.test.ts
git commit -m "feat: order repo lists unreported stale orders and marks them reported (#91, #89)"
```

---

### Task 3: The unconfirmed line names every unreported stale order once (#91, orders half of #89)

**Files:**
- Modify: `apps/server/src/wire/broadcast.ts:23-68` (result)
- Modify: `apps/server/src/pipeline/day.ts` (`notify`, `morningPipeline`, `processRun`, `planRun`, `runReminder`, `runDecemberNudge`; `unconfirmedOrders` and `StaleRoll` go away)
- Modify: `apps/server/test/broadcast.test.ts:150-178` (`describe('broadcastNotice result')`)
- Modify: `apps/server/test/day-unconfirmed.test.ts` (seed adjusted, seven tests added)
- Modify: `README.md` (after the Schedules table, Step 5), `AGENTS.md:40` (test list: `day-unconfirmed`)

**Interfaces:**
- Consumes: `listUnreportedStale`, `markReported`, `OrderRecord.reportedAt` and the `makeFakes()` behaviour from Task 2.
- Produces:

```ts
// wire/broadcast.ts
/** failed: inserts plus part sends that threw. recorded: notification rows written; 0 means no copy of the notice exists. */
export interface NoticeResult { failed: number; recorded: number }
export async function broadcastNotice<R extends number | null>(deps: BroadcastDeps<R>, runId: R, text: NoticeText, log: NoticeLog): Promise<NoticeResult>

// pipeline/day.ts
function notify(deps: DayDeps, runId: number | null, text: NoticeText, kind: string): Promise<NoticeResult>
export async function runReminder(deps: DayDeps): Promise<{ failed: number }>       // still exactly { failed }
export async function runDecemberNudge(deps: DayDeps): Promise<{ failed: number }>  // still exactly { failed }
```

- New log line: `console.error('mark reported failed:', { runId: run.id, ticker: run.ticker }, String(e))`.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/broadcast.test.ts`, `describe('broadcastNotice result')` — rename the helper `failedOf` to `resultOf` and pin the whole result:

| Test name | Call | Expected |
| --- | --- | --- |
| `all ok: every chat recorded` | `resultOf(['a', 'b'], {})` | `{ failed: 0, recorded: 2 }` |
| `one failing send still counts its row` | `resultOf(['a', 'b'], { send: ['a'] })` | `{ failed: 1, recorded: 2 }` |
| `insert and send failing for one chat` | `resultOf(['a', 'b'], { insert: ['a'], send: ['a'] })` | `{ failed: 2, recorded: 1 }` |
| `a failing web-only insert records nothing` | `resultOf([], { insert: ['web'] })` | `{ failed: 1, recorded: 0 }` |
| `one failing part of two` | `resultOf(['a', 'b'], { send: ['a:p1'] }, PARTS)` | `{ failed: 1, recorded: 2 }` |
| `no allowed chat: the web row counts` | `resultOf([], {})` | `{ failed: 0, recorded: 1 }` |
| `every insert failing records nothing even when the sends go out` | `resultOf(['a', 'b'], { insert: ['a', 'b'] })` | `{ failed: 2, recorded: 0 }` |
| `every send failing still records every row` | `resultOf(['a', 'b'], { send: ['a', 'b'] })` | `{ failed: 2, recorded: 2 }` |

`apps/server/test/day-unconfirmed.test.ts` — `seed` marks order 1 as already named (its comment says so: "one stale from 11-04 already named in an earlier digest"):

```ts
const seed = async (f: Fakes, status: OrderStatus) => {
  await f.repos.orderRepo.insertMany([
    order(1, '2026-11-04', 'stale'), order(1, '2026-11-05', status, 1), order(1, '2026-11-05', status, 2), order(1, '2026-11-05', 'filled', 3),
  ])
  await f.repos.orderRepo.markReported([1])
}
// Monday 2026-11-09: the previous trading day is Friday 2026-11-06. Each run's 11-06 buy order is still open, so it rolls stale.
const nextMorning = (deps: DayDeps, sent: string[]) => {
  deps.today = () => '2026-11-09'
  deps.fetchLastClose = async () => ({ date: '2026-11-06', close: 3402300n })
  sent.length = 0
}
const reported = (f: Fakes) => f.orders.map((o) => o.reportedAt !== null)
// Makes run 1's plan write fail; returns a function that undoes it.
function failRun1(f: Fakes) {
  const real = f.repos.bucketRepo.saveStateWithOrders
  f.repos.bucketRepo.saveStateWithOrders = async (runId, state, orders) => {
    if (runId === 1) throw new Error('db-down')
    await real(runId, state, orders)
  }
  return () => { f.repos.bucketRepo.saveStateWithOrders = real }
}
```

The three existing tests keep their assertions. Add (every test that injects a failure spies `console.error`, and `console.log` where a run is skipped, restored in `finally`; "run" means `await runMorningPipeline(deps)`; after `seed` the orders are ids 1-4, run 1's 11-06 order is id 5 and run 2's is id 6):

| Test name | Arrange and act | Assertions |
| --- | --- | --- |
| `orders named in a recorded digest are marked and not named again the next morning` | `seed(f, 'open')`; run; `nextMorning`; run | after the first run `reported(f).slice(0, 4)` equals `[true, true, true, false]`; after the second, the TSLA digest contains `'⚠️ 1 unconfirmed orders from 2026-11-06'` and does not contain `'2026-11-05'`; the AAPL digest contains `'⚠️ 1 unconfirmed orders from 2026-11-06'` |
| `after an earlier failed roll and a failed run, the retry names every unreported order (#91)` | insert `order(1, '2026-11-04', 'open')`, `order(1, '2026-11-05', 'open', 1)`, `order(1, '2026-11-05', 'open', 2)` (no `seed`); `const undo = failRun1(f)`; run; `undo()`; `sent.length = 0`; run | after the first run `f.orders.slice(0, 3).map((o) => [o.status, o.reportedAt])` equals three `['stale', null]`; second result `'sent'`; the TSLA digest contains `'⚠️ 3 unconfirmed orders from 2026-11-04'`; `reported(f).slice(0, 3)` equals `[true, true, true]` |
| `with no Telegram chat the web row counts: the orders are marked` | `deps.allowedChatIds = []`; `seed(f, 'open')`; run | `f.notifications.find((n) => n.runId === 1)!.chatId` is `'web'`; `reported(f).slice(1, 3)` equals `[true, true]` |
| `a digest every chat refused is still recorded: the orders are marked` | `deps.send = async () => { throw new Error('telegram-down') }`; `seed(f, 'open')`; run | result `'sent'`; `reported(f).slice(1, 3)` equals `[true, true]` |
| `a digest that could not be recorded leaves the orders unreported; they are named again the next morning` | `seed(f, 'open')`; `const insert = f.repos.notificationRepo.insert`; replace it with `async () => { throw new Error('db-down') }`; run; restore `insert`; `nextMorning`; run | first result `'sent'` and `reported(f).slice(1, 3)` equals `[false, false]`; the second TSLA digest contains `'⚠️ 3 unconfirmed orders from 2026-11-05'` |
| `a failed mark is logged, the run still completes, and the orders are named again the next morning` | `seed(f, 'open')`; `const mark = f.repos.orderRepo.markReported`; replace it with `async () => { throw new Error('db-down') }`; run; restore `mark`; `nextMorning`; run | after the first run: result `'sent'`; `errors` called with `'mark reported failed:', { runId: 1, ticker: 'TSLA' }, 'Error: db-down'`; no sent text starts with `'Morning pipeline error'`; `f.orders.filter((o) => o.tradeDate === '2026-11-06')` has 2 items; `reported(f).slice(1, 3)` equals `[false, false]`. After the second: the TSLA digest contains `'⚠️ 3 unconfirmed orders from 2026-11-05'` |
| `a run with nothing unconfirmed writes no mark` | no seed; wrap `f.repos.orderRepo.markReported` to push its argument into `calls` and call through; run | result `'sent'`; `calls` equals `[]` |

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/server/test/broadcast.test.ts apps/server/test/day-unconfirmed.test.ts`
Expected: FAIL — the results lack `recorded`; `reportedAt` stays `null` after a digest; the #91 retry digest reads `⚠️ 2 unconfirmed orders from 2026-11-05`; no `mark reported failed:` log. The three existing `day-unconfirmed` tests and `a run with nothing unconfirmed writes no mark` pass.

- [ ] **Step 3: Return `recorded` from `broadcastNotice`**

Count one for every insert that did not throw (the web-only row and each per-chat row); return `{ failed, recorded }` from both exits. Update the block comment above the function: the result tells a caller whether any copy of the notice was recorded.

- [ ] **Step 4: Read and mark in `day.ts`**

- `notify` returns `Promise<NoticeResult>`. `runReminder` and `runDecemberNudge` take `failed` out of that result and return `{ failed }` only (`apps/server/test/day-notices.test.ts:135-147` pins the exact shape and must stay green unchanged).
- Delete `unconfirmedOrders` and the `StaleRoll` type (and the `OrderRecord` import they needed); `processRun` and `planRun` lose their `stale` parameter. `morningPipeline` still awaits `rollStale` in its `try` (same `stale roll failed:` log) without keeping the result. Rewrite the comment above it: orders the roll could not flip stay open and are named on the morning a later roll flips them.
- Inside the run lock, where `unconfirmedOrders` was called: `const unconfirmed = await deps.repos.orderRepo.listUnreportedStale(run.id)`. The `oldest` computation and the `plan.notices.push` line stay as they are. The lock callback also returns the ids: `{ state, plan, unconfirmedIds }`.
- After the digest `notify`, outside the lock: when its `recorded > 0` and there are ids, `await deps.repos.orderRepo.markReported(unconfirmedIds)` inside its own `try`; the `catch` writes the `mark reported failed:` log (Interfaces) and nothing else. `planRun` returns `'completed'` either way.

- [ ] **Step 5: Document the line** — `README.md`, one sentence after the Schedules table: the digest's "⚠️ N unconfirmed orders from <date>" line names every order left unresolved that no recorded digest has named yet, each exactly once; if a morning's digest could not be recorded they are named again the next morning. Add `day-unconfirmed` to the test list in `AGENTS.md` (after `day-failures`).

- [ ] **Step 6: Run to verify they pass**

Run: `bun test apps/server apps/web/src/catalog.test.ts && bun test && bun run typecheck`
Expected: PASS, 0 fail — including the unchanged `day.test.ts` (f), `day-notices.test.ts` and `day-failures.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/wire/broadcast.ts apps/server/src/pipeline/day.ts apps/server/test/broadcast.test.ts apps/server/test/day-unconfirmed.test.ts README.md AGENTS.md
git commit -m "fix: the digest names every unreported stale order exactly once (#91, #89)"
```

---

### Task 4: The notice feed looks up only the runs on the page (#89, feed half)

**Files:**
- Modify: `apps/server/src/domain/repo-types.ts:102-110` (`RunRepo`)
- Modify: `apps/server/src/db/repos.ts:35-72` (`runRepo`)
- Modify: `apps/server/test/http-fakes.ts:33-54` (`runRepo` fake)
- Modify: `apps/server/src/http/routes/notifications.ts:16-19`
- Modify: `apps/server/test/repo-surface-types.test.ts` (`_runPins`)
- Test: `apps/server/test/http-notifications.test.ts`, `apps/server/test/db-notifications.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (`RunRepo`):

```ts
/** The runs with these ids, in no particular order; unknown ids are skipped; an empty list runs no query. */
getMany(ids: number[]): Promise<RunRow[]>
```

- `GET /api/notifications` keeps its response shape. `ticker` is `null` for a global notice and for a run id with no run.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/http-notifications.test.ts`:

```ts
// Rows 1-6; newest first the entries are: 6 (run 1), 5 (run 99), 4 (global), 3 (run 3), 2+1 (run 1).
async function mixedFeed() {
  const s = await setup()
  for (const ticker of ['AAPL', 'MSFT', 'NVDA']) await createRun(s.app, s.auth, { name: ticker, ticker, costPpm: 0, poolCents: 100 })
  await s.add(1, '42', 'digest'); await s.add(1, '43', 'digest'); await s.add(3, '42', 'digest')
  await s.add(null, '42', 'closed'); await s.add(99, 'web', 'orphan'); await s.add(1, '42', 'skip')
  return s
}
// Records every getMany call and makes list() throw.
function watchRuns(f: Awaited<ReturnType<typeof setup>>['f']) {
  const calls: number[][] = []
  const getMany = f.repos.runRepo.getMany
  f.repos.runRepo.getMany = async (ids) => { calls.push([...ids]); return getMany(ids) }
  f.repos.runRepo.list = async () => { throw new Error('the feed must not list every run') }
  return calls
}

test('looks up only the runs on the page, in one call, and never lists every run', async () => {
  const { f, get } = await mixedFeed()
  const calls = watchRuns(f)
  const { status, body } = await get('/api/notifications')
  expect(status).toBe(200)
  expect(body.entries.map((e: { runId: number | null; ticker: string | null }) => [e.runId, e.ticker])).toEqual([[1, 'AAPL'], [99, null], [null, null], [3, 'NVDA'], [1, 'AAPL']])
  expect(calls.map((ids) => [...ids].sort((a, b) => a - b))).toEqual([[1, 3, 99]])
})

test('a page of global notices asks for no run', async () => {
  const { f, add, get } = await setup()
  await add(null, '42', 'closed'); await add(null, '42', 'reminder')
  const calls = watchRuns(f)
  expect((await get('/api/notifications')).body.entries.map((e: { ticker: string | null }) => e.ticker)).toEqual([null, null])
  expect(calls).toEqual([[]])
})
```

`apps/server/test/db-notifications.test.ts`:

```ts
test('runRepo.getMany returns exactly the runs asked for', async () => {
  const mark = `gm-${Date.now()}-${process.pid}`
  const mk = (n: number, ticker: string) => repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: `${mark}-${n}`, poolCents: 1000, costPpm: 10 })
  const a = await mk(1, 'GMA'); await mk(2, 'GMB'); const c = await mk(3, 'GMC')
  const got = await repos.runRepo.getMany([c, a, a, 999999999])
  expect(got.map((r) => [r.id, r.ticker]).sort((x, y) => Number(x[0]) - Number(y[0]))).toEqual([[a, 'GMA'], [c, 'GMC']])
  expect(await repos.runRepo.getMany([])).toEqual([])
})
```

`apps/server/test/repo-surface-types.test.ts`, in `_runPins`: `// @ts-expect-error getMany takes a list of run ids` above `await r.runRepo.getMany(1)`.

- [ ] **Step 2: Run to verify they fail**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/http-notifications.test.ts apps/server/test/db-notifications.test.ts`
Expected: FAIL — `getMany is not a function` in the DB test; the two route tests get status 500 (the route still calls `list()`, which now throws) and `calls` stays empty.

- [ ] **Step 3: Add `getMany`** to `RunRepo` (Interfaces), to the real repo (`[]` at once for an empty list, otherwise `select().from(s.strategyRuns).where(inArray(s.strategyRuns.id, ids))`) and to the `http-fakes.ts` fake (`runs.filter((r) => ids.includes(r.id))`, no `this`). `RepoSurface.runRepo` keeps its pick.

- [ ] **Step 4: Use it in the route** — replace the `runRepo.list()` block: collect the distinct non-null `runId`s of `page.entries`, call `deps.repos.runRepo.getMany` once with them (also when the list is empty), and build the id → ticker map from the result. The response mapping is unchanged.

- [ ] **Step 5: Run to verify they pass**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/http-notifications.test.ts apps/server/test/db-notifications.test.ts apps/server/test/notice-feed.test.ts && bun test && bun run typecheck`
Expected: PASS, 0 fail (the five existing route tests unchanged).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/domain/repo-types.ts apps/server/src/db/repos.ts apps/server/src/http/routes/notifications.ts apps/server/test/http-fakes.ts apps/server/test/repo-surface-types.test.ts apps/server/test/http-notifications.test.ts apps/server/test/db-notifications.test.ts
git commit -m "fix: the notice feed looks up only the runs on its page (#89)"
```

---

### Task 5: Every "could not read fills" reply is recorded and never throws (#90)

**Files:**
- Modify: `apps/server/src/wire/capture.ts:11` (import), `:55-60` (failed extract), `:111-114` (empty auto-route group), `:139-142` (`rejected` outcome)
- Create: `apps/server/test/capture-replies.test.ts`
- Modify: `README.md:149-156` (Telegram capture bullets, Step 4), `AGENTS.md:40` (test list: `capture-replies`)

**Interfaces:**
- Consumes: `broadcastNotice` from `apps/server/src/wire/broadcast.ts` (its result is not used here).
- Produces, inside `makeCaptureHandlers` (not exported):

```ts
// "Could not read fills": recorded for System notices (no run) and then sent, to the asking chat only.
// broadcastNotice logs a failing insert or send and never throws, so the photo handler resolves.
async function tellBadExtract(chatId: string, detail: string): Promise<void> {
  await broadcastNotice(
    { allowedChatIds: [chatId], send: deps.send, notificationRepo: deps.repos.notificationRepo },
    null, t('capture-bad-extract', lang, { detail }), { kind: 'capture-bad-extract' },
  );
}
```

- Call sites, each written `await tellBadExtract(chatId, <detail>)`: the failed extract with `extract.detail`; the empty auto-route group and the `rejected` outcome with `'no fills recognized'`.
- Only the failed extract can be reached through `onPhoto`: `extractFills` never returns `ok` with zero fills (it answers `{ ok: false, reason: 'empty' }`), and `ingestCapture` answers `'rejected'` only for a failed extract, which `onPhoto` never passes on. The other two replies are pinned on the source.

- [ ] **Step 1: Write the failing tests** in `apps/server/test/capture-replies.test.ts`

```ts
import { describe, test, expect, spyOn } from 'bun:test'
import { makeCaptureHandlers, type CaptureDeps } from '../src/wire/capture'
import { makeFakes } from './http-fakes'

const IMAGE = { base64: 'aGVsbG8=', mime: 'image/png' }
const TEXT = 'Could not read fills from this image — http 500. Book the fill manually in the web UI.'
// The vision endpoint answers 500, so the extract fails with detail 'http 500'.
const vision500 = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch

// events lists every insert and send in the order they happened, as 'insert:<chatId>' / 'send:<chatId>'.
function setup(over: Partial<CaptureDeps> = {}) {
  const f = makeFakes()
  const events: string[] = []
  const sent: string[] = []
  const insert = f.repos.notificationRepo.insert
  f.repos.notificationRepo.insert = async (n) => { events.push(`insert:${n.chatId}`); await insert(n) }
  const handlers = makeCaptureHandlers({
    repos: f.repos,
    vision: { baseUrl: 'https://vision.example/v1', model: 'm' },
    getVisionApiKey: async () => 'k',
    today: () => '2026-11-10',
    allowedChatIds: ['111', '222'],
    fetchImpl: vision500,
    send: async (chatId, text) => { events.push(`send:${chatId}`); sent.push(text) },
    ...over,
  })
  return { f, handlers, events, sent }
}
const rows = (f: ReturnType<typeof makeFakes>) => f.notifications.map((n) => [n.runId, n.chatId, n.text])
```

Each test calls `await handlers.onPhoto('777', IMAGE)` with no `try`: a rejection fails the test. Tests that inject a failure spy `console.error` (restored in `finally`).

| Test name | Arrange | Assertions |
| --- | --- | --- |
| `a failed extract is recorded first, then sent, to the asking chat only` | `setup()` | `events` equals `['insert:777', 'send:777']`; `rows(f)` equals `[[null, '777', TEXT]]`; `sent` equals `[TEXT]` |
| `Telegram refusing the reply: the row is kept and the handler resolves` | `setup({ send: async () => { throw new Error('telegram-down') } })` | `rows(f)` equals `[[null, '777', TEXT]]`; `errors.mock.calls` equals `[['notice failed:', 'capture-bad-extract', { runId: null, chatId: '777' }, 'Error: telegram-down']]` |
| `the database refusing the row: the reply is still sent and the handler resolves` | `setup()`, then `f.repos.notificationRepo.insert = async () => { throw new Error('db-down') }` | `sent` equals `[TEXT]`; `rows(f)` equals `[]`; `errors.mock.calls` equals `[['notice failed:', 'capture-bad-extract', { runId: null, chatId: '777' }, 'Error: db-down']]` |
| `the reply is recorded in Korean when the bot speaks Korean` | `setup({ lang: 'ko' })` | `rows(f)` equals `[[null, '777', '이미지에서 체결을 읽을 수 없습니다 — http 500. 웹 UI에서 직접 예약해 주세요.']]` |

```ts
// The empty auto-route group and the 'rejected' outcome cannot be reached through the handlers
// (see extractFills and ingestCapture), so their wiring is pinned on the source.
test('every "could not read fills" reply goes through the one recording helper', async () => {
  const src = await Bun.file(new URL('../src/wire/capture.ts', import.meta.url)).text()
  expect(src.match(/t\('capture-bad-extract'/g)).toHaveLength(1)
  expect(src.match(/await tellBadExtract\(chatId, /g)).toHaveLength(3)
  expect(src.match(/await tellBadExtract\(chatId, 'no fills recognized'\)/g)).toHaveLength(2)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/server/test/capture-replies.test.ts`
Expected: FAIL — `events` is `['send:777', 'insert:777']`; the two failure tests reject with `telegram-down` / `db-down`; the source has three `t('capture-bad-extract'` and no `tellBadExtract`. The Korean test passes.

- [ ] **Step 3: Add `tellBadExtract` and use it at the three call sites** (Interfaces). In `extractOrTell` the send + insert pair becomes the one call; the other two replace a bare `deps.send`. Nothing else in the file changes; it must stay at or under 300 lines.

- [ ] **Step 4: Update the docs** — `README.md`, in the vision bullet of the Telegram section: a screenshot the vision model cannot read is answered with "Could not read fills…", and that reply is also listed under System notices. `AGENTS.md`: add `capture-replies` to the test list (after `capture-image`).

- [ ] **Step 5: Run to verify they pass**

Run: `bun test apps/server/test/capture-replies.test.ts apps/server/test/wire.test.ts && bun test && bun run typecheck && wc -l apps/server/src/wire/capture.ts`
Expected: PASS, 0 fail — including the unchanged `extract failure: no pending row, user sees the reason, admin notified` in `wire.test.ts`; `capture.ts` at or under 300 lines.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/wire/capture.ts apps/server/test/capture-replies.test.ts README.md AGENTS.md
git commit -m "fix: record every could-not-read-fills reply and keep a failed send inside the photo handler (#90)"
```

---

### Task 6: A system notice whose run is gone expands in place (#92), and final verification

**Files:**
- Modify: `apps/web/src/components/SystemNotices.tsx:1-3` (header comment), `:85-110` (message cell)
- Modify: `apps/web/src/api.notices.ts:4` (doc comment)
- Test: `apps/web/src/components/SystemNotices.test.tsx`

**Interfaces:**
- Consumes: the feed response from Task 4 — a run-linked entry whose run does not exist has `runId !== null` and `ticker === null`.
- Produces: DOM contract — an entry with `runId === null || ticker === null` renders the preview as `<button type="button" aria-expanded>` and, when expanded, the full text and the chat line in the same cell (exactly what a global notice renders today). Any other entry renders the `<a href="#/runs/<runId>?tab=notifications&notice=<id>">` link. The source column is unchanged: `#<runId>` for a gone run.

- [ ] **Step 1: Write the failing tests** in `apps/web/src/components/SystemNotices.test.tsx` (fixture `PAGE1`: row 1 is run 3 `NVDA`, row 2 is global, row 3 is run 8 with `ticker: null` and text `'\n  orphan  \nsecond line'`)

In `a run row links to the run's Notifications tab with the notice id`, replace the last expectation with `expect(container.querySelector('a[href^="#/runs/8"]')).toBeNull();`

Add:

```ts
it('a notice whose run is gone expands in place and keeps its run number', async () => {
  await render();
  const button = () => container.querySelector('tbody tr:nth-child(3) button') as HTMLButtonElement;
  const cell = () => container.querySelector('tbody tr:nth-child(3) td:nth-child(3)')!.textContent ?? '';
  expect(button().textContent).toBe('orphan');
  expect(button().getAttribute('aria-expanded')).toBe('false');
  expect(cell()).not.toContain('second line');
  await click(button());
  expect(button().getAttribute('aria-expanded')).toBe('true');
  expect(cell()).toContain('second line');
  expect(cell()).toContain('Chat: 42');
  expect(cells(2)[2]).toBe('#8');
  // the neighbours are untouched: the global row stays collapsed, the live run keeps its link
  expect(container.querySelector('tbody tr:nth-child(2) button')!.getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('a[href="#/runs/3?tab=notifications&notice=12"]')).not.toBeNull();
  await click(button());
  expect(cell()).not.toContain('second line');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/web/src/components/SystemNotices.test.tsx`
Expected: FAIL — row 3 holds a link to `#/runs/8?tab=notifications&notice=9` and no button.

- [ ] **Step 3: Render the gone-run entry inline**

In the row, `const inline = e.runId === null || e.ticker === null`; the message cell's two `e.runId === null` conditions become `inline`. The source cell keeps its own expression. Update the file's header comment (a run notice whose run is gone expands in place like a global one) and the `NoticeEntryDto` doc comment (`ticker` is null for a global notice and for a run that no longer exists).

- [ ] **Step 4: Run to verify they pass**

Run: `bun test apps/web && bun test && bun run typecheck`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/SystemNotices.tsx apps/web/src/components/SystemNotices.test.tsx apps/web/src/api.notices.ts
git commit -m "fix: a system notice whose run is gone expands in place (#92)"
```

- [ ] **Step 6: Final verification of the branch**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test`
Expected: 0 fail, no DB test skipped.
Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`
Expected: the smoke finishes without a failed check and drops its scratch database (it applies all of 0010, backfill included, to a fresh database).
Run: `bun run typecheck`
Expected: no errors.
Run: `wc -l apps/server/src/pipeline/day.ts apps/server/src/wire/broadcast.ts apps/server/src/wire/capture.ts apps/server/src/db/repos.ts apps/server/src/db/schema.ts apps/server/src/domain/repo-types.ts apps/server/src/http/routes/notifications.ts apps/web/src/components/SystemNotices.tsx apps/server/test/http-fakes.ts apps/server/test/day-unconfirmed.test.ts`
Expected: every file at or under ~300 lines.
Run: `git status --short`
Expected: empty (nothing left uncommitted; exactly one `0010_*.sql` in `apps/server/db/migrations/`).
