# Capture dedup against booked fills and pending rows

Date: 2026-11-15. Status: approved.

## Problem

A 기간체결 (date-range) capture lists every trade in a duration, including
trades already booked from earlier captures. Today `ingestCapture` only
dedups by image hash (identical screenshot), so an overlapping range image
re-inserts already-booked trades as new pending rows.

## Decisions (partner-approved)

- Mechanism: deterministic backend dedup in `ingestCapture`
  (`apps/server/src/domain/booking.ts`). Not prompt injection.
- Match scope: the run's booked fills AND its still-`pending` rows.

## Design

- Key per trade: `side | ticker | shares | parseUsd(price) | filledOn`.
  Price normalizes through `parseUsd` so `58.32` and `58.3200` match.
  `filledOn` is the extracted date (`f.date ?? deps.today`), matching what
  the pending/fill rows store.
  Ticker relies on `normalizeFill` stripping the exchange suffix
  (기간체결 shows "SOXL.N"; booked runs store "SOXL" — see fix 2a5094d);
  without it every dedup key would miss.
- Multiset counting (Map<key, count> built from booked fills + pending
  rows), not a set: each extracted occurrence is skipped only while a
  matching booked/pending occurrence remains. Re-consuming a booked trade
  is skipped; a genuinely new identical trade (count exhausted) still
  creates its pending row.
- Reads via `repos.fillRepo.listForRun` (optional on `RepoSurface`:
  guarded — dedup for booked fills degrades to off if a fake surface
  lacks it) and required `pendingRepo.listPending()` filtered to the run.
- Outcomes: rows that survive dedup behave exactly as today (pending
  insert + per-row Telegram keyboard). If extraction produced fills but
  every one was excluded, `ingestCapture` returns `'duplicate'`, so the
  capture wire replies with the existing `duplicate-capture` message
  instead of silent success. The capture row keeps status `parsed`.
- Matching pending rows are only those with status `pending`;
  operator-rejected trades reappear if captured again (reject means
  "wrong as displayed", not "never show this trade again").

## Tests (apps/server/test/booking.test.ts)

1. Fully overlapping range capture -> `'duplicate'`, zero new pendings.
2. Partial overlap -> only the new rows become pending.
3. Same trade in two different images while still pending -> 2nd is excluded.
4. Price spelling variance (`58.32` vs `58.3200`) still dedups.
5. Multiset: 1 booked + 2 identical rows in the image -> exactly 1 new pending.
6. Near-misses (differing side/ticker/shares/price/date) are not deduped.

## Out of scope

- Order matching, fee comparison, fuzzy price/share matching.
- Web UI changes; Telegram copy changes (reuses `duplicate-capture`).
