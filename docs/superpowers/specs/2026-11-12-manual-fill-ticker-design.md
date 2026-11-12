# Manual fill: ticker is a property of the run

Date: 2026-11-12
Status: approved direction (approach A + capture-path hardening)

## Problem

The manual "Add fill" form asks the operator to type a ticker, and the server
stores whatever it receives (`manualFill` → `runBooking` → `fillRepo.insert`)
without checking it against the run. A run has exactly one ticker, so a typed
ticker can only ever be noise or damage: a fill booked under a ticker its run
doesn't trade is a silent data-integrity bug.

The screenshot-capture path has the same latent exposure one layer down:
`confirmPendingFill` books `pending.ticker` (extracted from an image) into the
fill row without re-checking it against the run. Today the wire layer makes a
mismatch nearly impossible (pinned mode filters to the run's own ticker;
auto-route matches tickers exactly), but booking is where integrity must be
enforced, not the convenience layer.

## Goal

The ticker stored on every fill is always `run.ticker`, by construction.
No client — web form or pending row — can choose it.

## Design

### Server — one chokepoint (`apps/server/src/domain/booking.ts`)

1. `runBooking` already loads `const run = await repos.runRepo.get(input.runId)`.
   The `fillRepo.insert` call stamps `ticker: run.ticker`. Remove `ticker` from
   `BookInput` entirely — no caller can supply one. Every booking path
   (manual, pending confirm, and future ones) inherits the guarantee.
2. `manualFill(runId, fill, deps)`: input type becomes
   `Omit<RawFill, 'ticker'> & { filledOn: ISODate }`. A stray `ticker` in the
   object is simply ignored (JS), which keeps the HTTP route tolerant of old
   web bundles that still send it.
3. `confirmPendingFill` (capture path): after loading run and pending, guard
   `if (pending.ticker !== run.ticker) throw new Error('ticker-mismatch')`.
   This turns a would-be silent mismatch into an explicit, visible failure
   rather than silently booking under a ticker the operator never saw.

### Server — routes

- `POST /runs/:id/fills` (`http/routes/runs.ts`): body cast loses `ticker`
  (`Omit<RawFill, 'ticker'> & { filledOn: string }`); extra body fields remain
  ignored. No new error mapping needed — `manualFill` can no longer produce a
  ticker-related error.
- `POST /pending/:id/confirm` (`http/routes/pending.ts`): map
  `ticker-mismatch` → 409 (explicit conflict, same spirit as the cancel
  route's status mapping). All other errors keep the existing 422.

No schema change, no migration: `fills.ticker` stays, it just becomes
server-authoritative.

### Web

- `api.types.ts`: drop `ticker` from `ManualFillInput`; fix the doc comment
  (route is `POST /runs/:id/fills`).
- `api.ts` `addManualFill`: drop the `ticker:` line from the body builder.
- `ManualCaptureForm.tsx`: remove the ticker `useState`, the ticker `Field`,
  and the ticker line in submit; fix the stale header comment
  (`/manual-fills` → `/runs/:id/fills`).
- `i18n/en.json` + `i18n/ko.json`: delete `manualTicker` in the same commit.

### Tests (TDD order)

1. `apps/server/test/booking.test.ts`
   - existing `(h) manualFill`: input without ticker; assert the inserted fill
     row carries the run's ticker.
   - new: `manualFill` given a stray wrong `ticker` property → fill still
     stamped with `run.ticker` (ignored, no error).
   - new: `confirmPendingFill` where `pending.ticker !== run.ticker` →
     throws `ticker-mismatch`, nothing booked (no fill, no state save).
   - existing pending-confirm happy path must keep passing (match by
     construction in the fixture).
2. `apps/server/test/http.test.ts`
   - 'manual fill books': body without ticker; assert fill ticker === run's.
   - new: body carrying a bogus ticker → 200 and run's ticker on the fill.
   - new: confirm with mismatched pending ticker → 409 `ticker-mismatch`.
3. `apps/web/src/components/forms/ManualCaptureForm.test.tsx` (new, mirroring
   `GapEditForm.test.tsx`): renders without a ticker input; submit posts a body
   with no `ticker` key and correct side/shares/price/fee/filledOn.

### Verification matrix

`bun test`; DB suite with fresh `st_test` (no migrations touched, still run
it); `bun run typecheck`; `bun run --cwd apps/web build`; e2e smoke.

## Deliberately not doing

- No ticker edit/aliasing on runs; no attempt to "fix" historical fill rows
  whose ticker mismatches their run (none known; operator can book a
  correcting fill).
- No change to the wire layer (`wire/capture.ts`) — pinned filter and
  auto-route stay as UX-level routing; the new guard is the integrity layer.
- Pending rows keep their extracted ticker in the table for display; only
  booking consults `run.ticker`.
