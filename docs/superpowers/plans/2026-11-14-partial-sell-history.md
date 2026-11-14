# Partial-Sell History + Per-Line Recalc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every sell — partial included — produces a `ClosedBucket` history row, and a per-row "Update" button re-derives a run's stored state from its fill history.

**Architecture:** The core reducer `applySellFill` gains a tranche row on partial sells (single-bucket, fee remainder on the closing row). A new `recalcRunState` in the server domain replays fills through `rebuildState` (Cash Model A) and persists the result, exposed as `POST /api/runs/:id/recalc`. The web History tab renders one row per tranche and gets an Update column wired to that endpoint.

**Tech Stack:** Bun + TypeScript monorepo, bigint myriadths money, Hono routes, React (bun:test + happy-dom).

**Spec:** `docs/superpowers/specs/2026-11-14-partial-sell-history-design.md`

## Global Constraints

- Money: prices are `bigint` myriadths, fees/cash integer `number` cents — never float for money.
- `packages/*` never import `apps/*`.
- No source file over ~300 lines.
- All user-facing copy goes through `apps/web/src/i18n/en.json` + `ko.json`.
- Commit style: `feat|fix|docs|test|chore:`.
- All test commands run from the repo root: `bun test <path>`.
- Typecheck: `bun run typecheck`.

## Review Focus

Failure modes no single task's happy path exercises; each line is pinned by a named test in the owning task:

- Two partial sells of one bucket **on the same date** must render as two distinct History rows — naive React keys (`index`+date) collide. (Task 4: "renders repeated same-date rows")
- Per-tranche buy-fee rounding must still make `sum(closed.buyFeeCents)` of a bucket equal the booked buy fee exactly. (Task 1: "buy fees sum exactly")
- Recalc of a run whose state already matches history must write **no** ledger row — no phantom `adjust`. (Task 3: "books nothing when cash unchanged")
- Recalc must repair a run whose stored state predates the core fix without touching fills, orders, or pending rows. (Task 3: "repairs legacy state without touching fills")
- Over-selling beyond remaining bucket shares must still throw after partial rows exist — the tranche row must not bypass the guard. (Task 1: "over-sell guard survives partial rows")

---

### Task 1: Core — partial sell appends a tranche row

**Files:**
- Modify: `packages/core/src/fills.ts` (`applySellFill`, else-branch at line 129-131)
- Modify: `packages/core/test/fills.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `applySellFill(state, bucketIndex, shares, price, feeCents, closedOn?)` now appends a `ClosedBucket` row `{ index, shares, buyPrice, soldPrice, buyFeeCents, sellFeeCents, openedOn, closedOn }` on **partial** sells too, and shrinks `bucket.buyFeeCents` by the tranche's proportional part. Unchanged for callers.

- [ ] **Step 1: Update the stale 'partial sell' expectations** in `packages/core/test/fills.test.ts:20-31` — replace `expect(out.closed.length).toBe(0)` with assertions for one tranche row (full row shape below). Add a comment: `// 2026-11-14: partial sells now record a tranche row (spec 2026-11-14-partial-sell-history)`.

- [ ] **Step 2: Write the failing tests** (append to `packages/core/test/fills.test.ts`):

```ts
test('partial sell appends a tranche row', () => {
  const s = emptyState(1); s.cashCents = 0
  const b = applyBuyFill(s, 0, 300, 1000000n, 7, '2026-01-02')
  const out = applySellFill(b, 0, 120, 1020000n, 21, '2026-01-09')
  expect(out.closed.length).toBe(1)
  expect(out.closed[0]).toEqual({
    index: 0, shares: 120, buyPrice: 1000000n, soldPrice: 1020000n,
    buyFeeCents: 3, sellFeeCents: 21, openedOn: '2026-01-02', closedOn: '2026-01-09',
  })
  expect(out.buckets[0]!.state).toBe('held')
  expect(out.buckets[0]!.shares).toBe(180)
  expect(out.buckets[0]!.buyPrice).toBe(1000000n)
  expect(out.buckets[0]!.buyFeeCents).toBe(4) // 7 - round(7 * 120 / 300)
})

test('buy fees sum exactly across partial and closing rows', () => {
  const s = emptyState(1); s.cashCents = 0
  const b = applyBuyFill(s, 0, 300, 1000000n, 7, '2026-01-02')
  const p = applySellFill(b, 0, 120, 1020000n, 21, '2026-01-09')
  const out = applySellFill(p, 0, 180, 990000n, 25, '2026-02-01')
  expect(out.closed.length).toBe(2)
  expect(out.closed.reduce((n, c) => n + c.buyFeeCents, 0)).toBe(7)
  expect(out.closed.reduce((n, c) => n + c.sellFeeCents, 0)).toBe(46)
  expect(out.buckets[0]!.state).toBe('empty')
})

test('over-sell guard survives partial rows', () => {
  const s = emptyState(1); s.cashCents = 0
  const b = applyBuyFill(s, 0, 300, 1000000n, 0)
  const p = applySellFill(b, 0, 250, 1020000n, 0)
  expect(() => applySellFill(p, 0, 51, 1020000n, 0)).toThrow() // DomainError too-many-shares
})
```

