# Value Rebalancing core — Design

Date: 2026-11-25
Status: draft, awaiting owner approval

## Intent and why

The owner wants to run Laoer's Value Rebalancing (VR 5.0) next to his mean-reversion (MR) runs,
possibly on the same ticker. As with MR, he places every order himself; the app does the maths,
tells him what to place on Telegram, and keeps the books.

VR's maths is light but easy to get wrong by hand: every two weeks a new target value V, a band
around it, and a ladder of one-share limit orders whose prices depend on how many shares he
holds. The app takes that over.

This is **piece 2a** of the roadmap agreed with the owner:

1. Table split (`mr_` prefix) — done, PR #118.
2. VR — **2a core (this document)**: maths, tables, Telegram cycle message, VR screens, fills
   typed in by hand. **2b** (next): screenshot intake for VR, including the Telegram "which
   strategy?" question and a VR pending screen.
3. All-runs dashboard.

Owner decisions carried in: each strategy has its own tables (`vr_*`) and its own screens; a new
run starts from cash only ("new"); the **skill formula** is used for V.

### Where the rules come from

The cafe posts could not be read (login-gated). The rules below come from a public guide that
cites them post by post (d-capitalism.com/vr) and, for the skill formula, from several blogs
that quote it. Where the cafe differs, the cafe wins; the owner should flag it. Three points are
uncertain and are listed under "Uncertain points in the source".

## Goals

- Create a VR run from cash, get told how many shares to buy to start, and from then on receive
  one Telegram message per two-week cycle with the new V, the band, and the buy and sell ladders.
- Keep VR books (shares, Pool) from fills and cash movements typed in on the VR run page.
- A VR run page that always shows the current ladder for the current share count.
- MR behaves exactly as before. A VR run and an MR run may share a ticker.
- Screenshot intake is untouched in this piece: a screenshot still goes to MR runs only, so a
  screenshot of a VR fill on a ticker that also has an MR run lands in that MR run's pending
  list. Owner's ruling: when one brokerage account serves several strategies, he rejects the
  entries that belong elsewhere.

## Non-goals

- Screenshot intake for VR and the Telegram strategy question (piece 2b).
- The all-runs dashboard (piece 3).
- A VR simulator or backtest.
- Charts (V / band / value over time). The cycle history is a table for now.
- Recomputing past cycles' V after a late or edited fill (see "Late and edited entries").
- More than one share per rung, automatic switching between deposit styles, Infinite Buy.

## Anti-goals

- Floating-point money. All maths is integer (cents, and price in ten-thousandths of a dollar as
  elsewhere in the project).
- A V that is silently wrong. The formulas are pinned by worked examples.
- A ladder that tells him to spend more than the cycle's Pool budget.
- VR code reading or writing an `mr_*` table, or any change in MR behaviour.

## Approaches considered

**Delivery.** (1) Everything at once including screenshot intake: nothing usable until all is
done. (2) **Core first, screenshots second — chosen by the owner.** A real run can start after
the core; fills are typed by hand until 2b. (3) Sheet-style, typing share count and cash at each
cycle close: smallest, but no fill history for the books or the later dashboard.

