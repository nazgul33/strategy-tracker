# Pending view rework + vision review archive

Date: 2026-11-16
Status: approved design, not yet planned

## Intent and why

The Pending view is the one place where a human checks what the vision model
read off a broker screenshot before it becomes money in the books. Today it
fails at that job in two ways.

First, the row is confusing to operate. Trade date, qty and price each appear
**twice** — once as static detected text, once as an empty override input. Side
and ticker appear only as static text. So the operator reads one widget and
types into another, and side is not fixable at all without rejecting the row and
re-capturing.

Second, and more important: the screenshot itself is gone. `captures` stores
only `image_hash` (a SHA-256 of the base64, used for duplicate detection); the
bytes arrive from Telegram, go to the vision model, and are dropped. The
operator is asked to confirm that "NVDA buy 12 @ 178.42" is what the broker
showed, with no way to look at what the broker showed. And when vision *does*
misread something, nothing is kept: no image, no record that it was wrong, no
way to notice a pattern of misreads (one broker's table layout, thousands
separators, a date column in the wrong locale).

This work makes the pending row directly editable, puts the source screenshot in
front of the operator, and keeps the evidence when vision got it wrong.

## Goals

1. One editable control per field in the pending row, pre-filled with the
   detected value: trade date (date picker), side (dropdown), qty, price and
   fee. No static-plus-input duplication anywhere in the row.
2. The source screenshot visible as a thumbnail in the row, clickable to full
   size.
3. A per-row button opening a **side-by-side** modal: the screenshot next to
   editable fields pre-filled with the row's current values. `Cancel` discards,
   `Done` writes the values back into the row. `Done` does **not** book
   anything; confirm still happens from the row.
4. Screenshot bytes persisted from capture time and deleted as soon as every
   pending fill from that capture is resolved (confirmed or rejected).
5. When the operator confirms a row whose values differ from what vision
   detected, or rejects a row, a prompt offers to keep the screenshot for later
   review or discard it.
6. A **Vision review** nav tab listing kept screenshots, each with
   detected-vs-final values per fill and a delete action.
7. An archive entry covers the **whole screenshot**: one Keep press archives the
   image together with every fill that came off it, including siblings resolved
   earlier.

## Non-goals

- Editing ticker in the pending row. Ticker routes the capture to a run; a
  mismatch is already a hard 409 (`ticker-mismatch`) and the right fix is
  reject + re-capture.
- Bringing the `fill_corrections` conflict flow (a later screenshot disagreeing
  with an already-booked price) into the review tab. The schema is shaped so
  this is a later addition, not a rewrite.
- A keep/discard prompt on the Telegram confirm path. Telegram confirms carry
  no overrides, so they can never be "confirm with changes"; Telegram rejects
  discard the image, same as today's behaviour.
- Server-side thumbnailing, image re-encoding or compression. The stored bytes
  are what Telegram delivered, and the thumbnail is CSS sizing of the same
  image.
- Pagination, search or filtering in the review tab. Newest-first list with a
  fixed cap (see "Builder's choice").
- Storing bytes for captures that produce no pending fills (unparseable images,
  duplicates, captures that yield only conflicts). Nothing to resolve means
  nothing to review. *My call* — flag it if you want unparseable images kept,
  because that is arguably the most interesting failure case, but it needs a
  different surface than the pending row.

## Anti-goals

Things that would make this a failure even if it technically works:

- Unbounded database growth. Keeping is opt-in per screenshot, and everything
  not kept is deleted the moment it stops being useful.
- Losing the vision original. Today `pendingRepo.decide(id, 'confirmed', edited)`
  overwrites `shares`/`price`/`filled_on` **in place**, destroying what vision
  said. Any design where the archive reads those columns after confirm is
  already broken.
- Blobs on the capture dedup hot path. `captureRepo.findByHash` runs for every
  incoming screenshot; it must not get slower or risk dragging megabytes.

## Constraints

- `AGENTS.md`: no source file over ~300 lines, split by responsibility;
  `packages/*` never import `apps/*`; money as `@st/core/money` bigint
  myriadths, never float; all user-facing copy through the en/ko catalogs;
  `fetch` always injectable.
- Drizzle + MariaDB with generated migrations: edit
  `apps/server/src/db/schema.ts`, then `bun run --cwd apps/server db:generate`.
  Migrations apply at startup from `process.cwd()`.
- **Drizzle has no blob helper for MySQL.** `drizzle-orm/mysql-core` ships
  `binary` and `varbinary` only (verified in 0.44.7). The LONGBLOB column needs
  `customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'longblob' })`.
