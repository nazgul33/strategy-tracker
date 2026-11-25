# Add a Buy Fill to a Held Bucket — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A buy fill can be added to a held bucket: automatically when a bucket was bought the same day, or by the operator's choice in the web Pending page. Telegram sends rows from a multi-buy capture to the web Pending page.

**Architecture:** A new core transition `addBuyFill` (weighted-average merge), guarded by `isMergeableBucket`, plus `sameDayBuyBucketIndex`. `bookUnlocked` and `rebuildState` route a buy into a held bucket through it. The web Pending row shows `BucketSelect` for buys. `ingestCapture` flags the buy rows of a multi-buy capture with `mergeHint`, and `pendingMessage` turns that flag into a guidance line without buttons.

**Tech Stack:** Bun + TypeScript, bigint money (`@st/core/money`), Hono routes, React + bun test (happy-dom), en/ko catalogs.

**Spec:** `docs/superpowers/specs/2026-11-25-buy-add-to-bucket-design.md`

## Global Constraints

- Money via `@st/core/money` bigint myriadths, never float; average price rounded with `roundDiv` (half-up).
- All user-facing copy via en/ko catalogs (web `apps/web/src/i18n/{en,ko}.json`, Telegram `packages/telegram/src/i18n.ts`).
- No source file > ~300 lines; `packages/*` never import `apps/*`.
- Commit style `feat|fix|test|refactor|docs:`; one commit per task.
- Work on branch `feat/buy-add-to-bucket` in a dedicated worktree.

## Review Focus

1. Deleting the newest buy of a merged bucket must restore the bucket to its pre-merge shares/avg price/fee (rebuild from history), not empty it. Test goes in Task 2.
2. A partly sold bucket must refuse a buy (`bucket-not-mergeable`), and Automatic must skip it even when it was bought the same day (it falls back to the next empty bucket). Tests go in Tasks 1 and 3.
3. Automatic with an earlier-dated held bucket must NOT merge (only exact `filledOn` match). Test goes in Task 3.
4. A `force_sell` bucket is in `heldBuckets` (sells still need it) but must be absent from `mergeableBuckets`, and the server refuses a buy into it. Tests go in Tasks 1, 3 and 5.
5. A capture with two buys on different dates: both rows get `mergeHint` (no buttons), and the operator sorts them out in Pending. Test goes in Task 4.

---

### Task 1: Core `addBuyFill` and `sameDayBuyBucketIndex`

**Files:**
- Modify: `packages/core/src/fills.ts` (next to `applyBuyFill`)
- Test: `packages/core/test/fills.test.ts`

**Interfaces:**
- Produces:
  - `addBuyFill(state: RunState, bucketIndex: number, shares: number, price: bigint, feeCents: number): RunState`
  - `isMergeableBucket(state: RunState, bucketIndex: number): boolean`
  - `nextBuyBucketIndex(state: RunState, buyOn?: ISODate): number | null` (extended)
  - `sameDayBuyBucketIndex(state: RunState, filledOn: ISODate): number | null`
  - Both are exported from `@st/core` (check `packages/core/src/index.ts` re-exports `fills`).

Rules for `addBuyFill`:
- `bucket-not-found` for an unknown index.
- `bucket-not-held` (DomainError) when the bucket is `empty`.
- `bucket-not-mergeable` (DomainError) when `!isMergeableBucket`.
- `invalid-shares` as in `applyBuyFill`.
- Otherwise: `shares += n`, `buyPrice = roundDiv(old.buyPrice*old.shares + price*n, old.shares+n)`, `buyFeeCents += fee`, `cashCents -= roundDiv(price*n,100) + fee`.
- `state`, `filledOn` and `ages` are unchanged.

`isMergeableBucket`: true only for a bucket that is in state `held` with no `state.closed` entry where `index === bucketIndex && openedOn === bucket.filledOn` (a partial sell of the current holding; exact, because of the same-day rule below).

`nextBuyBucketIndex(state: RunState, buyOn?: ISODate): number | null`: the existing function gains an optional `buyOn`. When given, buckets with a `state.closed` entry where `index === b.index && closedOn === buyOn` are skipped (no sell and buy on the same day in one bucket). Without it, behaviour is unchanged (planner, seeding).

`sameDayBuyBucketIndex` returns the lowest index that is mergeable and whose `filledOn === filledOn`, else null.

