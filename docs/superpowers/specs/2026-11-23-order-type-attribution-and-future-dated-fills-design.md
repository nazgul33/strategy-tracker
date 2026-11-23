# Sell attribution by order type, and refusing future-dated fills — design

Date: 2026-11-23. Status: draft, awaiting operator approval.
Issues: #74 (a sell booked silently to the wrong bucket), #96 (a fill dated after
its bucket's open legs leaves them open without the pull notice).
Branch: `fix/issues-74-96`.
Supersedes the sell-matching ladder described in
`2026-11-16-cut-loss-and-sim-drafts-design.md` (rungs 1 to 4 of `matchSellOrder`).
"Sibling cancel" in that spec stays as it is.

## Intent

Two problems on the path that books a sell fill.

**#74.** The tracker decides which bucket a sell came from by share count and
price distance only, because a captured fill carries no order type. A print at
96.50 fits a 97.00 stop on one bucket and a 91.00 target on another. The
share-count rung picks without telling the operator, so a wrong pick is silent,
and a wrongly attributed fill can only be fixed by deleting and re-entering it.

**#96.** A fill booked with a date after today (typed wrong, or a settlement date
read as the trade date) empties its bucket but leaves that bucket's live target
or stop open, and no "pull it at your broker" notice goes out.

The operator's direction for #74 (2026-11-23): the order type on the screenshot
decides first; ties go to the bucket holding exactly the fill's shares, then the
older bucket; anything the tracker cannot tell is the operator's choice, never a
guess.

## What the broker screen shows

From the samples in `resources/trade_images/mpop/` (six older ones) and
`resources/trade_images/mpop/stop/` (five new ones, `IMG_2140` to `IMG_2144`,
added on this branch):

| View | 주문구분 text seen | 주문단가 | 주문수량 |
| --- | --- | --- | --- |
| 당일체결 (single day) | `매수/LOC`, `매도/보통(지정가)`, `매도/STOP(시장가)`, `매도/STOP(지정가)`, `정정(매도)` | shown | shown |
| 기간체결 (date range) | `매수` or `매도` only | not shown | not shown |

- The text has the shape `side/condition(price type)`: `보통` or `STOP` is the
  condition, `지정가` (limit) or `시장가` (market) the price type. `LOC` carries no
  price type.
- **A stop-market row shows 주문단가 `0.0000`.** The trigger is not on the screen.
  A stop-limit row shows its limit there (58.0000, 43.2400), not its trigger.
- The one filled stop in the samples: `매도/STOP(시장가)`, 주문수량 1, 체결수량 1,
  미체결수량 0, 체결단가 43.2500. Per file: `IMG_2140` has two rows and no fill;
  `IMG_2141` and `IMG_2142` have four rows, one of them the fill (the other
  three have 체결수량 0: two cancelled, one still working); `IMG_2143` and
  `IMG_2144` have the filled row only.
- The one filled plain limit sell: `매도/보통(지정가)`, 주문수량 44, 주문단가
  64.0700, 체결수량 44, 체결단가 64.0700 (`IMG_2112`).
- `정정(매도)` is an amended sell (`IMG_2103`). Its original order type is not
  shown.
- No sample shows a `LOC` sell or a market sell. `매도/LOC` is assumed by analogy
  with `매수/LOC`. A market sell is assumed to carry `시장가` outside a `STOP`
  (`매도/보통(시장가)` by the shape above; the operator wrote it as `매도(시장가)`).

## Goals

1. A captured sell carries what the screen says about its order: the 주문구분
   text, 주문단가 and 주문수량.
2. The order type decides which legs are candidates: a target fill is matched
   against target legs, a stop fill against stop legs, a market sell against the
   market orders of forced-sell buckets.
3. Nothing is attributed silently among several possible buckets. The tracker
   either has a stated reason and (where the operator asked for it) sends a
   notice, or it asks the operator to choose.
4. A fill dated after today is refused on every path that books or re-dates one.

## Non-goals

- #40, #50, #68, #69.
- Editing the order type in the web. The operator's bucket choice already
  overrides everything.
- Changing the bucket of a fill that is already booked.
- Tracking the unfilled remainder of an order as its own record.
- The buy side. A buy still goes to the next empty bucket.
- The order columns in the vision-review record (`vision_reviews`) or the
  Compare dialog. They have no "final" value to compare against.
