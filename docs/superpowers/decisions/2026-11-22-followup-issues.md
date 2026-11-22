# Follow-up issues (#52–#72) — decisions for human review

Branch: `fix/followup-issues` (one branch, one PR). Started 2026-11-22 from `main` at `42795c3`.
Scope: every open issue except #40 (multi-instance protection, deferred) and #50 (native read of Korean copy, needs a human).
Mode: the operator asked for no approval stops. Every design decision below was made by the controller (Claude Opus 5.5)
and is listed here so a human can review and reverse it. Plans and reviews: Opus 5.5. Implementation: Sonnet 5.5.

**How to read this:** each entry says what was decided, why, and what it costs if it is wrong.
Entries marked **[REVIEW]** change behaviour an operator will notice or reverse an earlier operator ruling; read those first.

## Plans

| Plan | Issues | File |
| --- | --- | --- |
| A. Fill attribution and bucket override | #52, #53, #54, #55, #57, #58 (attribution parts) | `docs/superpowers/plans/2026-11-22-fill-attribution-2.md` |
| B. Notices and Telegram | #56, #60, #58 (copy and wiring parts) | `docs/superpowers/plans/2026-11-22-notices-telegram.md` |
| C. Server tidiness | #62, #63, #64, #72 (server parts) | `docs/superpowers/plans/2026-11-22-server-tidy.md` |
| D. Web UX and accessibility | #61, #68 (phone width), #69, #70, #71, #72 (web parts) | `docs/superpowers/plans/2026-11-22-web-ux-a11y.md` |
| E. Repository typing | #67, #58 (typing parts) | `docs/superpowers/plans/2026-11-22-repo-typing.md` (written after A–D are executed, against the tree they leave) |

Execution order: A, B, C, D, E, on the one branch.

## Up-front design rulings

### Fill attribution (plan A)

1. **[REVIEW] #52 — exact share count becomes the first discriminator, reversing the 2026-11-18 ruling "price distance only".**
   Among the admissible sell legs (targets at or below the fill price, stops at or above it, and `market_sell` orders), if exactly
   one leg's `shares` equals the fill's shares, that leg wins. Otherwise (none or several), the existing price-distance rule
   decides as today. Why: at a normal exit several targets fill at one close; price distance cannot tell them apart and the
   reviewer reproduced a fill landing in the wrong bucket and a later fill failing `no-bucket-for-sell`. A full-leg fill's share
   count equals its order's size, so it is the one discriminator that separates them. Cost if wrong: a partial fill whose share
   count happens to equal another bucket's leg size is booked to that other bucket (the attribution notice still lists the
   alternatives).
2. **[REVIEW] #53 — a `stale` leg dated on the fill's trade date is a candidate**, through the shares gate only (its bucket must
   still hold at least the fill's shares). The matched stale order flips to `filled`. Why: a late-captured fill (confirmed after
   the morning re-plan) otherwise falls to the lowest-bucket guess and the sibling cancel pulls the wrong bucket's legs for
   today. This reverses the pinned test "a stale stop order never matches". Cost if wrong: a stale order that really did not
   fill could absorb a fill meant for a different order on that day.
3. **[REVIEW] #54 — a partial fill no longer flips its order to `filled`.** The matched order stays `open` until a fill empties
   its bucket; only then is it marked `filled` (and its siblings cancelled, as today). Why: the remaining shares are still live
   at the broker on that order, and a `filled` order stops being a candidate, so the rest of a partially filled leg was booked
   to another bucket. Cost if wrong: the orders table shows a partially filled order as `open`.
4. **#55 — `market_sell` legs on other buckets are listed as alternatives** in the attribution notice (new en/ko copy for a
   market leg with no limit or distance), and take part in the exact-share discriminator of ruling 1. Ranking by price is
   unchanged otherwise. Cost if wrong: a longer notice.
