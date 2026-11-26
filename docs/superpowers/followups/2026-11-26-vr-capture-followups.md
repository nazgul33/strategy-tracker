# VR screenshot intake — deferred follow-ups

Date: 2026-11-26
Branch: `feat/vr-capture` (`d5d2a9a..f79b9c5`)
Spec: `docs/superpowers/specs/2026-11-26-vr-capture-design.md`
Plan: `docs/superpowers/plans/2026-11-26-vr-capture.md`

The branch gives Value Rebalancing (VR) a screenshot intake: fills read from a
screenshot wait on the VR run page until they are confirmed or rejected, a
Telegram question for a ticker both strategies trade, and a hold on the cycle
while fills or a question wait. The whole-branch review found no Critical
issue. Its three Important findings were design gaps: the open-question hold
was fixed in the fix wave, and the duplicate rules were redone with the order
price as Task 9 on the owner's decision. What follows is what the reviews found
and the branch deliberately left.

## Known limits of the duplicate rules

All of these are pinned or described in `apps/server/test/vr-capture-match.test.ts`
and in the spec's "VR intake" rule 2.

- **Views without an order price keep the old behaviour.** The multi-day view
  and typed fills carry no order price. A second same-day screenshot from such
  a view has its new rung fills marked, and when several rungs fill at one
  price and arrive as two images, the later equal fill is dropped. Use the
  single-day view, or one image, on such days.
- **Several rungs filled at one price.** With order prices, a second screenshot
  that does not show the earlier rows again gets its new rows marked (one click
  each). A screenshot that shows all earlier rows gets none.
- **A misread of both the fill price and the order price** in a second image
  comes back unmarked. A possible guard: mark when a fill's price equals a
  same-side, same-day entry's known order price and that entry filled at
  another price.
- **A misread date** in a second image of the same day brings every row back
  as new, and Confirm all books them. With a known order price, a fill equal to
  an entry on a nearby day could be marked; the cost on orders that stand for
  days was not assessed.
- **A row read twice whose first copy is dropped against a typed fill** leaves
  the second copy plain. Letting a dropped fill lead a twin group would close
  it.
- **A twin group can end with every row marked** when its first row was already
  marked against an entry of another order. It costs a click.
- **A stored order price that was itself misread cannot be corrected.** Later
  correct reads of that row are marked every time.
- **A mistaken reject is permanent.** The rejected row keeps cancelling an equal
  fill, also after the fill was typed by hand. An "undo reject" would fix it.
- **A mark can cite a rejected row**, which no screen lists, and the cited
  fill's order price is shown nowhere (the Fills tab has no order-price column).
- **A market order equal in lot, price and day to a booked rung fill** whose row
  is not in the screenshot is dropped (an order price of zero counts as
  unknown).
- **Confirming one row by hand has no duplicate check.**

## Behaviour the owner could notice

- **The hold message has no once-a-day guard.** The scheduled morning job runs
  once; a manual second run the same day sends it again, as the buy instruction
  does.
- **A very long hold.** A hold cleared 28 or more days late moves the schedule
  to that day, and the deposits of skipped cycles are not caught up (VR core
  anchoring).
- **A screenshot uploaded after a roll** whose fill is dated before the new
  cycle's start is in neither the new cycle's ladder count nor its opening
  numbers, like a late typed fill.
- **An answer lost to a crash.** If the server stops between marking a question
  answered and carrying it out, a second press says "already answered"; the
  text tells the owner to send the screenshot again.
- **The fallback reply after a failed send** says the fills "were taken in" even
  when the outcome was a duplicate or nothing waiting
  (`wire/capture-choice.ts`).
- **A question whose send failed after it was parked** sits unasked until it
  expires. A clean-up of expired questions that keeps failing blocks every
  answer (fail closed, with a reply).
- **The result-line link does nothing** when the address is already
  `#/vr/<id>?tab=pending` (the tab is not written back to the hash). "Go to
  pending" works.
- **An old browser tab** still running the previous bundle cannot show a VR
  result line until it is reloaded.
- **A throw during a Telegram VR take-in** leaves no reply
  (`wire/capture.ts` photo handler; mean reversion behaves the same).
- **The Korean runs-list column** reuses the Pending tab's label, so it does not
  read as a count.

## Code and tests

- `domain/vr/capture.ts` imports `sha256` from `domain/booking.ts`; it belongs
  in a neutral module. `vrPendingRepo.hasConfirmedForCapture` is unused.
- `capture_choices` has no index on `vr_run_id` (`countOpenForVrRun` scans a
  table the 24-hour sweep keeps small).
- A screenshot reading with shares or a fee beyond the INT range makes
  `insertMany` throw after the capture row exists (the capture has no row, so
  it can be read again); mean reversion has the same class of failure.
- `vrRunRepo.list()` runs on every un-pinned upload, so a failed `vr_runs` read
  fails mean-reversion uploads too.
- The fake `vrPendingRepo.confirm` shows the row as confirmed while its insert
  is awaited; the real repository shows it only after commit.
- In `VrPendingPanel`, the Confirm-all summary names refused rows from a list
  snapshot that can be stale; `useAsync` has no stale-response guard; the
  after-today hint is not tied to the disabled Confirm button.
- Test files over ~300 lines: `wire-capture-question.test.ts`,
  `vr-capture-match.test.ts`, `VrPendingPanelStale.test.tsx`,
  `vr-pending.test.ts`.
- Smoke (`scripts/e2e-vr-capture.ts`): `pngOf` / `formOf` are copied from
  `e2e-web-upload.ts`; rows are found by share count; it does not assert that
  the un-pinned upload for the shared ticker sent no Telegram message, nor that
  an image with no rows left nothing stored; the Telegram photo path and the
  three-button question are covered by unit tests only.

## Deploy notes

- Migrations `0017_vr_capture` (two new tables) and `0018_vr_order_price` (a
  nullable `order_price` on `vr_fills` and `vr_pending_fills`) apply at server
  start on top of `0016`. Existing VR fills get an empty order price, which
  counts as unknown.
- A parked screenshot is stored as base64 text in one statement; at the 8 MiB
  upload limit that is about 11 MB, inside MariaDB's default 16 MiB
  `max_allowed_packet`. A lower setting makes parking fail, and the bot then
  asks for an upload from the run's page.
- Do not deploy a build between the routing change and the web result lines
  (both are on this branch; the squash merge ships them together).