- [ ] **Step 3: Run to verify failure** — `bun test packages/core/test/fills.test.ts`; expect the three new/updated tests to FAIL (`closed.length` is 0 after partial sells).

- [ ] **Step 4: Implement** the else-branch in `applySellFill` (`packages/core/src/fills.ts:129-131`): compute `buyFeePart = Math.round((bucket.buyFeeCents * shares) / bucket.shares)`, append the tranche row (`openedOn: bucket.filledOn`, `closedOn` = the parameter, whole `feeCents` as `sellFeeCents`), then `nb.shares = bucket.shares - shares` and `nb.buyFeeCents = bucket.buyFeeCents - buyFeePart`. The full-close branch (line 111-128) and cash line (132) stay byte-identical.

- [ ] **Step 5: Run full core suite** — `bun test packages/core/test/`; fix any other stale expectation the change invalidates (e.g. `force_sell partial preserves` around line 112 asserting an empty `closed`) the same way, with the dated comment. Then `bun run typecheck`.

- [ ] **Step 6: Commit** — `git add packages/core && git commit -m "feat: partial sells append closed tranche rows"`

### Task 2: Strategies — repeated rows aggregate

**Files:**
- Modify: `packages/strategies/test/mean-reversion.test.ts`

**Interfaces:**
- Consumes: `progressView(state)` (unchanged code — this task pins behavior for multi-row buckets).
- Produces: tests only.

- [ ] **Step 1: Write the failing-or-pinning test** (append to `packages/strategies/test/mean-reversion.test.ts`; construct the `RunState` by hand with `emptyState`, then set `state.closed`):

```ts
test('progressView aggregates repeated closed rows of one index', () => {
  const s = emptyState(2); s.cashCents = 0
  s.closed = [
    { index: 0, shares: 60, buyPrice: 1000000n, soldPrice: 1020000n, buyFeeCents: 1, sellFeeCents: 2, openedOn: '2026-01-02', closedOn: '2026-01-09' },
    { index: 0, shares: 40, buyPrice: 1000000n, soldPrice: 990000n, buyFeeCents: 1, sellFeeCents: 2, openedOn: '2026-01-02', closedOn: '2026-01-10' },
  ]
  const pv = progressView(s)
  expect(pv.realizedCents).toBe(11997 - 4003) // per-row roundDiv, then summed
  expect(pv.winRate).toBe(0.5)                // two tranches: one win, one loss
})
```

(`progressView` already iterates rows, so this may pass immediately — it is the regression pin for repeated-index rows. If it passes, note "pinning test, no code change" in the commit message.)

- [ ] **Step 2: Run** — `bun test packages/strategies/test/` → PASS.
- [ ] **Step 3: Commit** — `git add packages/strategies && git commit -m "test: progressView aggregates repeated closed rows"`

### Task 3: Server — `recalcRunState` + `POST /runs/:id/recalc`

**Files:**
- Modify: `apps/server/src/domain/booking.ts` (after `deleteFill`, end of file)
- Modify: `apps/server/src/http/routes/fills.ts`
- Modify: `apps/server/test/booking.test.ts`, `apps/server/test/http.test.ts`

**Interfaces:**
- Consumes: Task 1's partial-sell rows via `rebuildState`; `fakeRepos()` from `apps/server/test/booking.test.ts:25`; `bookingDeps()` helper in `fills.ts:10`.
- Produces: `export async function recalcRunState(runId: number, deps: BookingDeps): Promise<RunState>` in `booking.ts`; route `POST /api/runs/:id/recalc` → `200 {ok:true}` | `404 {error:'no-run'}` | `422 {error: <DomainError.kind>}`.

