# Edit & delete booked fills (shared fill popup)

Date: 2026-11-13
Status: draft (for review)

## Intent

The operator sometimes books a fill with the wrong Qty / Price / Fee. Today fills are
write-once: the only fix is a compensating manual fill, which distorts history. Add
**edit (Qty, Price, Fee)** and **delete** for booked fills on the Run detail fills
list, keeping the run's book (cash, buckets, closed history, ledger) consistent.
Both "Add fill" and "Modify fill" use one common popup.

## Goals

- Edit any booked fill's Qty, Price, Fee (both Buy and Sell). Fee auto-recalculates
  from `feeCents(price, shares, run.costPpm)` exactly like "Add fill" until the
  operator overrides it.
- Delete a fill when it is the **last booked** fill of the run; reject otherwise.
- After edit/delete: cash, bucket states, ages/force_sell, and closed history are
  consistent with the remaining (corrected) fill list — realized P&L recomputes.
- Conflicts with later activity (e.g. editing a buy below the qty a later sell
  already took) are **rejected with a clear message**, never cascaded.
- Original ledger rows stay untouched; each mutation appends a compensating
  ledger row (`kind: 'adjust'`) as audit trail.
- One shared popup: "Add fill" tab becomes a trigger; fills table rows get "Edit".
- Fix: native date-picker icon invisible in Dark theme.

## Non-goals

- No editing Side, Filled-on date, bucket, or ticker (immutable).
- No delete of non-last fills; no bulk edit.
- No re-opening or re-matching orders when a fill is deleted (a `filled` order stays
  filled — fills don't store their matched order id; re-deriving it is unreliable).
- No web UI for the ledger table (the `adjust` rows are audit trail only).
- No changes to screenshot capture / pending-fill confirmation flows.

## Anti-goals

- State that drifts from the fill list (closed history contradicting fills).
- Float money math — everything via `@st/core/money` bigint myriadths / int cents.
- Mutating or deleting original `buy`/`sell`/`seed` ledger rows.
- Silent partial success: every mutation is validate-then-persist, all-or-nothing.

## Approach considered

1. **Rebuild-from-fills (chosen)** — fills are the source of truth; re-run the pure
   `applyBuyFill`/`applySellFill` transitions over the corrected fill list and diff
   cash. Closed history, bucket reopen, etc. fall out of the replay automatically.
2. Inverse-delta patch (undo the fill, redo with new values) — small math but has to
   special-case closed records, bucket reopen order, and ages by hand; easy to drift.
3. Reject any edit touching a bucket with later activity — safest, but then the main
   use case (fixing a buy price before its sell) is impossible.

## Design

### Domain — new `rebookFill` / `deleteLastFill` in `apps/server/src/domain/booking.ts`

Shared helpers, mirroring `runBooking`'s validate → persist discipline:

1. **Order**: replay in **fill id order** (the original booking sequence; the fills
   list UI is in that order too). "Last fill" = highest id.
2. **Validate input** (edit): `shares` positive int, `price` via `parseUsd`, `fee`
   integer cents ≥ 0 or omitted → `feeCents(price, shares, run.costPpm)`.
3. **Rebuild**: `state = emptyState(run.bucketCount)`; for each fill in the corrected
   list call `applyBuyFill/applySellFill(state, f.bucketIdx, f.shares, f.price,
   f.fee, f.filledOn)` — stored `bucketIdx` makes replay deterministic. Any
   `DomainError` (`bucket-not-empty`, `bucket-not-held`, `too-many-shares`, …)
   → reject (422) with that code; the book is untouched.
4. **Ages / force_sell**: for each held bucket whose current state has the same
   `filledOn` (edits never change dates, so this is the normal case) carry over the
   current age and `held`/`force_sell` flag verbatim — no trading-day drift.
   A bucket that reappears (deleted sell, sell edited to partial) gets
   `age = ageBuckets({}, today, { idx: buyFilledOn })` and state `held`, matching how
   a same-day backdated manual buy books today (flips at the next `advanceDay`).
5. **Cash** (no full-history dependency):
   `newCash = currentCash − effect(target) + effect(edited|0)` where
   buy effect = `−(roundDiv(price·shares, 100) + fee)`, sell effect =
   `+(roundDiv(price·shares, 100) − fee)` — the exact deltas `booking.ts` booked.
   This preserves the seed cash override and any historic baseline offset.
6. **Persist** (same order as `runBooking`): `bucketRepo.saveState` →
   `fillRepo.update/delete` → `ledgerRepo.insert({ kind: 'adjust',
   amountCents: newEffect − oldEffect, ref: { fillId, bookedOn, reason } })` —
   skipped when the delta is 0.

Delete = the same pipeline with the target removed from the list, plus a guard:
reject `fill-not-last` (409) unless the id is the run's highest fill id. Missing id →
`fill-not-found` (404).

### HTTP — `apps/server/src/http/routes/fills.ts` (currently empty router)

- `PUT /runs/:id/fills/:fillId` — body `{ shares, price, fee? }` (fee USD text like
  the manual-fill POST; omitted → server computes). 422 `{ error: code }` on domain
  rejection, following `runs.ts`'s style.
- `DELETE /runs/:id/fills/:fillId` — 409 `fill-not-last`, 404 `fill-not-found`.
- Repos: add `fillRepo.update(id, patch)` / `fillRepo.delete(id)` in `db/repos.ts`.

### Web — one shared popup

- New `components/forms/FillDialog.tsx` owns the form logic extracted from
  `ManualCaptureForm` (which is removed; `autoFeeUsd` moves with it and keeps its
  exact half-up `feeCents` parity with the server).
  - **Add mode**: identical fields to today's form (Side select, Qty, Price, Fee,
    Filled-on). The Run detail "Add fill" tab becomes a "New fill" button that opens
    it; submit still `POST /runs/:id/fills`.
  - **Modify mode**: prefilled from the `FillDto`; Side rendered immutable
    (static badge), Filled-on shown read-only; Qty/Price/Fee editable with the same
    auto-fee → user-override → clear-to-revert rules. Buttons: Save (`PUT`), Cancel,
    and a danger **Delete fill** button — rendered only when the fill is the run's
    last row — with an in-popup confirm step (`DELETE`).
