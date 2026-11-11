# Buy Gap / Sell Gap Implementation Plan

> **You are executing a plan.** Read this first: every task contains the exact
> code and test text to write — your job is transcription plus verification,
> not design. Do not substitute your own price formulas, names, or tests for
> the ones written here; they are pinned by the operator-approved spec (see
> Context). If a step genuinely fails, fix the minimal cause and report it —
> never redesign. Follow the TDD order written per task (failing test first,
> then implementation) and commit as each task directs.

**Goal:** Add per-run configurable buy gap and sell gap (integer ppm percents) that replace the buy/sell limit price formulas when set, in live planning and in the simulator.

**Architecture:** Two pure price functions (`buyLimit`, `sellLimit`) become the single formula point inside `computeOrders`, so digest/pipeline/pending/sim all inherit them. Gaps persist as new `int` columns on `strategy_runs`/`sim_runs`, flow through the HTTP API as ppm, and are entered as percents in the web UI.

**Tech Stack:** Bun 1.3.5, TypeScript, Drizzle(MySQL/MariaDB), Hono, React 18 + Vitest.

## Context

Spec: `docs/superpowers/specs/2026-11-11-buy-sell-gap-design.md` (approved).
Key operator rulings embedded below: sell gap is relative to the **buy price**
(not close); unset/0 gaps keep the current formulas bit-identical; buy prices
are **ceiling**-rounded to cents, sell prices **truncated** (the legacy default
sell path stays unrounded).

Repo is at commit `3775707` (sell-cap feature removed; `MrParams` is now
`{ bucketCount, maxAgeDays }`). Execution happens in a git worktree
(`.worktrees/buy-sell-gap`, branch `buy-sell-gap`).

Money is bigint myriadths (1 USD = 10 000n); one cent = 100n. A "cent" in this
codebase is 100 myriadths; `cents` columns are real cents (÷100 myriadths).

## Test commands

