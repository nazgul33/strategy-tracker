# Trade date editing + capture date extraction — design

Date: 2026-11-15. Status: approved by operator.

## Intent and the why

The trade date of a booked fill is wrong in two everyday flows:

1. The **Edit fill popup** locks the trade date, so a fill booked with the wrong
   day can never be corrected from the UI.
2. A **screenshot capture** always books fills with *today's* date, even though
   the mPOP execution-history screenshot shows the actual execution date —
   capturing yesterday's fills late silently books them on the wrong day.

The operator wants the date they see (in the popup, in the screenshot) to be
the date the system books.

## Goals

- Edit fill popup: trade date editable and persisted (buy fills, same scope as
  qty/price/fee editing).
- Capture pipeline: extract the execution date from the screenshot and carry it
  through pending → booked fill.

## Non-goals / anti-goals

- Side stays locked in the Edit popup (per the previous fix, side is immutable
  server-side; sell fills remain non-editable).
- No re-matching of open orders when an already-booked fill's date changes —
  rebook never touched orders and keeps that contract.
- No new UI to review/override the extracted date on Telegram messages; the
  Pending page already allows a `filledOn` override at confirm time.

## Constraints

- `filledOn` is `ISODate` (`YYYY-MM-DD`) everywhere; money/date validation
  mirrors existing manual-fill guards.
- Cash Model A: state is re-derived from fill history — a patched `filledOn`
  must flow through the same `rebuildState` replay, so bucket ages recompute.
- Vision extraction stays tolerant: a bad/missing date must never drop an
  otherwise valid fill.

## Approaches

1. **Chosen:** extend the existing PUT + `rebookFill` with an optional
   `filledOn`, and extend the vision contract with a per-fill `date`.
   Everything reuses existing replay/pending plumbing.
2. Caption date (`/capture 7 11/14`) — rejected: the operator asked for the
   date *in the capture*, not retyped; retyping reintroduces the error class.
3. Separate "rebook date" endpoint — rejected: duplicates rebookFill's rebuild
   for no benefit.

## The how (decided)

### Server — editable trade date

- `PUT /runs/:id/fills/:fillId` accepts optional `filledOn` string; when
  present it must match `^\d{4}-\d{2}-\d{2}$` (else `invalid-body` 400).
- `rebookFill`'s `RebookEdit` gains `filledOn?: ISODate`; the patched history
  row carries it so `rebuildState` recomputes ages; `fillRepo.update` patch
  type gains `filledOn` (schema column already exists — no migration).
- Ledger `ref` for the adjust keeps `reason: 'fill-edit'`.

### Ingest — date from the screenshot

- `RawFill` gains optional `date?: string` (ISO). The mPOP prompt asks for the
  execution date shown in the screenshot (header/당일체결 date, row dates),
  normalized to `YYYY-MM-DD`, and `extractFills` receives "today is …" context
  (new optional `today` on `VisionConfig`, appended to the prompt) to resolve
  dates that omit the year.
- Normalizer: keep `date` only when it matches the ISO regex and is within 45
  days of `today` (guard against hallucinated dates); otherwise drop the field
  — the fill itself is kept.

### Booking — extracted date flows through

- `ingestCapture` uses `f.date ?? deps.today` for the pending row's
  `filledOn` (both pinned and auto-route paths share this code).
- `confirmPendingFill` already honors `pending.filledOn` — no change.

### Web

- `FillUpdatePayload` gains optional `filledOn`; `FillDialog` modify mode sends
  it and the date input is no longer `disabled` in modify mode (ISO-format
  client guard applies to both modes); Side select lock unchanged.
- Header comment updated (side locked, date editable).

## Left to the builder

Exact test placement in the existing suites (fills route tests, recompute
tests, ingest extract tests, booking tests, dialog tests) following each
suite's current fake-repo style.