- Dropping the date floor of the sibling cancel (#96 "direction B"). See
  "Why the cancel rule stays".

## Anti-goals

- A sell booked to one of several possible buckets with no notice and no
  operator choice.
- A sell held back for an operator choice when only one bucket could have sold
  it. The one exception is the operator's own ruling for a market sell with no
  forced-sell bucket (case C-market).
- A bucket decided at capture time and stored. One place decides: the booking.
- The order type classified inside the vision prompt.
- A refusal that blocks a real fill because of a time-zone difference. "Today"
  is the server's New York date (`deps.today`), never the browser's clock.

## Constraints

- Repo rules: no source file over about 300 lines; `packages/*` never import
  `apps/*`; money as bigint myriadths; all user-facing copy in the en/ko
  catalogs; `fetch` injectable; `bun test` passes with and without
  `TEST_DATABASE_URL`.
- Migrations: edit `apps/server/src/db/schema.ts`, then
  `bun run --cwd apps/server db:generate`. The new columns are nullable with no
  backfill, so nothing is hand-appended.
- The run lock is not reentrant. Everything below that reads state and orders
  for a decision runs inside the span that already holds it.
- Old web bundles and old pending rows keep working: every new field is
  optional and null means "not read".

## Approaches considered

1. **Store what the screen says, classify on the server, decide at confirm
   (chosen).** The extractor returns the raw order columns. Plain server code
   maps the text to a type. The bucket is decided when the fill is booked, as
   today; the same matcher runs as a dry run at capture and when the pending
   list is read, only to tell Telegram and the web whether a choice is needed.
   Trade-off: the dry run can go out of date if another fill books in between.
   The booking re-checks, so the worst case is a refusal that points to the web
   view.
2. **Decide at capture and store the bucket on the pending row.** Telegram
   could name the bucket up front. Rejected: the stored choice goes stale after
   another fill or the morning re-plan, so the booking must re-check anyway and
   two places would decide.
3. **Let the vision model classify (target, stop, other).** Fewer columns.
   Rejected: the rule would live in a prompt where it cannot be unit-tested,
   and a new broker wording would need a re-capture instead of a code change.

The operator picked 1 and fixed the mapping: `LOC` and `보통` are targets, `STOP`
is a stop, and a market sell (`시장가`) matches a forced-sell bucket's market
order if there is one and is otherwise the operator's choice.

## Design

### 1. What the extractor returns

`RawFill` (`packages/ingest/src/extract.ts`) gains three optional fields:

| Field | Source column | Kept when |
| --- | --- | --- |
| `orderType?: string` | 주문구분, verbatim | a non-empty string of at most 32 characters after trimming |
| `orderPrice?: string` | 주문단가 | matches the existing price pattern after commas are stripped (so `0.0000` is kept) |
| `orderedShares?: number` | 주문수량 | a positive integer |

A value that fails its test is dropped. It never makes the fill invalid.

The prompt (`packages/ingest/src/prompt.ts`) asks for the three values per row,
tells the model to copy 주문구분 exactly as shown (including `정정(매도)` and both
`STOP(...)` forms), and to omit a value whose column is not in the table (the
date-range view). The existing rules stay: `price` is 체결단가 only, `shares` is
체결수량 only, a row with 체결수량 0 is skipped. The example JSON gains the new keys.
`side` is still derived from 매수 / 매도 inside the text.

### 2. Where it is stored

Three nullable columns on `pending_fills`, written once at insert like the other
`detected_*` columns and never edited:

- `detected_order_type` varchar(32)
- `detected_order_price` bigint (myriadths)
- `detected_ordered_shares` int

`ingestCapture` writes them. `GET /api/pending` returns them inside the row's
`detected` object. They are not copied to `fills` or `vision_reviews`.

A row captured before this change, a date-range capture and a manual fill have
none of them.

### 3. Order type

A pure function on the server, `classifyOrderType(raw)`, returns `'target'`,
`'stop'`, `'market'` or `'unknown'`. It ignores whitespace and letter case.

| Text | Type |
| --- | --- |
| does not contain `매도` | unknown |
| contains `정정` | unknown |
| contains `STOP` | stop |
| contains `시장가` | market |
| contains `LOC` or `보통` | target |
| anything else (bare `매도`, `LOO`, …), or no text | unknown |

The tests are applied in that order, so `매도/STOP(시장가)` is a stop and a market
sell (`매도/보통(시장가)`, `매도(시장가)`) is a market sell, never a target.

| Type | Matched against orders of kind |
| --- | --- |
| target | `sell_loc` |
| stop | `stop_sell` |
| market | `market_sell` (planned only for a forced-sell bucket) |

### 4. Which bucket a sell belongs to

This replaces `matchSellOrder` and the fallback at the end of `pickSellBucket`
in `apps/server/src/domain/sell-match.ts`. `matchForcedLeg`, `openSellLegs` and
`staleSellLegs` stay as they are.

Terms, unchanged from today:

- **Pool:** this run's orders dated on the fill's trade date, `open` or `stale`.
- **Covers:** the order's bucket is not empty and holds at least the fill's
  shares.
- **Fits:** `sell_loc` when fill price >= limit; `stop_sell` when fill price <=
  trigger; `market_sell` at any price.

The decision, first match wins:

**A. The operator gave a bucket.** That bucket, as today, with no notice.

**B. The type is target, stop or market, and at least one order of that kind in
the pool covers and fits.** Those orders are the candidates. Narrow them step by
step; a step that would leave nothing is skipped.

| Step | Keeps | Applies to |
| --- | --- | --- |
| 1 order price | the candidates whose limit is nearest the screen's 주문단가 | targets, when `orderPrice` was read and is above 0 |
| 2 ordered shares | the candidates whose own `shares` equal the screen's 주문수량 | all, when `orderedShares` was read |
| 3 remaining shares | the candidates whose bucket holds exactly the fill's shares | all |
| 4 fill price | the candidates whose limit or trigger is nearest the fill price | targets and stops |
| 5 older bucket | the bucket with the earliest buy date (`Bucket.filledOn`), then the lowest bucket index, then the lowest order id | all |

The fill books to the bucket of the order left after step 5, and that order is
the one flipped when the fill empties the bucket.

A stop never uses step 1: its 주문단가 is 0 or a stop-limit's limit, not the
trigger. A market order has no price at all, so it uses neither price step.

**C. The type is target or stop, and no order of that kind is a candidate.** By
holdings only: if exactly one non-empty bucket holds at least the fill's shares,
it takes the fill. If none does, `no-bucket-for-sell` (as today). If several do,
the operator chooses. Orders of the other kind are never evidence for a typed
fill.

**C-market. The type is market, and no `market_sell` order is a candidate**
(operator ruling). The operator chooses, even when only one bucket holds enough
shares: a market sell with no forced-sell bucket behind it is something the
tracker did not plan. If no non-empty bucket holds at least the fill's shares it
is `no-bucket-for-sell`, as today.

**D. The type is unknown.**
1. The buckets that have at least one sell-side order (any kind) in the pool
   that covers and fits: exactly one such bucket takes the fill; several mean
   the operator chooses.
2. If there is none, by holdings as in C.

**The order that flips to `filled`** when the fill empties its bucket. In B it is
the order left after step 5. In A, C and D:

- When the fill's type is known and the decided bucket has an order of that kind
  in the pool, that order flips, **whether or not it fits the price**. The type
  says it was that order (a stop can fill a little above its trigger; a limit
  sell can be placed below the planned target). If the bucket has several, the
  one sized like 주문수량, then the one sized like the fill, then the lowest id.
- Otherwise the one `matchForcedLeg` picks, as today. None means nothing flips.

This matters for the sibling cancel: every other open sell-side order of the
emptied bucket is announced as "pull it at your broker", so the order that
really filled must not be among them.

The edit and delete paths (`recompute.ts`) keep calling `matchForcedLeg`: a
booked fill does not store its order type.

**"The operator chooses"** is a new `DomainError('choose-bucket')`. Nothing is
booked. A pending row stays pending, like the other booking refusals.

**The attribution notice** (`sell-attributed`, existing path and delivery):

- Sent in case B whenever a candidate on another bucket existed, with one
  exception: a target fill whose order price equals the limit of candidates on
  exactly one bucket (step 1 at distance 0). That is the normal exit of several
  targets at one close and stays quiet.
- A stop fill with candidates on more than one bucket always sends it, whichever
  step decided (operator ruling).
- A market sell with forced-sell candidates on more than one bucket sends it
  too.
- Never sent in A, C, C-market or D: there is either an operator choice or a
  single possible bucket.
- It names the chosen leg, the other candidates, and which step decided. The
  `rule` value and its en/ko "why" line cover the five steps; the existing
  `price` and `market` values and their copy go away with the old ladder.

Examples the tests must pin:

| Situation | Result |
| --- | --- |
| #74: bucket A's stop for 10 took 6; 4 are left. Bucket B's stop is sized 4. A 4-share stop fill arrives with 주문수량 10. | A (step 2), with a notice. |
| The same, captured from the date-range view (no type). | Operator chooses. |
| A holds 12 (trigger 97.00), B holds 10 (trigger 99.00). A 10-share stop fill at 96.50, no 주문수량. | B (step 3), with a notice. |
| Two targets fill at one close; each row's 주문단가 equals its own leg's limit. | Each to its own bucket, no notice. |
| #43: a `STOP` fill at 96.50; A has a 97.00 stop, B a 91.00 target. | A. B's target is not a candidate; no notice. |
| A `STOP` fill above every trigger, two buckets hold enough shares. | Operator chooses. |
| An unknown-type sell and one held bucket. | That bucket, no notice. |
| `정정(매도)` with two buckets whose legs fit. | Operator chooses. |
| A `시장가` sell; one forced-sell bucket with a market order, two other held buckets with enough shares. | The forced-sell bucket, no notice. |
| A `시장가` sell; two forced-sell buckets, one holding exactly the fill's shares. | That one (step 3), with a notice. |
| A `시장가` sell; no forced-sell bucket, one held bucket. | Operator chooses. |

### 5. Where the choice surfaces

The same matcher runs as a dry run (no writes) to answer "would this sell need a
choice right now?":

- **At capture.** `ingestCapture` marks each new pending sell row. Telegram sends
  such a row without the Yes/No buttons and adds a line pointing to the web
  Pending view, as it does today for a substituted date
  (`capture-date-substituted` in `apps/server/src/wire/capture.ts`).
- **On `GET /api/pending`.** Each sell row carries `needsBucket`. The web marks
  the bucket selector as required while it is on "automatic": the standing-issue
  border and a needs-input line under the row, the same pattern as a field vision
  missed.

The dry run uses the row's stored values and the run's current state. It is a
hint. A dry run that throws (for example no bucket can cover the sell) reports
"no choice needed"; the booking then reports the real error.

When the booking itself answers `choose-bucket`:

- Web pending confirm, manual fill: a worded error naming the bucket selector
  (both dialogs already have one). The pending row then marks the selector as
  required even if the list said otherwise.
- Telegram Yes: an error line pointing to the web Pending view
  (`CONFIRM_ERROR_KEYS`).

The pending row also shows what the screen said about the order, read-only, in
muted small text under the Side control. No new table column.

```
 Date          Ticker  Side              Qty   Price    Fee     Bucket
 [2026-11-23]  SOXL    [Sell ▾]          [1]   [43.25]  [0.03]  [Automatic ▾]  <- warning border
                       매도/STOP(시장가)
                       ordered 1 @ 0.00
 ⚠ More than one bucket could have sold this. Choose the bucket.
```

A row with no order data shows nothing there.

### 6. Refusing a fill dated after today (#96)

A new `DomainError('fill-date-in-future')` when the fill's trade date is after
`deps.today` (plain ISO string comparison; `deps.today` is the New York date):

| Path | Where |
| --- | --- |
| manual fill, pending confirm from the web, Telegram Yes | `bookUnlocked`, before anything is read or written, for buys and sells |
| fill edit that **changes** the date | `rebookFillUnlocked` (`apps/server/src/domain/recompute.ts`), before the first write |
| seeding a run | the `POST /runs` route, before the run row is created; `seedRun` guards as well |

**The edit refusal fires only when the date changes.** It applies when the
edit's `filledOn` differs from the stored date and is after today. The web edit
dialog always sends `filledOn`, and `applyCorrection` always passes the stored
date (`corrections.ts`), so a fill that is already stored with a future date
can still have its price or fee corrected, and can be moved to a valid date.
Finding and fixing such rows is not part of this change.

**Seeding.** The seed path is not named in the issue. It is included because a
seeded buy dated after today is exactly the issue's third case (a buy dated
after its own legs, later deleted). Today `POST /runs` creates the run before it
calls `seedRun` and has no catch, so a refusal inside `seedRun` would leave an
empty run behind and answer 500. The route therefore checks the seed dates
before `runRepo.create` and answers 422 with the code; the create-run form
words it.

