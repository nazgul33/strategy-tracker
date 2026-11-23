# Emptied-Bucket Legs, Exact Boot Rebuild and Test Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #81 (split the oversized test files), #73 (an edit or delete that empties a bucket retires its sell legs) and #77 (the boot repair rebuilds a review record with the confirm's fee override).

**Architecture:** The test split comes first and moves tests verbatim. Then one new domain module, `retire-legs.ts`, becomes the only place that retires sell legs; `bookUnlocked`, `rebookFillUnlocked` and `deleteFill` call it and return what they cancelled, and their public wrappers notify after the run lock is released. Last, one nullable column on `pending_fills`, written by the statement that flips the row, lets `refreezeKept` rebuild the record exactly.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle (MariaDB), React (happy-dom tests), `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-23-emptied-bucket-legs-and-test-split-design.md`

## Execution

- Worktree: `/Users/nazgul33/.local/share/opencode/worktree/c34a7d/fix/issues-73-74-77-81`, branch `fix/issues-73-77-81`. All commands run from the worktree root.
- Models (operator instruction): implementers `anthropic/claude-sonnet-5-5`; per-task planning and review subagents `anthropic/claude-opus-5-5`; final branch-wide review `anthropic/claude-fable-5-2`.
- Tasks run one at a time, in order. They share helper modules and one git index.
- Scratch files go under `T=/private/var/folders/yq/gll5h8h137z_8nzs1tq3gr1r0000gn/T/opencode`, never in the repo.
- Line numbers below are those of commit `34ca021`.

## Global Constraints

