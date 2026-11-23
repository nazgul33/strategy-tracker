# Repository surface typing (plan E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every `any` from the repository surface (`RepoSurface`, `HttpRepoSurface`, `CaptureRepos`), type the real repositories on the Drizzle database type, and make the test fakes checked on parameter count as well as name, with no behaviour change.

**Architecture:** The domain owns the row and repository types (new `apps/server/src/domain/repo-types.ts`, following the `correction-types.ts` precedent); the real repositories in `apps/server/src/db/` declare each repository `satisfies` its domain interface, and run on a typed `Db` (new `apps/server/src/db/db-type.ts`), so a schema/domain mismatch fails `tsc` at the repository definition. `main.ts` already assigns `getRepos(db)` to every surface, which ties the real and the declared types end to end once `db` is typed. Type-level pins live in one new test file, `apps/server/test/repo-surface-types.test.ts`; each task's red step is a pin that compiles today only because of an `any`.

**Tech Stack:** Bun + TypeScript (strict), Drizzle ORM 0.44 on mysql2 (MariaDB), Hono, `bun test`.

**Spec:** GitHub issue #67 ("Tighten the repository surface typing"), its follow-up comment (PR #82 merged; size against `main` at 394ca2f). Sizing done for this plan on 394ca2f: typing `db` alone yields 7 `tsc` errors from two root causes (the `side` varchar columns, `listUnfrozenKept`'s nullable `captureId`); deleting every `f.repos as any` in `apps/server/test` yields 0 errors.
**Models:** implementer subagents run on anthropic/claude-sonnet-5-5; per-task reviewers and the whole-branch reviewer run on anthropic/claude-fable-5-2; plan amendments and anything else run on anthropic/claude-opus-5-5.
**Branch:** `refactor/repo-surface-typing` (worktree). Code may have moved: locate by symbol, not line.

## Global Constraints

- English only in code, comments, tests and docs (never Chinese or Cyrillic characters).
- **No behaviour change.** No route, Telegram message, SQL statement or JSON wire shape changes. A route that returns rows keeps returning the full row (never project to a narrower domain type). The one permitted change: the six unguarded `runRepo.get` sites (Task 3) throw `Error('run-not-found')` instead of a `TypeError`.
- **No migration.** `$type<...>()` is type-only; after Task 1, `bun run --cwd apps/server db:generate` must report no schema changes and leave `apps/server/db/migrations/` untouched.
- No source file over ~300 lines (`booking.ts` is 286 today: the surface moves out of it, it must not grow).
- `packages/*` never import `apps/*`. Money stays bigint myriadths, cost integer ppm.
- Commit style `refactor|test|docs:`; one commit per task.
- Out of scope: `any` in HTTP request-body validation (`body: any`, `catch (e: any)`, `validSeed`, sim route validators), `bigintReplacer`, `sha256`'s `buf as any`, `apps/web`.
- Full gate before each commit: `bun run typecheck` and `bun test`. Tasks 1 to 4 also run the DB suite: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test`. Never point anything at port 3308 (production).

## Review Focus

1. **A typed result read that differs from the runtime shape** (`insertId`, `affectedRows` read off `const [res] = await db.insert|update(...)` instead of `(res as any)`): a repository must still return the new id and the affected count. Pinned in Task 1 (DB tests "pendingRepo.insert returns the new row id", "runRepo.updateStatusMany returns the number of rows it moved").
2. **A schema `$type` that sneaks in a migration**: Task 1 step "db:generate reports no changes".
3. **A real repository method that silently ignores a declared argument** (fewer parameters than the surface, e.g. `listForRun(runId)` dropping `date`): pinned in Task 5 (arity pins of `getRepos` against `HttpRepoSurface` and `CaptureRepos`).
4. **A fake that ignores an argument the real method takes**: pinned in Task 5 (arity pins of every fake, plus a `@ts-expect-error` negative pin proving the check fires).
5. **A booking path reached with a missing run**: now a named `run-not-found` error rather than a `TypeError`. Pinned in Task 3 ("manualFill on a missing run rejects with run-not-found").

---

### Task 1: Typed Drizzle database in the db layer

**Files:**
- Create: `apps/server/src/db/db-type.ts`
- Modify: `apps/server/src/db/schema.ts` (three `side` columns only; its `BucketRow`/`FillRow`/`LedgerRow` exports stay until Task 4)
- Modify: `apps/server/src/db/repos.ts`, `repos-sim.ts`, `repos-vision.ts`, `repos-bars.ts`, `client.ts`
- Modify: `apps/server/test/db.test.ts`, `db-sim-list.test.ts`, `db-sim-rewrite.test.ts`, `db-vision-janitor.test.ts`, `db-bar-coverage-lock.test.ts`, `bars-db.test.ts`
- Create: `apps/server/test/repo-surface-types.test.ts`

**Interfaces:**
- Produces: `export type Db = MySql2Database<typeof schema>`; `export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]`; `export type DbOrTx = Db | Tx` (all in `db/db-type.ts`). `getRepos(db: Db)`, `getSimRepo(db: Db)`, `getVisionRepos(db: Db)`, `getBarRepos(db: Db, opts?)`, `applyMigrations(db: Db)`.
- Produces (schema, type-only): `fills.side`, `pendingFills.side`, `fillCorrections.side` are `varchar(...).$type<'buy' | 'sell'>()`. `detectedSide` / `finalSide` stay `string | null`.

- [ ] **Step 1: Write the failing pins**

`apps/server/test/repo-surface-types.test.ts` (new; compile-time pins live in never-called functions, one runtime test keeps the file a suite):

```ts
import { test, expect } from 'bun:test'
import type { getRepos } from '../src/db/repos'