- Packages/server: `bun test packages/strategies/test packages/core/test apps/server/test` (from repo root)
- DB-gated suites + E2E: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` and `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts` (test container `st-mariadb-test`)
- Web: `bun run --cwd apps/web test`
- Whole repo: `bun test`; types: `bun run typecheck`

## Global Constraints

- No source file > ~300 lines. `packages/*` never import `apps/*`.
- Money only via bigint myriadths — never float, anywhere, including ppm math
  (`ppm` is an integer, multiplied as bigint).
- Every new user-facing string appears in BOTH `apps/web/src/i18n/en.json` and
  `ko.json`; no hardcoded English in components.
- API number fields validated integer-only (`Number.isInteger`) and bounded.
- Commit style `feat|fix|docs|test|chore:`.

---

### Task 1: Money helpers — `ceilDiv`, `ceilCents`, `floorCents`

**Files:**
- Modify: `packages/core/src/money.ts` (append functions)
- Test: `packages/core/test/money.test.ts` (append)

**Interfaces:**
- Consumes: existing `parseUsd`, `formatUsd` from the same file.
- Produces: `ceilDiv(n: bigint, d: bigint): bigint`, `ceilCents(v: bigint): bigint`, `floorCents(v: bigint): bigint` exported from `@st/core/money`. Task 4 imports all three; Tasks 4–6 rely on rounding semantics: `ceilCents(345578n)=345600n`, `floorCents(346655n)=346600n`, exact-cent values unchanged.

- [ ] **Step 1: Write the failing tests** — append to `packages/core/test/money.test.ts`:

```ts
import { ceilCents, ceilDiv, floorCents } from '../src/money'

describe('cent rounding helpers', () => {
  test('ceilDiv rounds up, exact stays exact, rejects non-positive divisor', () => {
    expect(ceilDiv(7n, 2n)).toBe(4n)
    expect(ceilDiv(6n, 2n)).toBe(3n)
    expect(ceilDiv(-7n, 2n)).toBe(-3n)
    expect(() => ceilDiv(1n, 0n)).toThrow('divisor must be positive')
  })
  test('ceilCents rounds up to next cent, no-op on exact cents', () => {
    expect(ceilCents(345578n)).toBe(345600n)
    expect(ceilCents(345500n)).toBe(345500n)
    expect(ceilCents(0n)).toBe(0n)
  })
  test('floorCents truncates down, no-op on exact cents', () => {
    expect(floorCents(346655n)).toBe(346600n)
    expect(floorCents(346600n)).toBe(346600n)
    expect(floorCents(99n)).toBe(0n)
  })
})
```

(merge the `import` into the file's existing `@st/core/money` import if it has one; the file imports via relative `../src/money` paths — match the file's existing import style.)

- [ ] **Step 2: Run to confirm failure** — `bun test packages/core/test` → FAIL `ceilDiv` undefined.
- [ ] **Step 3: Implement** — append to `packages/core/src/money.ts`:

```ts
export function ceilDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error('divisor must be positive')
  return -((-n) / d)
}

export function ceilCents(v: bigint): bigint {
  return ceilDiv(v, 100n) * 100n
}

export function floorCents(v: bigint): bigint {
  return (v / 100n) * 100n
}
```

- [ ] **Step 4: Run to confirm pass** — `bun test packages/core/test`.
- [ ] **Step 5: Commit** — `git commit -m "feat(core): cent ceiling/floor rounding helpers"` (all files touched by this task, staged explicitly by path).

---

### Task 2: DB schema columns + migration

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Generated: `apps/server/db/migrations/0003_*.sql` (+ `meta/`)

**Interfaces:**
- Consumes: nothing.
- Produces: drizzle fields `strategyRuns.buyGapPpm` / `strategyRuns.sellGapPpm` / `simRuns.buyGapPpm` / `simRuns.sellGapPpm` (`number`, always present on select, default 0). Task 5 inserts/updates them; Task 6 reads them; Task 7 exposes them in DTOs.

- [ ] **Step 1: Add columns** — in `apps/server/src/db/schema.ts`, in `strategyRuns` immediately after the `costPpm` line add:

```ts
  buyGapPpm: int('buy_gap_ppm').notNull().default(0),
  sellGapPpm: int('sell_gap_ppm').notNull().default(0),
```

and in `simRuns` immediately after its `costPpm` line add the same two lines.

- [ ] **Step 2: Generate migration** — `bun run --cwd apps/server db:generate`. Inspect the written SQL: exactly four `ALTER TABLE ... ADD COLUMN` statements (`buy_gap_ppm`/`sell_gap_ppm` `int NOT NULL DEFAULT 0` on `strategy_runs` and `sim_runs`), nothing else. If anything else appears, STOP and report.
- [ ] **Step 3: Verify apply on test DB** — the migration applies at server startup / db.test. From the repo root run `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db.test.ts` → PASS (migrations apply).
- [ ] **Step 4: Commit** — `git commit -m "feat(db): buy_gap_ppm/sell_gap_ppm columns"` (schema, migration SQL, `db/migrations/meta/`).

---

### Task 3: Core domain — `Run` gap fields

**Files:**
- Modify: `packages/core/src/domain.ts:9-14` (Run interface)
- Test: existing suites only (type-level change).

**Interfaces:**
- Consumes: nothing new.
- Produces: `Run` with required `buyGapPpm: number; sellGapPpm: number`. After this task every `Run` object literal must set both — the only literal in src is `sim.ts:181` (fixed in Task 6) and test literals fixed in Tasks 6–8; Task 4's tests build `Run` objects with gaps.

- [ ] **Step 1: Extend interface** — `Run` becomes:

```ts
export interface Run {
  id: number
  name: string
  ticker: string
  strategyKey: string
  costPpm: number
  buyGapPpm: number
  sellGapPpm: number
  poolCents: number
  status: RunStatus
}
```

- [ ] **Step 2: Fix typecheck fallout** — `bun run typecheck` and fix each error by adding `buyGapPpm: 0, sellGapPpm: 0` (keep any values the test already asserts otherwise) to the offending `Run` literals — expected in `packages/strategies/test/mean-reversion.test.ts`, `apps/server/test/*` (including the `const runRow: Run = {...}` literals in `booking.test.ts` and `day.test.ts`, which otherwise fail `tsc` with TS2739), and `apps/server/src/sim/sim.ts`. Where a test is about gaps (Task 4) set real values instead.
- [ ] **Step 3: Full unit run** — `bun test` → all pass.
- [ ] **Step 4: Commit** — `git commit -m "feat(core): Run carries buyGapPpm/sellGapPpm"`.

---

### Task 4: `buyLimit` / `sellLimit` + `computeOrders` integration

**Files:**
- Modify: `packages/strategies/src/mean-reversion.ts`
- Test: `packages/strategies/test/mean-reversion.test.ts` (append)

**Interfaces:**
- Consumes: `ceilCents`, `floorCents` (Task 1); `Run.buyGapPpm/sellGapPpm` (Task 3).
- Produces: exported `buyLimit(lastClose: bigint, buyGapPpm: number): bigint` and `sellLimit(buyPrice: bigint, costPpm: number, shares: number, sellGapPpm: number): bigint` from `@st/strategies`. `computeOrders` buy/sell_loc prices now come from them; Task 6's sim inherits.

- [ ] **Step 1: Write the failing tests** — append to `packages/strategies/test/mean-reversion.test.ts` (import `buyLimit, sellLimit` from `../src/mean-reversion`, reuse the file's existing `makeRun`-style helper or add `makeRunWithGaps(buyGapPpm, sellGapPpm)`; use `parseUsd`/`formatUsd` from `@st/core/money`):

```ts
describe('buyLimit', () => {
  test('default gap keeps close - $0.01, cent-rounded', () => {
    expect(buyLimit(parseUsd('34.56'), 0)).toBe(parseUsd('34.55'))
    expect(buyLimit(parseUsd('34.5678'), 0)).toBe(parseUsd('34.56')) // ceil(34.5578)
  })
  test('percent gap below close, ceiling to cents', () => {
    expect(buyLimit(parseUsd('100'), 5_000)).toBe(parseUsd('99.50')) // 0.5%
    expect(buyLimit(parseUsd('34.5678'), 5_000)).toBe(parseUsd('34.40')) // ceil(34.394961)
    expect(buyLimit(parseUsd('0.01'), 50_000)).toBe(parseUsd('0.01')) // ceil(0.0095): sub-cent floors back up to 1¢
  })
  test('edges: 0 and 100 percent', () => {
    expect(buyLimit(parseUsd('10'), 1_000_000)).toBe(0n)
  })
})

describe('sellLimit', () => {
  test('default gap keeps legacy sellTarget exactly', () => {
    expect(sellLimit(parseUsd('33.43'), 200, 100, 0)).toBe(sellTarget(parseUsd('33.43'), 200, 100))
  })
  test('percent gap above buy price, truncate to cents', () => {
    expect(sellLimit(parseUsd('100'), 200, 100, 10_000)).toBe(parseUsd('101'))
    expect(sellLimit(parseUsd('33.43'), 200, 100, 300_000)).toBe(parseUsd('43.45')) // 43.459 → 43.45
  })
  test('edges: 100 percent doubles buy price', () => {
    expect(sellLimit(parseUsd('12.34'), 200, 100, 1_000_000)).toBe(parseUsd('24.68'))
  })
})

describe('computeOrders with gaps', () => {
  test('buy and sell_loc prices follow run gaps', () => {
    const run = { ...makeRun(), buyGapPpm: 10_000, sellGapPpm: 20_000 }
    const state = { buckets: [mkBucket(0, 'held', 100, parseUsd('90'), '2026-11-02')], cashCents: 100_00, closedBuckets: [], lastBuys: [], lastSells: [] }
    const ctx = { lastClose: parseUsd('100'), today: '2026-11-03', prevTradingDay: '2026-11-02', maxAgeDays: 20 }
    const r = computeOrders(run, DEFAULT_MR_PARAMS, state, ctx)
    expect(r.buy?.limitPrice).toBe(parseUsd('99'))          // 100 × 0.99
    expect(r.sells[0]!.limitPrice).toBe(parseUsd('108'))    // 90 × 1.20
  })
  test('unset gaps keep legacy prices', () => {
    const state = { buckets: [mkBucket(0, 'held', 100, parseUsd('90'), '2026-11-02')], cashCents: 100_00, closedBuckets: [], lastBuys: [], lastSells: [] }
    const ctx = { lastClose: parseUsd('100'), today: '2026-11-03', prevTradingDay: '2026-11-02', maxAgeDays: 20 }
    const r = computeOrders(makeRun(), DEFAULT_MR_PARAMS, state, ctx)
    expect(r.buy!.limitPrice).toBe(parseUsd('99.99'))
    expect(r.sells[0]!.limitPrice).toBe(sellTarget(parseUsd('90'), 200, 100))
  })
})
```

(`makeRun()` / `mkBucket()` are the helpers already defined at the top of the test file — check their signatures at `packages/strategies/test/mean-reversion.test.ts:10-15` and adapt literal field names if they differ.)

- [ ] **Step 2: Run to confirm failure** — `bun test packages/strategies/test` → FAIL `buyLimit` undefined.
- [ ] **Step 3: Implement** — in `packages/strategies/src/mean-reversion.ts`:

```ts
import { ceilCents, floorCents, formatUsd } from '@st/core/money'

export const MILLION = 1_000_000n

export function buyLimit(lastClose: bigint, buyGapPpm: number): bigint {
  const raw = buyGapPpm === 0
    ? lastClose - 100n
    : (lastClose * BigInt(MILLION - BigInt(buyGapPpm))) / MILLION
  return ceilCents(raw)
}

export function sellLimit(buyPrice: bigint, costPpm: number, shares: number, sellGapPpm: number): bigint {
  if (sellGapPpm === 0) return sellTarget(buyPrice, costPpm, shares)
  return floorCents((buyPrice * (MILLION + BigInt(sellGapPpm))) / MILLION)
}
```

In `computeOrders`, replace the buy line `const limitPrice = ctx.lastClose - 100n` with:

```ts
  const limitPrice = buyLimit(ctx.lastClose, run.buyGapPpm)
```

and in the `sell_loc` loop replace the existing `const target = sellTarget(...)` line and the push branch below it with a single push using:

```ts
    const target = sellLimit(b.buyPrice, run.costPpm, b.shares, run.sellGapPpm)
```

(keep the loop's push/skip structure as it currently is — the cap branch no longer exists since 3775707).

- [ ] **Step 4: Run to confirm pass** — `bun test packages/strategies/test` → all pass, including all pre-existing tests unchanged.
- [ ] **Step 5: Commit** — `git commit -m "feat(strategies): buyLimit/sellLimit gap formulas"` (all files touched by this task, staged explicitly by path).

---

### Task 5: Run repo gap persistence + `POST /runs/:id/gaps`

**Files:**
- Modify: `apps/server/src/db/repos.ts:29-35` (runRepo.create)
- Modify: `apps/server/src/http/routes/runs.ts`
- Test: `apps/server/test/http.test.ts` (append)

**Interfaces:**
- Consumes: schema columns (Task 2).
- Produces: `runRepo.create({ ticker, name, strategyKey, poolCents, costPpm, buyGapPpm, sellGapPpm, stateJson })`; HTTP `POST /runs/:id/gaps` body `{ buyGapPpm, sellGapPpm }` → 204, 400 invalid, 404 unknown. Task 9's web client calls exactly this.

- [ ] **Step 1: Write the failing tests** — append to `apps/server/test/http.test.ts` following its existing fake-repos harness:

```ts
test('POST /runs accepts gap fields and rejects invalid', async () => {
  // create body with buyGapPpm: 10000, sellGapPpm: 20000 → 201; row carries both
  // body with buyGapPpm: 1.5 → 400; sellGapPpm: -1 → 400; buyGapPpm: 1000001 → 400
  // body without gaps → created row has buyGapPpm 0, sellGapPpm 0
})

test('POST /runs/:id/gaps updates, validates, 404s', async () => {
  // valid → 204 and updateGaps called with both values
  // missing/non-integer/out-of-range fields → 400, updateGaps not called
  // unknown id → 404
})
```

Write the bodies using the file's existing request helper and fake repo (mirror the existing pool-edit test — find it via `grep -n "pool" apps/server/test/http.test.ts`).

- [ ] **Step 2: Run to confirm failure** — `bun test apps/server/test/http.test.ts` → FAIL.
- [ ] **Step 3: Implement** —
  a) `repos.ts` `runRepo.create` gains `buyGapPpm: number; sellGapPpm: number` in its param type and inserts them; add beside `updatePool`:

```ts
    async updateGaps(id: number, buyGapPpm: number, sellGapPpm: number) {
      await db.update(s.strategyRuns).set({ buyGapPpm, sellGapPpm }).where(eq(s.strategyRuns.id, id))
    },
```

  b) `runs.ts`: add `const MAX_PPM = 1_000_000` and helpers `isValidPpm` (`Number.isInteger(x) && x >= 0 && x <= MAX_PPM`) and `readGapFields(body)` returning `{ buyGapPpm, sellGapPpm }` with defaults 0 (used by POST /runs; both fields optional). POST /runs validation rejects invalid values with 400 and passes both into `deps.runRepo.create`. New route mirroring the `POST /runs/:id/pool` shape (404 when `runRepo.get` is null; both fields required integers 0..1_000_000 or 400):

```ts
app.post('/runs/:id/gaps', async (c) => {
  if (!c.get('auth')) return c.json({ error: 'unauthorized' }, 401)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400)
  const body = await c.req.json().catch(() => ({}))
  if (!isValidPpm(body?.buyGapPpm) || !isValidPpm(body?.sellGapPpm)) return c.json({ error: 'invalid gaps' }, 400)
  const run = await deps.runRepo.get(id)
  if (!run) return c.json({ error: 'not found' }, 404)
  await deps.runRepo.updateGaps(id, body.buyGapPpm, body.sellGapPpm)
  return c.body(null, 204)
})
```

(match the exact auth/param/validation idioms already in the file).

- [ ] **Step 4: Run to confirm pass** — `bun test apps/server/test/http.test.ts`.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): gap fields on run create + POST /runs/:id/gaps"` (all files touched by this task, staged explicitly by path).

---

### Task 6: Sim gaps end to end

**Files:**
- Modify: `apps/server/src/sim/sim.ts`
- Modify: `apps/server/src/http/routes/sim.ts`
- Modify: `apps/server/src/db/repos.ts:110-114` (simRepo.create)
- Test: `apps/server/test/sim.test.ts`, `apps/server/test/http.test.ts` (append)

**Interfaces:**
- Consumes: `Run` gaps (Task 3), `buyLimit/sellLimit` via computeOrders (Task 4), `sim_runs` columns (Task 2).
- Produces: `SimInput.buyGapPpm?/sellGapPpm?` (validated, default 0) — Task 10's web form posts them.

- [ ] **Step 1: Write the failing tests** — append to `apps/server/test/sim.test.ts` (reuse its existing fake-deps harness — see the `mkDeps`/`runSim` usage at the top of the file):

```ts
test('simulation honours buy and sell gaps', async () => {
  // closes: day1 100.00, day2 90.00; buyGapPpm 10_000 → day1 buy plan price 99.00
  // sellGapPpm 20_000 → day2 sell plan price buyPrice × 1.2 truncated; fill via
  // lowDay(95) lands; final sell uses the same gap target
  // assert out.plans[0]!.buy!.limitPrice === parseUsd('99') and sell prices === gap targets
})

test('sim gaps default to 0 and are persisted on the sim run row', async () => {
  // insertRun receives buyGapPpm/sellGapPpm (0 when absent, real values when set)
})
```

Append to `apps/server/test/http.test.ts`: `POST /sims` rejects `buyGapPpm: -1` and `sellGapPpm: 1.5` with 400.

- [ ] **Step 2: Run to confirm failure** — `bun test apps/server/test/sim.test.ts` → FAIL.
- [ ] **Step 3: Implement** — in `sim.ts`:
  - `SimInput` and the `simulate` run-literal: add `buyGapPpm: number; sellGapPpm: number` to `SimInput` (required after validation), and in `simulate` build the synthetic run `{ ..., buyGapPpm: input.buyGapPpm, sellGapPpm: input.sellGapPpm }`.
  - `validateInput`: add the same ppm checks as Task 5 (`Number.isInteger`, 0..1_000_000, default 0 when `undefined`), writing defaults back into the returned input.
  - `runSim`'s `deps.insertRun({...})` call gains both fields; `SimRepoSurface.insertRun` param type gains `buyGapPpm: number; sellGapPpm: number`.
  In `repos.ts` `simRepo.create`: accept and insert both.
  In `routes/sim.ts` `validateBody`: mirror the costPpm checks for the two new optional fields (absent → 0).

- [ ] **Step 4: Run to confirm pass** — `bun test apps/server/test/sim.test.ts apps/server/test/http.test.ts`.
- [ ] **Step 5: Commit** — `git commit -m "feat(sim): simulation uses persisted buy/sell gaps"` (all files touched by this task, staged explicitly by path).

---

### Task 7: Run DTOs expose gaps

**Files:**
- Modify: `apps/server/src/http/routes/runs.ts` (DTO mapping)
- Test: `apps/server/test/http.test.ts` (extend Task 5 tests)

**Interfaces:**
- Consumes: run rows with gap columns.
- Produces: JSON `buyGapPpm`/`sellGapPpm` (numbers) on run DTOs returned by `GET /runs`, `GET /runs/:id`, `POST /runs`. Task 8's web types mirror this.

- [ ] **Step 1: Write the failing tests** — extend the Task 5 create test: after creating with gaps, `GET /runs/:id` and `GET /runs` rows carry `buyGapPpm: 10000, sellGapPpm: 20000`. (`POST /runs` itself responds `{ id }` only — assert through the GET routes.)
- [ ] **Step 2: Run to confirm failure** — FAIL (fields missing).
- [ ] **Step 3: Confirm pass-through** — run rows are returned raw (`c.json(rows)` for `GET /runs`, `c.json(jsonBig({ ...run, progressView, state }))` for `GET /runs/:id`), and drizzle `select()` returns all columns, so after Tasks 2+5 the fields already flow. If the Step 1 tests pass without source edits, this task lands as test-only — say so in the commit body. If they fail, add the missing fields at the response construction site (`grep -n "costPpm" apps/server/src/http/routes/runs.ts`).
- [ ] **Step 4: Run to confirm pass** — `bun test apps/server/test/http.test.ts`.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): run DTOs expose gap ppm"` (all files touched by this task, staged explicitly by path).

---

### Task 8: Web API types + client

**Files:**
- Modify: `apps/web/src/api.types.ts` (RunDto, CreateRunInput, SimInput, SimRunDto)
- Modify: `apps/web/src/api.ts` (createRun, createSim, new setGaps)

**Interfaces:**
- Consumes: server DTO fields (Task 7), `POST /runs/:id/gaps` (Task 5), `/sims` body (Task 6).
- Produces: `api.setGaps(id: number, input: { buyGapPpm: number; sellGapPpm: number }): Promise<void>`; `RunDto.buyGapPpm/sellGapPpm: number`; `CreateRunInput.buyGapPpm?/sellGapPpm?: number`; `SimInput.buyGapPpm?/sellGapPpm?: number`; `SimRunDto.buyGapPpm/sellGapPpm: number`. Tasks 9–11 use these.

- [ ] **Step 1: Write the failing test** — append to `apps/web/src/api.test.ts` (reuse its fetch-stub helper):

```ts
it('setGaps posts both ppm values', async () => {
  const calls: Array<[string, RequestInit | undefined]> = []
  // stub fetch capturing url+init, setToken('t'), await api.setGaps(7, { buyGapPpm: 100, sellGapPpm: 200 })
  // expect POST /runs/7/gaps, body { buyGapPpm: 100, sellGapPpm: 200 }, bearer header
})
```

- [ ] **Step 2: Run to confirm failure** — `bun run --cwd apps/web test` → FAIL.
- [ ] **Step 3: Implement** — add the fields to the four DTO/interface types (all `number`, optional exactly where the table above says optional). In `api.ts` add:

```ts
  setGaps: (id: number, input: { buyGapPpm: number; sellGapPpm: number }) =>
    req<void>(`/runs/${id}/gaps`, { method: 'POST', body: input }),
```

`createRun`/`createSim` pass bodies through already — nothing else changes there.
- [ ] **Step 4: Run to confirm pass** — `bun run --cwd apps/web test` + `bun run typecheck` (server-side web types compile; expect web typecheck green).
- [ ] **Step 5: Commit** — `git commit -m "feat(web): gap fields in api client and DTOs"` (all files touched by this task, staged explicitly by path).

---

### Task 9: CreateRunForm gap fields

**Files:**
- Modify: `apps/web/src/components/forms/CreateRunForm.tsx`
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Test: `apps/web/src/components/forms/CreateRunForm.test.tsx` (append)

**Interfaces:**
- Consumes: `api.createRun` + `CreateRunInput` (Task 8).
- Produces: two text inputs with `data-testid="buyGapInput"` / `"sellGapInput"`; input `"0.5"` → `buyGapPpm: 5_000`; blank → `0`; invalid (`abc`, negative, > 100, > 4 decimals) disables submit.

- [ ] **Step 1: Write the failing test** — append to `CreateRunForm.test.tsx` (follow the existing render/fireEvent patterns in the file):

```tsx
it('converts percent gap inputs to ppm on submit', async () => {
  // render form, fill name/ticker/pool/cost/buckets as existing tests do,
  // type '0.5' into getByTestId('buyGapInput'), '2' into getByTestId('sellGapInput'), submit
  // expect createRun called with buyGapPpm: 5000, sellGapPpm: 20000
})
it('blank gaps submit as 0', async () => { /* expect buyGapPpm: 0, sellGapPpm: 0 */ })
it('rejects >100 percent and >4-decimal precision', async () => { /* type '101' then '0.00001' → submit disabled */ })
```

- [ ] **Step 2: Run to confirm failure** — FAIL.
- [ ] **Step 3: Implement** — state + fields following the existing cost pattern exactly:

```tsx
const [buyGap, setBuyGap] = useState('');
const [sellGap, setSellGap] = useState('');
```

```tsx
<Field label={t('runForm.buyGapLabel')} hint={t('runForm.buyGapHint')}>
  <Input
    data-testid="buyGapInput"
    value={buyGap}
    onChange={(e) => setBuyGap(e.target.value)}
    inputMode="decimal"
    placeholder="0"
    invalid={buyGap !== '' && !isGapText(buyGap)}
  />