**Books (designer's call).** Stored running state updated on every booking (what MR does) versus
**books computed from the fill and cash history every time — chosen.** VR state is just two
numbers, so recomputing is cheap, and editing or deleting an entry can never leave the books out
of step. MR needed a large body of re-booking code for exactly that problem.

**Ladder (designer's call).** A stored orders table with open/filled status versus **computing
the ladder on demand — chosen.** A rung's price is a function of the band and the share count
only, so the ladder for "now" follows from the current books. Extra or missed fills need no
special handling: the ladder simply continues from the shares actually held, which is also what
the source says to do.

## The method, as built

Terms: **V** target stock value; **E** actual stock value (shares × price); **Pool** cash in the
VR account; **G** gradient (integer ≥ 1); **band** V ± 15%; **cycle** two weeks.

### Starting a run

Inputs: name, ticker, total cash, initial stock amount (default: half the cash), G (default 10),
formula (default skill), band (default 15%), Pool spend limit (default 50%), deposit per cycle
(default 0; negative means a withdrawal), trade cost.

- The cash is booked as the opening cash movement. Shares are 0, there is no cycle yet.
- While the run holds no shares, each morning job sends a **buy instruction**: buy
  `floor(target ÷ last close)` shares, where the target is the initial stock amount. The order
  type is his choice.
- The first morning job that finds shares > 0 opens **cycle 1** with V = the initial stock
  amount, and sends the first cycle message. No deposit is booked for cycle 1 (the opening cash
  is the first money in); its buy budget is the Pool at that moment × the spend limit. Deposits
  start with cycle 2.
- If the share count returns to 0 later (an edited or deleted fill, or a sale typed in by hand),
  cycles keep rolling on schedule with E = 0, there is no ladder, and the same daily buy
  instruction is sent with the current V as the target (designer's call).

### Each cycle

- A cycle lasts 14 calendar days. A new cycle opens in the morning job (07:30 ET, trading days)
  on the first trading day on or after the previous cycle's scheduled start + 14 days. The
  schedule is anchored: a holiday that delays one start does not shift later ones. If the job
  runs more than 14 days late (server down, run paused), it rolls **once** and re-anchors to
  that day.
- At that moment, with C = the last close (the same freshness check MR uses), books taken as of
  then, and D = the deposit per cycle:
  - `E = shares × C`
  - basic formula: `next V = V + Pool ÷ G + D`
  - skill formula: `next V = V + Pool ÷ G + (E − V) ÷ (2√G) + D`
  - D is also booked as a cash movement, so the new cycle opens with `Pool + D`.
  - band: `min = next V × 0.85`, `max = next V × 1.15`
  - buy budget for the cycle: `opening Pool (after D) × spend limit`
- Every term is rounded to the nearest cent with the project's existing rule (`roundDiv`:
  halves away from zero, which matters for a negative `E − V`). `2√G` is computed with integer
  arithmetic, not floats. If the result is not positive (only possible with large withdrawals),
  V is kept and the message says so.
- Between cycle starts the job sends nothing for the run.
- Settings changed mid-cycle (G, formula, band, spend limit, deposit) apply from the next cycle.

### The ladder

For the current share count n ≥ 1 in the current cycle:

- **Buy rungs:** one share each at `min ÷ n`, `min ÷ (n+1)`, `min ÷ (n+2)`, …, rounded to the
  nearest cent. Rungs are listed while their running total fits in the budget still unspent this
  cycle (budget minus price × shares of the buys dated in the cycle) and in the Pool itself.
  Fees are left out of both checks, as in the source's table (designer's call), so the ladder
  never exceeds the budget before fees.
- **Sell rungs:** one share each at `max ÷ n`, `max ÷ (n−1)`, …, rounded to the nearest cent,
  stopping while one share is still held: the ladder never offers the last share (designer's
  call, so the run does not sell itself out).
- Telegram shows the first 10 rungs of each side and the total count; the web page shows all.

### Worked examples (pinned as tests)

- Basic: V 9,000.00, Pool 1,000.00, G 10, D 250.00 → next V 9,350.00; band 7,947.50 to
  10,752.50. (From the guide.)
- Buy rungs: min 10,509.46, 176 shares → 59.71, 59.38, 59.04, 58.71, 58.39; a Pool of 383.14
  falls to 323.43, 264.05, 205.01, 146.30, 87.91. (The guide's table, matching to the cent.)
- Skill: V 14,837.55, Pool 0.50, G 10, E 15,871.05, D 130.00 → next V **15,131.01**
  (`1,033.50 ÷ 6.3245553… = 163.41`, plus `0.05` and `130.00`).

### Uncertain points in the source

1. **Skill formula precision.** The blog example above arrives at 15,131.13 because it rounds
   2√10 to 6.32 by hand. This design uses the exact root. If the cafe's sheet rounds, V differs
   by a few cents to a few dollars per cycle.
2. **Sell rungs.** The guide says the cafe gives no numeric sell table; the sell rule here
   mirrors the buy rule.
3. **Where the buy rungs stop.** The guide states the spend limit as a share of the Pool
   (75% / 50% / 25% for adding / lump sum / withdrawing), yet its own example table lists a
   fifth rung that passes 75%. This design stops before the rung that would exceed the budget.

## Books

Two histories per run, both editable:

- **Fills:** side, shares, price, fee, date, source (`manual` now, `capture` in 2b).
- **Cash movements:** kind (`open`, `deposit`, `withdraw`, `adjust`), signed amount, date, note.
  `adjust` covers dividends, interest and anything else that moves broker cash.

From them, at any moment:

- `shares = bought − sold`
- `Pool = cash movements − buy cost − fees + sell proceeds`
- effective average cost = `(buy cost − sell proceeds) ÷ shares`
- performance: `value = E + Pool`, `net invested = open + deposits − withdrawals`,
  `profit = value − net invested`. `adjust` movements are not invested money, so dividends and
  interest show up as profit (designer's call). E uses the latest stored close for the ticker;
  until one exists the page shows no value.

Rules: a fill may not be dated after today (the existing rule); a change that would make the
share count negative is refused; a negative Pool is allowed (the books must be able to follow
the broker) and is flagged on the page.

### Late and edited entries

Shares and Pool always reflect every entry. A cycle's V, however, is recorded when the cycle
opens and is **not** recomputed when an older fill is added, edited or deleted afterwards. The
effect is small (a missed 60-dollar fill moves the next V by a few dollars at G = 10) and the
page says when an entry is dated before the current cycle's start. Each cycle row stores the inputs that
produced its V (close, E, Pool before deposit, G, formula, deposit), so a "recalculate cycles"
action can be added later without a data change.

## Data model

New tables, generated by drizzle-kit in the normal way (no hand-written SQL):

- `vr_runs` — one row per VR run, keyed by `run_id` (= `strategy_runs.id`): G, formula, band,
  spend limit, deposit per cycle, initial stock amount.
- `vr_cycles` — one row per cycle: run, sequence number, scheduled start, actual start, V, band
  min and max, opening shares, opening Pool, buy budget, and the inputs listed above.
- `vr_fills`, `vr_cash_moves` — the two histories.

`strategy_runs` gets VR rows with `strategy_key = 'value-rebalancing'`. Name, ticker, status and
trade cost stay there. Messages are recorded in the shared `notifications` table.

## Server

- **Engine** (`packages/strategies`, pure, no I/O): next V for both formulas, band, ladder,
  books from the two histories, start-instruction share count.
- **Shared run reader:** a thin repository over `strategy_runs` alone (id, strategy, ticker,
  name, cost, status, created) for the places that must see every strategy. MR's `runRepo`
  still returns MR runs only. Run names remain unique across strategies; creating a VR run with
  a taken name returns a clear error. (MR's create route answers a taken name with a server
  error today; that is left as it is and noted as a follow-up.)
- **MR status writes become MR-only.** Today `runRepo.updateStatus` and `updateStatusMany`
  change `strategy_runs` by id without checking the strategy, so the MR bulk-status endpoint
  could pause or close a VR run. They are restricted to runs that have an `mr_runs` row. No MR
  run behaves differently.
- **Morning job:** after the MR runs, each active VR run is processed under the same weekend,
  holiday and calendar-conflict guards and the same last-close fetch and freshness check: start
  instruction, open cycle 1, roll the cycle, or nothing. One failing run never stops the others,
  as today. The job never opens two cycles for a run on the same day. The checked close is
  stored in `price_history` as MR's is, so a ticker used only by VR has a close for its page.
  VR runs count toward the job's result like MR runs: it reports a data error only when every
  run failed.
- **Booking:** adding, editing and deleting fills and cash movements, serialized per run with
  the existing run lock.
- **Telegram:** buy instruction and cycle message in English and Korean; `/status` and
  `/orders` include VR runs (holdings, Pool, V and band; first rungs of each side). The "no
  runs" and "no orders" replies are sent only when neither strategy has anything to show; with
  MR runs only, both commands reply exactly as today.
- **HTTP** under `/api/vr`: list and create runs; run detail (settings, books, current cycle,
  full ladder, performance); change status; change settings; cycle history; fills and cash
  movements (list, add, edit, delete).
- **System notices feed:** entries for VR runs carry the run's ticker and strategy, so the web
  can name them and link to the VR page.

## Web

A new top-level navigation entry, **VR**, with two pages. All copy goes through the en/ko
catalogs. Existing MR pages are unchanged; the MR runs list still lists MR runs only.

**VR runs list** — table of VR runs (name, ticker, status, shares, Pool, V, value) and a
"New VR run" form with the start inputs above.

**VR run page**

```
TQQQ lump sum  [active]                         [Pause] [Close] [Settings]
Cycle 3 · Dec 7 – Dec 20 · next cycle Dec 21
V $9,350.00    band $7,947.50 – $10,752.50    G 10 · skill formula
Shares 177     Pool $954.81    budget left $454.84 of $500.00
Value $9,096.81   net invested $10,000.00   profit −$903.19   avg cost $51.07

Buy ladder (1 share each)         Sell ladder (1 share each)
 to shares  price                  to shares  price
 178        44.90                  176        60.75
 179        44.65                  175        61.09
 ...                               ...

[Fills] [Cash] [Cycles] [Alerts]
 date        side  shares  price   fee      [Add fill]
 2026-12-08  buy   1       45.16   0.03     edit · delete
```

(The cycle opened with 176 shares and a Pool of $1,000.00; the one fill shown has been booked;
the last close is $46.00.) While the run holds no shares the page shows the buy instruction
instead of the ladder.

## Verification

- Engine unit tests, including the three worked examples and edge cases (0 shares, one share
  held so no sell rung, empty Pool, budget exactly reached, a negative `E − V` term rounding,
  withdrawal driving V non-positive).
- Repository and booking tests against a database; HTTP tests; morning-job tests with fakes
  (buy instruction, cycle 1 without a deposit, shares back to 0 after cycle 1, roll on the due day, holiday shift keeps the anchor, late job
  rolls once, already rolled today, one run failing).
- Web tests for the two pages and the forms.
- `scripts/e2e.ts` gains a VR step on its scratch database.
- The whole existing suite, typecheck and `db:generate` (no pending changes) stay green; no MR
  test changes in intent.

## Left to the builder

- File and module layout for VR on server and web, within the ~300-line convention.
- Exact column types and index choices in the new tables.
- Route shapes under `/api/vr` and DTO names.
- Message wording in both languages, and the layout details of the two pages beyond the sketch.
- How the integer square root is implemented, as long as the pinned example holds to the cent.
