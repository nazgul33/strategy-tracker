# Emptied-bucket legs, exact boot rebuild, and the test split (#73, #77, #81)

Date: 2026-11-23. Branch: `fix/issues-73-77-81`.

## Intent

Two recorded limitations of the sell-attribution and vision-review work are
closed, and the oversized test files are split so the new tests land in small
files.

- **#73.** A sell that empties its bucket retires that bucket's other sell legs,
  but only when the sell is booked as a new fill. A fill edit that empties a
  bucket leaves the legs `open` on an empty bucket. The rule lived in one writer
  only; it becomes one shared rule that every writer runs.
- **#77.** The boot repair rebuilds a frozen review record without the confirm's
  fee override, so the record's `feeOverridden` and `edited` can be wrong.
- **#81.** Eleven test files are far past the repo's ~300-line convention.

Why together: #73 and #77 both sit in `apps/server/src/domain`, and their
tests go into exactly the files #81 splits. Splitting first keeps the new tests
out of 1,700-line files.

## Goals

1. No open sell-side order on a bucket that an edit, a correction or a delete
   just emptied; the operator is told to pull every such order that is live.
2. A review record rebuilt at boot is identical to the one the confirm would
   have written (except `createdAt`, as today).
3. No test file that is in scope for the split stays above ~300 lines, and no
   test is lost or changed.

## Non-goals

- #40 (multi-instance locking), #50 (Korean copy read), #68 (browser check),
  #69 (accessibility leftovers).
- #74 (a second partial booked silently to another bucket). It was scoped in
  and taken out again on 2026-11-23: the operator wants the fill's order type,
  read from the screenshot, to decide first, and that needs a sample screenshot
  of a stop fill that is not available yet. The direction is recorded on the
  issue. `sell-match.ts` and the matching rule are not touched here.
- Reopening orders. An edit or delete that makes an emptied bucket held again
  still does not reopen its cancelled or filled orders; the next morning's
  re-plan places them. This stays a documented limitation.
- `recalcRunState` keeps its contract: it never touches orders.
- No link column from a fill to its order, and no explicit tracking of partial
  remainders.
- No web UI change. HTTP response bodies of the edit, delete and correction
  routes stay as they are.
- Test files between 300 and 400 lines at branch start are not split.

## Anti-goals

- A changed outcome for any new-fill booking. The existing sell tests must
  pass unchanged after the rule is moved.