- [ ] **Step 1: Write the failing tests** in `fills.test.ts`, in a `describe('addBuyFill')` block:
  - `test('merges the 2026-11-24 rungs into one bucket at the weighted average')`: Start from `emptyState(10)` with `cashCents: 5_000_000` and `applyBuyFill(s, 5, 26, 378500n, 69, '2026-11-24')`. Then `addBuyFill(.., 5, 26, 371000n, 68)` and `addBuyFill(.., 5, 94, 319896n, 210)`. Expect bucket 5: `shares 146`, `buyPrice 339433n`, `buyFeeCents 347`, `filledOn '2026-11-24'`, `state 'held'`. Expect cash `5_000_000 - (98410+69) - (96460+68) - (300702+210)`, computing each cost with `roundDiv(price*shares,100n)` in the test.
  - `test('refuses an empty bucket with bucket-not-held')`.
  - `test('keeps the age')`: `ages[5]=3` before the add, and it is still 3 after.
  - `test('refuses a force_sell bucket with bucket-not-mergeable')`.
  - `test('refuses a partly sold bucket with bucket-not-mergeable')`: buy 10 @ 100.00 on '2026-11-24', `applySellFill` 4 shares; adding 6 @ 80.00 throws.
  - `describe('nextBuyBucketIndex with buyOn')`: `emptyState(3)` with closed tranches idx 0 (`closedOn '2026-11-24'`), idx 1 (`'2026-11-20'`), idx 2 (`'2026-11-24'`). No `buyOn` gives 0, and `buyOn '2026-11-24'` gives 1. With idx 1's tranche also closed on '2026-11-24', `buyOn '2026-11-24'` gives null. A never-used bucket is still preferred: `emptyState(4)` with the same tranches gives 3.
  - `describe('isMergeableBucket')`: held gives true; empty, force_sell and partly sold give false. A bucket whose index has an older closed tranche (a different `openedOn`) and was re-bought later gives true.
  - `describe('sameDayBuyBucketIndex')`: buckets 3 and 5 held on '2026-11-24' and bucket 1 held on '2026-11-20'. `'2026-11-24'` gives 3, `'2026-11-20'` gives 1, `'2026-11-25'` gives null. When bucket 3 is partly sold, `'2026-11-24'` gives 5.
- [ ] **Step 2: Run the tests:** `bun test packages/core/test/fills.test.ts`. Expected: FAIL (`addBuyFill` is not exported).
- [ ] **Step 3: Implement** both functions in `fills.ts`.
- [ ] **Step 4: Run** `bun test packages/core` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: core addBuyFill merges a buy into a held bucket at the weighted average`

### Task 2: Replay merged buys in `rebuildState`

**Files:**
- Modify: `apps/server/src/domain/recompute.ts` (`rebuildState`)
- Test: create `apps/server/test/rebooking-buy-merge.test.ts` (use the fakes and fixtures the `rebooking-*.test.ts` files use)

**Interfaces:**
- Consumes `addBuyFill` from Task 1.
- `rebuildState` signature is unchanged.

When a buy is replayed and `state.buckets[f.bucketIdx]` is not `empty`, call `addBuyFill` and leave the age alone. Otherwise keep the current `applyBuyFill` + `ageBuckets` path.

- [ ] **Step 1: Write the failing tests:**
  - `test('rebuildState replays three buys in one bucket as one merged bucket')`: three `FillRow`s for bucket 5, the same values as Task 1. The rebuilt bucket 5 matches Task 1's expectation, and the cash matches.
  - `test('deleting the newest buy of a merged bucket restores the pre-merge bucket')` (Review Focus 1): book the three buys as fills in bucket 5 through the fakes, then `deleteFill` the newest one. Expect bucket 5: `shares 52`, `buyPrice 374750n`, `buyFeeCents 137`, `state 'held'`. Expect no retired legs (`orphans` empty).
  - `test('recalc of a merged bucket books no adjust')`: `recalcRunState` after the three merged buys gives `deltaCents 0`.
- [ ] **Step 2: Run** `bun test apps/server/test/rebooking-buy-merge.test.ts`. Expected: FAIL (`bucket-not-empty`).
- [ ] **Step 3: Implement** the branch in `rebuildState`.
- [ ] **Step 4: Run** `bun test apps/server` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: rebuild state replays buys into a held bucket as a merge`

### Task 3: Booking: Automatic same-day merge and a chosen bucket for buys

**Files:**
- Modify: `apps/server/src/domain/booking.ts` (`bookUnlocked`, the `BookInput.bucketIdx` comment)
- Modify: `apps/server/src/domain/confirm-pending.ts` (`ConfirmOverrides.bucketIdx` comment and the refusal list, adding `bucket-not-mergeable`)
- Modify: `apps/server/src/wire/capture.ts` error map, plus `packages/telegram/src/i18n.ts`: `'bucket-not-mergeable': 'confirm-err-bucket-not-mergeable'`. en: `'That bucket cannot take another buy: it is partly sold or set to force-sell.'`, ko: `'이 버킷에는 매수를 추가할 수 없습니다: 일부 매도되었거나 강제 매도 상태입니다.'`
- Modify tests that pin the old refusal: `apps/server/test/sell-bucket-override.test.ts:78-83,110-116`, `apps/server/test/http-bucket-override.test.ts:62-64,80-89`, `apps/server/test/confirm-keep-order.test.ts:103-108`
- Test: create `apps/server/test/booking-buy-merge.test.ts`