</Field>
```

(and the same pair for `sellGap` with `runForm.sellGap*` keys). Module-level helpers:

```tsx
function isGapText(s: string): boolean {
  return /^\d+(\.\d{1,4})?$/.test(s) && Number(s) <= 100;
}

function gapToPpm(s: string): number {
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '0000').slice(0, 4);
  return Number(whole) * 10_000 + Number(fracPadded);
}
```

`valid` gains `&& (buyGap === '' || isGapText(buyGap)) && (sellGap === '' || isGapText(sellGap))`; `onSubmit` passes `buyGapPpm: gapToPpm(buyGap), sellGapPpm: gapToPpm(sellGap)` (blank → `gapToPpm('')` = 0 — guard: `s === '' ? 0 : …`).
- [ ] **Step 4: i18n** — add to en.json:

```json
"runForm.buyGapLabel": "Buy gap (%)",
"runForm.buyGapHint": "limit = close × (1 − gap), rounded up to cent. blank = close − $0.01",
"runForm.sellGapLabel": "Sell gap (%)",
"runForm.sellGapHint": "limit = buy price × (1 + gap), truncated to cent. blank = cost + fees + $0.01"
```

and to ko.json:

```json
"runForm.buyGapLabel": "매수 간격 (%)",
"runForm.buyGapHint": "지정가 = 종가 × (1 − 간격), 센트 올림. 비우면 종가 − $0.01",
"runForm.sellGapLabel": "매도 간격 (%)",
"runForm.sellGapHint": "지정가 = 매수가 × (1 + 간격), 센트 버림. 비우면 매수가 + 수수료 + $0.01"
```

- [ ] **Step 5: Run to confirm pass** — `bun run --cwd apps/web test`.
- [ ] **Step 6: Commit** — `git commit -m "feat(web): gap fields in run form"` (all files touched by this task, staged explicitly by path).

---

### Task 10: Gap edit form on run detail + display

**Files:**
- Create: `apps/web/src/components/forms/GapEditForm.tsx`
- Modify: `apps/web/src/pages/RunDetail.tsx`, `apps/web/src/components/RunPanels.tsx` (or where the pool-edit block lives), `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Test: new colocated `apps/web/src/components/forms/GapEditForm.test.tsx`

