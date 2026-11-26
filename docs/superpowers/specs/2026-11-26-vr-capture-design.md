# Screenshot intake for Value Rebalancing — Design

Date: 2026-11-26
Status: approved (2026-11-26)

## Intent and why

VR runs exist (PR #120) but their fills are typed in by hand. A day on which the ladder fills can
mean ten rows of typing. Mean-reversion (MR) fills already arrive as broker screenshots: the app
reads them, shows them as pending, and books them when the owner confirms. This piece gives VR
the same intake, so the owner sends one screenshot and confirms.

It is **piece 2b** of the roadmap: 1 table split (done), 2a VR core (done), **2b this document**,
3 all-runs dashboard.

Owner decisions carried in:

- VR has its own pending table and its own screen; MR's pending flow is not generalised.
- **Routing:** the screenshot is read first. A ticker is routed by itself when only one strategy
  has an active run for it. When both do, Telegram asks.
- **VR fills are not confirmed on Telegram.** The bot only says how many are waiting; the owner
  confirms on the VR run page.
- When one brokerage account serves several strategies, the owner rejects the entries that
  belong elsewhere.

## Goals

- A screenshot sent to the bot or uploaded in the web app can end up as pending fills on a VR
  run, and confirming them books `vr_fills` rows with source `capture`.
- On Telegram, a ticker that both strategies trade gets one question with three answers: mean
  reversion, VR, or both.
- The VR run page shows the run's pending fills with the screenshot beside them, and lets the
  owner edit, confirm, reject, or confirm all.
- MR intake behaves exactly as today whenever VR is not involved in the ticker.
- A VR cycle never opens on books that are known to be incomplete: waiting screenshot fills
  hold the cycle until they are confirmed or rejected.

This replaces one rule from piece 2a. There, a screenshot for a ticker traded by both an MR run
and a VR run went to the MR run. Now it gets the question on Telegram, and "several active
runs" on an un-pinned web upload (including uploads from MR's Pending page).

## Non-goals

- Confirming or rejecting VR fills from Telegram.
- A "keep image" option, Vision Review entries, or correction proposals for VR.
- Using the broker's order type to guess the strategy.
- Asking the strategy question in the web app.
- Any change to how MR pending fills are confirmed, and the dashboard.

## Anti-goals

- A fill booked twice because a screenshot was sent twice.
- A VR screenshot silently landing in an MR run when a VR run exists for the ticker, or the
  reverse.
- A stored screenshot that is never deleted, or one deleted while its fills are still pending.
- Any change in MR's Telegram texts, events or bookings for tickers VR does not trade.

## Approaches considered

**A parallel VR intake that reuses the strategy-neutral parts — chosen.** Reading the
screenshot, the `captures` row and image storage are strategy-neutral as they stand. The
duplicate matcher and the "same screenshot again" check are neutral in their logic but read MR
tables today; both take their readers as arguments, so VR supplies its own (VR fills carry no
ticker, so the run's ticker is added on the way in). VR adds its own pending table, intake and
confirm on top, and routing learns that two strategies exist. This follows the piece-1 decision that everything bucket-bound stays
MR.

**One shared pending table for both strategies.** Rejected in piece 1: MR's pending rows carry
bucket choices, sell attribution evidence and review snapshots that VR has no use for.

**No routing change; VR only by pinning a run.** Smallest, but it contradicts the owner's
request that Telegram asks, and every VR screenshot would need a caption.

## Routing

The screenshot is read once (the existing vision call). Fills are grouped by ticker. For each
ticker, the candidates are the **active** runs of either strategy with that ticker.

| Candidates for the ticker | Telegram | Web upload without a run |
| --- | --- | --- |
| none | "no active run" notice, as today | same |
| one run | goes to that run | same |
| exactly one MR run and one VR run | **asks** (below) | "several active runs: upload from the run's page", as today's wording for two runs |
| any other mix of two or more runs | "several active runs" notice, as today | same |

**Pinning skips all of this.** A caption starting with a run id (`7`, `#7`, `/capture 7`) on
Telegram, or uploading from a run's page on the web, sends the screenshot to that run whatever
its strategy or status; fills for other tickers are skipped with the existing notice. A VR run
id works exactly as an MR one does.

### The Telegram question

- One message per ambiguous ticker: "TQQQ, 3 fills: which strategy?" with three buttons —
  **Mean reversion**, **VR**, **Both**. Button labels come from the catalog (en/ko).
- The screenshot and the fills read for that ticker are parked with the question until the
  owner answers, together with the day they were read. Every field read for a fill is kept, so
  an answer hands the intake exactly what it would have received at once. Parking happens only
  for Telegram; a web upload never parks anything, and the screenshot never travels back to the
  browser.
- An answer is carried out as if it had been given at once: dates missing from the screenshot
  are filled with the day it was read, not the day of the answer.
- The answer goes to the two runs named in the question, whatever their status has become in
  the meantime (as a pinned screenshot would).
- **Mean reversion** hands the fills to the existing MR intake for that run: the same messages
  and Yes/No buttons as today. **VR** hands them to VR intake. **Both** does both; the owner
  then rejects what does not belong on each side.
- A parked question expires after 24 hours. Pressing a button on an expired or already answered
  question gets a short reply saying so; nothing is booked.
- Expired questions and their parked screenshots are deleted at server start and each time a
  new question is parked.

## VR intake

For a VR run and the fills routed to it, inside the run lock:

1. **Same screenshot again.** If this exact screenshot was already taken in for this run and
   produced at least one pending fill then (waiting, confirmed or rejected), it is refused as a
   duplicate. (Amended during the build: the draft let a decided screenshot be read again. A
   fill whose row had been corrected before confirming, or an undated fill sent again on a
   later day, would then come back as a new row and could be booked twice.) A screenshot that
   produced no row is read again.
2. **Matching against what the run already has**, using the existing matcher with VR's booked
   fills, waiting fills and **rejected** fills (each existing entry can cancel one incoming
   fill):
   - an incoming fill equal to an existing one in side, shares, price and date is **dropped**.
     Counting rejected rows here is the designer's call: on a shared account the owner rejects
     the other strategy's fills once, and the next screenshot of the same day must not bring
     them back;
   - one equal to a booked or waiting entry in side, shares and date but with a different price
     becomes a pending fill **marked as a possible duplicate**, citing that entry's price;
   - everything else becomes a pending fill.
3. A fill with no date in the screenshot gets today's date and is marked so; a fill dated after
   today is kept as read and marked, and cannot be confirmed until its date is corrected.
4. The screenshot is stored when at least one pending fill was created (same size and type
   limits as today).

Telegram then says, per run: how many fills are waiting on the run's page, how many were dropped
as already booked or rejected, and how many are marked as possible duplicates. There are no
buttons.

### Waiting fills hold the cycle

With screenshots, a day or more between a fill and its confirmation becomes normal. A cycle
records its opening shares and Pool when it opens and its ladder is anchored on them, so opening
on incomplete books gives a wrong ladder for two weeks. Therefore (designer's call):

- When the morning job would open cycle 1 or roll a cycle and the run has waiting fills, it
  does not. It sends "the cycle is due; N fills are waiting to be confirmed" instead, every
  morning until the list is empty.
- The schedule stays anchored, so a late opening does not shift later cycles (the existing
  rule), and the manual morning trigger opens the cycle as soon as the list is clear.
- Nothing else in the morning job changes.

### Pending fills on the VR run page

A new **Pending** tab, with the number waiting shown on the tab.

```
[Fills] [Pending 3] [Cash] [Cycles] [Alerts]                 [Confirm all]
 date        side  shares  price   fee     screenshot
 2026-12-08  buy   3       45.15   (auto)  [thumb]   edit · confirm · reject
 2026-12-08  buy   3       44.39   (auto)  [thumb]   edit · confirm · reject
 2026-12-08  buy   3       44.40   (auto)  [thumb]   possible duplicate of 44.39   edit · confirm · reject
```

- **Edit** changes side, shares, price, fee and date of the pending row before it is booked.
- **Confirm** books it as a fill with source `capture`, under exactly the rules a typed fill
  follows (not after today, shares never negative, books in range). A fee left empty is computed
  from the run's trade cost, as for typed fills.
- **Reject** discards it.
- **Confirm all** confirms every waiting row that needs no second look: not marked as a
  possible duplicate, and with a date that was read from the screenshot (amended during the
  build: a guessed date is exactly what makes the same fill look new in a later screenshot).
  It works buys before sells and oldest first, and reports how many were booked, which were
  refused and why, and how many rows of each kind were left for a one-by-one decision. Refused
  and left rows stay waiting.
- The run header gets an **Upload screenshot** button, which opens the existing upload dialog
  pinned to this run. Its result lines and its "go to pending" button lead to this page's
  Pending tab, which therefore gets its own link (`#/vr/<id>?tab=pending`).
- The Fills tab marks fills that came from a screenshot.

### Screenshots

A VR screenshot is kept exactly as long as one of its pending fills is waiting. When the last one
is confirmed or rejected it is deleted. The server-start clean-up, which today deletes every
stored screenshot without a waiting MR row, also treats a waiting VR row as a reason to keep it.

When a question is answered "Both", the screenshot is taken in once per run, so each side's
copy lives and dies with that side's pending fills.

## Data model

Generated by drizzle-kit in the normal way:

- `vr_pending_fills` — run, capture, side, shares, price, fee (empty = compute at confirm),
  date, whether the date was read from the screenshot, the price of the possible duplicate
  (empty when none), status (`pending`, `confirmed`, `rejected`), created.
- `capture_choices` (shared, no prefix) — one row per parked Telegram question: chat, ticker,
  the MR run and the VR run it is between, the fills read for that ticker (every field), the
  screenshot itself, the day it was read, when it was asked, and how it was answered (empty
  while open). The screenshot is stored here, not in `capture_images`, which needs a capture
  and therefore a run. It must come back out as the identical text it went in as, because the
  "same screenshot again" check compares a hash of that text.

`vr_fills.source` already allows `capture`. `captures` and `capture_images` are used as they are.

## Server

- **Routing** (`wire/capture-route.ts`): candidates come from both strategies; a pinned id may
  be a VR run (today a VR id answers "no run with that id"); one new event for "both
  strategies, needs a choice", carrying the ticker, the two runs and the fills; one new outcome
  event for VR intake (run, ticker, counts). Routing itself parks nothing and knows no chat: the
  Telegram handler parks the question, and the web upload route turns the choice event into the
  existing "several active runs" event before it answers.
- **VR intake and confirm** (`domain/vr/`): take-in, confirm, reject, confirm all, each
  serialized per run with the existing run lock. Confirm writes the fill and marks the pending
  row in one transaction.
- **Telegram** (`packages/telegram`, `wire/capture.ts`): the question message and its buttons;
  a new button-press handler chosen by a prefix on the button data, with every existing Yes/No
  press reaching the existing handler unchanged; the VR "waiting" message; replies for expired
  and already answered questions. All texts in the catalog, en and ko.
- **HTTP** under `/api/vr/runs/:id/pending`: list, edit, confirm, reject, confirm all.
  `POST /api/captures` accepts a VR run id as the pin and routes un-pinned uploads as in the
  table above. The run detail gains the number of waiting fills.
- **Morning job** (`pipeline/vr-day.ts`): the hold described above.
- **Clean-up**: the screenshot sweep honours waiting VR rows (it already honours kept images
  and waiting MR rows); expired questions are removed at server start and when a new one is
  parked.

## Web

- VR run page: the Pending tab and its table, an edit dialog, Confirm all with its result
  summary, the Upload button, the source mark on fills.
- Upload results (`uploadlines`): lines for the VR outcome, linking to the run's Pending tab;
  the "go to pending" button also appears for a VR outcome with waiting fills.
- The VR runs list shows the number waiting per run.
- All copy through the en/ko catalogs. MR's Pending page, its table and its dialogs are
  unchanged.

## Verification

- Routing tests for every row of the table, pinned VR runs, and unchanged MR events for tickers
  VR does not trade.
- Telegram tests: the question and its three answers, expiry, a second press, and that every
  existing Yes/No press still reaches the existing handler with the same arguments.
- VR intake tests: same screenshot again, exact duplicates dropped (including two identical
  fills in one screenshot, where only as many are dropped as are on the books), possible
  duplicates marked, missing and future dates.
- Confirm tests: each refusal a typed fill can get, the one-transaction rule, Confirm all order,
  partial failure and skipped possible duplicates, the screenshot deleted with the last waiting
  row and not before.
- Morning-job tests: a due cycle with waiting fills is held and announced, opens once the list
  is clear, and keeps its anchor; cycle 1 likewise.
- Answer tests: an answer given the next day fills missing dates with the reading day; an
  answer after a run was paused still reaches it.
- Clean-up tests against a database: a screenshot with a waiting VR row survives the sweep, one
  without is deleted, MR's existing sweep cases unchanged.
- Web tests for the tab, the dialog, Confirm all, the upload from the run page, and the result
  lines.
- `scripts/e2e.ts` gains a VR screenshot step (pinned upload, confirm, books).
- The whole existing suite, typecheck and `db:generate` stay green; MR capture tests unchanged
  in intent.

## Left to the builder

- Module and file layout within the ~300-line convention; exact column types; route shapes and
  DTO names; message wording in both languages; the button-data format within Telegram's
  64-byte limit; how the parked screenshot is stored.
- Whether the edit dialog reuses pieces of the VR fill dialog or the MR review dialog.