**Interfaces:**
- Consumes `addBuyFill`, `sameDayBuyBucketIndex` (Task 1).
- `BookInput.bucketIdx`: now applies to both sides. `ConfirmOverrides.bucketIdx`: the same.

Rules in `bookUnlocked`:
- The `invalid-bucket` check becomes side-independent: a non-integer or negative value is still `invalid-bucket`.
- When a buy has `bucketIdx` given, `addBuyFill` into it (an empty bucket throws `bucket-not-held`).
- When a buy has no `bucketIdx`:
  - if `sameDayBuyBucketIndex(state, filledOn)` is non-null, use `addBuyFill` there;
  - else `nextBuyBucketIndex(state, input.filledOn)` + `applyBuyFill` + age; null gives `no-empty-bucket`, as today.
- The buy_loc order lookup and flip stay as they are, for both paths.

- [ ] **Step 1: Write the failing tests** in `booking-buy-merge.test.ts`:
  - `test('confirming the three 2026-11-24 buys on Automatic books all into bucket 5')`: three pending buys confirmed with no overrides. Expect 3 fills, all with `bucketIdx 5`; buckets 6 and 7 stay empty; bucket 5 shares 146; the buy_loc order for 2026-11-24 is `filled`.
  - `test('a chosen bucketIdx on a buy adds to that held bucket')`: bucket 2 is held from an earlier date. Confirming with `{ bucketIdx: 2 }` merges into bucket 2 and keeps its `filledOn` and age.
  - `test('a chosen empty bucket on a buy is bucket-not-held and the row stays pending')`.
  - `test('a chosen force_sell or partly sold bucket on a buy is bucket-not-mergeable and the row stays pending')`.
  - `test('Automatic skips a partly sold same-day bucket and books the next empty bucket')`.
  - `test('a buy never lands in a bucket emptied by a sell on the same date')`: only buckets 4 (sold out on '2026-11-24') and 8 (closed earlier) are empty. A buy on '2026-11-24' books bucket 8. When 4 is the only empty bucket, the buy is `no-empty-bucket` and the row stays pending.
  - `test('Automatic does not merge into a bucket bought on an earlier day')` (Review Focus 3): bucket 1 is held from '2026-11-20'. A buy on '2026-11-24' goes to the next empty bucket.
  - `test('a manual buy fill on Automatic merges into the same-day bucket')`: `manualFill` buy, the same rule.
- [ ] **Step 2: Update the pinned tests.** A buy with a valid `bucketIdx` is no longer `invalid-bucket`:
  - `sell-bucket-override.test.ts:80`: the buy with `bucketIdx: 4` on an empty bucket expects `bucket-not-held`.
  - `sell-bucket-override.test.ts:113`: `{ side:'buy', bucketIdx: 9 }` expects `bucket-not-held` (bucket 9 is held in that fixture → check it). If it is held, assert the buy merges instead and rename the test.
  - `http-bucket-override.test.ts:62-64,80-89`: assert `bucket-not-held` / the merge, whichever the fixture's bucket state gives.
  - `confirm-keep-order.test.ts:105`: use `bucketIdx: -1` so it still exercises `invalid-bucket`.
- [ ] **Step 3: Run** `bun test apps/server/test/booking-buy-merge.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** in `bookUnlocked`, and update the comments in `booking.ts` / `confirm-pending.ts`.
- [ ] **Step 5: Run** `bun test apps/server` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: book a buy into the same-day bucket or the operator's chosen held bucket`

### Task 4: Telegram guidance for multi-buy captures

**Files:**
- Modify: `apps/server/src/domain/booking.ts`: add `mergeHint: boolean` to `PendingFillRow`; set it in `ingestCapture`.
- Modify: `apps/server/src/wire/capture-pending-message.ts`
- Modify: `packages/telegram/src/i18n.ts`: new key `capture-buys-several`
- Modify: `apps/web/src/api.captures.types.ts`: add `mergeHint: boolean` to `CapturePendingRowDto` (type only; fixtures that build the DTO, e.g. `apps/web/src/uploadlines.test.ts`, gain `mergeHint: false`).
- Test: `apps/server/test/wire-capture-choice.test.ts` (the existing `pendingMessage` tests) and `apps/server/test/booking-capture-order.test.ts` (the `ingestCapture` flags)

**Interfaces:**
- `PendingFillRow.mergeHint: boolean`: true for a buy row when the capture's fresh rows hold 2+ buys, whatever their dates.

