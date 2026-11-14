# Buy allocation: next never-used bucket — implementation plan

Spec: `docs/superpowers/specs/2026-11-14-buy-next-bucket-design.md`

## Goal

A buy (planned `buy_loc` order or booked fill) takes the lowest **empty**
bucket index that has never been closed; a previously closed bucket is reused
only when no never-used empty bucket remains. Today every site picks the
lowest empty index, so a just-closed bucket is immediately re-opened.

## Architecture context (read before starting)

- "Never used" is *derived*, never stored: an empty bucket slot whose `index`
  appears in `state.closed` (a `ClosedBucket[]`, entries appended by
  `applySellFill` on a full sell) has been used. Empty index absent from
  `closed` = never used. No schema or `RunState` shape change.
- The single shared rule lives in `@st/core` (packages must not import apps;
  the plan path and the booking path must not drift). New export in
  `packages/core/src/fills.ts`; `packages/core/src/index.ts` already has
  `export * from './fills'`, so `import { nextBuyBucketIndex } from '@st/core'`
  works with no index change.
- Three call sites pick a buy bucket today, all with
  `filter(empty).map(index).sort()[0]` semantics:
  1. `computeOrders` BUY section, `packages/strategies/src/mean-reversion.ts`
     lines ~87–103 (`buy_loc` order's `bucketIndex`);
  2. `runBooking` buy branch, `apps/server/src/domain/booking.ts` lines ~71–76
     (it ignores the matched order's stored bucket and re-derives its own —
     which is exactly why both must call the same helper);
  3. `seedRun`, same file, lines ~228–231. On a fresh state (no closes) the
     helper returns 0,1,2… exactly like the current code, so seeding behavior
     is unchanged — switch it anyway so the rule lives in one place.
- Failure behavior is unchanged: `computeOrders` keeps pushing
  `{ code: 'no-bucket-available' }` when the helper returns `null`;
  `runBooking`/`seedRun` keep throwing `Error('no-empty-bucket')`.
- Not touched: sell bucket matching, `applyBuyFill`/`applySellFill`
  internals, `rebuildState` (replays stored `bucketIdx` from the fill ledger,
  so history stays deterministic), sim engine (it applies the planned order's
  `bucketIndex`, inheriting the new rule), UI.

## Global constraints

- Repo `AGENTS.md`: English-only source comments; commit style
  `feat|fix|docs|test|chore:`; `packages/*` never import `apps/*`.
- Money: bigint myriadths for prices — irrelevant here but do not "improve"
  nearby money math.
- Tests from the repo root: `bun test` (the DB suite `apps/server/test/db.test.ts`
  self-skips without `TEST_DATABASE_URL`); types: `bun run typecheck`.
- Existing tests expected to keep passing untouched, notably
  `packages/strategies/test/mean-reversion.test.ts` "sell orders carry the
  bucket age stamped at plan time" (`buy.bucketIndex === 2` with buckets 0/1
  *held* and zero closes — identical under the new rule), plus `day.test.ts`
  and `sim.test.ts` (sequential fresh-state use ⇒ same indices).

---

### Task 1 — `nextBuyBucketIndex` in `@st/core`

Depends on: nothing. Must land before Tasks 2 and 3.

**Files**
- `packages/core/test/fills.test.ts` (append tests)
- `packages/core/src/fills.ts` (add export)

**Steps (TDD)**

