# Capture follow-ups + per-run booking lock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four capture-dedup review follow-ups and serialize per-run booking/capture writes with an in-process lock.

**Architecture:** All domain writes live in `apps/server/src/domain/booking.ts` behind a `RepoSurface` of async repos. A new tiny module `run-lock.ts` provides a promise-chain mutex keyed by `runId`; `runBooking` and the dedup→insert section of `ingestCapture` run inside it. Copy changes live in `packages/telegram/src/i18n.ts` (en/ko catalogs).

**Tech Stack:** Bun + TypeScript monorepo, MariaDB via drizzle for integration tests, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-11-15-capture-followups-design.md`

## Global Constraints

- User-facing copy only via en/ko catalogs in `packages/telegram/src/i18n.ts`.
- Money is bigint myriadths (`parseUsd`); never float.
- No source file > ~300 lines.
- `bun test` must pass with **and** without `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test`; `bun run typecheck` must pass.
- Commit style: `feat|fix|docs|test|refactor|chore:`. English-only in code and comments.
- Multi-instance (two processes, one DB) is explicitly NOT protected — GitHub issue #1 tracks it. Do not add DB transactions.

## Review Focus

- Double-submitted capture of the same trades within milliseconds (photo resend, double-tap) — exactly one pending set is created, the second submission reports `duplicate`: Task 3, test "concurrent identical captures serialize".
- Two confirms of pending fills on the same run booked simultaneously — buckets get distinct indices, no lost state update: Task 3, test "concurrent confirms on one run serialize".
- Real-DB type coercions (DATE as string, price bigint vs extracted string) must not break dedup matching: Task 4, both DB cases.
- A repo fake missing the now-required `listForRun` must fail at compile time, not silently at runtime: Task 2, typecheck step.
- A rejected locked call must not poison the queue for later callers on the same run: Task 3, test "survives rejections".

---

### Task 1: `duplicate-capture` copy mentions pending matches

**Files:**
- Modify: `packages/telegram/src/i18n.ts:28` (both `duplicate-capture` entries — en and ko)
- Modify: `apps/server/test/wire.test.ts:269` (exact-string assertion)
- Modify: `scripts/e2e.ts:156` (`notice.includes(...)` assertion)

**Interfaces:**
- Consumes: nothing.
- Produces: catalog strings — en `Duplicate capture — all fills already booked or pending.` / ko `중복 스냅샷 — 모든 체결이 이미 예약되거나 대기 중입니다.` (exact, em dash).

- [ ] **Step 1: Update the failing assertion first** — change `wire.test.ts:269` expected text from `'Duplicate capture — already booked.'` to the new en string above.
- [ ] **Step 2: Run it to verify it fails** — `bun test apps/server/test/wire.test.ts` → the "sends a bilingual duplicate notice" test FAILS (old string still emitted).
- [ ] **Step 3: Replace both catalog entries** in `i18n.ts:28` with the exact en/ko strings, and update the string in `scripts/e2e.ts:156` to the new en text.
- [ ] **Step 4: Run `bun test apps/server/test/wire.test.ts`** → PASS.
- [ ] **Step 5: Commit** — `git add packages/telegram/src/i18n.ts apps/server/test/wire.test.ts scripts/e2e.ts && git commit -m "fix: duplicate-capture copy mentions pending matches"`

### Task 2: Strict `RepoSurface.fillRepo.listForRun`

**Files:**
- Modify: `apps/server/src/domain/booking.ts` — `RepoSurface.fillRepo` (remove `?` from `listForRun`, reword the comment so it says only `update`/`deleteById` are optional — rebook/delete history surface); remove the `if (repos.fillRepo.listForRun)` guard in the `ingestCapture` dedup block.
- Modify: `apps/server/src/domain/recompute.ts` — three guarded call sites of `repos.fillRepo.listForRun` become direct calls (keep the `update`/`deleteById` guards untouched).
- Modify: `apps/server/src/http/app.ts:15` — `fillRepo: RepoSurface['fillRepo']` (drop the `& { listForRun… }` intersection).
- Modify: `apps/server/test/day.test.ts:47` — add `async listForRun() { return [] as any[] }` to the fillRepo fake.
- Modify: `apps/server/test/booking.test.ts` — delete the test `'dedup tolerates a fillRepo without listForRun'` (contract changed).

**Interfaces:**
- Consumes: nothing.
- Produces: `RepoSurface['fillRepo']['listForRun']` is required: `listForRun(runId: number): Promise<FillRow[]>`. The real db repos (`apps/server/src/db/repos.ts`) and the `http.test.ts`/`sim.test.ts`/`booking.test.ts` fakes already implement it — no changes needed there.

- [ ] **Step 1: Make the surface required and strip the guards** in `booking.ts`, `recompute.ts`, `http/app.ts` as listed.
- [ ] **Step 2: Fix the fakes** — `day.test.ts` fillRepo gains `listForRun`; delete the `booking.test.ts` tolerance test.
- [ ] **Step 3: Run `bun run typecheck`** → no errors (this is the compile-time proof that no other fake was silently missing the method).
- [ ] **Step 4: Run `bun test`** → all green.
- [ ] **Step 5: Commit** — `git commit -am "refactor: make fillRepo.listForRun required on RepoSurface"`

### Task 3: Per-run in-process lock

**Files:**
- Create: `apps/server/src/domain/run-lock.ts`
- Modify: `apps/server/src/domain/booking.ts` — wrap `runBooking` body and the `ingestCapture` dedup→insert section.
- Test: `apps/server/test/booking.test.ts`

**Interfaces:**
- Consumes: `BookingDeps`, `fakeRepos()` and the dedup describe-block helpers (`setup`, `img`, `ext`, `trade`, `seedFill`) already in `booking.test.ts`.
- Produces: `export function withRunLock<T>(runId: number, fn: () => Promise<T>): Promise<T>` in `../domain/run-lock` — callers with the same `runId` run one at a time in arrival order; different `runId`s run concurrently; a rejecting `fn` does not break the queue; non-reentrant (never call from inside a locked section on the same runId — `ingestCapture` and `runBooking` never nest today; put a comment saying so).

- [ ] **Step 1: Write the failing unit tests** for `withRunLock` in `booking.test.ts` (top level, add `import { withRunLock } from '../src/domain/run-lock'` beside the other imports). Arrival order is the execution order — start `a` first:

```ts
test('withRunLock serializes by key and survives rejections', async () => {
  const log: string[] = []
  const slow = (s: string, ms: number) => withRunLock(1, async () => { log.push(s + 's'); await new Promise((r) => setTimeout(r, ms)); log.push(s + 'e') })
  const a = slow('a', 5)
  const b = withRunLock(1, async () => { throw new Error('boom') })
  const c = slow('c', 1)
  await Promise.allSettled([a, b, c])
  expect(log).toEqual(['as', 'ae', 'cs', 'ce'])
  await expect(b).rejects.toThrow('boom')
})
test('withRunLock does not serialize across keys', async () => {
  let active = 0, max = 0
  const j = (id: number) => withRunLock(id, async () => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 2)); active-- })
  await Promise.all([j(1), j(2)])
  expect(max).toBe(2)
})
```

- [ ] **Step 2: Write the two failing booking-concurrency tests** inside the existing `describe('capture dedup …')` block (they reuse its `setup/img/ext/trade/seedFill` helpers):

```ts
test('concurrent identical captures serialize: second returns duplicate', async () => {
  const { f, deps, runId } = await setup('race1')
  const slow = (obj: any, keys: string[]) => { for (const k of keys) { const orig = obj[k]; obj[k] = (...a: any[]) => new Promise((res) => setTimeout(() => res(orig(...a)), 1)) } }
  slow(f.repos.pendingRepo, ['insert', 'listPending'])
  slow(f.repos.fillRepo, ['listForRun', 'insert'])
  const out = await Promise.all([
    ingestCapture(runId, img('RACE-A'), ext(trade('buy', 10, '58.32', '2026-11-15')), deps),
    ingestCapture(runId, img('RACE-B'), ext(trade('buy', 10, '58.32', '2026-11-15')), deps),
  ])
  expect(out[0]).not.toBe('duplicate')   // distinct hashes: both pass the hash check
  expect(out[1]).toBe('duplicate')       // second sees the first's pending row
  expect(f._stores.pending.length).toBe(1)
})
```

A second test "concurrent confirms on one run serialize" in the main booking `describe`: create a run with `initialRunState: emptyState(2)` (pool 1_000_000, costPpm 100, today '2026-11-06'), push two pending buy rows via `f.repos.pendingRepo.insert` (`captureId: null, bucketIdx: null`, same ticker as the run — `confirmPendingFill` rejects mismatches — `shares 5, price parseUsd('10.00'), fee: null, filledOn '2026-11-06', status 'pending'`); instrument `f.repos.bucketRepo.loadState` to increment a shared `inflight` counter, `await setTimeout 1ms`, decrement, tracking `maxInflight`; then `await Promise.all([confirmPendingFill(id1, null, deps), confirmPendingFill(id2, null, deps)])`; assert `maxInflight === 1`, both fills booked to distinct `bucketIdx` values `[0, 1]`, and `loadState(runId)` shows two non-empty buckets. (Without the lock both bookings read the same state and collide on bucket 0.)

- [ ] **Step 3: Run `bun test apps/server/test/booking.test.ts`** → the four new tests FAIL (module missing / interleaved results).
- [ ] **Step 4: Implement `run-lock.ts`.** This queue algorithm is the part the tests do not fully determine — `run` is the caller-visible result (may reject; the caller handles it), `tail` is the never-rejecting chain link stored in the map (so a rejection cannot poison later callers) and doubles as the map-entry cleanup token:

```ts
const tails = new Map<number, Promise<void>>()
export function withRunLock<T>(runId: number, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(runId) ?? Promise.resolve()
  const run = prev.then(fn)
  const tail = run.then(() => {}, () => {}) // never rejects: safe as the next link
  tails.set(runId, tail)
  void tail.then(() => { if (tails.get(runId) === tail) tails.delete(runId) }) // drop drained queues
  return run
}
```

`tail` never rejects, so the cleanup `.then` needs no catch. Keep the module small with a header comment: per-runId promise-chain mutex, in-process only (multi-instance: GitHub issue #1), non-reentrant.

- [ ] **Step 5: Apply the lock in `booking.ts`.** Rename the private `runBooking` body to `bookUnlocked(input, deps)` and make `runBooking` `return withRunLock(input.runId, () => bookUnlocked(input, deps))` — covers `confirmPendingFill`, `manualFill`, and the decide→saveState→fill→ledger→flip sequence. In `ingestCapture`, keep the hash check/insert outside (the `inserted` flag is already atomic) and wrap everything from the dedup reads through the pending-insert loop: `return withRunLock(runId, async () => { …dedup + fresh check + insert loop, returning 'duplicate' or { pending } … })`. `booking.ts` must stay under ~300 lines.
- [ ] **Step 6: Run `bun test` and `bun run typecheck`** → all green.
- [ ] **Step 7: Commit** — `git commit -am "fix: serialize per-run booking and capture ingest with an in-process lock"`

### Task 4: DB integration case for capture dedup

**Files:**
- Modify: `apps/server/test/db.test.ts` (new tests inside the existing `describe`, reusing the shared `repos`, `db` and the already-imported `sql`; add imports `ingestCapture` + `type BookingDeps` from `../src/domain/booking`, `parseUsd` from `@st/core`)

**Interfaces:**
- Consumes: real repos from `makeRepos()`; `ingestCapture(runId, image, extract, deps)` per its current signature.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Write the two tests** (file self-skips without `TEST_DATABASE_URL`, so no skip logic needed):
  - `'ingestCapture dedups against real booked fills and pending rows'` — create a run (`ticker: 'DD' + Date.now()`, name unique, poolCents 1_000_000, costPpm 10); `fillRepo.insert` one booked buy (shares 11, `price: parseUsd('218.55')`, fee 0, `filledOn: '2026-11-12'`, source 'capture', bucketIdx 0); `pendingRepo.insert` one pending sell (shares 270, `price: parseUsd('65.53')`, fee 345, `filledOn: '2026-11-12'`, status 'pending'); call `ingestCapture` with `deps: BookingDeps = { repos, today: '2026-11-15' }`, a unique `image.base64` string, and an ExtractResult whose two fills mirror the booked+pending trades using **string prices** `'218.55'`/`'65.53'` with `date: '2026-11-12'`. Expect the result `toBe('duplicate')`; `(await repos.pendingRepo.listPending())` filtered to this run has length 1 (the seeded row only); `await db.execute(sql\`SELECT status FROM captures WHERE run_id = ${runId}\`)` returns exactly one row with status `'parsed'`.
  - `'mixed capture stores only the fresh fill as pending'` — same run pattern, only the booked buy seeded; extract covers the booked buy **plus** a fresh sell 270@'65.53' date '2026-11-12'; expect `{ pending: [...] }` with exactly one row (side 'sell', shares 270), and `listPending()` for the run shows exactly that one row.
- [ ] **Step 2: Run with the DB** — `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db.test.ts` → PASS (dedup already ships; these pin it against the real driver's DATE/bigint mappings).
- [ ] **Step 3: Run without the DB** — `bun test apps/server/test/db.test.ts` → suite self-skips (6 + 2 skipped, no failures).
- [ ] **Step 4: Full gate** — `bun test` and `bun run typecheck` green; `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts` passes (it asserts the new copy string).
- [ ] **Step 5: Commit** — `git commit -am "test: db integration cases for capture dedup"`