**Interfaces:**
- Consumes: `api.setGaps` (Task 8), `RunDto.buyGapPpm/sellGapPpm` (Task 8), `gapText` formatter (added here, consumed by Task 11).
- Produces: `<GapEditForm runId={number} initialBuyPpm={number} initialSellPpm={number} onSaved={() => void} />` mounted beside the pool editor on RunDetail; run header shows both gaps.

- [ ] **Step 1: Write the failing test** — `GapEditForm.test.tsx` (pattern-match `PoolEditForm`-style tests or the existing `poolInput` test in `RunDetail.test.tsx`; if the pool editor has no own test file, keep this component's test self-contained with `vi.mock('../../api')`):

```tsx
it('prefills percents from ppm and posts ppm on save', async () => {
  // render <GapEditForm runId={1} initialBuyPpm={5000} initialSellPpm={0} onSaved={fn} />
  // buy input shows '0.5', sell input shows ''
  // change buy to '1', click save → setGaps called with { buyGapPpm: 10000, sellGapPpm: 0 }, onSaved fired
})
it('rejects >100 with inline error and no post', async () => { /* type '101' → save disabled or error note */ })
```

- [ ] **Step 2: Run to confirm failure** — FAIL (module missing).
- [ ] **Step 3: Implement** — `GapEditForm.tsx`: two `Input`s + `Button`, local `error` state via `ErrorNote`, reuses `isGapText`/`gapToPpm` logic — export both from `CreateRunForm.tsx` or copy into a small shared module `apps/web/src/gaps.ts` (preferred, keeps files small): create `gaps.ts` with `isGapText`, `gapToPpm`, and `ppmToPercentText(ppm: number): string` (`ppm === 0 ? '' : (ppm / 10_000).toString()` — trim trailing zeros via `String(Number((ppm / 10_000).toFixed(4)))`), and make `CreateRunForm` (Task 9) import from it. Prefill with `ppmToPercentText`. On save: validate both, `await api.setGaps(...)`, then `onSaved()`; on `ApiError` show `t('runDetail.gapSaveFailed') + ' (' + err.code + ')'`.
  Mount in RunDetail next to the pool editor: `<GapEditForm runId={run.id} initialBuyPpm={run.buyGapPpm} initialSellPpm={run.sellGapPpm} onSaved={reload} />` (use the page's existing reload function name).
  Also add to `apps/web/src/format.ts` (Task 11 consumes it): `export function gapText(percent: number | null | undefined, t: (key: string) => string): string` — `null`/undefined → `'—'`, `0` → `t('fmt.gapDefault')`, else `percent + '%'` — plus its `fmt.gapDefault` strings (both catalogs, this task). Add a `format.test.ts` case for it following the existing formatter tests.
  Header: two `Stat` rows — `t('runDetail.buyGap')` → `gapText(run.buyGapPpm / 10_000, t)` and likewise sell.
- [ ] **Step 4: i18n** — en.json:

```json
"runDetail.gapFormTitle": "Order price gaps",
"runDetail.gapSave": "Save gaps",
"runDetail.gapSaveFailed": "gap update failed",
"runDetail.buyGap": "Buy gap",
"runDetail.sellGap": "Sell gap",
"fmt.gapDefault": "default"
```

ko.json:

```json
"runDetail.gapFormTitle": "주문 가격 간격",
"runDetail.gapSave": "간격 저장",
"runDetail.gapSaveFailed": "간격 업데이트 실패",
"runDetail.buyGap": "매수 간격",
"runDetail.sellGap": "매도 간격",
"fmt.gapDefault": "기본값"
```

- [ ] **Step 5: Run to confirm pass** — `bun run --cwd apps/web test` + `bun run typecheck`.
- [ ] **Step 6: Commit** — `git commit -m "feat(web): gap editor on run detail"` (all files touched by this task, staged explicitly by path).

---

### Task 11: Sim form gap fields + sim run display

**Files:**
- Modify: `apps/web/src/pages/Sim.tsx`, `apps/web/src/components/SimReplay.tsx`
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Test: `apps/web/src/pages/Sim.test.tsx`, `apps/web/src/components/SimReplay.test.tsx` (append)

**Interfaces:**
- Consumes: `SimInput.buyGapPpm/sellGapPpm` (Task 8), `SimRunDto` fields (Task 8), `gapToPpm`/`ppmToPercentText` (Task 10's `gaps.ts`), `gapText` (Task 10's `format.ts`).

- [ ] **Step 1: Write the failing tests** — append:

`Sim.test.tsx` (follow existing pool/cost field tests): typing `0.5`/`2` into `getByTestId('buyGapInput')`/`'sellGapInput'` submits `buyGapPpm: 5000, sellGapPpm: 20000`; blank submits 0.
`SimReplay.test.tsx`: detail for a stored run with `buyGapPpm: 5000, sellGapPpm: 0` renders `0.5%` and the default marker.

- [ ] **Step 2: Run to confirm failure** — FAIL.
- [ ] **Step 3: Implement** —
  `Sim.tsx`: add `buyGap`/`sellGap` text state + two `Field`/`Input` pairs beside cost (identical shape to Task 9, testids `buyGapInput`/`sellGapInput`, `isGapText` validation feeding `valid`), submit with `buyGapPpm: s === '' ? 0 : gapToPpm(s)` (same for sell).
  `SimReplay.tsx`: where stored-run meta renders (near `simDetail.cost`), add rows `t('simDetail.buyGap')` → `gapText(row.buyGapPpm / 10_000, t)` and `t('simDetail.sellGap')` → `gapText(row.sellGapPpm / 10_000, t)`.
- [ ] **Step 4: i18n** — en.json:

```json
"simForm.buyGapLabel": "Buy gap (%)",
"simForm.sellGapLabel": "Sell gap (%)",
"simDetail.buyGap": "Buy gap",
"simDetail.sellGap": "Sell gap"
```

ko.json:

```json
"simForm.buyGapLabel": "매수 간격 (%)",
"simForm.sellGapLabel": "매도 간격 (%)",
"simDetail.buyGap": "매수 간격",
"simDetail.sellGap": "매도 간격"
```

- [ ] **Step 5: Run to confirm pass** — `bun run --cwd apps/web test` + `bun run typecheck`.
- [ ] **Step 6: Commit** — `git commit -m "feat(web): gap inputs in sim form, gaps in sim detail"` (all files touched by this task, staged explicitly by path).

---

### Task 12: Full verification + E2E

**Files:**
- Possibly modify: `scripts/e2e.ts` (only if its fake payloads break on new required server fields — they should not, gaps are optional)

**Interfaces:** Consumes everything; produces the final green run.

- [ ] **Step 1: Full unit suites** — `bun test` → 0 fail.
- [ ] **Step 2: DB-gated suites** — `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` (container `st-mariadb-test`; start it per AGENTS.md if down) → 0 fail, migration 0003 applies.
- [ ] **Step 3: Operator E2E** — `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts` → `E2E OK`.
- [ ] **Step 4: Web + types** — `bun run --cwd apps/web test`; `bun run typecheck`.
- [ ] **Step 5: Commit (if anything changed)** — `git commit -m "test: gap feature verification fixes"` (all files touched by this task, staged explicitly by path).

---

## Non-goals (do not build)

- Per-bucket gaps; gap presets; Telegram gap editing.
- Rounding the legacy default sell formula; changing fees, pool, or the
  forced-exit market sell.
- Any refactor beyond the files listed above.
