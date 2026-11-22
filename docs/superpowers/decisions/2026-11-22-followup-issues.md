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
- **Plan A whole-plan review (Opus):** with fixes, no Critical or Important. Fixed in its fix pass: when a fill empties its bucket, that bucket's other `stale` legs of the fill day are also marked `cancelled` (no operator message; the broker day is over) **[REVIEW]**, so a later rebuy cannot let a stale leg absorb an unrelated late fill; spec wording; small test gaps. Recorded as a known limitation and a follow-up issue (not fixed): a fill edit or correction that turns a partial sell into a bucket-emptying one does not flip or cancel that bucket's legs, so they stay `open` on an empty bucket and a later same-day exact-price fill can fail `bucket-not-held` (loud; the operator can force the bucket). Also recorded: under ruling 1 a second partial of a leg can be booked silently to another bucket whose leg size equals the remaining shares.
- Plan B Task 1: the booking notices now look up the run (for `Run #<id> <ticker>`); if the run is gone the ticker shows `?`; if the lookup itself throws, the failure is logged and the notice still goes out with `?` for the ticker (hardened in Task 2, so a "cancel the other leg" message is not lost to a failed lookup).
- **[REVIEW] Plan B whole-plan review (Opus): the Telegram bot had no error handler.** In grammY an error thrown by any update handler ends long polling for good, so one transient failure (a Telegram 429 after a fill booked, a DB error on reject) would silently stop prompts, confirms and `/status` until a restart. This predates the branch, but plan B makes one-tap confirming live, so the fix pass adds `bot.catch` (log and keep polling) and replies with the worded error in the pressing chat when a reject fails. Cost if wrong: none (errors that used to stop the bot are now logged).
- Plan C Task 7 consequence: a ticker with cached bars that is later delisted now answers "no data" for new date ranges, so the bar cache records those ranges as covered (empty) with a `console.warn` instead of failing; a spurious Yahoo 404 for a live ticker would do the same (the README's `bar_coverage` escape hatch clears it). Recorded, not changed.
- **Model directive (user, 2026-11-22):** the controller and every subagent (implementers and reviewers) run on `m5max/q38fn`. This overrides the `anthropic/...` model lines written into the plan files. **[REVIEW]**
- **Plan C wrap-up reconciliation:** the plan file has exactly 9 tasks and all 9 are implemented and individually reviewed (`cd11328` is the tip); an earlier working note about "owed Tasks 10-13" was a numbering artifact of the progress ledger, not real owed work. #66 and #59 were closed upstream before this branch (origin/main `42795c3` is titled "(#66)"), so plan C owes nothing for them. The plan's "Issue closing" section stays the closing authority.
- **#67 (repository surface typing) is still relevant but has no plan:** plan E was never written (it was to be written against the tree plans A-D leave). Ruling: after plan D, do a scoped typing pass for #67 if it stays small, otherwise leave #67 open with a comment naming what this branch already tightened (strict ids, typed `send`), so the next branch can size it against the new tree. **[REVIEW]**
- **Branch state for the PR (checked 2026-11-22, before plan D):** `origin/main` is at `42795c3`, which is the branch's merge-base; `fix/followup-issues` is 30 ahead / 0 behind, so the PR is a clean fast-forward — an earlier "main diverged" worry was a stale local view of the main repo, not a real divergence. The PR covers plans A, B, C and D plus this decisions document.
- **Plan D execution shape:** implementers run sequentially because every task edits the two i18n catalogs (parallel implementers would conflict); reviewers are read-only and overlap the next implementer. `bun test apps/web/src` + `bun run typecheck` gate every task; the DB suite and e2e run once at plan end.

## Plan C close-out (whole-plan review)

- Whole-plan review of `0d1d66c..cd11328`: spec PASS, plan quality PASS, 0 Critical, 0 Important, 3 Minor. Fix pass in `1aad544` (clamp `deadlockBackoffMs` attempts 1..4 + pins; drop the dead `isTradingDay` test import) and `201801d` (drop the dead `mkBar` test import; document that a rebuilt review record carries boot-time `createdAt`, so it lists after siblings frozen later).
- **[REVIEW] Source-text boot pins stay as-is** (reviewer ruling, accepted): `main-boot-order.test.ts` pins boot order by substring search and the boot-sweeps test pins step order by call-name strings; both are refactor-brittle by design and fail loudly. The durable fix is a real seam in `main()`, deliberately not attempted on this branch.
- The deferred Task 4/Task 7 minors were verified already covered at HEAD (rejected-row pin in `db-vision-janitor.test.ts`; sweep-order assertion in `boot-sweeps.test.ts`; the narrow no-data exemptions pinned in `yahoo.test.ts` "the no-data exemptions stay narrow").
- The branch-final review's "spec wording — at exactly their target's price" fold item was verified a no-op: the sell-attribution spec already restricts the exact-price rule to rung 1 and **open** orders (table row 1, the gate paragraph, and the tie-break paragraph).

## Follow-up issues filed (branch end, 2026-11-22)

- #73 fill edit/correction emptying a bucket leaves the bucket's other legs open (known limitation item 5 of the sell-attribution spec).
- #74 a leg's second partial can book silently to another bucket whose leg size equals the remaining shares (ruling-1 recorded limitation).
- #75 the morning digest's `warn-data-error` names no run or ticker (anonymous daily warning for a cached-then-delisted ticker).
- #76 `sim_days` lacks a `(sim_run_id, trade_date)` index for the replay listing (`listDays` filters by run and filesorts by trade date; 0009 added the single-column index only).
- #77 boot repair rebuilds frozen review records with `feeOverridden: false` (whole-plan review Minor 3).

## Plan D rulings (as tasks land)

- **[REVIEW] ko `dismiss` = 닫기** (plan D Task 2, plan-pinned copy): 닫기 also means "close", and the dialog ✕ carries `aria-label=cancel`. Assistive tech distinguishes them by context, but a human may prefer 해제/무시 for the notice-dismiss button. Plan copy table verbatim for now.
- Task 2 kept the plan's notice trigger exactly: only `keepImage === true && !res.archived` warns; a discard never notifies; `archived:true` with no review row keeps the plain `keepImageNotKept` line.
- Task 2 touched `Modal.tsx` beyond its plan file list (authorized): the opener chain fixes the fee-dialog -> keep-prompt handoff so Escape returns focus to the row's Confirm button (plan Review Focus 1). Reviewer audited it as the minimal correct fix.
- Plan D Task 6: the controller's brief described the wrong task; the implementer followed plan Task 6 (`refreshKey`), which is correct. Briefs 7-13 were then re-audited against the plan and HEAD by a planning agent (Fable 5.2) before dispatch. Model directive from Task 3 on: planning Fable 5.2/high, review Opus 5.5/high, implementation Sonnet 5.5.
- Plan D Task 7: `FillDialog.tsx` is 306 lines at dispatch, so the plan's conditional extraction (`FillDeleteStep.tsx`) applies.
- Plan D Task 10: the unreferenced `errorNetwork` catalog key is deleted when `errNetwork` is added (no two keys with one meaning).
- **[REVIEW] Plan D Task 13 item 9** is scoped to the final-values row: the changed-field glyph renders in BOTH the detected and final rows of a review card, so "one mark in the card" would fail by design. If a single mark per card was the intent, that is a UI change for a follow-up.
- Plan D Task 5 follow-up (branch review): the Compare dialog's `Field` hints are part of the input's accessible NAME (the row uses `aria-describedby`); recorded, not changed on this branch.