- A notice that tells the operator to pull an order that is not live (`stale`).
- A test dropped, renamed or weakened by the split.
- A notice failure that reaches the caller. (A failing order write is
  different: it propagates, as it does on the booking path today. The edit is
  already stored by then, and a loud error is what sends the operator to look
  at the run's orders. Amended while planning, 2026-11-23.)

## Approaches

For the emptied-bucket rule (#73), three were considered:

1. **One shared rule run by every writer (chosen by the operator).** A helper
   compares the run state before and after a write and retires the sell legs of
   each bucket that went from held to empty. New fills, edits, corrections and
   deletes call it; the block in `bookUnlocked` is replaced by the call. The
   caller knows the cause, so the reason and the notice are right. Cost: it
   rewrites a well-tested part of the booking path.
2. A second copy of the block in the edit and delete paths. Lowest risk to
   booking, but two copies of one rule drift apart, which is how #73 arose.
3. A blind sweep ("no open sell leg on an empty bucket"). It cannot tell which
   leg fired, so it cannot flip the right order to `filled` or word the notice.

For #77: one nullable column on the pending row (chosen, my call, operator did
not object). Rejected: deriving the flag from the booked fee (cannot tell
"cleared" from "not overridden" when vision read no fee), and writing the
frozen record before the row flips (a refused booking would leave a record
behind; needs transactions, which is #40).

## Design

### Order of work

One branch, in this order, each step in its own commits: #81, #73, #77.

### #81: split the oversized test files

In scope: every test file above 400 lines at branch start (34ca021).

| Lines | File |
| --- | --- |
| 1706 | `apps/server/test/booking.test.ts` |
| 1032 | `apps/server/test/wire.test.ts` |
| 847 | `apps/server/test/db.test.ts` |
| 712 | `apps/web/src/components/forms/PendingTable.test.tsx` |
| 560 | `apps/web/src/components/forms/FillDialog.test.tsx` |
| 543 | `apps/web/src/pages/RunDetail.test.tsx` |
| 491 | `apps/server/test/http-runs.test.ts` |
| 486 | `apps/server/test/rebooking.test.ts` |
| 473 | `apps/server/test/sim.test.ts` |
| 471 | `apps/server/test/day.test.ts` |
| 437 | `apps/server/test/vision-review.test.ts` |

Rules:

- Each file is split by area into sibling files of at most ~300 lines. A
  `describe` block that is itself longer (two in `booking.test.ts` are) is split
  by topic into several files that repeat the same `describe` title.
- Tests move verbatim: test titles, bodies and their enclosing `describe` titles
  do not change. The only edits allowed are imports and the move of shared
  setup.
- Shared setup that more than one new file needs goes into a non-test module:
  the existing `booking-fakes.ts`, `http-fakes.ts`, `sell-fixture.ts`, or
  `apps/web/src/testing/*`, or a new helper beside them when none fits. Helpers
  are moved, not rewritten.
- Tests that depend on each other's side effects move together. `db.test.ts` is
  one `describe` over one shared database with a shared `beforeAll`; its tests
  may read rows that earlier tests wrote.
- Names follow the neighbours (`http-runs.test.ts`, `day-notices.test.ts`,
  `PendingKeepNotice.test.tsx`) and must not collide with an existing file
  (`sell-matching.test.ts` and `sell-attribution.test.ts` exist). Every file
  split from `db.test.ts` starts with `db-` and keeps the `TEST_DATABASE_URL`
  self-skip, so the test matrix in `AGENTS.md` stays true.
- One original file per commit, at least.
- `AGENTS.md`'s repo map lists the new test files.

Acceptance, checked after every commit of this step:

- Without a database: 1736 pass, 81 skip, 0 fail (the baseline at 34ca021).
  Amended while executing: from Task 3 on the run reports 85 skipped entries,
  because Bun counts one placeholder entry named `(unnamed)` per `describe.skip`
  wrapper and the `db.test.ts` split repeated that wrapper in four more files. No
  test was added or lost; the run with a database stayed at 1805 pass.
- With `TEST_DATABASE_URL`: 1805 pass, 0 fail.
- The sorted list of test titles in the moved files is the same before and
  after.
- `bun run typecheck` passes.

### #73: one rule for a bucket that just became empty

A new helper in `apps/server/src/domain` (its own module; `booking.ts` is at
244 lines) is the only place that retires sell legs. Every writer calls it
inside its `withRunLock` span, as its last writes (the R15 "flip the order
last" ordering), with the state before and after the write.

A bucket counts when it was not `empty` before and is `empty` after.

Amended 2026-11-23, after the final review: each writer looks only at the
bucket of the fill it wrote: the booked sell's bucket, the edited fill's bucket,
the deleted buy's bucket. A bucket emptied by drift between the stored state and
the fill history is left to the rebuild, and its orders are not touched.

**Cause "sold"** (a new sell fill, or a fill edit or applied correction):

- The emptying sell is the fill being booked (booking path), or the bucket's
  newest fill by id after the edit, which is always a sell (edit path).
- Its leg flips to `filled`. On the booking path that is the order the matching
  rule picked, as today (none on the fallback path). On the edit path it is the
  order `matchForcedLeg` picks for that sell in that bucket (none: nothing
  flips).
- Every other `open` sell-side order of that run and bucket dated on or after
  the sell's trade date is cancelled with `broker-filled` and announced with
  the existing `sibling-cancelled` notice.
- The bucket's `stale` sell-side orders dated exactly on the sell's trade date
  are cancelled with `broker-filled`, without a notice.

This is today's behaviour for a new fill, word for word; only its home changes.

**Cause "buy removed"** (deleting a fill; `deleteFill` only ever empties a
bucket by deleting its lot's buy):

- No order flips.
- Every `open` sell-side order of that run and bucket dated on or after the
  deleted buy's trade date is cancelled with reason `other` and announced with
  a new notice (copy below).
- The bucket's `stale` sell-side orders dated on or after the deleted buy's
  trade date are cancelled with reason `other`, without a notice (my call: they
  belong to a lot that no longer exists, and a later rebuy must not let one
  absorb a late fill).

The cause comes from the caller, never from the history: after a delete the
bucket's newest remaining fill can be an old sell of an earlier lot.

Which edits reach this:

- A sell edited up to the bucket's remaining shares (the case in #73).
- A buy edited down to what was already sold (buy 10, sell 6, edit the buy to
  6). Covered by the same "held before, empty after" test.
- A correction changes only price and fee, never shares, so it cannot empty a
  bucket today. It goes through the same path anyway; a test pins that applying
  a correction leaves orders alone.

Notices: as on the booking path, they are sent after the run lock is released,
attribution rules do not apply (no attribution on an edit), and a notifier
failure is logged and never reaches the caller. `PUT` and `DELETE` on fills
and the correction apply route therefore build their deps with
`fillBookingDeps(deps)` (`apps/server/src/http/booking-deps.ts`) so they carry
a notifier.

New copy in `packages/telegram/src/i18n.ts` (key names are the builder's; the
`-market` variant drops the limit, like `sibling-cancelled-market`):

- en: `⚠️ Run #{id} {ticker}: cancel bucket {bucket} {leg} (${limit}) at your broker — the buy it was placed for was deleted, so this order is no longer needed.`
- ko: `⚠️ 런 #{id} {ticker}: 증권사에서 버킷 {bucket} {leg} (${limit}) 주문을 취소하세요 — 이 주문의 근거였던 매수 체결이 삭제되어 더 이상 필요하지 않습니다.`

Tests, at least: sell edit that empties (leg flips, sibling cancelled and
announced, stale leg of that day cancelled silently); buy edit that empties;
an old sell edited days later cancels today's open legs and announces them;
an edit that does not empty changes no order; deleting a buy (open legs
cancelled with `other` and the new notice, stale legs silently, nothing
flipped); deleting a second lot's buy does not use the earlier lot's sell;
a notifier that throws does not fail the edit or delete; the routes answer as
before. The existing sell tests pass unchanged.

### #77: the boot rebuild carries the fee override

- `pending_fills` gets one nullable column recording how the confirm treated
  the fee: untouched, cleared (`feeCents: null`, the server booked the default
  fee) or set (an explicit amount). `null` on a pending or rejected row and on
  every row decided before the migration.
- It is written by the same `pendingRepo.decide` statement that flips the row
  to `confirmed` (through `PendingDecisionPatch`, which `bookUnlocked` builds),
  so a crash cannot separate the flip from the flag. `confirmPendingFill`
  passes the information down; a manual fill has no pending row and writes
  nothing.
- `listUnfrozenKept` returns the column. `refreezeKept` turns it back into the
  confirm's `feeOverride` (untouched or `null` column: none; cleared: `null`;
  set: the row's booked fee) and passes it to `freezeReview`, so `feeOverridden`
  and `edited` come out exactly as the live path computes them.
- Migration `0011` is generated with `db:generate`. No backfill: an old row
  rebuilds as it does today.
- The "Known loss" comment in `vision-review.ts` goes.

Tests: `refreeze-kept.test.ts` covers the three states and a legacy `null`
row, each compared with the record the live confirm writes for the same
inputs; a DB test pins that `decide` writes the column; the fakes carry it.

### Docs

- `docs/superpowers/specs/2026-11-16-cut-loss-and-sim-drafts-design.md`: known
  limitation 5 marked addressed (#73), the sibling-cancel section extended to
  edits and deletes, and the remaining limitation (orders are not reopened)
  kept. The #52 "cost" sentence about a second partial stays: #74 is open.
- The comment above `rebookFill` in `recompute.ts` that says an emptying edit
  leaves legs open.
- Any other doc that records the #77 loss.
- `AGENTS.md`: repo map (new domain module, new test files, migration 0011).

## Constraints

- Repo conventions in `AGENTS.md`: no source file above ~300 lines, money in
  bigint, copy in en and ko, commit style, `packages/*` never import `apps/*`.
- The run lock is not reentrant: the helper runs inside the caller's span and
  uses the plain status writer (`orderRepo.setStatus`), never `cancelOrder`.
- New tests go into the split files and keep every file at or under ~300
  lines.
- TDD: each behaviour change starts with a failing test.

## Verification

`bun test`, `bun run typecheck`, the DB suite and the E2E smoke
(`TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test`; the
`st-mariadb-test` container is running) all pass at the end. The smoke is not
extended (my call: unit and DB tests cover the new behaviour).

## Left to the builder

- The helper's name, module name and signature; how the edit, delete and
  correction functions return what was cancelled so the caller can notify.
- The column's name and type, and the shape of the value passed from
  `confirmPendingFill` to `bookUnlocked`.
- i18n key names and the notifier method for the new notice.
- Where each test file is cut and what the new files are called, within the
  rules above.