- Auth is a bearer token in `sessionStorage` **and** an HttpOnly `st_session`
  cookie set by `POST /api/login` (`http/app.ts:54`), which the middleware
  accepts (`http/auth.ts:64-67`). This is what makes a plain `<img src>` work
  for the image endpoint — an `<img>` tag cannot send an Authorization header.
- Existing UI parts to reuse from `apps/web/src/components/ui.tsx`: `Modal`,
  `Select`, `Input`, `Field`, `Button`, `TableWrap`/`Th`/`Td`, `EmptyNote`.

## Approaches

Three ways to hold the bytes and the detected snapshot were considered. The UI
work is identical in all three.

**A — everything on `captures`.** Add `image_bytes` (LONGBLOB), `image_mime` and
`keep` to `captures`, plus `detected_*` columns on `pending_fills`; the review
tab diffs detected against final by reading resolved `pending_fills`. Fewest
moving parts. Rejected: it puts megabytes on the table every incoming
screenshot has to read, and deletion leaves tombstone rows of NULLs.

**B — bytes in their own table.** New `capture_images` (1:1 with `captures`)
holding bytes, mime and the keep flag; `captures` untouched so dedup stays
exactly as cheap; `detected_*` on `pending_fills`; the tab derives the diff.
Clean retention (image presence is row presence, deletion is a DELETE). Costs
one table and a join.

**C — bytes in their own table plus a dedicated audit table (chosen).** Like B,
and each kept capture additionally writes one `vision_reviews` row per fill,
freezing detected and final values at archive time rather than deriving them
from live rows.

**Chosen: C.** It duplicates numbers that already exist in `pending_fills`, which
is the honest cost. In exchange the archive is a true historical record: immune
to later edits or deletion of the fill it came from, able to represent a
rejected fill (which has no final values at all), and already shaped to absorb
the `fill_corrections` conflict flow later without a migration. For a record
whose entire purpose is "what did vision say, and what did the human say
instead", freezing beats deriving.

C also turns out to be what makes whole-screenshot archiving work at all: a
frozen row can be written at the moment each fill resolves, so a Keep press on
the *last* fill can still show what happened to its siblings. Deriving would
have to read `pending_fills` rows that `decide()` has already overwritten.

## Data model