5. **[REVIEW] #57 — a sell can be booked to an operator-chosen bucket.** Optional `bucketIdx` on manual sell fills and on pending
   confirm overrides (sell only). Validated like any sell (`bucket-not-held`, `too-many-shares`). The chosen bucket's open leg
   that fits the price best (exact share count first, then price distance, among that bucket's legs) flips; none if none fits.
   Its other legs are cancelled if the fill empties the bucket. The web gets a bucket selector, "Automatic" by default, on the
   manual fill dialog and the pending row when the side is sell. No new column: the fill's `bucket_idx` already records where it
   went; whether the bucket was forced is not recorded. Moving an already booked fill to another bucket is out of scope (the
   fill edit path can delete and re-book). Cost if wrong: a new control on two forms.

### Notices and Telegram (plan B)

6. **[REVIEW] #56 — with no allowed Telegram chat, booking notices are still recorded:** one `notifications` row with the
   sentinel chat id `web` (no migration; the column is `NOT NULL`). Applies to the attribution notice and the sibling-cancel
   notice (the booking notifier). Other notification writers (manual cancel route, morning pipeline) are unchanged. Cost if
   wrong: rows with chat id `web` in the Notifications tab.
7. **[REVIEW] #60 — Telegram confirm prompts get their Yes/No buttons in production.** The `send` wired in `main.ts` passes the
   reply markup through; the confirm handler replies to the chat the button was pressed in (not an in-memory "last chat");
   a prompt whose trade date was substituted is sent WITHOUT buttons (it already tells the operator to fix the date in the web
   Pending view). Telegram confirms never keep the screenshot (as today). Cost if wrong: one-tap confirming is live in
   Telegram for the first time.

### Server (plan C)

8. **#62 — `POST /api/sim` no longer requires a `name`** (accepted and ignored, as `PUT` already is); the name field is removed
   from the new-sim form. Cost if wrong: none (the server never stored it).
9. **#63 — the runs, fills and pending routes parse path ids with the strict `parseId`** (canonical decimal ids only), as the
   sim, corrections and vision-review routes do. Cost if wrong: a hand-written client sending `0x1` gets a 404.
10. **[REVIEW] #64 — the keep flag is written before the pending row flips.** When the operator asks to keep the screenshot,
    `setKeep` runs first, so a crash or a failed archive write leaves a kept image (reviewable, deletable from the review tab)
    and never one the boot janitor sweeps. Cost if wrong: a confirm that then fails leaves the screenshot kept while the row is
    still pending (it is kept anyway when the retry succeeds).

### Web (plan D)

11. **#61 — the "screenshot could not be kept" note becomes its own notice**: warning styling, names the fill (ticker, side,
    shares, price, date), stays until dismissed or the page is left, survives the next action.
12. **#68 — the phone-width trade-off is fixed without a browser**: below the `sm:` breakpoint the Confirm and Reject buttons
    stack, and the "needs input" message moves out of the pinned cell. The rest of #68 (a human looking at the pages in a
    browser) stays open with a comment; this branch cannot do it.
13. **#69 — the shared `Modal` gets a focus trap, Escape to close, initial focus and focus restore**; the action error gets
    `role="alert"`; the hint text is exposed to sighted keyboard users (not only `title`); the cost note moves out of the field
    label. Screen-reader output is still not checked by a human.
14. **#70 — the review tab gets a Reload control and dismissible page-level errors**; a `not-found` on delete is read as
    "already deleted" and triggers a reload instead of an error; the common error codes get en/ko copy.
15. **#71, #72, #58 (grouped lists)** — each item is triaged by the plan that owns its area as fix, or leave with a reason; the
    leave list is copied below when the plans are written, and the grouped issues are closed with a comment naming what was left.

## Decisions made during planning and execution

### Controller rulings on the plans (2026-11-22)

