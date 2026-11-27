# All-runs dashboard — deploy notes and deferred follow-ups

Date: 2026-11-27
Branch: `feat/runs-dashboard` (`9cda9b2..91e89c9`)
Spec: `docs/superpowers/specs/2026-11-26-runs-dashboard-design.md`
Plan: `docs/superpowers/plans/2026-11-26-runs-dashboard.md`

The branch adds the Dashboard page (value per strategy at the newest stored close plus
cash), a close catch-up at the end of the morning job, an evening job that stores the day's
close, and makes a mean-reversion pool edit move the run's stored cash. Neither the
whole-branch review nor the scoped check of the two late additions found a Critical issue;
their Important findings were fixed on the branch or decided by the owner. What follows is
what the owner needs at deploy, and what the reviews found and the branch left.

## Deploy notes

- **No migration.** Build the web app and the server together: the "closes are behind"
  banner changed its meaning together with its text.
- **Press Update once on every mean-reversion run that had funds added since its last
  Update or fill edit.** Such a run still carries the old difference between pool and
  stored cash, and the dashboard understates it until then. The popup amount should equal
  the funds added. On a seeded run that was never Updated, the Update also replaces the
  seed cash, as before. A candidate list (not tested):

  ```sql
  SELECT e.run_id, MAX(e.edited_at) AS last_edit,
         (SELECT MAX(l.ts) FROM mr_ledger l WHERE l.run_id = e.run_id AND l.kind = 'adjust') AS last_adjust
  FROM mr_pool_edits e GROUP BY e.run_id
  HAVING last_adjust IS NULL OR last_adjust < last_edit;
  ```

- **First evening.** Expect a log line `[jobs] evening closes: N stored, 0 behind` at 17:00
  New York (07:00 in Korea in winter, 06:00 in summer), and "closes of" that day on the
  page. The job runs again at 18:00 and 19:00 and then fetches nothing.
- **A banner during the Korean day** means that evening's store failed three times. It
  clears when the next morning job stores the close (21:30 in Korea in winter).
- **The first week:** compare the close stored at 17:00 with the one the next morning's job
  stores for the same date (the morning job overwrites it for tickers of active runs). The
  code cannot tell whether the provider's 17:00 figure is the official close or provisional.

## Known limits

### Closes and the evening job

- **The 17:00 figure is what the page shows all day.** The morning overwrite lands at 21:30
  in Korea and is replaced as the newest close at 07:00. A ticker held only by paused runs
  keeps the 17:00 value.
- **Half days.** The close is stored at 17:00, four hours after a 13:00 close.
- **A clock an hour or more fast** defeats the 16:30 guard (it reads the same clock), and a
  live price dated today could be stored. The next morning overwrites it for active runs.
- **The price fetch has no timeout** (`packages/market-data/src/yahoo.ts`). A hanging fetch
  delays the manual "trigger morning" answer and that evening run; it blocks no other job.
- **A missed session's close is never backfilled** by these jobs; the newest close moves on.
  The chart's bar cache fills the gap when that range is next requested.
- **Outside the calendar's covered years** (2029 on, until the table is extended) the
  banner misfires after each holiday, and the evening job treats a holiday as open.
- **Reads.** The dashboard and both jobs read a ticker's whole price history to use its
  newest row (`dashboard.ts`, `main.ts`). A newest-row query is the lean version.
- **No Telegram signal** when the evening job has not stored anything for days; the banner
  on the page is the only sign.

### The dashboard page

- **A sub-cent close** is shown rounded to cents next to a stock value computed from the
  exact price.
- **Reload** gives no in-flight feedback and has no guard against an older response landing
  last (`useAsync` has none).
- **A malformed answer** shows "The request failed (http-200)." The web app has no error
  boundary anywhere; the dashboard guards its own response shape only.
- **A negative Pool** has no warning tone on the dashboard (the VR page warns).
- **One broken run fails the whole page** (a deliberate choice over a silent partial total).
- **The standing note** names 17:00 only, not the 18:00 and 19:00 retries.

### Adding funds to a mean-reversion run

- **Two browser tabs.** The route takes an absolute pool total computed by the client. A
  stale tab that adds funds posts an old total and reverses another tab's top-up, now in
  cash as well as pool. A check of the pool the client started from (answering 409) would
  stop it.
- **The audit rows are not in the transaction.** If the pool-edit row or the ledger row
  fails after pool and cash were stored, a retry sees no difference and that row is lost.
  No money figure is affected.
- **The morning plan** sizes a buy from the pool it read before taking the run lock, so an
  edit landing in that instant applies to the next morning (unchanged behaviour).

## Tests and code

- The smoke (`scripts/e2e-dashboard.ts`) never produces an "older close" row or two stored
  closes for one ticker, does not compare waiting counts, and has a single live VR row.
- `apps/server/test/pool-edit.test.ts` copies the held-lock helpers of
  `run-lock-writers.test.ts`; the fakes' `saveStateWithPool` is not atomic.
- `http-runs.test.ts` checks the dashboard value after a pool edit with no stored close.
- Closes are de-duplicated by the raw ticker spelling (`soxl` and `SOXL` are read twice;
  the result is correct).
- Test files slightly over ~300 lines: `apps/web/src/pages/Dashboard.test.tsx`.