New generated migration — never hand-written. (At design time the next number was `0007`; `main` has since taken it with #42, so ours is `0008`. The plan carries the current number.)

### `capture_images` (new)

| column | type | notes |
| --- | --- | --- |
| `capture_id` | int, PK | 1:1 with `captures.id`; presence == "bytes exist" |
| `mime` | varchar(32) | as delivered by Telegram (`image/jpeg` default) |
| `bytes` | LONGBLOB | via `customType`, see Constraints |
| `byte_len` | int | so listings and the review tab never SELECT the blob |
| `keep` | boolean, default false | true == archived indefinitely |
| `created_at` | timestamp, default now | |

### `pending_fills` (altered)

Add the vision snapshot, written at insert time in `ingestCapture` and never
updated afterwards:

`detected_side` varchar(8) null, `detected_shares` int null, `detected_price`
bigint null, `detected_filled_on` date null, `detected_fee` int null (cents).

Two separate reasons for the nulls, and they must not be conflated:

- **Rows predating this work** have the whole snapshot null. The UI then treats
  the row's own values as the detected baseline, so a legacy row can never be
  detected as edited. Acceptable; there are at most a handful.
- **Vision missed that field.** The snapshot stores the honest null, *not* the
  value `ingestCapture` substituted. Today it substitutes `filledOn = f.date ??
  deps.today`, so a capture with no readable date gets `filled_on = today` and
  `detected_filled_on = NULL`. Fee is already nullable and stays that way.

  Filling in a field vision missed **counts as edited** (*my call*): vision
  dropping a column is the most interesting misread of all, and it's exactly
  the case where you want the screenshot kept. A null detected value with any
  final value therefore triggers the prompt.

  **Exception, found during implementation: the fee.** Fee is the one field
  the system derives on its own — when vision reads no fee, the booking path
  computes it from the run's cost ppm. So "detected fee null, final fee 7"
  is the *normal* path for a feeless screenshot, not a correction, and the
  rule above would mark every such capture edited and prompt on every
  confirm. The fee therefore counts toward `edited` only when the operator
  actually supplied one: the confirm carried a `feeCents` override. The
  frozen row still records the booked fee in `final_fee` either way.

Distinguishing the two cases needs one bit that is not per-field: a legacy row
has `detected_*` all null *and* predates the migration. The builder should add
a non-null `detected_at` timestamp alongside the snapshot columns — present
means "snapshot taken, nulls are real", absent means legacy.

### `vision_reviews` (new)

One row per resolved fill, written at the moment it resolves — **not** only on
keep. See "Lifecycle" for why.

| column | type | notes |
| --- | --- | --- |
| `id` | int, PK auto | |
| `run_id` | int | |
| `capture_id` | int | groups rows under one image; indexed |
| `pending_fill_id` | int, unique | one row per fill; the unique index is what makes the write idempotent across retries |
| `ticker` | varchar(16) | |
| `outcome` | enum('confirmed','rejected') | |
| `detected_side` / `detected_shares` / `detected_price` / `detected_filled_on` / `detected_fee` | varchar(8) / int / bigint / date / int | all nullable: vision can miss a field entirely |
| `final_side` / `final_shares` / `final_price` / `final_filled_on` / `final_fee` | same types, nullable | all null when `outcome = 'rejected'` |
| `edited` | boolean | true when any final differs from its detected value; drives the review tab's marking without re-deriving |
| `created_at` | timestamp, default now | |

## Lifecycle

**At capture** (`ingestCapture`, inside the existing per-run lock): after the
pending rows are inserted, if at least one pending row was created, insert the
image bytes into `capture_images` with `keep = false`. No pending rows (dup,
unparseable, conflicts only) means no insert. One screenshot that routes to two
runs produces two `captures` rows and therefore two copies of the bytes;
accepted, it keeps the 1:1 invariant and these are small.

**Freeze on every resolution.** Every confirm and every reject writes its
`vision_reviews` row, whether or not the operator keeps anything. This is the
mechanism behind whole-screenshot archiving: a Keep press on the *last* fill of
a three-fill screenshot must be able to show what happened to the two siblings,
and by then `pendingRepo.decide()` has overwritten their live values. Freezing
as we go is the only way those rows still exist. The cost is a few rows per
capture that are usually swept away unread — rows of integers, against a blob
we were already storing.

**At confirm:** the request carries overrides and an optional `keepImage` flag.
The server compares the effective values against the `detected_*` snapshot;
`edited` means any of side, shares, price, filled-on or fee differs (a null
detected value with a non-null final counts — see the snapshot notes). Write the
`vision_reviews` row with `outcome = 'confirmed'`, and if `keepImage` is true set
`keep = true` on `capture_images`. Then run the sweep.

**At reject:** same, with `outcome = 'rejected'` and null finals. A reject can be
kept regardless of whether anything was edited — rejecting *is* the signal that
vision was wrong.

**Keep is sticky** (*my call*): once any fill from a capture sets `keep = true`,
answering "Discard" on a sibling never flips it back. The flag is about the
screenshot, and the operator already said that screenshot is worth looking at.
A discard on a sibling of a kept capture is therefore a no-op on the flag; its
frozen row is part of the entry either way.

**The sweep** (after every confirm/reject): if the capture has no remaining rows
with `status = 'pending'` and `keep` is false, delete the `capture_images` row
**and** that capture's `vision_reviews` rows. They only existed to be archived;
unkept, they go with the bytes. A capture that is never fully resolved keeps
both indefinitely — that is the intended "keep until all unconfirmed fills are
resolved".

**Delete from the review tab:** removes the `capture_images` row *and* its
`vision_reviews` rows — the whole entry disappears from the tab. *My call*:
"delete each one" reads as removing the entry, and a tab full of imageless
diff-only rows would be clutter.

**Re-ingesting a capture whose image was kept.** The dedup note below is only
true when every fill from a screenshot was *confirmed*. A **rejected** fill is
neither booked nor pending, so re-uploading that screenshot lets `claimCapture`
reuse the existing `captures` row and `matchCapturedFills` call the fill fresh —
and a naive `capture_images` insert would then collide on the primary key and
throw inside the run lock, failing ingest. *My call*: the store is an
insert-or-ignore. If a row already exists, keep the existing bytes, leave `keep`
alone, and proceed. One capture id can then accumulate `vision_reviews` rows
from two resolution generations; the unique index is on `pending_fill_id`, which
differs per generation, so both survive and the tab groups them under one image
ordered by `created_at`. That is the honest history. This path needs a test.

## Server surface

Routes (all behind the existing auth middleware):

- `GET /api/pending` — each row gains `hasImage: boolean` and
  `detected: { side, shares, price, filledOn, fee } | null` (null for legacy
  rows without `detected_at`). Never returns bytes.
- `GET /api/captures/:id/image` — raw bytes with the stored `Content-Type`,
  `Cache-Control: private, max-age=300`, `404 {error:'not-found'}` when absent.
  Authenticated by the `st_session` cookie in the `<img>` case.
- `POST /api/pending/:id/confirm` — body `{ overrides?: { side?, shares?,
  price?, filledOn?, feeCents? }, keepImage?: boolean }`. `side` and `feeCents`
  are new; `feeCents: null` means "recompute from the run's cost ppm".
- `POST /api/pending/:id/reject` — body `{ keepImage?: boolean }`.
- `GET /api/vision-reviews` — newest-first entries grouped by capture:
  `{ captureId, runId, ticker, createdAt, hasImage, mime, byteLen, fills: [...] }`.
- `DELETE /api/vision-reviews/:captureId` — `{ ok: true }`, or 404.

Domain:

- `confirmPendingFill` accepts `side` in overrides, validated as `'buy' | 'sell'`
  (anything else → 422 `invalid-side`). A side override switches the whole
  booking branch in `bookUnlocked` — buy picks the next empty bucket, sell runs
  order/bucket matching — and the existing `no-empty-bucket` /
  `no-bucket-for-sell` errors already cover the failure cases. `side` joins the
  `edited` patch handed to `pendingRepo.decide`.
- `confirmPendingFill` also accepts `feeCents: number | null`, matching the
  `feeCents` convention `bookUnlocked` already has (`null` ⇒ compute from
  `costPpm`). Validated as an integer ≥ 0. Omitted entirely ⇒ today's behaviour,
  `pending.fee`.
- **The archive write happens after booking succeeds, inside the same locked
  section** (*my call*). A side override can fail late with `no-empty-bucket` or
  `no-bucket-for-sell`, and the operator will fix and retry; writing first would
  leave `outcome='confirmed'` rows for a fill that is still pending, one per
  attempt. So `confirmPendingFill` takes the keep decision as a parameter and
  does the freeze + keep-flag + sweep after `bookUnlocked` returns, rather than
  the route doing it afterwards. The unique index on
  `vision_reviews.pending_fill_id` is the backstop.
- New `apps/server/src/domain/capture-image.ts`: store, sweep, keep-flag.
- New `apps/server/src/domain/vision-review.ts`: edit detection, review-row
  writes, list and delete.
- New repos in `db/repos.ts`: `captureImageRepo`, `visionReviewRepo`, added to
  the `RepoSurface` in `domain/booking.ts`. Blob reads live behind a dedicated
  `getBytes(captureId)` method so no listing path can pull them by accident.
- New `http/routes/vision-review.ts` carrying both the review endpoints and the
  image endpoint; `routes/pending.ts` extended for the new body fields.

## Web surface

- `components/forms/PendingTable.tsx` — one control per field, pre-filled from
  the row; thumbnail; the side-by-side button; the keep/discard prompt. Pulled
  under the 300-line limit by splitting the two modals out.
- `components/forms/PendingReviewDialog.tsx` (new) — the side-by-side modal.
  Image on one side, `Field`-wrapped inputs on the other, `Cancel` / `Done`.
  Local state only; `Done` lifts values to the row.
- `components/forms/KeepImagePrompt.tsx` (new) — the two-button prompt. Copy is
  settled:
  > **Values were edited**
  > You changed this fill before confirming, so vision may have misread the
  > screenshot. Keep the screenshot for review?
  > `[Keep for review]` `[Discard]`

  The reject variant reuses the prompt with a reject-flavoured lead line.

  **The prompt is suppressed when `hasImage` is false** (*my call*): there is
  nothing to keep, so asking is noise. That covers legacy rows, captures over
  the byte cap, and any capture whose image was already swept. The resolution
  proceeds as an unprompted confirm/reject, and its frozen `vision_reviews` row
  is swept with the rest. Consequence: the review list is driven off
  `capture_images` (entry presence == image presence), which keeps the delete
  semantics simple.
- `pages/VisionReview.tsx` (new) — the tab. Per entry: image, a small table of
  detected vs final per fill with differing values marked, and Delete.
- Routing: `#/vision-review` added to the `Route` union in `components/hooks.tsx`,
  `pageFor` in `App.tsx`, and `NAV` in `components/Layout.tsx`.
- `api.ts` / `api.types.ts`: `confirmPending` gains `side` and `keepImage`,
  `rejectPending` gains `keepImage`, plus `listVisionReviews` and
  `deleteVisionReview`. Note `call()` always parses JSON, so the image endpoint
  is never routed through the typed client — it is an `<img src>` URL built from
  the capture id.
- The **fee field** is the fifth editable control, in the row and in the
  side-by-side dialog. Pre-filled with `detected_fee` when vision read one;
  when vision missed it, pre-filled with the auto-computed fee from the run's
  `costPpm` and marked as derived, following the auto-fee prefill pattern
  (`docs/superpowers/specs/2026-11-12-auto-fee-prefill-design.md`). Clearing the
  field sends `feeCents: null` (recompute). Fee is in USD on the wire like the
  other money inputs; validate with `usdFeeOrNull` (which allows 0) and convert
  with `usdToCents`.
- `viewmodels.ts`: a `pendingEdits(row, values)` helper returning which fields
  differ from the detected baseline, used for the prompt trigger and for marking
  changed fields. `pendingIssue` stays, but with every field now pre-filled its
  warning only fires when vision missed a field outright.
- New keys in `i18n/en.json` and `i18n/ko.json` for the tab name
  ("Vision review"), prompt copy, side-by-side dialog, column headers and the
  delete confirmation.

### Row sketch

```
  Screenshot   Trade date     Ticker  Side      Qty    Price     Fee     Actions
  ┌────────┐   ┌──────────┐           ┌──────┐  ┌───┐  ┌──────┐  ┌────┐
  │ [img]  │   │2026-11-14│   NVDA    │ Buy ▾│  │ 12│  │178.42│  │0.21│  [Side by side] [Confirm] [Reject]
  └────────┘   └──────────┘           └──────┘  └───┘  └──────┘  └────┘
```

## Correctness notes for the builder

- Prices on the wire are myriadth **strings** (`PendingFillDto.price`); the
  inputs are USD strings. Display through `format.ts:priceUsd`, validate with
  `api.ts:usdOrNull`, and send USD. Never compare USD strings for edit
  detection — compare parsed myriadths, so `178.4` and `178.40` are equal.
- Because every field is now pre-filled, confirm requests always carry a full
  override set. An unedited confirm must behave exactly as today's
  no-overrides confirm, and must not trigger the keep prompt.
- The sweep and the keep-flag write belong inside the same per-run lock span as
  the confirm/reject they follow, so two concurrent resolutions of sibling fills
  from one capture cannot both decide "I was last" and race the delete.
- Cap stored bytes (suggest 8 MB; MariaDB's `max_allowed_packet` is the real
  ceiling). Over the cap, skip the image and let the fill proceed —
  a missing screenshot must never block booking.
- Re-uploading a screenshot whose fills were all **confirmed** hits exact dedup
  and returns `duplicate`, so no bytes are re-stored. A screenshot with a
  **rejected** fill does not — see "Re-ingesting a capture whose image was kept"
  above, which is why the store must be insert-or-ignore.

## Test plan

- `apps/web`: PendingTable (pre-filled controls, side dropdown, edit detection,
  prompt appears only on edit, prompt on reject), PendingReviewDialog
  (Done writes back, Cancel does not), VisionReview page (render, delete),
  `viewmodels` `pendingEdits` unit tests.
- `apps/server/test`: `booking.test.ts` for the side override (both directions,
  and the `no-bucket-for-sell` path); new tests for store/sweep/keep lifecycle,
  including "sibling fill still pending ⇒ bytes stay" and "keep=true ⇒ bytes
  survive the sweep"; `http.test.ts` for the new bodies, the image endpoint
  (content type, 404, auth) and the review endpoints; `db.test.ts` for the two
  new repos.
- New cases the reviewer's questions turned up, all worth explicit tests: the
  three-fill capture where only the last fill is kept (siblings' frozen rows
  must still be in the entry); keep-then-discard-on-sibling (flag stays true);
  re-ingesting a capture whose image was kept after a reject (insert-or-ignore,
  no throw, two generations of review rows); a null `detected_filled_on` filled
  in by the operator counting as edited; and the suppressed prompt when
  `hasImage` is false.
- `scripts/e2e.ts`: extend the existing capture flow — capture stores an image,
  confirm with an edited price and keep, the review entry shows detected vs
  final, delete removes it, and a plain unedited confirm leaves no bytes behind.

## Builder's choice

- Exact layout and sizing of the thumbnail and the side-by-side modal, within
  the existing `Modal` (its `max-w-md` will need widening for side-by-side).
- Whether the review tab caps at a fixed count (e.g. newest 200) or loads all;
  either is fine at this scale.
- How the diff is marked visually (the codebase already uses `border-warning`
  and `text-warning` for "needs attention").
- Where the keep/discard prompt's reject-variant copy differs from the confirm
  variant, beyond the lead line.
- Repo/module boundaries beyond the files named above, as long as nothing
  exceeds ~300 lines.