**The manual-fill dialog's default date.** `FillDialog.tsx` pre-fills a new
fill's date with the browser's local date (`todayIso()`). The operator's browser
is in Korea, where the local date is one day ahead of New York's for much of the
day, so the default itself would be refused (and today it quietly books fills a
day ahead, which is one way #96 happens). The dialog's default for a new fill
becomes the server's New York date, delivered with data the run page already
loads. Editing an existing fill keeps showing its stored date.

On the other paths HTTP answers 422 with the code, like the other domain
errors. Web and Telegram get en/ko copy.

**A screenshot whose date reads as after today** (operator ruling):

- The extractor keeps the date. Its 45-day rule is unchanged.
- The pending row keeps it as `filledOn` and `detectedFilledOn`, so the review
  tab shows what vision really read.
- `ingestCapture` marks the row. Telegram sends it without buttons and adds a
  line saying the date is after today and must be fixed in the web Pending view.
- `GET /api/pending` gives each row the server's New York date. The web marks
  the date field as a standing issue while the entered date is after it, with a
  hint that says so. It does not compare against the browser's clock.
- Confirm is refused until the date is changed.

### Why the cancel rule stays

Issue #96 proposed, as a second step, cancelling an emptied bucket's open legs of
every date instead of only those dated on or after the fill. It is not needed
once future dates are refused:

- A leg dated today is live at the broker. A fill that empties its bucket is
  dated today or earlier, so the leg's date is on or after the fill's and the
  existing rule cancels and announces it.
- A leg that survives is therefore dated before today. Targets and stops are day
  orders, so its broker day is over and there is nothing to pull. The tracker
  shows it as `open` until the next open-day morning run marks it `stale`, which
  is what happens today.

Cancelling those legs would also announce a "pull it" notice for an order that
no longer exists at the broker. The issue gets this reasoning as a comment when
the branch ships.

Assumption to hold the operator to: the 일자 on the screen is the US trade date
and is never a day ahead of New York's date. The premarket sample (ordered
05:59, captured the same evening in Korea) fits that.

