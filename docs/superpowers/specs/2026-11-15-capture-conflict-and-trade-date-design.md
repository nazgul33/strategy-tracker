# Capture conflict detection + pending trade-date display — design

Date: 2026-11-15 · Status: approved (2026-11-15)
Follows: `2026-11-15-capture-followups-design.md` (exact-signature dedup + per-run lock)

## Problem

Two bugs reported from a live mPOP screenshot (`IMG_2109.jpg`):

1. **Re-detected fill created a duplicate pending row instead of erroring.**
   A manual fill was booked with a price typo (`sell 44 @ $66.03` on 2026-11-11;
   the screenshot says `$64.07`). Re-sending the screenshot inserted a *new*
   pending sell instead of flagging the existing fill, because the dedup key
   (`side|ticker|shares|price|filledOn`) requires an exact price match.
   Desired behavior (user-approved option A): a re-extracted fill that matches
   an existing booked/pending fill on **side, ticker, shares and trade date**
   but differs on price is the *same trade* — create **no new row**, report a
   conflict so the operator fixes the booked fill.

2. **"Trade date" looks unset on the Pending page.** Extraction and storage are
   correct (pending rows carry the image dates). The Pending table's Trade date
   column renders only the empty override input and never shows the detected
   `filledOn`. The Telegram `capture-booked` / `booked` lines also omit the
   date, reinforcing the impression.

## Design

### 1. Same-trade conflict detection (`apps/server/src/domain/booking.ts`)

`ingestCapture` dedup becomes two-phase inside the existing per-run lock:

- Build two multisets from booked fills + pending rows of the run:
  - **exact key** `side|ticker|shares|canonPrice|filledOn` (as today), and
  - **loose key** `side|ticker|shares|filledOn` (price ignored), values keeping
    the matched entry's kind (`fill` | `pending`), id and canonical price.
- **Phase 1 (exact):** drop every extracted fill whose exact key hits, and
  consume the matching loose entries. Exact-first across the whole list means
  order cannot let a mismatched fill steal an exact match's loose slot.
- **Phase 2 (loose):** for each remaining extracted fill, a loose-key hit
  consumes the entry and records a `CaptureConflict` — no pending insert.
  No hit → fresh (pending insert, as today).
- `fresh.length === 0 && conflicts.length === 0` → `'duplicate'` (unchanged).
  Any conflicts → return the object outcome so every conflict is reported even
  when no fresh fills remain.

Outcome type widens:

```ts
export interface CaptureConflict {
  side: 'buy' | 'sell'; ticker: string; shares: number;
  extractedPrice: string;          // canonical USD string
  filledOn: ISODate;
  matchedKind: 'fill' | 'pending';
  matchedId: number; matchedPrice: string;
}
export type CaptureOutcome =
  | 'duplicate' | 'rejected'
  | { pending: PendingFillRow[]; conflicts: CaptureConflict[] }
```

Same-trade logic mirrors the dedup key decision: fee differences never matter;
a different trade *date* is a different trade (no conflict, stays pending).

**Reporting (`apps/server/src/wire/capture.ts`):** after the per-pending
messages, send one line per conflict:

- `capture-conflict` (vs booked fill):
  - en: `Same trade as booked fill #{id} — {side} {shares} sh @ ${bookedPrice} on {date}. Detected ${price} differs — edit that fill instead.`
  - ko: `예약된 체결 #{id}과 같은 거래 — {side} {shares}주 @ ${bookedPrice}, {date}. 감지된 가격 ${price}(이)가 다릅니다. 새 체결 대신 해당 체결을 수정하세요.`
- `capture-conflict-pending` (vs pending row):
  - en: `Already pending #{id} — {side} {shares} sh @ ${bookedPrice} on {date}. Detected ${price} differs.`
  - ko: `이미 대기 중 #{id} — {side} {shares}주 @ ${bookedPrice}, {date}. 감지된 가격 ${price}(이)가 다릅니다.`

The capture row itself is still stored `parsed` (fills were recognized; only
the inserts were suppressed), consistent with current duplicate handling.

No change to `manualFill`, `rebookFill`, or `confirmPendingFill` — conflicts
are a capture-ingest concern.

### 2. Pending trade-date display (`apps/web`)

`PendingTable.tsx` Trade date cell follows the qty/price pattern: detected
`isoDate(r.filledOn)` as the row value (`—` when absent, via `isoDate`; warning border kept
via `pendingIssue`), with the existing small override `<Input type="date">`
below it. Empty override = keep detected date (behavior unchanged). No backend
or DTO change — `filledOn` is already delivered.

### 3. Trade date in Telegram booking lines (`packages/telegram`)

- `capture-booked` gains `{date}`: `Booked {ticker} {side} {shares} sh @ ${price} on {date} — confirm?`
  / ko equivalent.
- `booked` gains `{date}`: `Booked {ticker} {side} {shares} sh @ ${price} on {date} into bucket {bucket}`
  (actual current en copy ends `into bucket {bucket}`) / ko: insert `({date})`
  after `${price}`.
- `capture.ts` passes `filledOn` at both call sites; its local `PendingRow`
  type grows `filledOn: string`, and the post-confirm `pendingRepo.get` row
  already carries it.

## Testing

- `booking.test.ts`: conflict unit cases — price-only diff vs booked fill →
  conflict, no pending; price-only diff vs pending row → conflict; exact match
  still silent duplicate; different date → pending (no conflict); exact match
  wins over a later loose steal (order independence); mixed capture (fresh +
  conflict + duplicate) reports both arrays.
- `db.test.ts` (TEST_DATABASE_URL): conflict path against real repos.
- `wire.test.ts` / capture handlers test: conflict lines sent, `capture-booked`
  contains the date.
- `PendingTable.test.tsx`: renders detected date, override still posts.
- i18n catalog parity (en/ko keys) per existing telegram/web test style.
- Full gates: `bun test`, `bun test` with `TEST_DATABASE_URL`, `bun run
  typecheck`, `bun scripts/e2e.ts`.

## Out of scope

- **Prod data repair** (reject pending #3, correct fill #2 price 66.03 → 64.07
  via the web dialog): operator action, explicitly not automated and not
  touched by this change.
- Auto-correcting booked fills from OCR (rejected — could silently rewrite
  accounting).
- Multi-instance protection (issue #1) and recompute/seedRun locks (issue #22).