- `FillTable` gains an Actions column with a per-row "Edit" button and accepts
  `lastFillId` + `onEdit`. `FillsPanel` hosts the dialog state and calls
  `onMutated()` after save/delete; `RunDetail` wires `onMutated` to the existing
  `setPanelKey + reload` pattern so stats, BucketBoard, history, and fills refresh.
- `api.ts`: `updateFill(runId, fillId, input)`, `deleteFill(runId, fillId)`.
- Server error codes map through the en/ko catalogs
  (`fillErr.bucket-not-empty`, `fillErr.too-many-shares`, `fillErr.fill-not-last`, …)
  with a generic fallback; all new copy goes into both `i18n/en.json` and `i18n/ko.json`.

### Dark-theme date icon fix

`apps/web/src/style.css` declares no `color-scheme`, so `input[type=date]` renders
its WebKit calendar-indicator glyph with the light palette (near-black icon on the
dark input). Add `color-scheme: light` to `:root` and `color-scheme: dark` to
`.dark` — native controls (date picker, spinners, scrollbars) then repaint with the
theme. No component changes needed.

## Tests

- `apps/server/test/rebooking.test.ts` (fake repos, like `booking.test.ts`):
  edit buy on a held bucket (bucket fields + cash delta + `adjust` row);
  edit sell price/fee recomputes the closed record (realized P&L shifts);
  edit buy below a later sell's qty → reject `too-many-shares`, state unchanged;
  delete last sell → bucket reopens, age from buy `filledOn`; delete non-last →
  reject; fee omitted → recomputed from `costPpm`; zero cash delta → no ledger row;
  ages/force_sell of untouched holdings carried over exactly.
- `apps/server/test/http.test.ts`: PUT/DELETE happy paths + status codes
  (404/409/422), auth applies.
- `apps/server/test/db.test.ts`: `fillRepo.update/delete` round-trip.
- `apps/web`: rewrite `ManualCaptureForm.test.tsx` as `FillDialog.test.tsx`
  (add mode unchanged incl. auto-fee rules; modify mode prefills, side static,
  save body, delete button only for last fill, delete confirm); `FillTable` edit
  button; `RunDetail` "Add fill" tab opens the popup.
- Date-icon fix: visual/manual (CSS tokens only).