## Behaviour that changes for existing flows

- A manual sell with no bucket chosen is refused with `choose-bucket` when more
  than one bucket could have sold it. Today it is attributed by share count or
  price distance.
- A date-range capture of a sell, a `정정(매도)` row, and a pending row captured
  before this change behave the same way.
- A sell that today falls to "the lowest bucket holding enough shares" is now
  the operator's choice when several buckets hold enough.
- The exact-price rung's "fail loudly" behaviour is gone with the ladder: an
  exact-price target whose bucket cannot cover the fill is simply not a
  candidate.
- Many tests in `apps/server/test/sell-matching.test.ts` and
  `sell-attribution.test.ts`, and any e2e step that books a sell among several
  held buckets, pin the old ladder and must be rewritten to the new rule, not
  patched to pass.

## Verification

- Unit tests for the classifier on the exact strings above.
- Matcher tests for every row of the examples table and every step of case B,
  plus C and D.
- Extractor tests with responses shaped like the stop samples (two rows and no
  fill; four rows and one fill; the filled row alone), like `IMG_2112` (a filled
  `매도/보통(지정가)`), `IMG_2103` (`정정(매도)`) and the date-range sample.
- Booking, confirm, edit and seed tests for the future-date refusal, including
  that nothing is written.
- Capture wiring tests: no buttons for a needs-choice row and for a future-dated
  row.