- **[REVIEW] Plan A — the exact-price rung stays before the exact-share rung** (overruling the planner, who had put exact share count first). An exact-price print the bucket cannot cover still fails loudly with `too-many-shares`; among several exact-price legs, the one whose size equals the fill wins. The exact share count decides only when no leg matches the price exactly. Why: an exact price is the strongest signal, and booking a sell into a bucket that did not sell was the original design's first anti-goal. Cost if wrong: a fill with a vision-misread share count at an exact limit price still needs an operator fix instead of being booked elsewhere.
- **[REVIEW] Plan A — no attribution notice when the exact share count decided** (overruling the planner). Why: a normal exit with several targets filling at one close would otherwise send a notice for every fill but the last, and once the share count identifies the leg the fill is not ambiguous in practice. The notice still goes out when price distance, an exact-price tie or a market sell decided among several admissible legs. Cost if wrong: a partial fill whose share count happens to equal another bucket's leg size is booked there with no notice (ruling 1's cost line is amended accordingly).
- **Plan A — accepted as planned:** stale legs never take the exact-price fail-loudly read; a forced bucket considers its open and stale legs of the fill day; a late buy flips a stale `buy_loc` of its fill day; `invalid-bucket` (malformed, or sent with a buy) and `bucket-not-found` (past the run's bucket count) as 422s; `GET /api/pending` rows carry `heldBuckets` so the Pending page can offer each row its own run's buckets **[REVIEW]**; choosing a bucket on a pending row is not a vision correction and opens no keep/discard prompt; a chosen bucket no longer held stays selected and the server answers `bucket-not-held`; a market-sell fill sends a notice when another bucket also fit **[REVIEW]**.
- **Plan B — accepted as planned:** booking messages name the run as `Run #<id> <ticker>` (as `/status` does) and both messages describe a leg the same way, e.g. `bucket 0 target ($103.00)` **[REVIEW]**; a notice recorded with no chat shows as "web only" in the Notifications tab **[REVIEW]**; the button press is answered before booking runs; a press on an already handled row answers "Already handled" in the pressing chat **[REVIEW]**; a prompt without buttons (substituted date) points to the web Pending view **[REVIEW]**; the production `send` moves into `wire/send.ts`, typed so the reply markup cannot be dropped again.
- **[REVIEW] Plan D — Escape closes prompt dialogs only** (overruling the planner, who had Escape close every dialog). Dialogs that hold typed input (manual fill, run edit, the Compare dialog) ignore Escape, so a stray key cannot discard what the operator typed; prompts (keep/discard, default fee, review-tab confirm) close on Escape. Cost if wrong: keyboard users close those forms with the ✕ button or Cancel.
- **Plan D — ruling 11 reworded by plan C's change:** after the keep flag is written first, `archived: false` means the screenshot WAS kept and only its review record failed, so the #61 notice no longer says "could not be kept"; it uses the corrected wording and names the fill.
- **Plan D — accepted as planned:** the shared `Modal` traps focus, focuses the first body control unless a child has `autoFocus`, and returns focus to the opener when it is still on the page; the keep prompt opens on "Keep for review"; the #61 notice stacks one per action and survives tab changes on the run page **[REVIEW]**; hints are exposed through `aria-describedby` and shown below the control on focus (`title` kept); at phone width the buttons stack and the needs-input message gets its own row **[REVIEW]**; every field vision missed is flagged, with a new "filled in" hint and reworded needs-input copy **[REVIEW]**; "auto fee" replaces "default fee" in the popup and the erased-fee hint **[REVIEW]**; `costPercentText` shows a fourth decimal when the cost is not a multiple of 10 ppm, on every page **[REVIEW]**; the run page refreshes the pending table in place so typed edits survive a correction, and a cost edit re-derives fees the operator did not edit; the manual fill dialog accepts comma-grouped prices; the cost note is always mounted and outside the field label; `api.ts` and `api.test.ts` are split under the line limit; a browser "Failed to fetch" is worded on the sim and review pages only; on the review tab a `not-found` delete shows no message and the card disappears on reload **[REVIEW]**, Reload is always shown, page errors are dismissible and codes are worded **[REVIEW]**. `PendingTable.test.tsx` (700 lines) is not split.
- **Plan C — accepted as planned, including its fix to ruling 10:** writing the keep flag first is not enough on its own, because the review tab lists only kept screenshots that have a frozen review record; a boot-time repair rebuilds a missing record for a kept screenshot (rebuilt records have `feeOverridden: false`) **[REVIEW]**. If the keep write itself fails, the confirm or reject is refused and nothing is booked **[REVIEW]**. `POST /runs/:id/pool` and `POST /runs/:id/fills` answer 404 for an unknown run (before: a 200 with a stray pool-edit row, and a 422 with a raw message) **[REVIEW]**. The three list routes answer `[]` for a non-canonical id, as for an unknown one. A Yahoo 404 with the "Not Found" body reads as no data, also for the last close **[REVIEW]**; an unreachable provider gives 502 `market-data:http` instead of a raw 500 **[REVIEW]**. Sims are listed as `Simulation #<id>`. One migration adds indexes on `orders` (run and trade date; trade date), `sim_runs` and `sim_days`. Jittered backoff between coverage-merge deadlock retries.
- **Cross-plan check (Opus 5.5) — PASS WITH FIXES, applied:** the pending list looks a run's buckets up only when the run exists; plan A's web task is done in two parts (manual fill dialog, pending row); the `listForRunFrom` ordering test from #58 is owned by plan C's index task; `invalid-bucket` is listed among the refusals that come after the keep write; Escape on the review tab's inline delete confirm cancels the arm; file-size guards for `FillDialog.tsx` and `api.test.ts`; every plan updates the `AGENTS.md` repo map for the files it adds.
- **[REVIEW] Plan A Task 2 consequence:** a partially filled order stays `open`, so the next morning it is rolled to `stale` like any unfilled order and counts in the digest's "{count} unconfirmed orders from {date}" warning; a day with a partial now reports one more order than before. The re-plan sizes the next day's legs from the bucket's remaining shares, as before. Cost if wrong: an operator reads the higher count as a regression.
- Plan A Task 2 (implementer): rung 1 ties within one bucket break by order id; the exact-price fail-loudly pick still computes alternatives, but the booking throws before any notice is sent.
- Plan A Task 5 (implementers): a pending row whose side vision missed shows no bucket selector until a side is chosen; a chosen bucket on the manual fill dialog is kept when the side is switched to buy and back (it is only sent for a sell); `heldBuckets` includes buckets marked for forced sale (they hold shares).
