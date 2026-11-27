# Partial-Sell History + Per-Line Recalc — Design

Date: 2026-11-14
Status: approved (user confirmed A–F below in session)

## Problem

History (the closed-bucket table) misses money when a bucket is sold in parts.

`applySellFill` (`packages/core/src/fills.ts:87-134`) appends a `ClosedBucket`
row only when a sell **fully** drains the bucket (line 111-128); a partial
sell just shrinks `bucket.shares` (line 129-131) and the sold tranche is
recorded nowhere. Anything reading `state.closed` therefore understates
realized P&L and the History tab never shows partial exits:

- `apps/web/src/components/RunHistory.tsx` — the table itself
- `apps/web/src/components/SimReplay.tsx:94` — `realizedCents`
- `packages/strategies/src/mean-reversion.ts:139-143` — `progressView`

There is also no way to re-derive a run's stored state from its fill history
on demand. Cash Model A says state is fully derived from fills, but only
`rebookFill`/`deleteFill` (`apps/server/src/domain/booking.ts:269-326`)
actually rebuild, and only as a side effect of editing a fill.

## Decisions (confirmed by user)

- **A. Row model:** one `ClosedBucket` row per *sell event* (tranche), keyed
  by the bucket `index`. A bucket sold 60 then 40 produces two rows with the
  same `index`. `ClosedBucket` gains **no new fields** — the shape in
  `packages/core/src/domain.ts:14-23` (`index, shares, buyPrice, soldPrice,
  buyFeeCents, sellFeeCents, openedOn, closedOn`) already fits.
- **B. Recalc:** re-derive from fills only (existing `rebuildState`,
  `booking.ts:250-262`); no screenshot re-capture.
- **C. Trigger:** explicit "Update" button in History only; no automatic
  recalc added to the pipeline beyond the fixed incremental booking itself.
- **D. Fee split:** the sell fill's fee belongs entirely to its tranche (a
  fill touches exactly one bucket — `applySellFill` throws `too-many-shares`
  beyond it, line 105-107). Only the bucket's **buy** fee must be split:
  proportional to shares, with the remainder staying on the bucket so the
  eventual closing row keeps per-bucket buy-fee sums exact.
- **E. API:** `POST /api/runs/:id/recalc`.
- **F. UI:** an Update button per History row; each triggers the run-level
  recalc and refreshes.

No DB migration: `state.closed` lives in `runs.state_json` and the revive in
`apps/server/src/db/repos.ts` already reads exactly this row shape.

## Design

### 1. Core — `packages/core/src/fills.ts` (`applySellFill`)

Keep the signature `(state, bucketIndex, shares, price, feeCents, closedOn)`
and all guards (lines 95-107). Change only the partial branch (line
129-131): it appends the tranche row before shrinking the bucket.

```ts
} else {
  const buyFeePart = Math.round((bucket.buyFeeCents * shares) / bucket.shares)
  next.closed = [...next.closed, {
    index: bucket.index,
    shares,
    buyPrice: bucket.buyPrice,
    soldPrice: price,
    buyFeeCents: buyFeePart,
    sellFeeCents: feeCents,
    openedOn: bucket.filledOn,   // same source as the full-close row (line 119)
    closedOn,
  }]
  nb.shares = bucket.shares - shares
  nb.buyFeeCents = bucket.buyFeeCents - buyFeePart
}
```

Properties that fall out:

- The full-close branch (line 111-128) is untouched and still takes the
  bucket's *remaining* `buyFeeCents`, so `sum(buyFeeCents)` over a bucket's
  rows equals the original buy fee despite per-tranche rounding.
- The bucket stays `'open'` with `buyPrice`/`filledOn`/`ages` intact; only
  `shares` and `buyFeeCents` shrink. Cash line 132 unchanged.
- `rebuildState` re-runs this same function over history, so recalc is
  idempotent and retroactively repairs runs whose stored state predates the
  fix (old partial-sell fills re-materialize as closed rows).

Existing tests in `packages/core/test/fills.test.ts` that assert a partial
sell leaves `closed` empty get updated in the same commit, with a comment
naming the intentional change. New cases: 60/40 split produces two rows with
exact fee totals; repeated partial sells; over-sell still throws.

### 2. Strategy view — `packages/strategies/src/mean-reversion.ts`

`progressView` (line 133-151) already iterates `state.closed` row-by-row
(`realizedCentsOfClosed`, line 129-131), so repeated-index rows sum and
`winRate` counts tranches naturally. **No code change**; add tests that two
rows of one index aggregate in `realizedCents` and win/loss counting.

### 3. Server domain — `apps/server/src/domain/booking.ts`

New export after `deleteFill` (line 326), mirroring it minus the delete:

```ts
export async function recalcRunState(runId: number, deps: BookingDeps): Promise<RunState>
```

1. Guard `repos.fillRepo.listForRun` availability (`fill-history-unavailable`).
2. `history = byIdAsc(await listForRun(runId))`, `run = await runRepo.get(runId)`,
   `state = await bucketRepo.loadState(runId)`.
3. `rebuilt = rebuildState(history, run.poolCents, deps.today, state.buckets.length)`.
4. `await saveState(runId, rebuilt)`.
5. If `rebuilt.cashCents !== state.cashCents`, book one ledger row
   `{ kind: 'adjust', amountCents: rebuilt.cashCents - state.cashCents,
   ref: JSON.stringify({ bookedOn: deps.today, reason: 'recalc' }) }` so the
   books keep matching derived cash (same pattern as line 297-299 / 322-324).