1. Append to `packages/core/test/fills.test.ts` a `describe('nextBuyBucketIndex', …)`
   block covering, in this order:
   - fresh `emptyState(3)` → `0`; after `applyBuyFill(s, 0, …)` → `1`;
     after also filling 1 → `2`; after filling 2 → `null`.
   - skip closed: build `let s = emptyState(3)`, fill 0, full-sell 0
     (`applySellFill(s, 0, shares, price, 0, '2026-01-05')`) so bucket 0 is
     empty again but `closed` has an entry with `index: 0` → expect `1`.
   - closed in the middle: state with bucket 1 closed (fill 1 then full-sell
     1) and buckets 0,2 empty untouched → expect `0`; then fill 0 → expect `2`.
   - all closed fallback: `emptyState(2)`, fill+full-sell both buckets → both
     empty, both in `closed` → expect `0` (lowest closed index).
   - held buckets are ignored even when a closed one is free:
     `emptyState(2)`; fill 0; full-sell 0; fill 1 → bucket 0 is empty but
     closed, bucket 1 is held → expect `0` (no fresh empty remains, so the
     closed-empty fallback applies; `null` only when every bucket is held).
   Construct closed entries only through `applyBuyFill`/`applySellFill`, never
   hand-craft `RunState.closed` objects (keeps bigint discipline).

2. Run `bun test packages/core/test/fills.test.ts` — the new tests fail
   (`nextBuyBucketIndex is not a function`).

3. Implement in `packages/core/src/fills.ts`, directly above `advanceDay`:

   ```ts
   /**
    * Bucket a next buy should take: the lowest empty index never present in
    * `closed` (never used), else the lowest empty (previously closed) index,
    * else null when every bucket is held. Shared by planning and booking so
    * the two can never drift.
    */
   export function nextBuyBucketIndex(state: RunState): number | null {
     const closedIdx = new Set(state.closed.map((c) => c.index))
     let fallback: number | null = null
     for (const b of state.buckets) {
       if (b.state !== 'empty') continue
       if (!closedIdx.has(b.index)) return b.index
       if (fallback === null) fallback = b.index
     }
     return fallback
   }
   ```

   (Buckets arrive index-ascending from `emptyState` and every state
   transformer preserves order; iterating in array order is the sort.)

4. `bun test packages/core/test/fills.test.ts` → green.
   `bun run typecheck` → clean.

5. Commit: `feat: nextBuyBucketIndex helper prefers never-closed empty buckets`

---

### Task 2 — `computeOrders` plans with the helper

Depends on: Task 1. Independent of Task 3 (no file overlap; parallel-safe).

**Files**
- `packages/strategies/test/mean-reversion.test.ts` (append tests)
- `packages/strategies/src/mean-reversion.ts` (BUY section + import line 2)

**Steps (TDD)**

1. Append to the `describe('computeOrders', …)` block in
   `packages/strategies/test/mean-reversion.test.ts` two tests reusing the
   same `run` literal shape as the sibling tests:
   - *"buy plan skips a previously closed bucket"*: `let state = emptyState(3)`;
     `applyBuyFill(state, 0, 10, 3402200n, 34, '2026-11-02')`; full
     `applySellFill` bucket 0 so it is empty with a `closed` entry; then
     `applyBuyFill(state, 1, …)` (leave held). Plan → the single `buy_loc`
     order has `bucketIndex === 2`.
   - *"buy plan reuses a closed bucket only when none is fresh"*:
     `emptyState(2)`; fill+full-sell bucket 0; fill+full-sell bucket 1;
     plan → `buy_loc` `bucketIndex === 0`.
   - Also assert the untouched case keeps working: with bucket 1 closed only
     (bucket 0 empty never used) the plan targets `0`.

2. `bun test packages/strategies/test` → new tests fail (currently pick `0`
   in case one).

3. In `packages/strategies/src/mean-reversion.ts`:
   - add `nextBuyBucketIndex` to the value import from `@st/core` (line 2);
   - replace the BUY block's lines ~87–94 (the `emptyIndices`/`lowestEmpty`
     computation and its comment `// BUY: lowest-index empty bucket`) with:

     ```ts
     // BUY: next never-used empty bucket (closed buckets only as last resort)
     const nextBuy = nextBuyBucketIndex(state)
     if (nextBuy === null) {
       notices.push({ code: 'no-bucket-available' })
     } else {
     ```

     and change `bucketIndex: lowestEmpty` to `bucketIndex: nextBuy`. The rest
     of the `else` branch (limit, shares, `shares-zero` notice, `orders.push`)
     is untouched; brace structure stays identical.

