# Fill Edit & Delete + Cash Model A — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit/delete captured fills (Qty/Price/Fee, both sides) via one popup shared with "Add fill"; cash = pool + top-ups + Σ signed fill effects; realized stays closed-bucket history.

**Architecture:** Server rebuilds run state from fill history (pure `applyBuyFill`/`applySellFill` replay for buckets/closed/ages; cash diff-anchored from source-of-truth ledger lines). HTTP `PUT`/`DELETE /runs/:id/fills/:fillId`. Web: one `FillDialog` (add/modify), per-row Edit, Delete for newest fill only.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle/MySQL, React + Vitest, `@st/core` bigint myriadths money.

**Spec:** `docs/superpowers/specs/2026-11-13-fill-edit-delete-design.md`

**Conventions:** packages/* never import apps/*; money via `@st/core/money`; user copy in `apps/web/src/i18n/en.json` AND `ko.json`; commit style `feat|fix|test|chore:`; run all commands from repo root.

---

### Task 1: Domain — pure `rebuildState` + cash anchoring in booking.ts

**Files:**
- Modify: `apps/server/src/domain/booking.ts`
- Test: `apps/server/test/rebooking.test.ts` (create)

- [ ] **Step 1: Write failing tests** in `apps/server/test/rebooking.test.ts` using the fake-repo pattern from `apps/server/test/booking.test.ts` (read it first; `fakeRepos()` already supports `fillRepo.listByRun`, `bucketRepo.loadState/saveState/deleteState`, `ledgerRepo`). Import `emptyState` from `@st/core/fills`. Test `runBooking` with these `manualFill` inputs:

1. `rebookFill(run, {fillId: 2, qty: 12, priceCents: 18000, feeCents: 400})` after two seed fills (bucket0 @1000.00, bucket1 @1500.00, seedCash) → bucket0 shares=12 buyPrice=1800000 buyFee=400; cash == poolCash − newEffect1 − effect2 where `poolCash` passed in seed-style (simulate by booking seed with `seedCashCents`, then rebook — assert cash equals `seedCashCents - (BigInt(12)*1800000n/100n - ... )`; compute expected in-test with `roundDiv` from `@st/core/money`); one ledger row `kind:'adjust'` added.
2. `rebookFill` restore-to-exact-values → ledgerRepo rows count unchanged (no adjust when delta 0).
3. `rebookFill` bucket0 100→200 qty, pool 100_000 seed 70_000 → `DomainError('insufficient-cash')`; state and ledger untouched (re-read via loadState).
4. `rebookFill` sell → `DomainError('immutable-field')`.
5. `deleteLastFill(run)` on sell-last buy-last run → bucket1 state 'empty', age for idx1 removed, cash = cashBefore + effect2, one adjust row `reason:'fill-delete'`.
6. `deleteLastFill` on sell-last closes bucket: seed@1000 + sell@2000 (fee 0) → delete sell → bucket1 held again, closed empty, ages has idx1 (positive number).
7. `deleteLastFill` on buy-last partial-sell run → `DomainError('not-last')` (list fills: sell id > buy id, newest = sell → delete newest leaves buy last; then call deleteLastFill again → deletes buy? No: after sell delete the newest IS the buy → second call succeeds). Assert second call removes bucket0.
8. `deleteLastFill` on sell-last whose buy fill is also deleted-last chain — covered by 7; plus `DomainError('not-last')` when run has NO fills → `no-fill`.
9. `rebookFill` buy changing bucketIdx is impossible (bucketIdx from fill record) but changing qty so replay becomes invalid: seed buy bucket0, then second seed buy bucket1, rebook fill1 price so that… (skip — no transition error possible from qty/price change on a buy into an empty bucket; assert instead that rebooking a BUY whose bucket was later sold keeps closed consistent: seed buy b0 @1000, sell b0 @2000 fee 500, rebook buy fee to 900 → closed[0].buyFeeCents=900, realized shifts by −400 (verify `progressView(run.state).realizedCents` from `@st/strategies`).)

- [ ] **Step 2: Run to verify failure**
Run: `bun test apps/server/test/rebooking.test.ts`
Expected: FAIL — `rebookFill`/`deleteLastFill` not exported.

- [ ] **Step 3: Implement in `apps/server/src/domain/booking.ts`** (after `manualFill`):

```ts
interface Line { fillId: number; qty: number; priceCents: number; feeCents: number }
const signedCents = (l: Line): bigint => {
  const gross = roundDiv(BigInt(l.priceCents) * BigInt(l.qty), 100n)
  return l.side === 'buy' ? -(gross + BigInt(l.feeCents)) : gross - BigInt(l.feeCents)
}

/** Pure rebuild of buckets/closed/ages from fills in id order. Cash NOT touched. */
export function rebuildState(run: Run, lines: Line[], agesBefore: Record<number, number>, today: string): RunState {
  let s = emptyState()
  for (const l of lines) {
    const input: FillInput = {
      source: 'manual', side: l.side, qty: l.qty,
      priceMyriadths: BigInt(l.priceCents) * 10_000n,
      bucketIdx: l.bucketIdx, feeCents: BigInt(l.feeCents),
      filledOn: l.filledOn, bookedOn: today,
    }
    s = l.side === 'buy' ? applyBuyFill(s, input) : applySellFill(s, input)
  }
  const touched = new Set(lines.map((l) => l.bucketIdx))
  for (const b of s.buckets) {
    if (!touched.has(b.index)) {
      const prev = agesBefore[b.index]
      if (prev !== undefined) s.age[b.index] = prev
    } else if (b.state === 'held') {
      const age = ageBuckets(agesBefore, today, { [b.index]: s.buckets[b.index]!.filledOn! })[b.index]
      if (age !== undefined) s.age[b.index] = age
    }
  }
  return s
}
```

Wait — `FillInput` fields `source`/`bookedOn` required; `applyBuyFill` doesn't read them but type does. Fills carry `bucketIdx`/`side`/`filledOn`: define `Line` as `Omit<Fill, 'id'|'createdAt'|'bookedOn'|'source'|'ticker'> & { fillId: number }` — simplest: `type Line = Fill` and use fill's own side/bucketIdx/filledOn/bookedOn:

```ts
export function rebuildState(run: Run, fills: Fill[], agesBefore: Record<number, number>, today: string): RunState {
  let s = emptyState()
  for (const f of fills) s = f.side === 'buy' ? applyBuyFill(s, f) : applySellFill(s, f)
  const touched = new Set(fills.map((f) => f.bucketIdx))
  for (const b of s.buckets) {
    if (!touched.has(b.index)) {
      const prev = agesBefore[b.index]
      if (prev !== undefined) s.age[b.index] = prev
    } else if (b.state === 'held') {
      const opened: Record<number, string> = { [b.index]: b.filledOn! }
      const age = ageBuckets(agesBefore, today, opened)[b.index]
      if (age !== undefined) s.age[b.index] = age
    }
  }
  return s
}
```

`Fill` structurally satisfies `FillInput` (source 'seed'|'capture'|'manual' ⊆ FillInput['source']; bookedOn present). If TS complains about `side`/`state` unions, cast at call site.

Then the two orchestrators (both `deps`-free except ledger write — reuse the `deps?:` pattern):

```ts
export async function rebookFill(
  run: Run,
  edit: { fillId: number; qty: number; priceCents: number; feeCents: number },
  today: string,
  poolCash: number,
  deps?: BookingDeps,
): Promise<BookingOutcome> {
  const fills = await fillRepo.listByRun(run.id)
  const target = fills.find((f) => f.id === edit.fillId)
  if (!target) throw new DomainError('no-fill')
  if (target.side !== 'buy') throw new DomainError('immutable-field')
  const edited: Fill = { ...target, qty: edit.qty, priceCents: edit.priceCents, feeCents: edit.feeCents }
  return applyRebuild(run, fills, target, edited, 'fill-edit', today, poolCash, deps)
}