- Respond and write in English only. No Chinese or Russian characters anywhere. Korean only in UX string resources.
- No source or test file above ~300 lines. `packages/*` never import `apps/*`. Money is bigint, never float. User-facing copy in en and ko.
- Commit style `feat|fix|docs|test|refactor|chore:`. No file is written outside the worktree except under `$T`.
- `apps/server/src/domain/sell-match.ts` and the matching rule are not changed (#74 is out of scope).
- The run lock is not reentrant: code that runs inside a `withRunLock` span uses `orderRepo.setStatus`, never `cancelOrder`, and never calls a locking wrapper.
- No web UI change. The JSON bodies of `PUT`/`DELETE /runs/:id/fills/:fillId` and `POST /corrections/:id/apply` do not change.
- Behaviour changes are test-first: write the failing test, watch it fail, then implement.
- Baselines: `bun test` = 1736 pass, 81 skip, 0 fail; `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` = 1805 pass, 0 fail; `bun run typecheck` clean. Tasks 1-7 must leave all three unchanged.

## Review Focus

1. An edit empties a bucket that has no orders at all (a seeded run, or a day never planned): the edit succeeds, nothing is cancelled, no notice. Test in Task 9.
2. An edit that is refused (`too-many-shares`) or repeated on an already-empty bucket: no order changes and no second notice. Tests in Task 9.
3. A delete of a buy touches only that bucket's `open`/`stale` sell-side orders dated on or after the buy: a `filled` `buy_loc`, an older stale leg, another bucket's legs and another run's orders stay as they were. Test in Task 10.
4. An emptying edit or delete with no allowed Telegram chat: the notice is still recorded as a `web` row. Tests in Tasks 9 and 10.
5. A confirm whose fee override equals the fee vision read, and a rejected row: the rebuilt record matches the live one (`feeOverridden` true and `edited` false for the first; `feeOverridden` false for the second). Tests in Task 11.

---

## Rules for Tasks 1-7 (the split)

These apply to every split task; each task lists only its file mapping.

- **Verbatim:** the text of every `test(...)`/`it(...)` call (title and body) and of every enclosing `describe` title is byte-identical after the move. Allowed edits: `import` lines, and relocating setup.
- **Long describes:** when a `describe` is cut across files, each file repeats the same `describe('<same title>', ...)` wrapper.
- **Setup:** stateless helpers and fixtures that more than one new file needs move to a non-test module (named in the task). File-level mutable state (`let` variables that tests assign or read) stays in each test file; shared code receives it through parameters or getter callbacks, so test bodies do not change. If a test body would have to change, stop and report instead.
- **Order dependence:** tests that rely on another test's side effects move together and keep their order.
- **Size:** every resulting test file and helper module is at most ~300 lines.
- **Commits:** one commit per original file, message `test: split <file> by area (#81)`.
- **Do not edit `AGENTS.md`** in these tasks; Task 12 does it once.

Verification, run for each original file before its commit (shown for `booking.test.ts`; substitute paths):

```bash
T=/private/var/folders/yq/gll5h8h137z_8nzs1tq3gr1r0000gn/T/opencode
titles() { bun test --reporter=junit --reporter-outfile=$T/$1.xml >/dev/null 2>&1; grep -o '<testcase name="[^"]*" classname="[^"]*"' $T/$1.xml | sort > $T/$1.txt; }
# before touching anything in the task:
titles before
# after the split:
titles after && diff $T/before.txt $T/after.txt          # expected: no output
norm() { sed 's/^[[:space:]]*//' | grep -v '^import ' | sort; }
git show HEAD:apps/server/test/booking.test.ts | norm > $T/old.txt
cat <every file the old one was split into, plus the helper modules touched> | norm > $T/new.txt
comm -23 $T/old.txt $T/new.txt                            # expected: no output, or only adapted setup lines
bun test 2>&1 | tail -4                                   # expected: 1736 pass, 81 skip, 0 fail
TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test 2>&1 | tail -4   # expected: 1805 pass, 0 fail
bun run typecheck                                         # expected: no errors
wc -l <the new files>                                     # expected: each <= ~300
```

Every line `comm` prints is reported with the reason; a line from inside a test body is a failure.

### Task 1: Split `apps/server/test/booking.test.ts` (1706 lines)

**Files:**
- Modify: `apps/server/test/booking.test.ts` (keeps `describe('booking')` tests at lines 18-239)
- Create: `apps/server/test/booking-guards.test.ts` — `describe('booking')` tests at 240-429, `describe('buy bucket selection')` 432-477, `describe('withRunLock')` 1049-1067
- Create: `apps/server/test/booking-capture-dedup.test.ts` — 479-696
- Create: `apps/server/test/booking-capture-reupload.test.ts` — 698-847
- Create: `apps/server/test/booking-capture-corrections.test.ts` — 849-1047
- Create: `apps/server/test/booking-sell-legs.test.ts` — `describe('sell matching with target and stop legs')` tests at 1096-1257, and `describe('matchSellOrder')` 1569-1607
- Create: `apps/server/test/booking-sell-cancel.test.ts` — same describe title, tests at 1259-1415
- Create: `apps/server/test/booking-sell-notify.test.ts` — same describe title wrapping the nested `describe('notifying the operator of the cancelled leg')` 1417-1566
- Create: `apps/server/test/booking-confirm-overrides.test.ts` — 1609-1706
- Create: `apps/server/test/booking-sell-fixture.ts` — the describe-local helpers at 1070-1094 (`D`, `setup`, `sell`, `order`, `lastFill`, `bookInput`, `pair`, `held1` and the `Held`/`Ord` types they use), exported under the same names

- [ ] **Step 1:** Record the title baseline (`titles before`).
- [ ] **Step 2:** Move the blocks as mapped. The three capture describes each keep their own local `setup`/`img`/`ext`/`seedFill` helpers verbatim (they differ slightly; do not merge them).
- [ ] **Step 3:** Run the verification block. Expected results as stated there.
- [ ] **Step 4:** Commit: `git add apps/server/test && git commit -m "test: split booking.test.ts by area (#81)"`

### Task 2: Split `apps/server/test/wire.test.ts` (1032 lines)

**Files:**
- Modify: `apps/server/test/wire.test.ts` (keeps `FULL_ENV`, `describe('parseEnv')` 28-113, `describe('todayEt')` 115-125)
- Create: `apps/server/test/wire-capture-fakes.ts` — lines 127-280: `makeCaptureFakes`, `visionFetch`, `activeRun`, the `_wire` type assertion, `makeCapture`, `multiVisionFetch`, `NOTICE_EN`, `DATE_NOTICE_EN`, `PNG_B64`, exported under the same names
- Create: `apps/server/test/wire-capture-photo.test.ts` — describes at 282-431 and 539-573
- Create: `apps/server/test/wire-capture-routing.test.ts` — describes at 433-537, 755-811, 813-880
- Create: `apps/server/test/wire-capture-confirm.test.ts` — describes at 575-656, 658-753, 957-1032
- Create: `apps/server/test/wire-capture-status.test.ts` — describe at 882-955

- [ ] **Step 1:** `titles before`.
- [ ] **Step 2:** Move as mapped.
- [ ] **Step 3:** Run the verification block (paths for `wire.test.ts`).
- [ ] **Step 4:** Commit `test: split wire.test.ts by area (#81)`.

### Task 3: Split `apps/server/test/db.test.ts` (847 lines)

The file is one `describeIf('db integration')` with a shared `beforeAll` and a local `selectRows`. Each new file repeats lines 14-29 verbatim (the `describeIf` constant, the describe header, `let db`, `let repos`, `beforeAll`, `selectRows`), so test bodies keep resolving the same names.

**Files:**
- Modify: `apps/server/test/db.test.ts` (keeps tests at 31-284)
- Create: `apps/server/test/db-capture.test.ts` — tests at 285-438
- Create: `apps/server/test/db-corrections.test.ts` — tests at 439-542
- Create: `apps/server/test/db-migration-0007.test.ts` — nested describe 543-729
- Create: `apps/server/test/db-vision-review.test.ts` — nested describe 730-846

- [ ] **Step 1:** `titles before`.
- [ ] **Step 2:** Move as mapped. Every new file name starts with `db-` and keeps the `TEST_DATABASE_URL` self-skip.
- [ ] **Step 3:** Run the verification block. If a DB test fails only because it needed rows an earlier test wrote, move the two together and report it.
- [ ] **Step 4:** Run the DB suite a second time (expected again 1805 pass): the split must not depend on a clean `st_test`.
- [ ] **Step 5:** Commit `test: split db.test.ts by area (#81)`.

### Task 4: Split `rebooking.test.ts` (486) and `vision-review.test.ts` (437)

**Files:**
- Create: `apps/server/test/rebooking-fixture.ts` — `rebooking.test.ts` lines 8-62 (`TODAY`, `F`, `deps`, `getState`, `adjustRows`, `asJson`, `scrambleListForRun`, `createRun`, `bookBuy`, `gross`, `buyEffect`, `sellEffect`, `ageOf`, `expectKind` and whatever else sits in that range), exported under the same names
- Modify: `apps/server/test/rebooking.test.ts` (keeps `describe('rebuildState')` 64-81 and `describe('rebookFill')` 83-323)
- Create: `apps/server/test/rebooking-delete.test.ts` — `describe('deleteFill')` 325-486
- Create: `apps/server/test/vision-review-fixture.ts` — `vision-review.test.ts` lines 15-38 and `setup` at 102-109
- Modify: `apps/server/test/vision-review.test.ts` (keeps `describe('isEdited')` 40-100 and `describe('freeze, keep, sweep')` tests at 112-212)
- Create: `apps/server/test/vision-review-fee.test.ts` — `describe('freeze, keep, sweep')` 214-348, including its local `feelessCapture` and `sellEmptyingBucket`
- Create: `apps/server/test/vision-review-reject.test.ts` — describes at 351-437

- [ ] **Step 1:** `titles before`.
- [ ] **Step 2:** Split `rebooking.test.ts`; run the verification block; commit `test: split rebooking.test.ts by area (#81)`.
- [ ] **Step 3:** Split `vision-review.test.ts`; run the verification block; commit `test: split vision-review.test.ts by area (#81)`.

### Task 5: Split `http-runs.test.ts` (491), `sim.test.ts` (473), `day.test.ts` (471)

**Files:**
- Modify: `apps/server/test/http-runs.test.ts` (keeps `describe('http runs')` tests at 8-176)
- Create: `apps/server/test/http-runs-fills-gaps.test.ts` — `describe('http runs')` tests at 177-332
- Create: `apps/server/test/http-runs-cutloss.test.ts` — `describe('http runs')` wrapping the nested describes at 333-451 and 452-490
- Create: `apps/server/test/sim-fixture.ts` — `sim.test.ts` lines 10-26 (`bars`, `gapBars`, `makeRun`)
- Modify: `apps/server/test/sim.test.ts` (keeps `describe('simulateDays')` 28-144 and `describe('routes')` 429-474)
- Create: `apps/server/test/sim-cut-loss.test.ts` — 146-317
- Create: `apps/server/test/sim-run.test.ts` — 319-427
- Create: `apps/server/test/day-fakes.ts` — `day.test.ts` lines 14-60 (`makeRepos`, the `_day` type assertion); `WARN_EN` (line 63) goes here too if more than one new file uses it
- Modify: `apps/server/test/day.test.ts` (keeps `describe('day pipeline')` tests at 65-175 and 322-394)
- Create: `apps/server/test/day-data-error.test.ts` — `describe('day pipeline')` tests at 176-321
- Create: `apps/server/test/day-run-lock.test.ts` — 397-471

- [ ] **Step 1:** `titles before`.
- [ ] **Step 2:** For each of the three files in turn: split, run the verification block, commit `test: split <file> by area (#81)`.

### Task 6: Split `apps/web/src/components/forms/PendingTable.test.tsx` (712 lines)

Neighbour names to follow and not collide with: `PendingTableBucket.test.tsx`, `PendingTable.edge.test.tsx`, `PendingKeepNotice.test.tsx`, `PendingDefaultFee.test.tsx`, `PendingRefresh.test.tsx`.

**Files:**
- Create: `apps/web/src/testing/pendingTable.ts` — the stateless parts of lines 1-112 (fetch stub builder, `confirmButton`, `flush`, `renderTable`, `clickConfirm`); reuse what `apps/web/src/testing/pendingRow.ts` already exports instead of duplicating it
- Modify: `apps/web/src/components/forms/PendingTable.test.tsx` (keeps `describe('PendingTable')` tests at 113-252 and 314-324)
- Create: `apps/web/src/components/forms/PendingTableCompare.test.tsx` — nested describe 253-313, and tests at 325-335, 512-545, 645-675
- Create: `apps/web/src/components/forms/PendingTableKeep.test.tsx` — nested describe 336-511
- Create: `apps/web/src/components/forms/PendingTableFee.test.tsx` — nested describes 546-644 and 676-711

Each new file wraps its tests in `describe('PendingTable', ...)` with the same `beforeEach`/`afterEach`, and registers happy-dom the way `PendingTableBucket.test.tsx` does (dynamic imports after `GlobalRegistrator.register()`).

- [ ] **Step 1:** `titles before`.
- [ ] **Step 2:** Move as mapped.
- [ ] **Step 3:** Run the verification block (path `apps/web/src/components/forms/PendingTable.test.tsx`; the DB run is not needed for web-only tasks).
- [ ] **Step 4:** Commit `test: split PendingTable.test.tsx by area (#81)`.

### Task 7: Split `FillDialog.test.tsx` (560) and `RunDetail.test.tsx` (543)

Neighbours: `FillDialogBucket/Escape/Focus/Grouped.test.tsx`, `RunDetailCorrections/Cost/KeepNotice.test.tsx`.

**Files:**
- Create: `apps/web/src/testing/fillDialog.ts` — stateless helpers of `FillDialog.test.tsx` lines 37-120 and the fetch-stub logic of the `beforeEach` at 133-179, taking the file's state (`putFailure`, `postFailure`, `deleteFailure`, `deltaCents`, `calls`) through getter callbacks
- Modify: `apps/web/src/components/forms/FillDialog.test.tsx` (keeps `describe('FillDialog')` tests at 191-315)
- Create: `apps/web/src/components/forms/FillDialogErrors.test.tsx` — tests at 351-434 and 505-508
- Create: `apps/web/src/components/forms/FillDialogResult.test.tsx` — tests at 316-350 and 435-504
- Create: `apps/web/src/components/forms/FillDialogAutoFee.test.tsx` — `describe('autoFeeUsd')` 511-560
- Create: `apps/web/src/testing/runDetail.ts` — stateless parts of `RunDetail.test.tsx` lines 32-127 (`RUN`, `BARS`, `SUB_ROUTES`, DOM helpers) and 332-383 (`CLOSED_ROW`, `RUN_WITH_HISTORY`)
- Modify: `apps/web/src/pages/RunDetail.test.tsx` (keeps describes at 128-199 and 201-256)
- Create: `apps/web/src/pages/RunDetailAddFill.test.tsx` — describe 258-330
- Create: `apps/web/src/pages/RunDetailRecalc.test.tsx` — describes at 385-444 and 446-543, with `stubFetchWithRecalc` and `recalcPosts`

- [ ] **Step 1:** `titles before`.
- [ ] **Step 2:** Split `FillDialog.test.tsx`; verify; commit `test: split FillDialog.test.tsx by area (#81)`.
- [ ] **Step 3:** Split `RunDetail.test.tsx`; verify; commit `test: split RunDetail.test.tsx by area (#81)`.
- [ ] **Step 4:** `wc -l` over the eleven original paths and every file created in Tasks 1-7: none above ~300.

---

### Task 8: `retire-legs.ts`, and `bookUnlocked` uses it

**Files:**
- Create: `apps/server/src/domain/retire-legs.ts`
- Create: `apps/server/test/retire-legs.test.ts`
- Modify: `apps/server/src/domain/booking.ts:129-148`

**Interfaces:**
- Produces:

```ts
// apps/server/src/domain/retire-legs.ts
export type EmptyCause =
  | { kind: 'sold'; filledOn: ISODate; legId: number | null }   // legId: the order the emptying sell belongs to
  | { kind: 'buy-removed'; filledOn: ISODate }                  // filledOn: the deleted buy's trade date

// Indices of the buckets that are not 'empty' in prev and 'empty' in next, ascending.
export function emptiedBuckets(prev: RunState, next: RunState): number[]

// Retires the sell-side orders of one emptied bucket. `orders` is the run's orders from
// cause.filledOn onwards (orderRepo.listForRunFrom). Resolves to the ids of the OPEN
// orders it cancelled (the ones the operator must pull), lowest id first.
export function retireLegs(
  repos: { orderRepo: Pick<OrderRepo, 'setStatus'> },
  orders: OrderRow[],
  key: { runId: number; bucketIdx: number },
  cause: EmptyCause,
): Promise<number[]>
```

Behaviour of `retireLegs`, in write order:

| Cause | Open sell-side orders of the bucket, `tradeDate >= filledOn` | Stale sell-side orders of the bucket | Flip |
| --- | --- | --- | --- |
| `sold` | all but `legId`: `cancelled`, reason `broker-filled`, returned | dated exactly `filledOn`, all but `legId`: `cancelled`, `broker-filled`, not returned | last: `legId` (when not null) to `filled` |
| `buy-removed` | all: `cancelled`, reason `other`, returned | `tradeDate >= filledOn`, all: `cancelled`, `other`, not returned | none |

Sell-side means `sell_loc`, `stop_sell`, `market_sell`. For `sold`, reuse `openSellLegs` and `staleSellLegs` from `sell-match.ts` unchanged; the `buy-removed` stale filter lives in `retire-legs.ts`.

- [ ] **Step 1: Write the failing tests** in `retire-legs.test.ts` (an in-memory `orders` array and a `setStatus` that records `[id, status, reason]` in call order):
  - `emptiedBuckets lists the buckets that went from held to empty`: `emptiedBuckets(prev, next)` is `[2]` when bucket 2 went `held` to `empty`, bucket 3 was already empty and bucket 4 stayed held.
  - `sold: cancels the open legs, then the stale legs of that day, then flips the leg`: orders of bucket 1 on `D`: target id 1 open, stop id 2 open (`legId: 2`), `market_sell` id 3 stale, target id 4 open dated the next day, target id 5 stale dated the day before. Calls are exactly `[[1,'cancelled','broker-filled'],[4,'cancelled','broker-filled'],[3,'cancelled','broker-filled'],[2,'filled',undefined]]`; the result is `[1, 4]`.
  - `sold with legId null flips nothing`.
  - `buy-removed: cancels open and stale legs from the buy's date on with reason other and flips nothing`: with `filledOn` one day before `D`, an open target and stop on `D`, a stale target on that earlier day, a stale target two days before it and a `filled` `buy_loc`: the two open legs and the first stale leg get `['cancelled','other']`, the older stale leg and the `buy_loc` get no call; the result is the two open ids.
  - `orders of another bucket or another run are never touched` (both causes).
- [ ] **Step 2:** `bun test apps/server/test/retire-legs.test.ts` — expected: FAIL, module not found.
- [ ] **Step 3:** Implement `retire-legs.ts`.
- [ ] **Step 4:** `bun test apps/server/test/retire-legs.test.ts` — expected: PASS.
- [ ] **Step 5:** Replace `booking.ts:129-148`: a sell calls `retireLegs(repos, sellOrders, { runId: input.runId, bucketIdx }, { kind: 'sold', filledOn: input.filledOn, legId: matchedOrderId })` when `emptiedBuckets(state, next)` contains `bucketIdx`, and its result is `cancelledIds`; a buy still flips its matched `buy_loc` to `filled`. Keep the explanatory comment, shortened to what still applies there; the rule's own comment moves to `retire-legs.ts`.
- [ ] **Step 6:** `bun test && bun run typecheck` — expected: 1736 + the new tests pass, 0 fail, with **no existing test edited**.
- [ ] **Step 7:** Commit `refactor: one helper retires the sell legs of an emptied bucket (#73)`.

### Task 9: An edit or correction that empties a bucket retires its legs

**Files:**
- Modify: `apps/server/src/domain/recompute.ts` (`rebookFill`, `rebookFillUnlocked`, and the comment at lines 38-42)
- Modify: `apps/server/src/domain/corrections.ts` (`applyCorrection`)
- Modify: `apps/server/src/http/routes/fills.ts` (the `PUT` handler), `apps/server/src/http/routes/corrections.ts` (apply)
- Create: `apps/server/test/legs-fixture.ts`, `apps/server/test/rebooking-legs.test.ts`, `apps/server/test/http-fill-edit-legs.test.ts`
- Modify: `apps/server/test/corrections.test.ts`

**Interfaces:**
- Consumes: `emptiedBuckets`, `retireLegs` (Task 8); `matchForcedLeg` (`sell-match.ts`); `notifyBookingOutcome` (`booking-notify.ts`); `fillBookingDeps` (`http/booking-deps.ts`).
- Produces:

```ts
// recompute.ts
export function rebookFill(runId: number, edit: RebookEdit, deps: FillBookingDeps, audit?: { reason: string; correctionId?: number }): Promise<{ fill: FillRow; deltaCents: number }>
export function rebookFillUnlocked(runId: number, edit: RebookEdit, deps: BookingDeps, audit?: { reason: string; correctionId?: number }): Promise<{ fill: FillRow; deltaCents: number; cancelledIds: number[] }>
// corrections.ts
export function applyCorrection(id: number, deps: FillBookingDeps): Promise<{ deltaCents: number }>
// test/legs-fixture.ts
// A 10-bucket run (costPpm 0, pool 1_000_000 cents, today = D) whose buckets are held through real
// buy fills (manualFill, so the history rebuilds), buy i landing in bucket i. Orders as in sell-fixture's Ord.
export function heldRun(buys: Array<{ shares: number; price: string; filledOn: ISODate }>, ords: Ord[]): Promise<{ f: Fakes; deps: FillBookingDeps; rec: ReturnType<typeof recordingNotifier>; runId: number }>
export const lastFillId: (f: Fakes) => number
```

`rebookFillUnlocked`, after the ledger write: for each index in `emptiedBuckets(state, rebuilt)`, take the newest fill (highest id) of that bucket in the patched history; when it is a sell, load `orderRepo.listForRunFrom(runId, sell.filledOn)`, pick the leg with `matchForcedLeg(orders, { runId, filledOn: sell.filledOn, shares: sell.shares, price: sell.price, bucketIdx })`, and call `retireLegs(..., { kind: 'sold', filledOn: sell.filledOn, legId: leg?.id ?? null })`. `rebookFill` and `applyCorrection` call `notifyBookingOutcome(runId, { cancelledIds, attribution: null }, deps)` after their lock is released. Existing callers and tests that pass plain `BookingDeps` gain `notify: silentNotifier`; no other test edit is allowed.

- [ ] **Step 1: Write the failing tests** in `rebooking-legs.test.ts` (`D`, `Y`, `sellAt`, `orderOf` from `sell-fixture.ts`; buy `{ shares: 10, price: '100.00', filledOn: '2026-11-01' }` unless stated; bucket 0 legs: target `103.00`, stop `97.00`):
  - `a sell edited up to the whole bucket flips its leg and retires the others`: legs open on `D` plus a stale `sell_loc` `104.00` on `D`. `sellAt(runId, 6, '96.50', deps)`, then `rebookFill(runId, { fillId: lastFillId(f), shares: 10, priceStr: '96.50', feeCents: 0 }, deps)`. Expect stop `filled`; target `103.00` `{ status: 'cancelled', cancelReason: 'broker-filled' }`; the stale `104.00` leg the same; `rec.siblings.map((s) => s.order.id)` equals `[<id of the 103.00 target>]`; `rec.attributions` is `[]`.
  - `a buy edited down to what was sold empties the bucket the same way`: after the 6-share sell, `rebookFill` the buy to `shares: 6, priceStr: '100.00', feeCents: 0`. Stop `filled`, target cancelled `broker-filled`, one sibling notice.
  - `an old sell edited later cancels today's legs and announces them`: target and stop `stale` on `Y`, and open on `D`. `sellAt(runId, 6, '96.50', deps, Y)`, then edit to 10. `orderOf(f, 0, 'stop_sell', Y)` is `filled`; the `Y` target is cancelled; both `D` legs are cancelled `broker-filled`; `rec.siblings` ids are exactly the two `D` legs.
  - `an edit that does not empty the bucket changes no order`: edit the sell to 7; every order status as before; `rec.siblings` is `[]`.
  - `a refused edit changes no order`: edit to 11 rejects with `kind: 'too-many-shares'`; statuses unchanged.
  - `editing the price of an emptying sell again sends no second notice`: after the first test's edit, `rebookFill` with `priceStr: '96.40'`; `rec.siblings` still has length 1.
  - `an emptying edit on a bucket with no orders succeeds quietly`: `heldRun(buys, [])`; resolves; `rec.siblings` is `[]`.
  - `a notifier that throws does not fail the edit`: `notify.siblingCancelled` throws; `rebookFill` resolves and the target is cancelled (silence `console.error` with `spyOn`).
- [ ] **Step 2:** Add to `corrections.test.ts`: `applying a correction leaves the run's orders alone` — an open target and stop on the corrected sell's bucket keep their status after `applyCorrection`.
- [ ] **Step 3:** Write `http-fill-edit-legs.test.ts`, modelled on `http-sibling-notify.test.ts` (same `setup`, seed and two orders): `POST` a 6-share sell at `96.50`, then `PUT /api/runs/:id/fills/:fillId` with 10 shares.
  - `an edit that empties the bucket tells every allowed chat to pull the other leg`: status 200, body `{ ok: true, deltaCents: <number> }` and no other key; `f.sent` equals the sibling text of that file for chats `'42'` and `'43'`.
  - `with no allowed chats the notice is recorded for the web`: `f.sent` is `[]`; one notification row `{ runId: id, chatId: 'web', text }`.
- [ ] **Step 4:** `bun test apps/server/test/rebooking-legs.test.ts apps/server/test/http-fill-edit-legs.test.ts` — expected: FAIL (orders stay `open`, nothing sent).
- [ ] **Step 5:** Implement as described under Interfaces; the `PUT` handler and the correction apply route build their deps with `fillBookingDeps(deps)` (recalc keeps plain deps). Rewrite the comment at `recompute.ts:38-42`: orders are still never reopened; an emptying edit now retires the bucket's legs.
- [ ] **Step 6:** `bun test && bun run typecheck` — expected: all pass.
- [ ] **Step 7:** Commit `fix: a fill edit that empties a bucket retires its sell legs (#73)`.

### Task 10: Deleting a bucket's buy retires its legs, with its own notice

**Files:**
- Modify: `apps/server/src/domain/booking-notify.ts`, `apps/server/src/domain/recompute.ts` (`deleteFill`, `deleteFillUnlocked`), `apps/server/src/wire/booking-notifier.ts`, `packages/telegram/src/i18n.ts`, `apps/server/src/http/routes/fills.ts` (the `DELETE` handler), `apps/server/test/booking-fakes.ts`
- Create: `apps/server/test/rebooking-delete-legs.test.ts`, `apps/server/test/http-fill-delete-legs.test.ts`
- Modify: `apps/server/test/booking-notifier.test.ts`

**Interfaces:**
- Consumes: `retireLegs`, `emptiedBuckets` (Task 8); `heldRun`, `lastFillId` (Task 9).
- Produces:

```ts
// booking-notify.ts
export interface BookingNotifier {
  siblingCancelled(runId: number, order: OrderRow): Promise<void>
  sellAttributed(runId: number, attribution: SellAttribution): Promise<void>
  buyRemoved(runId: number, order: OrderRow): Promise<void>     // new
}
export interface BookedOutcome { cancelledIds: number[]; attribution: SellAttribution | null; orphanedIds?: number[] }
// notifyBookingOutcome: attribution, then cancelledIds (siblingCancelled), then orphanedIds (buyRemoved);
// each call in its own try/catch, logged as 'buy-removed'.
// recompute.ts
export function deleteFill(runId: number, fillId: number, deps: FillBookingDeps): Promise<{ fill: FillRow; deltaCents: number }>
// booking-fakes.ts: silentNotifier gains buyRemoved; recordingNotifier() also returns `orphans: Array<{ runId: number; order: OrderRow }>`
```

Copy, exact, in `packages/telegram/src/i18n.ts`:

```ts
'buy-removed-cancelled': { en: '⚠️ Run #{id} {ticker}: cancel bucket {bucket} {leg} (${limit}) at your broker — the buy it was placed for was deleted, so this order is no longer needed.', ko: '⚠️ 런 #{id} {ticker}: 증권사에서 버킷 {bucket} {leg} (${limit}) 주문을 취소하세요 — 이 주문의 근거였던 매수 체결이 삭제되어 더 이상 필요하지 않습니다.' },
'buy-removed-cancelled-market': { en: '⚠️ Run #{id} {ticker}: cancel bucket {bucket} {leg} at your broker — the buy it was placed for was deleted, so this order is no longer needed.', ko: '⚠️ 런 #{id} {ticker}: 증권사에서 버킷 {bucket} {leg} 주문을 취소하세요 — 이 주문의 근거였던 매수 체결이 삭제되어 더 이상 필요하지 않습니다.' },
```

`deleteFillUnlocked`, after the ledger write: when the deleted fill is a buy and `emptiedBuckets(state, rebuilt)` contains its bucket, call `retireLegs(repos, await orderRepo.listForRunFrom(runId, fill.filledOn), { runId, bucketIdx: fill.bucketIdx }, { kind: 'buy-removed', filledOn: fill.filledOn })`; the result is `orphanedIds`. `deleteFill` notifies after the lock with `{ cancelledIds: [], attribution: null, orphanedIds }`. `buyRemoved` in `booking-notifier.ts` mirrors `siblingCancelled` (market variant without the limit; same `broadcastNotice` delivery).

- [ ] **Step 1: Write the failing tests** in `rebooking-delete-legs.test.ts`:
  - `deleting a bucket's buy cancels its legs with reason other and tells the operator`: buys `[{ shares: 10, price: '100.00', filledOn: '2026-11-10' }, { shares: 5, price: '90.00', filledOn: '2026-11-01' }]`; orders: bucket 0 target and stop open on `D`, bucket 0 target stale on `Y`, bucket 0 target stale on `'2026-11-05'`, bucket 1 target open on `D`, and a `filled` `buy_loc` for bucket 0 dated `'2026-11-10'` (insert it directly through `f.repos.orderRepo.insertMany`). `deleteFill` the bucket-0 buy. Expect: the two open bucket-0 legs `{ status: 'cancelled', cancelReason: 'other' }` and `rec.orphans` ids equal to them; the `Y` stale leg cancelled `other` and absent from `rec.orphans`; the `'2026-11-05'` leg still `stale`; the `buy_loc` still `filled`; bucket 1's target still `open`; `rec.siblings` is `[]`; no order is newly `filled`.
  - `deleting a second lot's buy does not read the earlier lot's sell`: `heldRun` with one buy (10 on `'2026-11-01'`) and no orders; `sellAt(runId, 10, '103.00', deps, '2026-11-05')`; a `manualFill` buy of 8 at `100.00` on `'2026-11-10'` (lands in bucket 0 again); only then insert bucket 0's target and stop, open on `D`, through `f.repos.orderRepo.insertMany` (inserted earlier, the emptying sell would cancel them). Delete the second buy: both legs cancelled `other`; `rec.orphans` has 2 entries; `rec.siblings` is `[]`.
  - `a notifier that throws does not fail the delete`: `notify.buyRemoved` throws; `deleteFill` resolves and the legs are cancelled.
- [ ] **Step 2:** Add to `booking-notifier.test.ts`, under a new `describe('booking notifier: buyRemoved')`, following the `siblingCancelled` tests: en price leg — `'⚠️ Run #7 AAPL: cancel bucket 1 target ($103.00) at your broker — the buy it was placed for was deleted, so this order is no longer needed.'`; en market leg — `'⚠️ Run #7 AAPL: cancel bucket 2 market sell at your broker — the buy it was placed for was deleted, so this order is no longer needed.'`; ko price leg — the `buy-removed-cancelled` ko string with `7`, `AAPL`, `1`, `목표가 매도`, `103.00`.
- [ ] **Step 3:** Write `http-fill-delete-legs.test.ts` (same shape as Task 9's route test, but the run's bucket is held through a `POST` buy, not a seed, so the buy can be deleted): `DELETE /api/runs/:id/fills/:fillId` answers 200 with exactly `{ ok: true, deletedFillId, deltaCents }`; with chats `['42']` one message per open leg in the `buy-removed-cancelled` wording; with no allowed chats the rows have `chatId: 'web'`.
- [ ] **Step 4:** Run the three files — expected: FAIL (`buyRemoved` missing, legs stay open).
- [ ] **Step 5:** Implement as described under Interfaces.
- [ ] **Step 6:** `bun test && bun run typecheck` — expected: all pass.
- [ ] **Step 7:** Commit `fix: deleting a bucket's buy retires its sell legs and tells the operator (#73)`.

### Task 11: The boot rebuild carries the fee override (#77)

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`pendingFills`), `apps/server/src/domain/repo-types.ts`, `apps/server/src/domain/booking.ts` (`BookInput`, the decide patch at line 122), `apps/server/src/domain/confirm-pending.ts`, `apps/server/src/domain/vision-review.ts` (`UnfrozenPendingRow`, `refreezeKept`, the comment at 153-159), `apps/server/src/db/repos-vision.ts` (`listUnfrozenKept`), `apps/server/test/booking-fakes.ts`
- Create: `apps/server/db/migrations/0011_*.sql` and its `meta/` files, by `bun run --cwd apps/server db:generate`
- Modify: `apps/server/test/refreeze-kept.test.ts`, `apps/server/test/db-vision-review.test.ts`

