# Fill corrections from screenshot conflicts — design

Date: 2026-11-15 · Size: project · Status: draft for operator approval (approach B,
sell edits everywhere, sticky dismiss — operator decisions; snapshot staleness, run
lock on apply/dismiss, orphan handling, no backfill — designer's calls after builder
check)

## Intent and why

When a re-sent broker screenshot disagrees with a booked fill only on price (same
side / ticker / shares / trade date), capture today reports a Telegram conflict
("extracted $64.07, but booked fill #2 has $66.03 — fix the booked fill") and books
nothing. The operator then has to fix the fill by hand. Two problems:

1. Manual fixing is friction the operator wants gone: the conflict should land in
   the Pending view as a **correction to approve** — one click applies it.
2. Manual fixing is currently **impossible for sells**: `rebookFill`
   (`apps/server/src/domain/recompute.ts:50`) rejects any sell with
   `immutable-field`, and a sell that is not the newest fill of its bucket cannot be
   deleted either (`deleteFill` per-bucket-last rule). Prod fill #2 (sell 44 SOXL @
   66.03 typo, 2026-11-11, bucket 0, followed by fill #7) is exactly this case. The
   original fill-edit design (`2026-11-13-fill-edit-delete-design.md`, Goals: "Edit any
   booked fill's Qty, Price, Fee (both Buy and Sell)") intended sell edits; its plan
   narrowed it to buys.

## Goals

- **Sell edits everywhere.** `rebookFill` accepts sells (qty, price, fee, trade date —
  same fields as buys). The existing Edit fill dialog on the run page therefore works
  for sells with no new UI. Replay of the corrected history validates the edit
  (e.g. a sell qty larger than the bucket holds is rejected); nothing is persisted on
  failure.
- **Correction proposals from captures.** Every capture conflict that cites a
  **booked** fill creates an open correction: target fill, proposed price, proposed
  fee, source capture. Listed on the Pending page (and the run page's Pending tab,
  filtered to the run) in a "Corrections" section above unconfirmed fills, with
  **Apply** and **Dismiss**.
- **Apply** runs the same rebuild as a manual edit (cash, buckets, closed history /
  realized P&L, one `adjust` ledger row when cash moves) and marks the correction
  applied. **Dismiss** marks it dismissed and changes nothing else.
- Telegram conflict line for booked fills tells the operator the correction is
  waiting in Pending.

## Non-goals

- Conflicts against a still-**pending** row (`capture-conflict-pending`): no
  correction row — the operator already overrides the price inline on that row.
- Apply/Dismiss buttons in Telegram (web only for now).
- Corrections for anything other than price/fee (qty/date/side differences are
  different trades by the dedup rules and stay so).
- Moving `rebookFill` under the per-run lock (tracked in issue #22) — unchanged.
- Changing the `PUT /runs/:id/fills/:fillId` body format (`priceCents`).

## Anti-goals

- A correction ever booking a **new** fill (a second sell) — corrections only patch
  the target fill.
- Applying a correction to a fill that changed since the correction was proposed
  (edited by hand, deleted, or corrected by another correction) — must be refused,
  not silently overwrite.
- Duplicate open corrections for the same fill + proposed price, or re-proposing a
  correction the operator dismissed.
- Float money math.

## Constraints

- Money: bigint myriadths for prices, integer cents for fees (`@st/core/money`).
- Schema change via drizzle: edit `apps/server/src/db/schema.ts`, then
  `bun run --cwd apps/server db:generate`; migrations apply at startup. Additive only
  (new table) — no change to existing tables.
- Files ≤ ~300 lines; `packages/*` never import `apps/*`; all copy via en/ko catalogs
  (`packages/telegram/src/i18n.ts`, `apps/web/src/i18n/{en,ko}.json`).
- Prod DB never touched by development or tests (st_test + e2e scratch DB only).

## Approaches

- **A. Corrections as a kind of `pending_fills` row** (nullable `target_fill_id`).
  Reuses lifecycle and UI, but every pending consumer — HTTP confirm, Telegram
  yes/no, the capture dedup matcher, `listPending` callers — must learn to
  distinguish; one miss books a second sell. Rejected (operator chose B).
- **B. Separate `fill_corrections` table — chosen.** Own repo, routes and UI section;
  existing pending flows untouched.
- (No-persistence variants are impossible: a conflict exists only during capture.)

## Design

### Data — new table `fill_corrections`

| column | type | notes |
| --- | --- | --- |
| id | int PK auto | |
| run_id | int not null | |
| fill_id | int not null | target booked fill |
| capture_id | int null | source capture (re-upload live check) |
| side | varchar(8) not null | fill snapshot when proposed |
| ticker | varchar(16) not null | fill snapshot |
| booked_shares | int not null | fill snapshot |
| booked_filled_on | date not null | fill snapshot |
| booked_price | bigint not null | fill price (myriadths) snapshot |
| booked_fee | int not null | fill fee (cents) snapshot |
| proposed_price | bigint not null | extracted price (myriadths) |
| proposed_fee | int null | extracted fee (cents) or null = keep booked fee |
| status | enum `open` / `applied` / `dismissed`, default `open` | |
| created_at | timestamp default now | |

Repo `correctionRepo`: `insert`, `listOpen()`, `get(id)`, `decide(id, status)` with
the same "only from `open`" guard `pendingRepo.decide` uses (returns `false` when not
open), `listBlocking(fillId, proposedPrice)` → the `open` or `dismissed` corrections
for that fill + proposed price, ordered by id (`applied` ones never block; the
recorder drops snapshot-stale rows), and `hasOpenForCapture(captureId)`.

**Dismiss sticks (operator decision).** A dismissed correction means "I checked, the
booked price is right": while the fill still matches the correction's snapshot, the
same fill + same proposed price is never proposed again, whatever screenshot it comes
from. The same holds for an open correction (it is reused, not duplicated). Once the
fill is hand-edited the old row is stale (the same predicate that sets `stale` on the
Pending page), so it no longer blocks and a new correction may be proposed. A
*different* proposed price for the same fill is a new correction. An `applied`
correction never suppresses anything (if the fill is later hand-edited back and a
screenshot disagrees again, a new correction appears).

### Capture flow (`apps/server/src/domain/booking.ts` / `capture-dedup.ts`)

- `CaptureConflict` gains `extractedFee: string | null` (from the raw fill) so a
  correction can carry the screenshot fee. The matcher's consumption rules are
  otherwise unchanged.
- Inside the existing `withRunLock` span of `ingestCapture`, after matching: for each
  conflict with `bookedId !== null`, look up `listBlocking(bookedId, proposedPrice)`
  and keep only rows whose snapshot still matches the booked fill: none →
  insert an open correction (snapshot columns from the booked fill row the matcher
  cited); `open` → reuse it; `dismissed` → insert nothing. A stale open/dismissed
  row is ignored, and a non-stale open row wins over a non-stale dismissed one. The conflict
  object gains `correction: { id: number; status: 'open' | 'dismissed' } | null`
  (`null` for pending-row conflicts) so Telegram can say which.
- Re-upload live rule (`claimCapture`): a capture with an **open correction** counts
  as live, exactly like a pending row → a byte-identical re-send stays `'duplicate'`.
  Applied/dismissed corrections do not keep a capture live.
- The capture outcome shapes (`{ pending }`, `{ pending, conflicts }`,
  `{ conflicts }`, `'duplicate'`) are unchanged.

### Sell edits (`apps/server/src/domain/recompute.ts`)

- Remove the sell guard in `rebookFill`. Replay (`rebuildState`) already handles
  sells; any invalid result throws `DomainError` before persisting.
- `rebookFill` gains an optional ledger reason (default `'fill-edit'`); apply uses
  `'capture-correction'` and includes the correction id in the adjust row's `ref`.
- Web copy: `fillErr.immutable-field` stays (side/ticker still immutable server-side
  for any edit path that would send them); any copy claiming sells cannot be edited
  is removed. Existing tests asserting the sell rejection
  (`rebooking.test.ts`, `http.test.ts` "PUT on a sell fill → 422") flip to assert a
  successful sell edit.

### Apply / Dismiss (`apps/server/src/domain/corrections.ts`, new)

`applyCorrection(id, deps)` — the whole sequence runs inside
`withRunLock(correction.runId, …)` (`rebookFill` takes no lock itself, so no nesting;
the manual `PUT` edit path stays unlocked per issue #22):
1. Load the correction; not `open` → `DomainError('correction-not-open')`.
2. Load the target fill; missing → `'correction-stale'`; any of side, ticker,
   shares, filledOn, price, fee ≠ the snapshot → `'correction-stale'`.
3. `rebookFill(runId, { fillId, shares: fill.shares, priceStr: formatUsd(proposed),
   feeCents: proposed_fee ?? fill.fee, filledOn: fill.filledOn }, deps, reason)`.
4. `decide(id, 'applied')`. Under the lock a concurrent second apply waits and then
   fails at step 1, so rebook-then-decide is safe.

Stale corrections — including ones whose fill was deleted — stay listed so the
operator can Dismiss them (they cannot be applied); the list renders from the
snapshot, so it never depends on the fill still existing. `dismissCorrection(id)`
(also under the run lock) → `decide(id, 'dismissed')`, `false` →
`'correction-not-open'`.

### Rollout

No backfill. After deploy, prod fill #2 is fixed either by editing it in the fill
dialog (sell edits now allowed) or by re-sending a screenshot showing the trade and
applying the resulting correction.

### HTTP (`apps/server/src/http/routes/corrections.ts`, new; mounted under `/api`)

- `GET /corrections` → open corrections from the snapshot columns plus a computed
  `stale: boolean` (fill missing or differing from the snapshot) — prices are
  decimal strings (myriadths via `jsonBig`), fees are integer-cent numbers. Stale rows render with the stale note and only Dismiss.
- `POST /corrections/:id/apply` → 200 `{ ok, deltaCents }`; 409
  `correction-not-open` / `correction-stale`; 422 for other `DomainError`s (e.g.
  replay rejects).
- `POST /corrections/:id/dismiss` → 200 / 409 `correction-not-open`.

### Web

- `api.ts`: `listCorrections`, `applyCorrection`, `dismissCorrection`; DTO in
  `api.types.ts`; new error codes in the `ApiErrorCode` union.
- New `components/forms/CorrectionList.tsx` (own file): section "Corrections (from
  screenshots)" rendered on `pages/Pending.tsx` and in RunDetail's pending tab
  (`runId` filter) above `PendingTable`; hidden when empty.

```
Corrections (from screenshots)
  Fill #2  SOXL sell 44 sh · 2026-11-11 · price $66.03 → $64.07 · fee $2.03   [Apply] [Dismiss]
```

  Fee column shows `→ new` only when it differs. On 409 stale: show
  "This fill changed since the screenshot — dismiss this correction." and keep the
  row. After Apply/Dismiss: reload the list (and the pending table / run panels on
  RunDetail so cash and fills refresh).
- en/ko copy for section title, column labels, buttons, stale/not-open errors.

### Telegram

- `capture-conflict` (booked fill) wording changes to point at Pending, e.g. en:
  `⚠️ Conflict: {side} {shares} {ticker} on {date} — extracted ${extracted}, booked
  fill #{id} has ${dupPrice}. Correction listed in Pending.` with matching ko.
- New `capture-conflict-dismissed` (en/ko) for a conflict whose correction was
  dismissed earlier, e.g. en: `ℹ️ {side} {shares} {ticker} on {date} — extracted
  ${extracted}, booked fill #{id} has ${dupPrice}. You dismissed this correction
  before; not listed again.`
- `capture-conflict-pending` unchanged.

## Tests (what proves it)

- Domain: sell edit price/fee/qty rebuilds closed history and books an adjust; sell
  qty above holdings rejected with nothing persisted.
- Capture: booked-fill conflict creates exactly one open correction (with extracted
  fee and full snapshot); repeat conflict via a different screenshot reuses it;
  after Dismiss, the same fill + price creates none and Telegram uses
  `capture-conflict-dismissed`; a different proposed price after Dismiss creates a
  new one; an applied correction never suppresses; pending-row conflict creates
  none; re-send of the same image while a correction is open → `'duplicate'`,
  after Dismiss → re-read (conflict reported as dismissed).
- Apply: patches only the target fill (no new fill row), state/ledger match a manual
  edit; second apply → `correction-not-open`; apply after the fill was edited or
  deleted, or its shares/date hand-edited → `correction-stale`; two concurrent
  applies → exactly one rebook; dismiss leaves fill untouched; stale/orphaned
  corrections listed with `stale: true` and dismissable.
- HTTP routes incl. status codes; web `CorrectionList` render/apply/dismiss/stale.
- DB integration: IMG_2109 shape end-to-end against real repos (conflict → correction
  → apply → fill #2 price 64.07, re-send → `'duplicate'`).
- e2e smoke stays green.

## Left to the builder

File split inside these bounds, repo/test fake shapes, exact copy wording within the
meaning above, the `jsonBig` join shape, and how RunDetail refreshes after apply.