export async function deleteLastFill(
  run: Run, today: string, poolCash: number, deps?: BookingDeps,
): Promise<BookingOutcome> {
  const fills = await fillRepo.listByRun(run.id)
  const last = fills[fills.length - 1]
  if (!last) throw new DomainError('no-fill')
  return applyRebuild(run, fills, last, null, 'fill-delete', today, poolCash, deps)
}

async function applyRebuild(
  run: Run, fills: Fill[], target: Fill, edited: Fill | null,
  reason: string, today: string, poolCash: number, deps?: BookingDeps,
): Promise<BookingOutcome> {
  const booked = (await bucketRepo.loadState(run.id)) ?? emptyState()
  const lines = fills.map((f) => (f.id === target.id ? edited : f)).filter((f): f is Fill => f !== null)
  let rebuilt: RunState
  try {
    rebuilt = rebuildState(run, lines, booked.age, today)
  } catch (e) {
    if (e instanceof DomainError) throw e
    throw new DomainError('invalid-fill')
  }
  const kept = lines.filter((f) => f.id !== target.id)
  const cash = BigInt(poolCash) + kept.reduce((sum, f) => sum + signedCents(f), 0n)
  const delta = cash - BigInt(booked.cashCents)
  const state: RunState = { ...rebuilt, cashCents: Number(cash) }
  if (delta !== 0n) {
    const row = { runId: run.id, ts: now(), kind: 'adjust' as const,
      deltaCents: Number(delta), cashAfter: Number(cash),
      ref: JSON.stringify({ fillId: target.id, bookedOn: today, reason }) }
    state.ledger = [...rebuilt.ledger, row]
    if (deps) await deps.ledgerRepo.insert(run.id, row)
  }
  if (deps) {
    if (edited) await deps.fillRepo.update(run.id, target.id, { qty: edited.qty, priceCents: edited.priceCents, feeCents: edited.feeCents })
    else await deps.fillRepo.deleteLast(run.id)
    await deps.bucketRepo.saveState(run.id, state)
  }
  const notices: Notice[] = []
  return { run: { ...run, initialRunState: state }, orders: [], notices, state }
}
```

Import `ageBuckets` from `@st/strategies`; extend the `DomainError` code union with `'immutable-field' | 'not-last' | 'invalid-fill'`.

- [ ] **Step 4: Run tests** `bun test apps/server/test/rebooking.test.ts` → iterate to green (watch: test 3 must leave `loadState` unchanged — throw happens before any deps write).

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: rebuild run state from fill history on rebook and delete"`