**Interfaces:**
- Produces:

```ts
// repo-types.ts
export type FeeOverrideKind = 'none' | 'cleared' | 'set'
export interface PendingDecisionPatch { side: 'buy' | 'sell'; shares: number; price: bigint; fee: number; filledOn: ISODate; bucketIdx: number; feeOverride?: FeeOverrideKind }   // optional: existing patch literals in tests stay as they are; bookUnlocked always sets it
// schema.ts, pendingFills (nullable, no default)
feeOverride: mysqlEnum('fee_override', ['none', 'cleared', 'set']),
// booking.ts
export interface BookInput { /* existing fields */ feeOverride?: FeeOverrideKind }   // read only with pendingId; absent = 'none'
// vision-review.ts
export type UnfrozenPendingRow = ReviewedPendingRow & { /* existing fields */ feeOverride: FeeOverrideKind | null }
```

`confirmPendingFill` passes `feeOverride: feeOverride === undefined ? 'none' : feeOverride === null ? 'cleared' : 'set'` to `bookUnlocked`. `refreezeKept` maps the column back for a confirmed row: `'cleared'` to `null`, `'set'` to `row.fee ?? 0`, `'none'` or `null` to `undefined`, and passes it to `freezeReview` as `feeOverride`. `PendingRow`/`NewPending` do not gain the field.

