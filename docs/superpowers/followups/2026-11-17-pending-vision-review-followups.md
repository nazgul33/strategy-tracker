# Pending view + vision review — deferred follow-ups

Date: 2026-11-17
Branch: `feat/pending-vision-review` (28 commits, `eed3571..9b6df5c`)
Spec: `docs/superpowers/specs/2026-11-16-pending-vision-review-design.md`
Plan: `docs/superpowers/plans/2026-11-17-pending-vision-review.md`

Every task on this branch was reviewed individually, then the whole branch was
reviewed again. Findings rated Critical or Important were fixed before merge.
What follows is everything triaged as Minor and deliberately **not** fixed, plus
two items parked with a ruling. The whole-branch review read this list and
judged only one entry merge-blocking (the review tab flagging a derived fee as a
misread); that one was fixed and is not repeated here.

Nothing below is known to be broken. They are small truths about the code that a
future reader would rather be told than discover.

## Behaviour an operator could notice

- **The missed-date block is client-only.** *(parked with a ruling)* The web row
  now refuses to confirm until the operator fills in a trade date vision could
  not read. A hand-written `POST /api/pending/:id/confirm` without `filledOn`,
  and Telegram's quick-confirm path, still book the substituted ingest date.
  This predates the branch: `ingestCapture` has always substituted
  `filledOn = f.date ?? today`, and Telegram deliberately confirms with `null`
  overrides, so server-side blocking would break that path for any capture with
  no readable date. The fix, if wanted, is to surface the substituted date in
  the Telegram confirm message rather than to block.
- **A swallowed archive failure can strand bytes forever.** The freeze/keep/sweep
  write is wrapped in try/catch so a booked fill never fails for an audit-trail
  reason. If it throws on a capture's *last* sibling, nothing will ever sweep
  that capture's screenshot. A janitor pass — "no pending rows, not kept, image
  present" — would collect them. The branch reviewer also suggested returning
  `{ ok: true, archived: false }` so the UI can say the keep did not stick.
- **`fee_overridden` means "an override was present", not "the operator typed a
  fee".** *(parked with a ruling)* A hand-written `feeCents: null` on a feeless
  capture therefore records `fee_overridden: true` with `edited: false`, and the
  review tab tints that derived fee beside an "As read" badge. The shipped client
  never sends that state, and Telegram confirms with `null` overrides, so only a
  direct API call reaches it.
- **Clearing the fee on a feeless row leaves a blank field** while the server
  books the derived fee. Nothing marks it. This is the pre-existing "blank means
  derive" semantic, not a value mismatch.
- **Delete from the review tab takes no run lock.** A kept capture whose fill was
  rejected and then re-captured can have its image deleted while a live pending
  row still references it; that row then renders with `hasImage: false`. This
  matches the "delete means delete" intent.
- **Non-allow-listed mime types are relabelled `image/jpeg`.** With `nosniff`, an
  `image/heic` upload would not render as a thumbnail. Telegram photos are JPEG,
  so this only affects documents.
- **`GET /api/pending` does a small N+1**, awaiting `runRepo.get` once per
  distinct run. Bounded by the number of runs with pending fills; `Promise.all`
  would remove the serial latency.
- **`DELETE /api/vision-reviews/:captureId` is not transactional.** It deletes the
  image, then the frozen rows. A failure between the two orphans rows that are
  never listed and never swept.

## Accessibility and layout

- The thumbnail column and the review tab's row-label column both use an empty
  `<Th />`, leaving them unnamed for screen readers.
- Review-tab highlighting is tint plus bold only, with no non-colour marker.
- The pending row's delete/load errors render at page level, which can sit far
  from the armed entry; `deleteError` is not cleared when the operator cancels.
- The pending row now carries five inputs, a thumbnail and three buttons. Fixed
  widths keep it scannable, but narrow-width behaviour was never checked in a
  browser and the table will scroll horizontally.

## Code hygiene

- `vision-review.ts` takes `pendingRow: any`; a narrow structural type would let
  the compiler catch a projection that drops a column.
- `edited: any` in the `pendingRepo.decide` patch is pre-existing and untyped.
- `samePrice` rejects comma-grouped input while `usdToCents` accepts it, so
  `"1,000.00"` reads as an unparsable edit for a price and as equal for a fee.
  Low impact — the server rejects that price string anyway.
- The `invalid-side` / `invalid-fee` Telegram catalog entries are unreachable
  today, because `onConfirm` passes `null` overrides.
- Validation order: override validation runs before the pending-exists check, so
  a malformed override on an already-handled row answers `invalid-*` rather than
  `not-pending`. `invalid-shares` fires later, inside `bookUnlocked`.
- `schema.ts`'s `detected_at` comment should note the column is currently
  date-granular (it stores midnight of the ingest date; only its presence is
  ever read).
- Two source files sit marginally over the ~300-line convention:
  `http-pending-settings.test.ts` (318, a test file) and `viewmodels.ts` (302,
  since reduced by the `pendingvalues.ts` / `autofee.ts` split).
- `AGENTS.md`'s repo map still omits `apps/web/src/testing/` and `style.css`
  (pre-existing).

## Test gaps

- `capture-image.test.ts`'s "no image when no pending fills" case passes
  trivially: an `ok: false` extract returns before the store gate is reached. A
  conflicts-only case would actually pin `pendingRows.length > 0`.
- `capture-image.test.ts` imports `./booking.test`, re-running ~107 booking tests
  inside the file. Moving `fakeRepos` into a shared non-test module would fix it.
- `sim.test.ts` and `day.test.ts` build `RepoSurface` fakes without the two new
  repos. They pass only because their paths never reach the store call.
- `e2e-vision-review.ts`'s "no entry" labels overstate what they prove: over HTTP
  the kept-only listing cannot detect a left-behind *unkept* `vision_reviews`
  row. The image 404 is the real sweep proof. A direct row count via the `repos`
  object in `main()` would close it.
- Invalid-input coverage on the pending row reaches only qty `0`; invalid price,
  cleared date and invalid fee text each have an untested throw branch.
- No test pins: `Modal` without `wide` keeping `max-w-md`; the Compare dialog's
  empty-side option; `confirmPending` with `overrides` and `keepImage: false`;
  dismiss-then-reconfirm on the keep prompt; the row vanishing mid-prompt; one
  review card's delete leaving a sibling card alone; null `side`/`shares`/
  `price`/`filledOn` in the review tab (only null `fee` is exercised); the
  failed-delete error text and the entry staying armed.

## Copy

- The Korean strings added across this branch are machine translations. Automated
  checks cover en/ko key parity, `localeCompare` ordering and the no-Chinese rule
  only. Tracked separately as a GitHub issue for a native read.
- `keepImageDiscard` uses "삭제" (delete), harder-edged than the English
  "Discard" — accurate, since the image is swept.