6. Return `rebuilt`.

Recalc never touches fill rows, orders, or pending rows; sell immutability is
untouched.

### 4. HTTP — `apps/server/src/http/routes/fills.ts`

Add to `fillsRouter` (mounted under `/api`), following the sibling routes:

```ts
r.post('/runs/:id/recalc', async (c) => {
  const runId = Number(c.req.param('id'))
  const run = await deps.repos.runRepo.get(runId)
  if (!run) return c.json({ error: 'no-run' }, 404)
  try { await recalcRunState(runId, bookingDeps()) }
  catch (e) { if (e instanceof DomainError) return c.json({ error: e.kind }, 422); throw e }
  return c.json({ ok: true })
})
```

### 5. Web

- `apps/web/src/api.ts`: add `recalcRun(runId: number): Promise<void>` to the
  interface (near `deleteFill`, line 120) and
  `recalcRun: (runId) => send<{ ok: true }>('POST', `/api/runs/${runId}/recalc`).then(() => undefined)`
  to the implementation (near line 190).
- `apps/web/src/components/RunHistory.tsx`:
  - Row key at line 41 is `${c.index}-${c.closedOn}` — two partial sells of
    one bucket **on the same date** would collide. Change to
    `` `${c.index}-${i}` `` using the `map` position.
  - `closedPnlCents` (line 12-17) is already per-row — no change.
  - New signature: `RunHistory({ closed, onRecalc }: { closed: ClosedBucketDto[]; onRecalc?: () => Promise<void> })`.
    When `onRecalc` is given, render a trailing `Th`/`Td` column
    (`t('historyColActions')`) with a per-row `Button` (`t('updateButton')`)
    that calls `onRecalc()` and is disabled while another recalc is in
    flight (local `useState` busy flag keyed by row index). Keep the
    component presentational — it never calls `api` itself.
- `apps/web/src/pages/RunDetail.tsx` (usage at line 175): pass
  `onRecalc={recalc}` where `recalc` mirrors the `setStatus` busy/error
  pattern (lines 60-71): `await api.recalcRun(id); await reload()`.
- `apps/web/src/i18n/en.json` + `ko.json`: add `historyColActions`
  (en "Actions" / ko "관리") and `updateButton` (en "Update" / ko "갱신")
  next to the existing `historyCol*` keys.
- `SimReplay.tsx:94` already sums rows — no change.

### 6. Tests

- `packages/core/test/fills.test.ts`: partial sell appends a tranche row
  (shares, prices, `closedOn = filledOn`, `openedOn = bucket.filledOn`);
  proportional buy fee with exact totals across 60/40; bucket stays open with
  residual `buyFeeCents`; over-sell guard unchanged; updated stale
  expectations commented as intentional.
- `packages/strategies/test/*`: repeated-index rows aggregate in
  `progressView.realizedCents` and `winRate`.
- `apps/server/test/booking.test.ts` (fake repos): `recalcRunState` rebuilds
  from history; books `adjust` only on cash drift; repairs a run whose stored
  state predates the core fix; no fill/order/pending writes.
- `apps/server/test/http.test.ts`: `POST /api/runs/:id/recalc` → 200
  `{ok:true}` + persisted state; 404 `no-run`; 422 on `DomainError.kind`.
- `apps/web`: RunHistory renders repeated-index same-date rows with distinct
  keys; Update button invokes `onRecalc` once and disables while pending.

## Out of scope

- Re-parsing captures or re-booking (existing flows untouched).
- Automatic recalc in the day pipeline or on every sell confirm.
- Multi-bucket spill in one fill (`applySellFill` still rejects it).
- New `ClosedBucket` fields or any SQL migration.

## Recalc and drift

Cash Model A: the *derived* cash of a run is `poolCents` minus the signed cash
effect of every fill in history (`rebuildState` replays exactly that). Recalc
(`POST /api/runs/:id/recalc`, `recalcRunState` in `domain/recompute.ts`)
re-derives state from fills and, when stored cash differs from derived cash,
books exactly one compensating `adjust` ledger row (`ref.reason: 'recalc'`)
and reports the signed correction as `deltaCents` (rebuilt minus stored).

Two flows write stored cash without a matching fill, so derived cash can
differ from it there:

- `seedRun` (`domain/booking.ts`) applies seed buckets and then overwrites
  `state.cashCents` with the operator's number — that value is authoritative
  until the first recalc, which re-derives it from history.
- Editing a run's pool (`setRunPool`, `domain/pool-edit.ts`) moves the stored
  cash by the same difference as `poolCents`, in one transaction with the new
  pool and under the run lock, and books one `adjust` row
  (`ref.reason: 'pool-edit'`). Derived cash is linear in the pool, so the edit
  keeps whatever difference the run already had: a straight run stays
  straight, and a seeded run keeps its seed difference.

A run whose pool was edited before the pool edit moved the cash still carries
the difference of those edits (the pool changed, the cash did not) until its
first Update books it, once.

Consequently an Update on a seeded run may book **one large
adjust row** — that is the repair working as designed, not a bug: it is the
one-time correction that re-anchors the books to `poolCents` minus history.
The web UI surfaces this via the recalc result popup (`deltaCents` and
`fillCount` in the response), so the operator sees the magnitude before the
books move silently. Subsequent Updates on a straight run report
`deltaCents: 0` and book nothing (idempotent).
