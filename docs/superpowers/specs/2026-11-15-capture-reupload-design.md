# Capture re-upload: re-read a seen image unless it still has fills awaiting a decision

Date: 2026-11-15 · Size: small change · Status: approved approach (B + reuse row, Loose rule)

## Why

Operator re-sent IMG_2109 to the bot after rejecting both pending fills that its first
upload produced (prod `captures` #3 → `pending_fills` #3, #4, both `rejected`). The bot
answered "Duplicate capture" and nothing appeared on the Pending page.

Root cause (verified read-only against prod, 2026-11-15): `ingestCapture`
(`apps/server/src/domain/booking.ts:141`) short-circuits on any earlier `captures` row with
the same `(run_id, image_hash)`, regardless of what happened to that capture's fills. The
fill-level dedup (`capture-dedup.ts`) already ignores rejected rows; the image-hash guard
does not. Two side findings:

- The guard's `insert({ status: 'duplicate' })` always fails on the unique index
  `captures_run_hash_unique` and is swallowed by `captureRepo.insert` — re-uploads leave
  no trace.
- A capture whose vision read failed once (`unparseable`, no fills) blocks that image
  for the run forever. Correction: from Telegram this cannot happen, because
  `extractOrTell` (`apps/server/src/wire/capture.ts`) returns before `ingestCapture`
  whenever extraction fails. The `unparseable` reuse path is reachable only by direct
  callers of `ingestCapture`.

## Goal

Re-sending an image the run has seen before is re-read and re-matched, unless a fill from
that earlier upload is still **waiting for a decision** (`pending_fills.status = 'pending'`).
New pending fills attach to the **existing** capture row.

Non-goals: changing the vision call order (extraction still runs before `ingestCapture`;
auto-route needs the ticker to pick the run), the fill-level dedup/conflict rules, the
HTTP pending routes, manual fills, migrations.

Anti-goals: a re-upload must never re-book a fill that is booked or still pending —
the fill-level dedup inside the run lock remains the guarantee.

## Approaches

- **A. Drop the image-hash guard** (+ migration dropping the unique index). Simplest;
  rejected by operator in favour of keeping the "seen this exact image" check.
- **B. Keep the guard, let the image through when nothing from it is still live, reuse the
  old capture row.** **Chosen.** No migration; the unique index stays as the per-run image
  identity.
- **C. No code change, document "crop or retake".** Rejected — leaves the silent failure.

Rule variant chosen: **Loose** — block only while a row from that capture is `pending`.
Rejected, confirmed (fill may since have been deleted), unparseable, and conflicts-only /
nothing-fresh captures are all re-read. Strict ("only when every row was rejected") was
rejected because it blocks failed reads and deleted-fill resubmits forever.

## Behaviour

On `ingestCapture(runId, image, extract, deps)`, with `hash` as today:

1. Look up the existing capture for `(runId, hash)`.
2. **Existing capture with ≥1 `pending_fills` row (`captureId` = it, status `pending`)** →
   return `'duplicate'`, write nothing (the doomed `'duplicate'` insert is removed).
3. **Existing capture, nothing live** → reuse it: set its status to `unparseable` if
   `!extract.ok` (return `'rejected'`), else `parsed`, and continue with its id as
   `captureId`.
4. **No existing capture** → today's behaviour (insert `unparseable` / `parsed`; a lost
   insert race still returns `'duplicate'`).
5. Fill matching and pending inserts unchanged (`matchCapturedFills` under `withRunLock`).
   A re-read whose fills are all booked/pending still yields `'duplicate'` from step 5's
   "nothing fresh, no conflicts" rule — same Telegram message as today.

Concurrency (builder's call, recommended): perform steps 1–3 inside the existing
`withRunLock(runId, …)` span so two simultaneous re-sends of one image cannot both reuse
the row and race the status write; the in-lock fill dedup already prevents double
pending rows.

## Interfaces (builder's call within these bounds)

- `captureRepo`: replace `hasHash(runId, hash): boolean` with a lookup returning the row
  (`{ id, status } | null`), and add `setStatus(id, status)`. Update `BookingDeps`, the
  drizzle repo, and every test fake (`booking.test.ts`, `wire.test.ts`, `http.test.ts`,
  `sim.test.ts`, `day.test.ts`, `db.test.ts`).
- "Live" check: reuse `pendingRepo.listPending()` filtered by `captureId` — no new
  pending method needed.

## Tests

- Unit (`booking.test.ts`): re-send after all rows rejected → new pending rows on the
  **same** captureId, no new capture row; re-send while one row pending → `'duplicate'`,
  no writes; re-send after confirm → `'duplicate'` (booked fill dedups); re-send of an
  `unparseable` capture with a good extract → `parsed` + pending rows; IMG_2109 shape
  (buy/sell booked, one conflict, one fresh) after rejection → conflict + 1 pending.
- DB (`db.test.ts`): reuse path against real repos — row count stays 1, status flips,
  pending row's `capture_id` = original id.
- Existing re-send assertions (incl. e2e "same photo again -> duplicate-capture") must
  stay green.

## Known limitations

Re-sending the exact image of an upload whose fills were **confirmed** is re-read (the
Loose rule). Only the fill matcher then prevents a second booking, and its key includes
the trade date (`f.date ?? today`). If the re-read date is missing (the model omits it, or
`packages/ingest/src/extract.ts` drops a date more than 45 days from today) or read
differently, the trade comes back as a fresh pending row. Nothing is booked without
operator confirmation, and the same exposure already applies to any non-identical
screenshot of the same trades.

Mitigation (issue #24): when a reused capture already has a `confirmed` pending row
(`pendingRepo.hasConfirmedForCapture`) and the re-read yields fresh pending rows, the
outcome carries `bookedEarlier` and the Telegram reply sends a short notice
(`capture-booked-earlier`, en/ko) before those rows, warning that they may duplicate
fills booked earlier. Booking and dedup rules are unchanged. The live check is now
`pendingRepo.hasLiveForCapture` instead of filtering `listPending()`.

The notice is per capture, not per fill. If a multi-fill screenshot had one fill
confirmed and another rejected, re-sending it shows the "may be duplicates" notice even
though the fresh row is the rejected one. Accepted: the "may be" wording keeps this
false alarm harmless.

## Constraints

Money bigint myriadths; files ≤ ~300 lines (`booking.ts` is close to the limit — keep the guard logic
compact or put the lookup helper next to it); English comments; commit style
`fix:` / `test:`; prod DB never written — tests use `127.0.0.1:3307/st_test` and the e2e
scratch DB only.