---

### Task 2: Repos — `fillRepo.update` + `fillRepo.deleteLast`

**Files:**
- Modify: `apps/server/src/db/repos.ts` (fillRepo block ~line 100-130; read existing first)
- Test: `apps/server/test/db.test.ts` (extend; self-skips without DB)

- [ ] **Step 1:** In `fillRepo` add:

```ts
    async update(runId: number, fillId: number, patch: { qty: number; priceCents: number; feeCents: number }): Promise<void> {
      await db.update(s.fills).set(patch).where(and(eq(s.fills.id, fillId), eq(s.fills.runId, runId)))
    },
    async deleteLast(runId: number): Promise<void> {
      const last = await db.select().from(s.fills).where(eq(s.fills.runId, runId))
        .orderBy(desc(s.fills.id)).limit(1)
      if (last[0]) await db.delete(s.fills).where(eq(s.fills.id, last[0].id))
    },
```

Match the file's existing import style (`and`, `desc` may need adding to the drizzle import line).

- [ ] **Step 2:** Extend `db.test.ts`: insert 2 fills → update qty of first → assert listByRun reflects it; deleteLast → newest gone, count 1; deleteLast again → count 0.

- [ ] **Step 3:** With test DB up (`docker run -d --name st-mariadb-test -e MARIADB_ROOT_PASSWORD=test -e MARIADB_DATABASE=st_test -p 127.0.0.1:3307:3306 mariadb:11`):
Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db.test.ts` → green (or `skip`-reported if DB absent — note it).

- [ ] **Step 4: Commit** `git commit -am "feat: fillRepo update and deleteLast"`

---

### Task 3: HTTP routes — PUT/DELETE fills + pool-aware booking

**Files:**
- Modify: `apps/server/src/domain/booking.ts` — `seedRun`: after `state.cashCents = seedCashCents` add `await ledgerRepo.insert` of kind `'seed'` row `{ ref: JSON.stringify({ bookedOn: today, reason: 'seed' }) }` ONLY when `deps` present, and include it in `state.ledger` only if seed is saved as a fill row — check how seed ledger is persisted today (grep `seedRun(` callers; `apps/server/src/sim/sim.ts` and routes/runs.ts create runs). If adding this row would double-count `lines()` later, exclude kind 'seed' from lines instead: **decision: `lines()` filters `kind !== 'adjust' || reason startsWith 'fill-'` — simpler: adjust rows carry `reason` in ref; lines() = fills only. Cash truth = pool + Σ effects; the 'seed' ledger row is display-only. Do NOT filter anything else.**
- Modify: `apps/server/src/http/routes/fills.ts`
- Modify: `apps/server/src/http/routes/runs.ts` line ~79 and pool route + `apps/server/src/pipeline/day.ts` `dep.runState` — **only fills.ts + a shared helper**; pool/topup consistency needs no change because rebook computes from `pool + Σ fills`.
- Test: `apps/server/test/http.test.ts` (extend)

- [ ] **Step 1: Add helper** in fills.ts: `const poolCashOf = async (runId: number): Promise<number> => { const run = await deps.runRepo.get(runId); const edits = await deps.poolEditRepo.listByRun ? ... : null; ... }` — **read `runs.ts` POST /runs/:id/pool and `runRepo.updatePool` semantics first: poolCents on run row IS absolute current pool; `poolEdits` is history only.** So `poolCashOf = (await deps.runRepo.get(runId)).poolCents`. No new ledger plumbing needed; Task 3 Step 3 seed-row idea above is CANCELLED (rebook never reads ledger — drop it).

- [ ] **Step 2: Write failing HTTP tests** in `http.test.ts` (mirror existing fill-capture test setup):
- PUT /runs/:id/fills/:id happy path: seed run, capture a manual fill via existing POST, then PUT `{"qty":12,"priceCents":18000,"feeCents":400}` → 200, `{"ok":true}`; GET run state shows bucket shares 12.
- PUT unknown fillId → 422 `{"error":"no-fill"}`; PUT sell fill → 422 `{"error":"immutable-field"}`; PUT negative qty / non-integer price / negative fee → 400; PUT buy with huge qty that breaks cash invariant → 422 `{"error":"insufficient-cash"}`.
- DELETE /runs/:id/fills/:lastFillId → 200 and state rolled back; DELETE with mismatched/older id → 422 `{"error":"not-last"}`; DELETE on run with no fills → 422 `{"error":"no-fill"}`; routes require auth like siblings (401/403 when unauthenticated per existing pattern).

- [ ] **Step 3: Implement** in `fills.ts` (follow `runs.ts` style: `Number(c.req.param(...))`, JSON body with catch, numeric guards → 400, `DomainError` → `c.json({ error: e.code }, 422)`):

```ts
  r.put('/runs/:id/fills/:fillId', async (c) => {
    const runId = Number(c.req.param('id'))
    const fillId = Number(c.req.param('fillId'))
    const body = await c.req.json().catch(() => ({}))
    const { qty, priceCents, feeCents } = body ?? {}
    if (!Number.isInteger(qty) || qty <= 0 || !Number.isInteger(priceCents) || priceCents <= 0
      || !Number.isInteger(feeCents) || feeCents < 0) return c.json({ error: 'invalid body' }, 400)
    const run = await deps.runRepo.get(runId)
    if (!run) return c.json({ error: 'not-found' }, 404)
    try {
      const out = await rebookFill(run, { fillId, qty, priceCents, feeCents }, deps.today, run.poolCents, {
        fillRepo: deps.fillRepo, bucketRepo: deps.bucketRepo, ledgerRepo: deps.ledgerRepo,
      })
      await deps.runRepo.updateState(runId, out.state)
      return c.json({ ok: true })
    } catch (e) {
      if (e instanceof DomainError) return c.json({ error: e.code }, 422)
      throw e
    }
  })
  r.delete('/runs/:id/fills/:fillId', async (c) => {
    const runId = Number(c.req.param('id'))
    const fillId = Number(c.req.param('fillId'))
    const run = await deps.runRepo.get(runId)
    if (!run) return c.json({ error: 'not-found' }, 404)
    const last = await deps.fillRepo.lastId(runId)
    if (last === null || last !== fillId) return c.json({ error: 'not-last' }, 422)
    try {
      const out = await deleteLastFill(run, deps.today, run.poolCents, { /* deps trio */ })
      await deps.runRepo.updateState(runId, out.state)
      return c.json({ ok: true })
    } catch (e) {
      if (e instanceof DomainError) return c.json({ error: e.code }, 422)
      throw e
    }
  })
```

Add `lastId(runId)` to `fillRepo` (Task 2 file): select id desc limit 1, return `number | null`. Check `runRepo.updateState` exists (used by `pipeline/wire.ts`); if it's named differently use the existing updater. Check how routes get `today`/`deps` (`HttpAppDeps`) and mirror `manualFill` route in `runs.ts` for the deps object.

- [ ] **Step 4:** `bun test apps/server/test/http.test.ts` → green. Then `bun test` and `bun run typecheck` → green (self-skips allowed).

- [ ] **Step 5: Commit** `git commit -am "feat: fill edit and delete endpoints"`

---

### Task 4: Web API client

**Files:**
- Modify: `apps/web/src/api.ts`

- [ ] **Step 1:** After `captureManual` (line ~130) add:

```ts
  updateFill: (runId: number, fillId: number, body: { qty: number; priceCents: number; feeCents: number }) =>
    request<{ ok: true }>(`/runs/${runId}/fills/${fillId}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteFill: (runId: number, fillId: number) =>
    request<{ ok: true }>(`/runs/${runId}/fills/${fillId}`, { method: 'DELETE' }),
```

- [ ] **Step 2:** `bun run typecheck` → green. **Step 3:** Commit `"feat(web): fill update/delete api"`.

---

### Task 5: Shared `FillDialog` + auto-fee extraction (TDD)

**Files:**
- Create: `apps/web/src/components/forms/FillDialog.tsx`
- Modify: `apps/web/src/components/forms/ManualCaptureForm.tsx` (import `autoFeeUsd` from FillDialog file, delete its local copy)
- Create: `apps/web/src/components/forms/FillDialog.test.tsx`
- Modify: `apps/web/src/components/forms/ManualCaptureForm.test.tsx`

- [ ] **Step 1: Write failing `FillDialog.test.tsx`** — copy test harness/wrapper (i18n + router providers) from `ManualCaptureForm.test.tsx`. Cases:
1. **add mode** renders Side/Qty/Price/Fee + submit; submitting POSTs (mock `api.captureManual`) resolved side buy + parsed cents; success calls `onSaved` and closes.
2. **modify mode** (`fill` prop = sell fill): Side select `disabled`, prefilled qty/price/fee from fill (`centsToUsdText`), submit calls `api.updateFill(runId, fill.id, {...})` — NOT captureManual.
3. Fee auto-sync in modify mode: change qty 10→20 with fee untouched (no `touched` flag) → fee input doubles; user edits fee manually → further qty changes leave fee alone.
4. Delete: `deletable` + `fill` → Delete button visible; click renders confirm step with `dialog.deleteWarning` text; confirm calls `api.deleteFill`, then `onSaved`. No Delete button in add mode or when `deletable === false`.
5. API error: mock rejects with `ApiError('insufficient-cash', 422)` → `[data-testid="error"]` shows `fillErr.insufficient-cash` translation.
6. Side select in add mode shows resolved buy/sell from bar as today (keep existing behavior).

- [ ] **Step 2:** `bun test apps/web/src/components/forms/FillDialog.test.tsx` → FAIL (missing module).

- [ ] **Step 3: Implement `FillDialog.tsx`.** Move `autoFeeUsd` here **verbatim** (export it), move `toCents` here (keep a re-export or local copy in ManualCaptureForm — ManualCaptureForm may delete `autoFeeUsd`/`toCents` and import from FillDialog). Component contract:

```tsx
interface FillDialogProps {
  runId: number; bucketCount: number;
  bar: { tradeDate: string; closeCents: number } | null; // null in modify mode
  fill?: FillDto; deletable: boolean;
  onClose: () => void; onSaved: () => void;
}
```

Structure: reuse `Modal`, `Field`, `Button`, `useT`, `ApiError` (all from `./ManualCaptureForm`'s current imports — check `Modal` source location). State: `side, qty, price, fee, touched, submitting, error, confirmDelete` — initialize qty/price/fee from `fill` (`centsToUsdText(fill.priceCents)`, `String(fill.qty)`, `centsToUsdText(fill.feeCents)`) or defaults in add mode. `useEffect` auto-fee (skip when `touched`; in modify mode price defaults to `fill.priceCents` when bar null → use `fill.priceCents` as fee basis, keep same formula `autoFeeUsd(side, qty, (fill.priceCents/100).toFixed(2))`). Header: `t('dialog.editFill')` vs `t('dialog.addFill')`. Footer: Cancel | (Delete danger button when `fill && deletable`) | Submit (`dialog.save` / `dialog.add`). Delete click → `confirmDelete` state swaps footer for `[Delete-confirm][Cancel]` with `t('dialog.deleteWarning', { n: qty })`. Submit → validate (`qtyOk`, `priceOk`) → `api.updateFill(...)` when `fill` else existing captureManual flow → `onSaved(); onClose()`; `ApiError` → `t('fillErr.' + code)` fallback raw message → `[data-testid="error"]`. Render inside existing `Modal` (backdrop + dialog roles — same as ManualCaptureForm so its tests' role queries apply).

- [ ] **Step 4:** Update `ManualCaptureForm.test.tsx`: delete its fee-auto-sync tests (moved), keep one import check — or simply delete the whole file IF ManualCaptureForm.tsx is now a thin wrapper scheduled for deletion in Task 6. **Decision: keep `ManualCaptureForm.tsx` compiling (it gets deleted in Task 6); strip its auto-fee test cases now.**

- [ ] **Step 5:** `bun test apps/web/src/components/forms/` → green. **Step 6:** Commit `"feat(web): shared fill dialog for add and modify"`.

---

### Task 6: Wire RunDetail + FillsPanel + FillTable; retire ManualCaptureForm

**Files:**
- Modify: `apps/web/src/components/FillTable.tsx`
- Modify: `apps/web/src/components/RunPanels.tsx` (FillsPanel)
- Modify: `apps/web/src/pages/RunDetail.tsx`
- Modify: `apps/web/src/components/RunPanels.test.tsx` (if it references fills panel)
- Delete: `apps/web/src/components/forms/ManualCaptureForm.tsx` + its test
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`

- [ ] **Step 1: FillTable.** Add optional props `lastFillId?: number; onEdit?: (f: FillDto) => void`. When `onEdit` provided, add `<Th label={t('fills.col.actions')} align="right" />` and a final `<Td align="right">` cell: `<button className="btn btn-ghost btn-sm" onClick={() => onEdit(f)}>{t('fills.edit')}</button>` (only if `onEdit`). Keep everything else byte-identical.

- [ ] **Step 2: FillsPanel** (`RunPanels.tsx:61`): add props `onMutated?: () => void`; own `const [editFill, setEditFill] = useState<FillDto | null | 'new'>(null)`; render `<FillTable fills={fills} lastFillId={fills.length ? fills[fills.length-1].id : undefined} onEdit={setEditFill} />` plus when `editFill`:

```tsx
<FillDialog
  runId={fills[0] ? runIdOf : runId} // FillsPanel needs runId prop — add it
  bucketCount={bucketCount}
  bar={null}
  fill={editFill === 'new' ? undefined : editFill}
  deletable={editFill !== 'new' && editFill !== null && fills[editFill...] } // see note
  onClose={() => setEditFill(null)}
  onSaved={() => { setEditFill(null); onMutated?.() }}
/>
```

`deletable = editFill !== 'new' && editFill.id === lastFillId`. Add `runId: number` to FillsPanel props (RunDetail passes `run.id`). Fills are listed oldest→newest (`fills.ts:92-96` has no ORDER BY; id order) — pass `onClose` and keep the existing bucket-ages fetch effect.

- [ ] **Step 3: RunDetail.** Replace `else if (tab === 'manual') setActiveTab('fills')` with `else if (tab === 'manual') setShowFill(true)`; add `const [showFill, setShowFill] = useState(false)`; render when `showFill`:

```tsx
<FillDialog runId={run.id} bucketCount={bucketCount}
  bar={{ tradeDate: run.lastTradedOn ?? '—', closeCents: run.lastCloseCents ?? 0 }}
  fill={undefined} deletable={false}
  onClose={() => setShowFill(false)}
  onSaved={() => { setShowFill(false); setPanelKey((k) => k + 1); void reload() }} />
```

and pass `onMutated={() => { setPanelKey((k) => k + 1); void reload() }}` to `<FillsPanel …/>`.

- [ ] **Step 4: Delete `ManualCaptureForm.tsx` + `ManualCaptureForm.test.tsx`**; move its still-used tests (`manual-capture-*` ids are gone, so port the add-mode cases already covered in FillDialog.test) — verify `grep -rn ManualCaptureForm apps/web/src` is empty.

- [ ] **Step 5: i18n — add to BOTH catalogs (same key order; `fills.*` after `fills.source.seed` / `필드.*`):**

en:
```json
"fills.col.actions": "Actions",
"fills.edit": "Edit",
"dialog.addFill": "Add fill",
"dialog.editFill": "Modify fill",
"dialog.save": "Save",
"dialog.delete": "Delete",
"dialog.deleteConfirm": "Confirm delete",
"dialog.deleteWarning": "This fill is the newest booked activity. Deleting rolls back {n} shares and its cash effect. This cannot be undone.",
"fillErr.invalid-body": "Invalid values.",
"fillErr.no-fill": "Fill not found.",
"fillErr.immutable-field": "Sell fills cannot be edited; delete and re-add instead.",
"fillErr.not-last": "Only the newest fill can be deleted — later activity depends on it.",
"fillErr.no-run": "Run not found.",
"fillErr.invalid-fill": "This fill cannot be deleted — bucket history conflicts."
```
ko:
```json
"fills.col.actions": "작업",
"fills.edit": "수정",
"dialog.addFill": "체결 추가",
"dialog.editFill": "체결 수정",
"dialog.save": "저장",
"dialog.delete": "삭제",
"dialog.deleteConfirm": "삭제 확인",
"dialog.deleteWarning": "이 체결은 가장 최근 기록입니다. 삭제하면 {n}주와 현금 효과가 되돌려지며 되돌릴 수 없습니다.",
"fillErr.invalid-body": "값이 올바르지 않습니다.",
"fillErr.no-fill": "체결을 찾을 수 없습니다.",
"fillErr.immutable-field": "매도 체결은 수정할 수 없습니다. 삭제 후 다시 추가하세요.",
"fillErr.not-last": "가장 최근 체결만 삭제할 수 있습니다 — 이후 기록이 의존합니다.",
"fillErr.no-run": "런을 찾을 수 없습니다.",
"fillErr.invalid-fill": "이 체결은 삭제할 수 없습니다 — 버킷 내역과 충돌합니다."
```

(`manual.*` keys stay in catalogs for now — harmless; optionally remove in Task 7 if `grep -rn '"manual\.' apps/web/src` clean. Leave them.)

- [ ] **Step 6:** `bun test && bun run typecheck` → green.

- [ ] **Step 7: Commit** `git add -A && git commit -m "feat(web): edit and delete fills from the fills panel"`

---

### Task 7: Dark-mode date icons + live check + final sweep

**Files:**
- Modify: `apps/web/src/style.css` (`:root` line 20, `.dark` line 41)
- Possibly: manual verification notes

- [ ] **Step 1:** `:root {` add `color-scheme: light;` — `.dark {` add `color-scheme: dark;` (first declaration in each block).

- [ ] **Step 2:** Full gate: `bun test && bun run typecheck` → green. With test DB: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test`. E2E smoke: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`.

- [ ] **Step 3:** Live check: `bun run --cwd apps/server dev` + `bun run --cwd apps/web dev`, browser → dark theme → fills tab → fill date input: calendar icon visible; edit a buy fill, watch cash/realized in Metrics; delete newest fill, confirm rollback; Add-fill popup works.

- [ ] **Step 4: Commit** `git commit -am "fix(web): native date-picker icons visible in dark theme"`

---

**Not in scope:** sell-fill editing (delete-and-re-add), mid-history deletes/cascade, order reopen on delete, ledger line rebuild for fills.