Exact copy (key `capture-buys-several`, no placeholders):
- en: `'ℹ️ Several buys came in this capture. Confirm them in the web app\'s Pending view and choose the bucket: Automatic adds a buy to the bucket bought the same day, or pick "Add to bucket N".'`
- ko: `'ℹ️ 이 스냅샷에 매수 체결이 여러 건 있습니다. 웹 앱의 \'확인 대기\'에서 버킷을 골라 확정하세요: 자동 선택은 같은 날 매수한 버킷에 합치며, "버킷 N에 추가"를 직접 고를 수도 있습니다.'`

- [ ] **Step 1: Write the failing tests:**
  - `ingestCapture` with two buys on '2026-11-24' plus one sell gives the buys `mergeHint true` and the sell `false`.
  - Two buys on different dates give both `true` (Review Focus 5).
  - A single buy gives `false`.
  - `pendingMessage` with `mergeHint: true` ends with the `capture-buys-several` line and returns `buttons: false`.
- [ ] **Step 2: Run** the two test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In `ingestCapture`, compute the hint after the loop from `pendingRows` (count the buy rows).
  - In `pendingMessage`, push the line when `row.mergeHint`.
  - Add the catalog key.
- [ ] **Step 4: Run** `bun test` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: Telegram sends same-day multi-buy captures to the web Pending view`

### Task 5: Web Pending: bucket picker on buy rows

**Files:**
- Modify: `apps/server/src/http/routes/pending.ts`: next to `heldBucketsOf`, add `mergeableBucketsOf(state)` (held buckets filtered by `isMergeableBucket`, same `{ index, shares }` shape); the response row gains `mergeableBuckets`. Test: `apps/server/test/http-pending-routes.test.ts`. A force_sell bucket and a partly sold bucket are in `heldBuckets` but not in `mergeableBuckets`.
- Modify: `apps/web/src/api.pending.types.ts`: `mergeableBuckets: HeldBucketDto[]` on the pending DTO (test fixtures in `apps/web/src/testing/pendingRow.ts` / `pendingTable.ts` gain it).
- Modify: `apps/web/src/components/forms/BucketSelect.tsx`: new prop `side: 'buy' | 'sell'`. For `buy`, label held options `t('bucketAddTo', { n, shares })`; the `''` option stays `t('fillBucketAuto')`.
- Modify: `apps/web/src/components/forms/PendingRow.tsx:195`: render for `values.side === 'buy' || 'sell'`, passing `side`, and `held={side === 'buy' ? row.mergeableBuckets : row.heldBuckets}`.
- Modify: `apps/web/src/components/forms/PendingTable.tsx:106`: send `bucketIdx` whenever `bucket !== ''` and the side is set.
- Modify: `apps/web/src/components/forms/FillDialog.tsx`: pass `side="sell"` (its picker stays sell-only).
- Modify: `apps/web/src/i18n/en.json`, `ko.json`:
  - `"bucketAddTo": "Add to bucket {n} · {shares} sh"` / `"버킷 {n}에 추가 · {shares}주"`
  - `"fillErr.invalid-bucket"` → `"Invalid bucket."` / `"잘못된 버킷입니다."`
  - `"fillErr.bucket-not-mergeable"`: `"This bucket cannot take another buy: it is partly sold or set to force-sell."` / `"이 버킷에는 매수를 추가할 수 없습니다: 일부 매도되었거나 강제 매도 상태입니다."` (check whether the pending table resolves errors through `fillErr.*` or its own prefix in `errortext.ts`, and add the key there)
- Tests: `apps/web/src/components/forms/PendingTableBucket.test.tsx`, `BucketSelect.test.tsx`

- [ ] **Step 1: Write and update the failing tests:**
  - Replace `'a buy row shows no bucket selector'` with `'a buy row offers Automatic and Add to bucket N for each mergeable bucket only'`: the fixture has `heldBuckets` [1, 5] and `mergeableBuckets` [5]; expect only `Add to bucket 6 · 26 sh`, and no bucket 2 option.
  - Replace `'a bucket chosen and then the side switched to buy posts no bucketIdx'` with `'a bucket chosen on a buy row posts it as bucketIdx'` (choose index 5 → overrides `{ bucketIdx: 5 }`).
  - `BucketSelect` with `side="sell"` keeps the old labels.
- [ ] **Step 2: Run** `bun test apps/web/src/components/forms`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: choose Automatic or Add to bucket N when confirming a pending buy`

### Task 6: Docs and the full check

**Files:**
- Modify: `AGENTS.md` repo map only if a new test file name breaks its listing pattern (add `booking-buy-merge`, `rebooking-buy-merge` to the test list).

- [ ] **Step 1:** Update `AGENTS.md` test listing.
- [ ] **Step 2: Run** `bun test`, `bun run typecheck`, and, with the test DB up, `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test`. Expected: all PASS.
- [ ] **Step 3: Commit** `docs: list the buy-merge test files`