- Web tests for the required bucket selector, the date issue and the order line.
- `bun test`, `bun run typecheck`, the DB suite and `scripts/e2e.ts`.
- **A live read of all eleven samples through the real vision model** after the
  prompt change. This needs the operator's vision endpoint and key; the builder
  asks for it at the end.

## Left to the builder

- File layout. `sell-match.ts` is at 172 lines; the new rule and the classifier
  most likely want their own modules.
- Names of the new DTO fields, i18n keys and the dry-run function.
- Whether `maxTokens` (1024 in `wire/capture.ts`) is still enough with three more
  values per row.
- The exact en/ko wording. Korean copy stays within the scope of #50's later
  native read.
- Updating the superseded section of the cut-loss spec with a pointer here, and
  the repo map in `AGENTS.md`.

## Calls made without the operator (check these)

1. **Step 2, ordered shares, is new.** The operator's rule named remaining
   shares only. 주문수량 is stronger evidence when it is on the screen, and it is
   what resolves the case in the issue's title.
2. **Narrowing.** "If none or several hold exactly the fill's shares, the nearest
   trigger" is built as: several narrow to those several, none skips the step.
3. **Case C.** A typed fill with no leg of its type is booked when exactly one
   bucket holds enough shares, instead of always waiting for the operator.
4. **Target notices** stay quiet only on an exact order-price match.
5. **Seeding** refuses future dates too, checked before the run is created.
6. **A market sell is recognised by `시장가` outside `STOP`.** The rule itself is
   the operator's (forced-sell bucket if there is one, otherwise the operator
   chooses). The wording is inferred: no sample shows a market sell yet. Read
   literally, "otherwise" also covers a single held bucket, so that case waits
   for a choice.
7. **The order columns are shown under the Side control**, not in a new column
   and not in the Compare dialog.
8. **#96 closes with the refusal only.**
9. **A fill edit is refused only when it changes the date** to one after today.
10. **The manual-fill dialog defaults to New York's date**, not the browser's.
11. **A typed fill flips its bucket's order of that kind even when the price does
    not fit**, so the order that filled is not announced as one to pull.
