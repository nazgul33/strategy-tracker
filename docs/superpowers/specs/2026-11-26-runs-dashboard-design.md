# All-runs dashboard — design

Status: approved by the owner on 2026-11-26 (a builder's read-through is folded in; the points
it settled are marked "designer's call")
Date: 2026-11-26
Piece 3 of the roadmap in `2026-11-24-mr-table-split-design.md` (1 `mr_` split, 2a VR core,
2b VR screenshot intake, 3 all-runs dashboard).

## Intent and why

The owner runs two strategies, mean reversion (MR) and Value Rebalancing (VR), each with its own
runs list. Neither list says what a strategy is worth right now. He wants one screen that shows,
per strategy, the **current total value including cash, computed with the last closing prices**.

In his words: "What I want is current total value including cash computed with last closing
prices. The totals are per strategy." And: "Closed MR runs are out of scope here."

## Goals

- One page that shows, for each strategy, the total value of its runs: shares at the last stored
  closing price, plus cash.
- Each run is listed under its strategy with the pieces of its value, so a total can be checked
  by eye, and each row links to the run's page.
- A figure that rests on a missing or older close says so.
- The existing run lists, run pages and their server responses do not change.

## Non-goals

- Profit, return, or anything measured against money put in.
- History of the value over time, charts.
- A combined figure across strategies (the owner asked for totals per strategy).
- Closed runs, of either strategy (the owner ruled closed MR runs out; leaving closed VR runs out
  too is the designer's call, stated to him).
- Conversion to another currency. Everything is US dollars, as elsewhere in the app.
- A Telegram command or message for these figures.
- Fetching prices when the page is opened. The page uses closes already stored.

## Anti-goals

- A total that silently leaves a run's shares out, or values them at a price from another day
  without saying so.
- A figure that disagrees with what the run's own page shows for the same books and close.
- Any float in the money arithmetic.
- Any change in what the MR or VR screens show, or in the morning messages, other than the two
  additions the owner decided on after the final review: stored closes one session newer in the
  evening, and a mean-reversion run's cash following "Add funds" at once.

## Approaches considered

**A. The page computes it from existing responses.** No server change, but the MR list carries
no closing price, so the page would need extra requests per run, and the money arithmetic would
live in the browser, apart from the server's.

**B. One new server endpoint that returns the finished dashboard — chosen by the owner.** The
server reads the runs, their books and the latest stored closes, computes each run's value and
each strategy's total with the integer money code used everywhere else, and the page only
displays it. One request; the arithmetic is in one tested place; existing responses stay as
they are.

**C. Value fields added to the two existing run lists, summed in the page.** Changes the MR
list's response for a page that is not the list, needs two requests, and splits the logic.

## What is counted

Runs with status `active` or `paused`, of both strategies. Closed runs are not listed and not
counted.

For one run:

- **shares** — MR: the shares in every bucket that holds any (held and force-sell buckets).
  VR: the shares on the books (from `vr_fills`).
- **close** — the newest row for the run's ticker in `price_history`, with its trade date.
- **stock value** — shares times close, rounded to the cent the way the VR books already round
  (`evalCents` in `packages/strategies/src/value-rebalancing.ts`). Zero when the run holds no
  shares, whether or not a close exists.
- **cash** — MR: the run's cash (`cashCents` in its state). VR: the Pool on the books.
- **value** — stock value plus cash.

The shares and the Pool of a VR run come from the VR books computation that its own page and
the VR list use (`vrBooks`); the dashboard does not compute books a second time. The valuation
rule above is the dashboard's own and is the same for both strategies. So a VR row equals the
VR list in shares and Pool always, and in value whenever the VR list reports one. Designer's
call, for the one case where they differ: a VR run with no shares and no stored close (a run
just created, before its first buy) has no value on the VR screens today; on the dashboard its
value is its Pool, because cash needs no price. The VR screens do not change.

Fills waiting to be confirmed (MR pending fills, VR waiting fills) are not on the books, so they
are not counted. Each row shows how many are waiting, so the owner knows the figure will move.

A strategy's **total** is the sum of its runs' values.

### Missing and older closes

- A run that holds shares and whose ticker has **no stored close** shows no stock value; its
  value is its cash alone and the row says the close is missing. Its strategy's total is marked
  incomplete.
- The page states the date of the closes it used. Only rows that hold shares use a close; a row
  with no shares shows none and plays no part in this (designer's call). When all the closes
  used are from the same date, it is shown once at the top. A row whose close is from an
  **earlier date than the newest close used on the page** shows its own date and is marked, and
  its strategy's total is marked as resting on an older close. There is no time-of-day logic (the owner reads the page in Korea, where the
  New York date and the morning job's hour would otherwise raise false alarms every afternoon).
- A run with no shares needs no close and is never marked.
- Added after the final review, and changed again on the owner's decision to store the close
  in the evening (see "The evening close job"): when every row is equally old nothing above
  marks it, so the page also says when its closes are **behind**. The closes are behind when
  the newest close used is older than the close the page should have by now: today's, when
  today is a trading day and it is 17:30 or later in New York (the evening job runs at 17:00);
  otherwise the previous trading day's. A normal day never trips it; a missed evening job
  trips it from 17:30 New York (07:30 in Korea in winter) until the next morning job stores
  that close. The page also says in one line when closes are stored.

### Keeping closes current for paused runs

Today the morning job fetches and stores the last close only for the tickers of **active** runs
(`pipeline/day.ts`, `pipeline/vr-day.ts` through `fetchClose`). A paused run's ticker would
therefore keep an old close, and the dashboard would mark it every day. Designer's call: on the
mornings the job processes runs (not on weekends, closed days, or when it stops early for any
reason it stops today), after the MR and VR runs have been processed, it takes every ticker of
an active or paused run of either strategy whose newest stored close is older than the previous
trading day, and fetches and stores the last close for it through the existing checked fetch.
A ticker already stored that morning is therefore not fetched again, and a ticker whose run
skipped or failed earlier is caught up. The step sends no message, takes no run lock, changes
no run state, and a failure is only logged. Nothing else about the morning job changes.

### The evening close job (added on the owner's decision after the final review)

The final review found that the newest stored close was one session behind the last one traded
for most of the owner's day: a session's close was only stored by the next trading morning's
job (07:30 New York, 21:30 in Korea). The owner chose to close that gap.

- Every trading day at **17:00 New York**, an hour after the normal close (early-close days
  close earlier), a job stores **that day's** close for every ticker of an active or paused run
  of either strategy. It uses the same price source and the same check as the morning fetch,
  with the expected date being today: an answer dated any other day is not stored and is
  logged.
- It stores nothing on a day the market is closed, and nothing when it is called before 16:30
  New York, so a half-formed bar of a session still open can never be stored.
- It sends no message, takes no run lock and changes no run, order or books. A failure is
  logged; the next morning's job stores the same close anyway (and overwrites the evening's
  value with its own for the same date, so a late correction by the source is picked up).
- The morning job and its catch-up stay as they are. On a normal morning the catch-up finds
  every ticker already stored and fetches nothing.
- `price_history` may therefore hold a row dated today, written only by this job after the
  session. The bar cache (`market/bars.ts`) still never stores or marks as covered anything
  after the last finished trading day; when that day is later backfilled, the bar overwrites
  the close-only row.
- Readers of stored closes see the newer close the same evening: the dashboard, the VR page's
  last close and value, the mean-reversion price chart and the cut-loss hint. No morning
  decision reads a stored close.

### Adding funds to a mean-reversion run (added on the owner's decision after the final review)

The final review found that "Add funds" on a mean-reversion run changed the run's pool but not
its stored cash, which the run page shows and the dashboard sums; the cash only caught up at
the next Update or fill edit, as one large adjustment. The owner chose to fix it.

- Setting a run's pool now moves the run's stored cash by the same difference (new pool minus
  old pool), in the same request, under the run lock, and books one ledger row for it. The
  run page's cash and the dashboard include the added funds at once.
- A later Update on such a run reports no difference from this edit (the stored cash already
  equals the pool minus the fill history, as far as this edit is concerned). A seeded run keeps
  whatever difference its seed already had: this change adds the pool difference and does not
  re-derive the cash.
- Order sizing is unaffected: it uses the pool, as before.
- This is the one intended change to mean-reversion behaviour in this piece.

## The page

A new page, **Dashboard**, at `#/dashboard`. It is the first item in the menu and the page the
app opens on: the empty hash, the app name in the header and the redirect after signing in go
there (today they go to the MR runs list at `#/runs`, which stays where it is).

```
Dashboard                                         closes of 2026-11-25

Mean reversion                                     total  $48,210.33
 run          ticker  status   shares   close   stock value   cash         value        waiting
 SOXL main    SOXL    active   118      36.18   $4,269.24     $20,105.10   $24,374.34
 TQQQ swing   TQQQ    paused   95       71.40   $6,783.00     $17,052.99   $23,835.99   2

Value Rebalancing                                  total  $31,902.75
 run          ticker  status   shares   close   stock value   Pool         value        waiting
 TQQQ VR      TQQQ    active   277      71.40   $19,777.80    $12,124.95   $31,902.75
```

- Both strategies are always shown, in this order. A strategy with no active or paused run shows
  an empty-state line and a total of $0.00.
- The run name links to the run's page (`#/runs/<id>` or `#/vr/<id>`); a waiting count above
  zero links to where those fills are decided (the MR Pending page, the VR run's Pending tab).
- Loading, a failed load with a retry, and an expired sign-in behave as on the other pages.
- The page loads when opened; a reload control re-reads it. No automatic refresh.
- All copy through the en/ko catalogs; VR strings write "Pool".

## Server

One read-only endpoint behind the existing sign-in, `GET /api/dashboard`, returning the two
strategy groups with their runs, totals and marks, the date of the closes used, and the server's
New York date. Amounts are integer cents; prices leave as strings like every other price in the
API. It takes no run lock and writes nothing.

No new table, no migration.

## Verification

- Unit tests of the computation with fixed books and closes: an MR run with held and force-sell
  buckets; a VR run whose figures equal its own summary; a run with no shares and no close; a
  run with shares and no close (cash only, total incomplete); two tickers with closes of
  different dates (the older row and its total marked); paused runs counted and closed runs
  absent; waiting counts; rounding at half a cent.
- A test that the VR row equals what `GET /api/vr/runs` reports for the same run in shares and
  Pool, and in value when the list reports one; and the new-run case (no shares, no close): the
  list reports no value, the dashboard reports the Pool.
- Route tests: sign-in required, the response shape, prices as strings.
- The morning job: a paused run's ticker gets its close stored; a ticker whose close was already
  stored that morning is not fetched again; an active run's ticker that was not stored (its run
  skipped or failed) is caught up; a failed fetch is logged and changes nothing else; nothing
  is fetched on a morning the job stops early; every existing `day*` and `vr-day*` test passes
  with its assertions unedited.
- Web tests: the table for each strategy, totals, the marks, the empty state, links, the
  landing redirect, and that the MR and VR list pages are unchanged.
- The end-to-end smoke gains a check that the dashboard's totals equal the sums of what the two
  lists and the stored closes give for the script's runs.

## Left to the builder

- The exact response shape and names; where the computation lives on the server.
- How the newest close per ticker is read (the existing listing, or a new repository method).
- How the MR waiting count is read.
- The layout details of the page within the app's existing table and card styles, and how the
  marks look.
- The wording of every string, in English and Korean.