export function _dbPins(g: typeof getRepos) {
  // @ts-expect-error the real repositories need a Drizzle database
  g({})
}

test('repository surface type pins compile', () => { expect(true).toBe(true) })
```

In `apps/server/test/db.test.ts` add, using the file's existing run/capture helpers:
- `test('pendingRepo.insert returns the new row id')`: insert one full pending row; `expect(Number.isInteger(id) && id > 0).toBe(true)` and the row read back by `pendingRepo.get(id)` has that `id`.
- `test('runRepo.updateStatusMany returns the number of rows it moved')`: create two runs, `updateStatusMany([a, b, 999999999], ['active'], 'paused')` returns `2`; a second identical call returns `0`.

- [ ] **Step 2: Run to verify red**

Run: `bun run typecheck` — Expected: FAIL, `Unused '@ts-expect-error' directive` in `repo-surface-types.test.ts`.
Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db.test.ts` — Expected: PASS (the two DB tests are characterization pins of current behaviour; they must stay green through the refactor).

- [ ] **Step 3: Type the db layer**

- `db-type.ts` as in Interfaces; `client.ts` `applyMigrations(db: Db)`.
- Replace every `db: any` / `q: any` / `tx: any` in `db/*.ts` with `Db` / `DbOrTx` / inferred `tx`. Replace `(res as any).insertId`, `(res as any)?.affectedRows`, `res: any` (in `markStale`, drop the `Array.isArray` dance: `const [res] = await ...; return res.affectedRows`), the row-callback `(r: any)` annotations, and `affected(res: any)` in `repos-sim.ts` with the typed `ResultSetHeader` reads.
- Keep the `status as any` / `from as any` / `insert(x: any)` casts on *parameters* in `repos.ts`: Tasks 2 to 4 remove them with the signatures.
- `listUnfrozenKept` (`repos-vision.ts`): keep the SQL; narrow its result with a type-guard filter (`captureId !== null` and status `confirmed`/`rejected`), which is redundant with the inner join and the `where`.
- `$type<'buy' | 'sell'>()` on the three `side` columns.
- Test files: `let db: Db`, `let repos: ReturnType<typeof getRepos>`; remove `(r: any)` callback annotations that now infer; `getBarRepos(db as any, ...)` loses its cast. Where `db.test.ts` passes the partial patch `decide(id, 'confirmed', { shares: 7 })`, pass a full `PendingDecisionPatch` built from the inserted row with `shares: 7` (the test's point, "only from pending", is unchanged).

- [ ] **Step 4: Verify green**

Run: `bun run typecheck` — Expected: PASS.
Run: `bun test` — Expected: 0 fail.
Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` — Expected: 0 fail.
Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts` — Expected: `e2e OK`.
Run: `bun run --cwd apps/server db:generate` then `git status --short apps/server/db` — Expected: drizzle-kit reports no changes; no output from git.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db apps/server/test
git commit -m "refactor: type the real repositories on the Drizzle database (#67)"
```

---

### Task 2: Domain repository types; `orderRepo` and `pendingRepo`

**Files:**
- Create: `apps/server/src/domain/repo-types.ts`
- Modify: `apps/server/src/domain/booking.ts` (move `RepoSurface`, `PendingDecisionPatch`, `FillRow` out; re-export them, as it already does for `OrderRow`)
- Modify: `apps/server/src/db/repos.ts` (`orderRepo`, `pendingRepo`), `apps/server/src/domain/confirm-pending.ts`, `booking.ts` (the `orders.find((o: any) ...)`), `domain/order-ops.ts`, `pipeline/day.ts` (`insertMany` rows, `stale` reducer `e: any`), `wire/capture.ts` (drop local `PendingRow`; `CaptureRepos.pendingRepo: PendingRepo`), `http/app.ts` (`orderRepo: OrderRepo`, `pendingRepo: PendingRepo`), `http/routes/pending.ts` (`(p: any)` and `detectedDto(row: any)` → `PendingRow`)
- Modify: test fakes that stop compiling (`apps/server/test/wire.test.ts` order fake: `listFor*` return `[]` typed as `OrderRecord[]`, `markStale` returns `0`)
- Test: `apps/server/test/repo-surface-types.test.ts`

**Interfaces (all exported from `domain/repo-types.ts`; `booking.ts` re-exports every name its importers use today):**
- `type OrderKind = 'buy_loc' | 'sell_loc' | 'market_sell' | 'stop_sell'`; `type OrderStatus = 'open' | 'filled' | 'stale' | 'cancelled'`
- `interface OrderRecord extends OrderRow { kind: OrderKind; status: OrderStatus; skipReason: string | null; cancelReason: string | null }` (`OrderRow` stays in `sell-match.ts`, unchanged)
- `interface NewOrder { runId: number; tradeDate: ISODate; kind: OrderKind; bucketIdx: number; limitPrice: bigint; shares: number; status: OrderStatus }`
- `interface OrderRepo { insertMany(orders: NewOrder[]): Promise<void>; get(id: number): Promise<OrderRecord | null>; listForDate(date: string): Promise<OrderRecord[]>; listForRun(runId: number, date?: string): Promise<OrderRecord[]>; listForRunFrom(runId: number, fromDate: string): Promise<OrderRecord[]>; listOpenBefore(date: string): Promise<OrderRecord[]>; markStale(date: string): Promise<number>; setStatus(id: number, status: OrderStatus, cancelReason?: string): Promise<void> }`
- `type PendingStatus = 'pending' | 'confirmed' | 'rejected'`
- `interface PendingRow extends ReviewedPendingRow { captureId: number | null; bucketIdx: number | null; side: 'buy' | 'sell'; shares: number; price: bigint; fee: number | null; filledOn: ISODate; status: PendingStatus; createdAt: string }`
- `type NewPending = Omit<PendingRow, 'id' | 'createdAt'>`
- `interface PendingRepo { insert(p: NewPending): Promise<number>; listPending(): Promise<PendingRow[]>; get(id: number): Promise<PendingRow | null>; hasLiveForCapture(captureId: number): Promise<boolean>; hasConfirmedForCapture(captureId: number): Promise<boolean>; decide(id: number, status: 'confirmed' | 'rejected', edited?: PendingDecisionPatch): Promise<boolean> }`
- `RepoSurface` (moved verbatim, then): `orderRepo: OrderRepo`, `pendingRepo: Omit<PendingRepo, 'get'>`. Other members untouched in this task.
- Real repos: `const orderRepo = { ... } satisfies OrderRepo`, `const pendingRepo = { ... } satisfies PendingRepo`; their parameter annotations and `status as any` casts go.

- [ ] **Step 1: Write the failing pins** — append to `repo-surface-types.test.ts`:

```ts
export async function _orderPendingPins(r: RepoSurface) {
  // @ts-expect-error an order needs every column
  await r.orderRepo.insertMany([{ runId: 1 }])
  // @ts-expect-error 'closed' is a run status, not an order status
  await r.orderRepo.setStatus(1, 'closed')
  // @ts-expect-error limitPrice is bigint myriadths
  const _lp: string = (await r.orderRepo.get(1))!.limitPrice
  // @ts-expect-error a pending row carries its vision snapshot
  await r.pendingRepo.insert({ runId: 1 })
  // @ts-expect-error price is bigint myriadths
  const _pp: string = (await r.pendingRepo.listPending())[0]!.price
}
```

- [ ] **Step 2: Run to verify red** — `bun run typecheck`. Expected: FAIL, five `Unused '@ts-expect-error' directive`.

- [ ] **Step 3: Implement** the Interfaces block; fix the fallout in the listed callers and fakes (e.g. `day.ts` builds its order rows in a `.map`, where `status: 'open'` widens to `string`: type the mapped rows as `NewOrder`). `confirmPendingFill`/`rejectPendingFill` now hand `resolveReview` a `PendingRow` (that is the point: a narrower listing would now fail to compile). The `asReviewed`/`asPatch` pins in `vision-review.test.ts` stay.

- [ ] **Step 4: Verify green** — `bun run typecheck`, `bun test`, DB suite. Expected: PASS / 0 fail.

- [ ] **Step 5: Commit** — `refactor: type orderRepo and pendingRepo on domain row types (#67)`

---

### Task 3: `runRepo`

**Files:**
- Create: `apps/server/src/domain/require-run.ts`
- Modify: `domain/repo-types.ts`, `db/repos.ts` (`runRepo`), `http/app.ts` (`runRepo: RunRepo`), `domain/booking.ts` (`bookUnlocked`'s run read, `seedRun`), `domain/recompute.ts` (three sites), `domain/confirm-pending.ts` (one site), `pipeline/day.ts` (`runs as any[]`, `params: (run: any)` → `RunRow`; keep `run as Run` only if `RunRow` is not assignable to `@st/core`'s `Run`), `http/routes/runs.ts` and `http/routes/fills.ts` (`deps.repos as any` and `deps.today() as any` casts)
- Test: `apps/server/test/repo-surface-types.test.ts`, `apps/server/test/rebooking.test.ts` (or the booking test file that already covers `manualFill`)

**Interfaces:**
- `type RunStatus = 'active' | 'paused' | 'closed'`
- `interface RunRow { id: number; strategyKey: string; ticker: string; name: string; poolCents: number; costPpm: number; buyGapPpm: number; sellGapPpm: number; cutLossPpm: number; status: RunStatus; stateJson: string; createdAt: string }`
- `interface NewRun { strategyKey: string; ticker: string; name: string; poolCents: number; costPpm: number; buyGapPpm?: number; sellGapPpm?: number; cutLossPpm?: number; initialRunState?: RunState }` (the real `create`'s current input, moved)
- `interface RunRepo { list(): Promise<RunRow[]>; get(id: number): Promise<RunRow | null>; create(input: NewRun): Promise<number>; updateStatus(id: number, status: RunStatus): Promise<void>; updateStatusMany(ids: number[], from: RunStatus[], to: RunStatus): Promise<number>; updatePool(id: number, poolCents: number): Promise<void>; updateOrderShaping(id: number, v: { buyGapPpm: number; sellGapPpm: number; cutLossPpm: number }): Promise<void> }`
- `RepoSurface.runRepo: Pick<RunRepo, 'list' | 'get' | 'create' | 'updateStatus'>`
- `requireRun(repos: { runRepo: Pick<RunRepo, 'get'> }, runId: number): Promise<RunRow>` in `domain/require-run.ts`; throws `new Error('run-not-found')` when `get` returns null. Used at the six sites that dereference `runRepo.get` without a null check today; the routes and `wire/` keep their own existing null handling.
- The runs routes narrow the validated `status`/`from` strings to `RunStatus` (the `RUN_STATUSES_SERVER` check already guarantees it; a type guard or typed constant, no new runtime branch).

- [ ] **Step 1: Write the failing tests**

Pins appended to `repo-surface-types.test.ts`:

```ts
export async function _runPins(r: HttpRepoSurface) {
  // @ts-expect-error 'done' is not a run status
  await r.runRepo.updateStatus(1, 'done')
  // @ts-expect-error a run needs its name, pool and cost
  await r.runRepo.create({ ticker: 'X' })
  // @ts-expect-error get may return null
  const _t: string = (await r.runRepo.get(1)).ticker
}
```

Runtime test: `test('manualFill on a missing run rejects with run-not-found')` with `fakeRepos()` and no run created: `await expect(manualFill(42, { side: 'buy', shares: 1, price: '1.00', filledOn: '2026-11-06' }, deps)).rejects.toThrow('run-not-found')`.

- [ ] **Step 2: Run to verify red** — `bun run typecheck` (three unused directives) and `bun test apps/server/test/rebooking.test.ts` (FAIL: a `TypeError`, not `run-not-found`).

- [ ] **Step 3: Implement** the Interfaces block; `const runRepo = { ... } satisfies RunRepo`, dropping its `status as any` / `from as any` casts.

- [ ] **Step 4: Verify green** — `bun run typecheck`, `bun test`, DB suite.

- [ ] **Step 5: Commit** — `refactor: type runRepo and name the missing-run error (#67)`

---

### Task 4: `fillRepo`, `captureRepo`, `ledgerRepo`, `notificationRepo`; `HttpRepoSurface`

**Files:**
- Modify: `domain/repo-types.ts`, `db/repos.ts`, `domain/capture-claim.ts` (`insert(c: any)` → `NewCapture`), `http/app.ts`, `wire/capture.ts` if its fakes' shapes require it, `http/routes/runs.ts` (`let bars: any[]` → `OHLCBar[]`)
- Modify: fakes that stop compiling (`apps/server/test/http-fakes.ts`, `wire.test.ts`)
- Test: `apps/server/test/repo-surface-types.test.ts`

**Interfaces:**
- `FillRow` (moved in Task 2) narrows `source: FillSource` where `type FillSource = 'capture' | 'manual' | 'seed'`; `type NewFill = Omit<FillRow, 'id'>`; `interface FillPatch { shares?: number; price?: bigint; fee?: number; filledOn?: ISODate }`
- `interface FillRepo { insert(fill: NewFill): Promise<void>; listForRun(runId: number): Promise<FillRow[]>; update(runId: number, fillId: number, patch: FillPatch): Promise<void>; deleteById(runId: number, fillId: number): Promise<void> }`; `RepoSurface.fillRepo: Pick<FillRepo, 'insert' | 'listForRun'> & Partial<Pick<FillRepo, 'update' | 'deleteById'>>` (optional exactly as today; `recompute.ts` guards them)
- `type CaptureStatus = 'pending' | 'parsed' | 'unparseable' | 'duplicate' | 'confirmed'`; `interface NewCapture { runId: number; chatId: string | null; imageHash: string; status: CaptureStatus }`; `interface CaptureRepo { findByHash(runId: number, hash: string): Promise<{ id: number; status: CaptureStatus } | null>; setStatus(id: number, status: 'parsed' | 'unparseable'): Promise<void>; insert(c: NewCapture): Promise<{ inserted: boolean; id?: number }> }`
- `interface LedgerRow { id: number; runId: number; ts: string; kind: string; amountCents: number; ref: string | null }`; `type NewLedgerEntry = Omit<LedgerRow, 'id' | 'ts'>`; `interface LedgerRepo { insert(l: NewLedgerEntry): Promise<void>; listForRun(runId: number): Promise<LedgerRow[]> }`
- `interface NotificationRow { id: number; runId: number | null; chatId: string; text: string; sentAt: string }`; `type NewNotification = Omit<NotificationRow, 'id' | 'sentAt'>`; `interface NotificationRepo { insert(n: NewNotification): Promise<void>; listForRun(runId: number): Promise<NotificationRow[]> }`; `RepoSurface.notificationRepo: Pick<NotificationRepo, 'insert'>`
- `HttpRepoSurface`: `runRepo: RunRepo`, `orderRepo: OrderRepo`, `fillRepo: FillRepo`, `pendingRepo: PendingRepo`, `notificationRepo: NotificationRepo` (no inline method lists left for these); `HttpDeps.fetchDailyBars: (ticker: string, from: string, to: string) => Promise<OHLCBar[]>` (`OHLCBar` from `@st/market-data`).
- `schema.ts`'s `FillRow`/`LedgerRow`/`BucketRow` exports: delete; `wire.test.ts` imports `FillRow` / `LedgerRow` from `../src/domain/booking` instead (re-exported).
- Real repos `satisfies` each interface. After this task `grep -n "any" apps/server/src/domain/repo-types.ts apps/server/src/http/app.ts apps/server/src/wire/capture.ts apps/server/src/domain/capture-claim.ts` prints nothing, and `db/repos.ts` has no `as any` / `: any` left.

- [ ] **Step 1: Write the failing pins**

```ts
export async function _restPins(r: HttpRepoSurface, d: HttpDeps) {
  // @ts-expect-error a fill needs every column
  await r.fillRepo.insert({ runId: 1 })
  // @ts-expect-error a capture needs its hash and status
  await r.captureRepo.insert({ runId: 1 })
  // @ts-expect-error a ledger entry needs kind and amount
  await r.ledgerRepo.insert({ runId: 1 })
  // @ts-expect-error a notification needs its chat
  await r.notificationRepo.insert({ text: 'x' })
  // @ts-expect-error text is a string
  const _n: number = (await r.notificationRepo.listForRun(1))[0]!.text
  // @ts-expect-error bars carry a bigint close
  const _c: string = (await d.fetchDailyBars('X', '2026-01-01', '2026-01-02'))[0]!.close
}
```

(`OHLCBar` is `{ date: ISODate; open; high; low; close: bigint }`.) Pins in this file import their types (`RepoSurface`, `HttpRepoSurface`, `HttpDeps`, `CaptureRepos`) with `import type`.

- [ ] **Step 2: Run to verify red** — `bun run typecheck`. Expected: six unused directives.
- [ ] **Step 3: Implement** the Interfaces block and fix fallout.
- [ ] **Step 4: Verify green** — `bun run typecheck`, `bun test`, DB suite, and the `grep` above prints nothing.
- [ ] **Step 5: Commit** — `refactor: type the remaining repositories and HttpRepoSurface (#67)`

---

### Task 5: Fakes checked on arity; drop the test-side casts

**Files:**
- Create: `apps/server/test/type-assert.ts`
- Modify: `apps/server/test/repo-surface-types.test.ts`, `booking-fakes.ts`, `http-fakes.ts`, `fake-corrections.ts`, `wire.test.ts`, `sim.test.ts`, and every test file with `f.repos as any` (15 files, 63 casts; `grep -rln "repos as any" apps/server/test`)
- Modify: `AGENTS.md` repo map (add `domain/repo-types.ts`, `domain/require-run.ts`, `db/db-type.ts`, `test/type-assert.ts`, `test/repo-surface-types.test.ts`)

**Interfaces:**
- `type-assert.ts` exports:
  - `type Expect<T extends true> = T`, `type IsNever<T> = [T] extends [never] ? true : false`
  - `type ArityMismatches<Impl, Surface>`: the union of `` `${repo}.${method}` `` for every repository key and method key present in both whose full parameter count differs, where full count is `Required<Parameters<NonNullable<M>>>['length']` (optional parameters count; optional methods are compared when both sides have them). `never` when all match.

- [ ] **Step 1: Write the failing pins** — in `repo-surface-types.test.ts`:

```ts
type _real = Expect<IsNever<ArityMismatches<ReturnType<typeof getRepos>, HttpRepoSurface>>>
type _realCapture = Expect<IsNever<ArityMismatches<ReturnType<typeof getRepos>, CaptureRepos>>>
type _booking = Expect<IsNever<ArityMismatches<ReturnType<typeof fakeRepos>['repos'], RepoSurface>>>
type _http = Expect<IsNever<ArityMismatches<ReturnType<typeof makeFakes>['repos'], HttpRepoSurface>>>
// @ts-expect-error a fake that drops listForRun's date is caught
type _neg = Expect<IsNever<ArityMismatches<{ orderRepo: { listForRun(runId: number): Promise<[]> } }, Pick<RepoSurface, 'orderRepo'>>>>
```

In `wire.test.ts`, after `makeCaptureFakes`: `type _wire = Expect<IsNever<ArityMismatches<ReturnType<typeof makeCaptureFakes>['repos'], CaptureRepos>>>`, and its `repos` object literal gets `satisfies CaptureRepos`.

- [ ] **Step 2: Run to verify red** — `bun run typecheck`. Expected: FAIL (at least the wire fake: `captureImageRepo` lacks `discard`, zero-parameter methods mismatch, `decide`'s `status: string`).

- [ ] **Step 3: Fix the fakes and drop the casts**
  - Give every flagged fake method the surface's full parameter list (unused ones prefixed `_`).
  - `wire.test.ts`: the fake `satisfies CaptureRepos` (add `discard`; `decide(id, status: 'confirmed' | 'rejected', edited?: PendingDecisionPatch)`); delete every `as never` on `repos` and on `fillRepo.insert(...)` arguments.
  - `sim.test.ts` `describe('runSim')`: the fake `satisfies Pick<SimRepoSurface, ...>` for the methods it defines; stores typed `SimRunRow[]` / `SimDayRow[]`; no `any`.
  - Delete every `f.repos as any` (sizing on 394ca2f: compiles with zero changes).

- [ ] **Step 4: Verify green** — `bun run typecheck`, `bun test`, DB suite, `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`; `grep -rn "repos as any\|repos as never" apps/server/test` prints nothing.

- [ ] **Step 5: Commit** — `test: check fakes on arity and drop the repository casts (#67)`