- [ ] **Step 1: Write the failing tests** in `refreeze-kept.test.ts` (widen `crashConfirm`'s `overrides` parameter to `ConfirmOverrides | null`):

```ts
const strip = ({ id: _id, createdAt: _at, ...rest }: any) => rest
async function liveAndRebuilt(overrides: ConfirmOverrides | null) {
  const live = await setup(1)
  await confirmPendingFill(live.ids[0]!, overrides, live.deps, { keepImage: true })
  const crashed = await setup(1)
  await crashConfirm(crashed.f, crashed.deps, crashed.ids[0]!, overrides)
  await refreezeKept(crashed.f.repos)
  return { live: strip(live.f._stores.visionReviews[0]), rebuilt: strip(crashed.f._stores.visionReviews[0]) }
}
```

  - `a rebuilt record equals the live one when the confirm left the fee alone`: `liveAndRebuilt(null)`; `rebuilt` equals `live`; `rebuilt.feeOverridden` is `false`.
  - `... when the confirm cleared the fee`: `{ feeCents: null }`; equal; `feeOverridden` `true`; `edited` `true` (vision read `0.05`, the recomputed fee is 0).
  - `... when the confirm set a fee`: `{ feeCents: 7 }`; equal; `feeOverridden` `true`; `finalFee` 7; `edited` `true`.
  - `... when the confirm set the fee vision read`: `{ feeCents: 5 }`; equal; `feeOverridden` `true`; `edited` `false`.
  - `a row decided before the column existed rebuilds as before`: after `crashConfirm(..., { feeCents: 7 })` set the stored pending row's `feeOverride` to `null`, then `refreezeKept`; the record has `feeOverridden: false`.
  - Extend the existing `a rejected fill is rebuilt with null finals` expectation with `feeOverridden: false`.
- [ ] **Step 2:** `bun test apps/server/test/refreeze-kept.test.ts` — expected: the cleared, set and same-fee tests FAIL (`feeOverridden` false in `rebuilt`).
- [ ] **Step 3:** Implement the schema column, the types, the confirm and rebuild mapping and the fake's `listUnfrozenKept` (it returns the stored `feeOverride ?? null`). Delete the "Known loss" sentence at `vision-review.ts:156-157`.
- [ ] **Step 4:** `bun run --cwd apps/server db:generate` — expected: a new `apps/server/db/migrations/0011_*.sql` containing one `ALTER TABLE \`pending_fills\` ADD \`fee_override\` enum('none','cleared','set')` statement and nothing else, plus the `meta/` snapshot and journal entry. No hand-appended statement.
- [ ] **Step 5:** Add to `db-vision-review.test.ts`, inside `describe('vision review storage')`: `decide stores the fee override and listUnfrozenKept returns it` — insert a pending row on a capture whose image is kept, `decide(id, 'confirmed', { ...patch, feeOverride: 'cleared' })`; `selectRows(sql\`select fee_override from pending_fills where id = ${id}\`)` equals `[{ fee_override: 'cleared' }]`; `listUnfrozenKept()` contains an entry with that `id` and `feeOverride: 'cleared'`. Build the row and the kept image the way the neighbouring tests in that describe do.
- [ ] **Step 6:** `bun test && bun run typecheck && TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` — expected: all pass.
- [ ] **Step 7:** Commit `fix: the boot repair rebuilds a review record with the confirm's fee override (#77)`.

### Task 12: Docs and the full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-11-16-cut-loss-and-sim-drafts-design.md`, `AGENTS.md`
- Modify (only if it records the #77 loss): any file under `docs/superpowers/specs/` or `docs/superpowers/followups/` found by `grep -rn "feeOverridden\|fee_overridden\|fee override" docs/superpowers/specs docs/superpowers/followups`. Files under `docs/superpowers/plans/` and `decisions/` are history and are not edited.

- [ ] **Step 1:** Cut-loss spec, section "Booking a stop fill":
  - Known limitations heading: no item is open any more except the reopen limitation; item 5 becomes `Addressed 2026-11-23 (#73): a fill edit, an applied correction or a delete that empties a bucket retires that bucket's sell legs through the same rule as a new fill.`
  - "Sibling cancel": add bullets for the edit path (the emptying sell is the bucket's newest fill; its leg is the one `matchForcedLeg` picks; same cancels and the same notice), for the delete path (reason `other`, the `buy-removed-cancelled` notice, stale legs from the buy's date on cancelled silently, nothing flips), and one stating that orders are never reopened when an edit or delete makes a bucket held again.
  - Leave the #52 "Cost" sentence about a second partial as it is and add after it: `Still open, tracked as #74.`
- [ ] **Step 2:** `AGENTS.md` repo map: add `domain/retire-legs.ts`; migrations line ends at `0011_<name>.sql`; the `test/` list names the new server test files and the fixtures `booking-sell-fixture.ts wire-capture-fakes.ts rebooking-fixture.ts vision-review-fixture.ts sim-fixture.ts day-fakes.ts legs-fixture.ts`; `testing/{...}` gains `pendingTable,fillDialog,runDetail`. In "Commands", the hand-appended-statements sentence stays true (0011 has none).
- [ ] **Step 3:** Full verification, all expected to pass with 0 failures:

```bash
bun test
bun run typecheck
TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test
TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts
find apps packages scripts \( -name '*.ts' -o -name '*.tsx' \) -not -path '*/node_modules/*' -not -path '*/dist/*' | xargs wc -l | sort -rn | awk '$1>400 && $2!="total"'   # expected: no output
```

- [ ] **Step 4:** Commit `docs: record the emptied-bucket rule for edits and deletes, and the new test layout (#73, #77, #81)`.
