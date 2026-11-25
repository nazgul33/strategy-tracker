# Add a buy fill to a held bucket at confirm time

Status: approved (2026-11-25)

## Why

Occasionally one bucket's buy is placed as several broker orders (e.g. 2026-11-24 on run 1:
bucket 6's buy went in as three limit orders, 26 @ 37.85, 26 @ 37.10, 94 @ 32.00). One capture
then yields several buy fills, and booking puts each into the next empty bucket (6, 7, 8), so the
morning plan places three sell legs instead of one. The operator wants them booked as one bucket.

Today this is impossible: `bookUnlocked` always picks `nextBuyBucketIndex` for buys (the bucket
override is sell-only, `invalid-bucket` otherwise), and `applyBuyFill` refuses a held bucket
(`bucket-not-empty`).

## Goals

- Automatic bucket choice for a buy: if a held bucket was bought on the fill's date (a same-day
  buy rung exists), the buy is added to it; otherwise the next empty bucket, as today.
- When confirming a pending **buy** in the web Pending page, the operator can override with
  "Add to bucket N" for any held bucket (not only same-day ones).
- A bucket emptied by a sell can't be bought into again on the same date.
- A buy can only be added to a **mergeable** bucket: `held` (not `force_sell`) and not partly sold.
  The server refuses anything else with `bucket-not-mergeable`, and the buy picker lists only
  mergeable buckets.
- When a capture brings 2+ buy fills (same day or not), Telegram tells the operator to confirm them
  in the web Pending page and choose the bucket there.

## Non-goals

- No automatic merge inference (it is occasional; the order evidence is not reliable enough).
- No Telegram button for choosing a bucket.
- No "merge buckets after booking" tool on the run page.
- Repairing the already-booked staging/prod fills (ids 15, 16 → bucket idx 5) is not part of
  this change; it is a separate, one-time operation, run only with explicit approval.

## Approaches

- **A (picked):** bucket choice for buys in the web confirm flow + Telegram guidance line.
  Smallest change; history replay, ledger and the next morning's sell plan all work unchanged once
  a held bucket can take another buy.
- B: A plus a Telegram bucket choice. Rejected: more UI and tests for an occasional case.
- C: merge buckets after booking. Rejected: not confirm-time, and emptying buckets means retiring
  their open sell legs (more edge cases).

## Design

**Core (`packages/core/src/fills.ts`).** A new `addBuyFill(state, idx, shares, price, fee)` for a
held bucket: shares summed, `buyPrice` = cost-weighted average of the held shares and the new ones
(myriadths, rounded half-up via the existing money helpers), `buyFeeCents` summed, cash reduced by
cost + fee exactly as `applyBuyFill`. It refuses an empty bucket (`bucket-not-held`) and a bucket
that is not mergeable (`bucket-not-mergeable`). `isMergeableBucket(state, idx)` is the one test,
shared by booking, the automatic pick and the HTTP picker list: state `held`, and no closed tranche
with the same index and `openedOn === bucket.filledOn` (that tranche is a partial sell of the
current holding). This test is exact because of the next rule.

**No sell and buy on the same day in one bucket.** A bucket emptied by a sell dated D (a `closed`
tranche with `closedOn === D`) can't take a buy dated D. `nextBuyBucketIndex(state, buyOn?)` gains
an optional `buyOn` that skips such buckets; booking passes the fill's `filledOn`, so Automatic picks
another empty bucket, or refuses with `no-empty-bucket` when none is left. The morning planner and
seeding call it without `buyOn` (unchanged). Replaying history is not guarded, so existing data
always rebuilds. `filledOn` and age are kept (my call: the bucket's age counts
from its first buy). `applyBuyFill` keeps refusing a held bucket; callers choose which to use.

**Replay (`recompute.ts` `rebuildState`).** A buy into a bucket that is held at that point in the
history uses `addBuyFill` and does not reset the age. So fill edits, deletes and recalc stay
consistent. The `not-last` delete rule already handles several fills per bucket.

**Booking (`booking.ts` `bookUnlocked`).** `bucketIdx` is now accepted for buys too. If it's given,
the bucket must be held (otherwise `bucket-not-held`, the error that already exists for sells) and
`addBuyFill` is used. Omitted = Automatic: the mergeable bucket whose `filledOn` equals the fill's
`filledOn` gets the buy via `addBuyFill` (lowest index if several, my call); when there's none, the
next empty bucket via `applyBuyFill`, as today. Automatic applies to every `bookUnlocked` buy
(capture confirms and manual fills); seeding is unchanged. The buy_loc order matching stays the same
(it only flips an open/stale order; the bucket's order is normally flipped already by the first
fill).

**HTTP / web.** The pending confirm route already carries `bucketIdx`; it stops being sell-only.
`GET /pending` adds `mergeableBuckets` (same shape as `heldBuckets`) per run; buy rows list those.
`PendingRow`/`BucketSelect` show the picker for buy rows too: "Automatic" (same-day bucket, else
next empty) plus
"Add to bucket N · X shares" for mergeable buckets (en/ko catalog strings). Error text for the new
refusals goes through `errortext.ts`.

**Telegram (`capture-pending-message.ts`, `packages/telegram/src/i18n.ts`).** `ingestCapture`
flags a buy row as `mergeHint` when the same capture produced another buy (any date; buys on
different dates are the operator's to sort out in the Pending page). Such rows get an extra line
(en/ko) pointing to the web Pending page. They're sent
**without Yes/No buttons**, like the other rows that need the web page. My call: the strategy places
one buy order per day, so same-day buys in one capture almost always belong together, and a
Telegram "Yes" would split them. (With Automatic now merging same-day buys, a "Yes" would usually
merge correctly too; the buttons are still dropped, as approved, so the operator checks the bucket
in the web page.)

## Left to the builder

Test layout, exact copy wording, and where `mergeHint` is computed (next to `rowsNeedingBucket` is
the natural place).