- [ ] **Step 1: Write the failing domain tests** in `apps/server/test/booking.test.ts` (follow the file's existing fake-repo style; book fills with `manualFill` as neighboring tests do):

```ts
test('recalcRunState books nothing when cash unchanged', ...)
// manual buy + partial sell -> recalcRunState -> ledger listForRun length unchanged,
// loadState() closed.length === 1 with shares matching the partial sell.

test('recalcRunState repairs legacy state without touching fills', ...)
// book buy(300) + partial sell(120); then corrupt: loadState, drop state.closed rows
// and restore bucket shares to 300, saveState; recalcRunState;
// assert closed has the tranche row again, fillRepo.listForRun length unchanged,
// ledger length unchanged (cash was never corrupted), order/pending stores untouched.

test('recalcRunState books adjust on cash drift', ...)
// book a sell, corrupt only state.cashCents (+500), recalcRunState;
// ledger gains one row { kind: 'adjust', amountCents: -500, ref contains "recalc" }.
```

- [ ] **Step 2: Run** — `bun test apps/server/test/booking.test.ts` → FAIL (`recalcRunState` not exported).

- [ ] **Step 3: Implement `recalcRunState`** at the end of `apps/server/src/domain/booking.ts`, mirroring `deleteFill` (line 306-326) minus the delete: guard `repos.fillRepo.listForRun` (`throw new Error('fill-history-unavailable')`), `byIdAsc(listForRun)`, `runRepo.get`, `loadState`, `rebuildState(history, run.poolCents, deps.today, state.buckets.length)`, `saveState`, and when `rebuilt.cashCents !== state.cashCents` insert `{ runId, kind: 'adjust', amountCents: rebuilt.cashCents - state.cashCents, ref: JSON.stringify({ bookedOn: deps.today, reason: 'recalc' }) }`. Return `rebuilt`. Run: `bun test apps/server/test/booking.test.ts` → PASS.

- [ ] **Step 4: Write the failing route tests** in `apps/server/test/http.test.ts` (mirror how existing fill-route tests build the app + seed a run):
  - `POST /api/runs/1/recalc` → `200` `{ ok: true }` and the stored state has the tranche row.
  - unknown run id → `404` `{ error: 'no-run' }`.
  - corrupt a stored sell fill row to `shares` exceeding the bucket (insert via the fake `fillRepo`) → `422` `{ error: 'too-many-shares' }`.

- [ ] **Step 5: Implement the route** in `fillsRouter` (`apps/server/src/http/routes/fills.ts`) exactly as the spec §4 block, importing `recalcRunState` next to `rebookFill`/`deleteFill`. Run: `bun test apps/server/test/` → PASS. `bun run typecheck` → clean.

- [ ] **Step 6: Commit** — `git add apps/server && git commit -m "feat: recalc run state from fill history via POST /runs/:id/recalc"`

### Task 4: Web — Update column in History

**Files:**
- Modify: `apps/web/src/api.ts` (interface near line 120, impl near line 190)
- Modify: `apps/web/src/components/RunHistory.tsx`
- Modify: `apps/web/src/pages/RunDetail.tsx` (usage at line 175)
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Create: `apps/web/src/components/RunHistory.test.tsx` (copy the harness setup from `apps/web/src/components/FillTable.test.tsx:1-40`)

**Interfaces:**
- Consumes: `POST /api/runs/:id/recalc` (Task 3).
- Produces: `api.recalcRun(runId: number): Promise<void>`; `RunHistory({ closed, onRecalc }: { closed: ClosedBucketDto[]; onRecalc?: () => Promise<void> })`.

- [ ] **Step 1: Add i18n keys** next to `historyCol*`: en `"historyColActions": "Actions"`, `"updateButton": "Update"`; ko `"historyColActions": "관리"`, `"updateButton": "갱신"`.

- [ ] **Step 2: Write the failing component tests** in `apps/web/src/components/RunHistory.test.tsx`:
  - "renders repeated same-date rows": two `ClosedBucketDto`s, same `index: 0`, same `closedOn: '2026-01-09'`, shares 60/40 → `tbody tr` count 2, both shares values present, no React duplicate-key warning.
  - "Update calls onRecalc and disables while pending": render with a stub `onRecalc` returning a controllable promise; click the first Update button → stub called once, button `disabled` until the promise resolves.
  - "no actions column without onRecalc": render without the prop → header text `관리`/`Actions` absent.

- [ ] **Step 3: Run** — `bun test apps/web/src/components/RunHistory.test.tsx` → FAIL.

- [ ] **Step 4: Implement:**
  - `api.ts`: `recalcRun(runId: number): Promise<void>;` on the interface; impl `recalcRun: (runId) => send<{ ok: true }>('POST', `/api/runs/${runId}/recalc`).then(() => undefined)` next to `deleteFill`.
  - `RunHistory.tsx`: map gets `(c, i)`; row key `` `${c.index}-${i}` ``; new optional `onRecalc` prop; when present, trailing `<Th className="text-right">{t('historyColActions')}</Th>` and per-row `<Td>` with `<Button disabled={busy !== null} onClick={() => void handle(i)}>{t('updateButton')}</Button>` where `handle` sets a local `useState<number | null>` busy row, awaits `onRecalc()`, clears it in `finally`. Component stays presentational — no `api` import.
  - `RunDetail.tsx`: beside `setStatus` add
    ```ts
    const [recalcing, setRecalcing] = useState(false);
    const recalc = async () => { setRecalcing(true); try { await api.recalcRun(id); await reload(); } finally { setRecalcing(false); } };
    ```
    and pass `onRecalc={recalc}` at the `<RunHistory ... />` usage (line 175); disable nothing extra beyond the component's own busy state.
- [ ] **Step 5: Run** — `bun test apps/web/` → PASS (existing RunPanels/SimReplay tests unaffected). `bun run typecheck` → clean.

- [ ] **Step 6: Commit** — `git add apps/web && git commit -m "feat: per-row Update button recalculates run history"`

---

## Dependency / dispatch notes

- Task 1 → Task 3 (domain tests replay partial sells through `rebuildState`).
- Tasks 1, 2, 4 are mutually independent (no shared files) and may run in parallel worktrees; Task 3 merges after Task 1.