4. `bun test packages/strategies/test` → green, including the pre-existing
   line-102 expectation (`buy.bucketIndex === 2`, no closes in that state).

5. Commit: `feat: morning buy plan targets the next never-used bucket`

---

### Task 3 — booking and seeding paths use the helper

Depends on: Task 1. Independent of Task 2 (no file overlap; parallel-safe).

**Files**
- `apps/server/test/booking.test.ts` (append tests)
- `apps/server/src/domain/booking.ts` (buy branch lines ~71–74, `seedRun`
  lines ~228–231, import line 1)

**Steps (TDD)**

1. Append to `apps/server/test/booking.test.ts` (reuse its `fakeRepos()` +
   `manualFill` helpers; see the existing `manualFill` tests for the exact
   call shape) a `describe('buy bucket selection', …)`:
   - *"manual buy after a closed cycle skips the closed bucket"*: create a run
     with `emptyState(3)` via `runRepo.create`; `manualFill` a buy (lands in
     bucket 0), then a full-size `manualFill` sell of bucket 0 so slot 0 is
     empty again with a `closed` entry; then `manualFill` another buy → after
     `loadState`, bucket **1** is held (the fresh slot; bucket 0 is skipped
     despite being the lowest empty) and `closed` still has exactly one entry.
   - *"manual buy reuses lowest closed bucket when all buckets closed"*: run
     with `emptyState(2)`; buy→full-sell both buckets; another manual buy →
     lands in bucket **0**.
   - *"seedRun fills 0,1 in order"* (regression guard): `seedRun` with two
     buckets on a fresh run → fills have `bucketIdx` `[0, 1]`.

2. `bun test apps/server/test/booking.test.ts` → case one fails
   (lands in 0 today).

3. In `apps/server/src/domain/booking.ts`:
   - add `nextBuyBucketIndex` to the line-1 import from `@st/core` (keep
     `type Bucket` — still used by the sell-matching code);
   - `runBooking` buy branch: replace

     ```ts
     const empties = state.buckets.filter((b: Bucket) => b.state === 'empty').map((b: Bucket) => b.index).sort((a: number, b: number) => a - b)
     if (!empties.length) throw new Error('no-empty-bucket')
     bucketIdx = empties[0]!
     ```

     with

     ```ts
     const picked = nextBuyBucketIndex(state)
     if (picked === null) throw new Error('no-empty-bucket')
     bucketIdx = picked
     ```

   - `seedRun` loop: replace the `const empties = …` / `if (!empties.length)`
     / `const idx = empties[0]!` trio with

     ```ts
     const idx = nextBuyBucketIndex(state)
     if (idx === null) throw new Error('no-empty-bucket')
     ```

4. `bun test apps/server/test/booking.test.ts` → green. Then the full
    `bun test` → green (`rebooking.test.ts`, `day.test.ts`, `sim.test.ts`
    must all still pass; they use fresh states so indices are unchanged).

5. Commit: `feat: booked and seeded buys take the next never-used bucket`

---

### Task 4 — integration sweep and spec annotation

Depends on: Tasks 2 and 3 merged.

**Steps**

1. From the repo root: `bun test` and `bun run typecheck` — both clean.
   If a test MariaDB is up (AGENTS.md Test matrix), also run
   `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test`
   and the E2E smoke `TEST_DATABASE_URL=… bun scripts/e2e.ts`.
2. In `docs/superpowers/specs/2026-11-10-strategy-tracker-design.md`, edit the
   superseded line (§Bucket allocation edge cases) so it reads: "A buy order
   fills the **next never-used bucket index** (lowest empty index absent from
   `closed`; a previously closed bucket is reused only when no fresh one
   remains) — see `2026-11-14-buy-next-bucket-design.md`." Keep the
   surrounding edge-case bullets intact.
3. Commit: `docs: note superseded lowest-free-bucket rule in master spec`
