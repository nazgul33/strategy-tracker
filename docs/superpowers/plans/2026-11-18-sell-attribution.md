# Sell attribution by nearest order price (wave A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Book an ambiguous sell fill to the open target/stop leg whose price is nearest the fill, tell the operator why when another bucket could have taken it, bound the order read inside the booking lock, and make the post-booking notifier mandatory for every fill-booking entry point.

**Architecture:** `matchSellOrder` replaces rungs 1b (highest qualifying target) and 1c (lowest qualifying stop) with one "nearest" rung over both leg kinds, and returns a `SellAttribution` when legs on other buckets were also admissible. `bookUnlocked` returns a `BookedOutcome` (cancelled ids + attribution); `runBooking` / `confirmPendingFill` pass it to `notifyBookingOutcome`, which calls a required `BookingNotifier` after the run lock is released. The real notifier writes a `notifications` row and a Telegram message per allowed chat, exactly like the sibling-cancel message today.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle (MariaDB), `bun:test`.

**Spec:** GitHub #43 (attribution), #45 (bounded scan), #48 (bullet "`notifySiblingCancelled` is optional" and the `market_sell` tie-break test gap). Parent design: `docs/superpowers/specs/2026-11-16-cut-loss-and-sim-drafts-design.md`, section "Booking a stop fill" (updated by Task 3). Operator rulings 2026-11-18: price distance only; tell the operator via Notifications tab + Telegram; equal distance → target before stop, then lowest bucket.

**Models (operator ruling 2026-11-18):** implementer subagents run on `anthropic/claude-sonnet-5-5`; per-task reviewers, the whole-branch reviewer and any plan amendments run on `anthropic/claude-opus-5-5`. Pass these as the subagent `model` parameter.

Branch: `fix/sell-attribution` in a dedicated worktree. Merge before waves B/C (`2026-11-18-server-hardening.md`, `2026-11-18-type-safety-and-test-gaps.md`), which assume this wave's types.

## Global Constraints

- Money is bigint myriadths (`parseUsd`, `formatUsd` from `@st/core/money`); distances are bigint, never float.
- All operator copy lives in `packages/telegram/src/i18n.ts` with `en` and `ko`; English and Korean only, no Chinese or Cyrillic characters anywhere.
- No source file over ~300 lines (`apps/server/src/domain/booking.ts` is at 299 today — see Task 2 Step 5).
- Notifications are sent after `withRunLock` is released; a notifier failure is logged and swallowed and never fails or rolls back a booking.
- `packages/*` never import `apps/*`.
- Commit style `feat|fix|docs|test|refactor|chore:`.

## Review Focus

1. **A fill exactly midway between a target and a stop** (bucket 9 target 91.00, bucket 0 stop 97.00, fill 94.00) must book to the target, and the message must still be sent, because a stop was just as admissible. Pinned in Task 2, `equidistant target and stop resolve to the target`.
2. **A prior-day screenshot confirmed after today's re-plan** must still cancel today's legs once the read is bounded to `tradeDate >= filledOn`. The existing test `a prior-day fill that empties the bucket also pulls and announces today legs` must stay green against the new `listForRunFrom` fake. Task 1 adds the DB-level bound test.
3. **An exact-price target with impossible shares** must still fail with `too-many-shares` and never fall through to the nearest rung on another bucket. Existing test `an exact target match with impossible shares fails loudly…` stays green unchanged.
4. **A Telegram outage on the attribution message** must not fail the booking and must not suppress the sibling-cancel message that follows. Pinned in Task 2, `a failing attribution notice still lets the sibling notices through`.
5. **An unambiguous fill** (only one bucket's leg qualifies) sends no attribution message. Pinned in Task 2, and also by the unchanged E2E step `checkStopBooking` in `scripts/e2e-cutloss.ts`, which asserts exactly one push.

---

### Task 1: Shared booking fakes + bounded order read (#45)

**Files:**
- Create: `apps/server/test/booking-fakes.ts` (move `serializeState`, `rehydrate`, `fakeRepos` out of `apps/server/test/booking.test.ts:16-164`)
- Modify: `apps/server/test/booking.test.ts` (import from `./booking-fakes`), and the six importers of `./booking.test`: `vision-review.test.ts`, `rebooking.test.ts`, `capture-image.test.ts`, `recalc.test.ts`, `run-lock-writers.test.ts`, `corrections.test.ts`
- Modify: `apps/server/src/domain/booking.ts:36` (`RepoSurface.orderRepo` gains `listForRunFrom`), `:137-138` (use it)
- Modify: `apps/server/src/db/repos.ts:110-113` (real `listForRunFrom`)
- Modify fakes: `apps/server/test/booking-fakes.ts`, `apps/server/test/http-fakes.ts:58`, `apps/server/test/day.test.ts:42`, `apps/server/test/wire.test.ts` (base fake and the `setupSell` override at `:779-788`), plus any other fake `tsc` reports
- Test: `apps/server/test/booking.test.ts`, `apps/server/test/db.test.ts`

**Interfaces:**
- Produces: `orderRepo.listForRunFrom(runId: number, fromDate: string): Promise<OrderRow[]>`, which returns every order of the run with `tradeDate >= fromDate`, in all statuses, sorted by id ascending.
- Produces: `apps/server/test/booking-fakes.ts` exporting `fakeRepos()` (unchanged behaviour). Task 2 adds the notifier helpers to it.

- [ ] **Step 1: Move `fakeRepos` and its two helpers verbatim into `booking-fakes.ts`. Repoint `booking.test.ts` and the six importers to `./booking-fakes`.**
- [ ] **Step 2: Run `bun test apps/server/test`.** Expected: the same pass count as on `main`, with each booking test now running once instead of seven times. Commit `test: move booking fakes into a shared non-test module`.
- [ ] **Step 3: Write the failing tests.**
  - `booking.test.ts`, in `describe('sell matching with target and stop legs')`, test `a sell reads only the orders from its fill date onwards`. Wrap `f.repos.orderRepo` so that `listForRun` throws `'unbounded-read'` and `listForRunFrom` records its arguments. Book `sell(runId, 10, '96.50', deps)` against `held1`/`pair` (move those two fixtures up from the notifier `describe` so both blocks share them). Expect the calls to equal `[[runId, D]]` and the fill to be booked in bucket 1.
  - `db.test.ts` (self-skipping like its neighbours), test `orderRepo.listForRunFrom bounds by trade date and run`. Insert orders for `runId` on `2026-11-09`, `2026-11-10` and `2026-11-11`, plus one order on another run dated `2026-11-10`. Expect `listForRunFrom(runId, '2026-11-10')` to return the trade dates `['2026-11-10', '2026-11-11']`, in id order.
- [ ] **Step 4: Run `bun test apps/server/test/booking.test.ts -t "from its fill date"`.** Expected: FAIL with `unbounded-read`.
- [ ] **Step 5: Implement `listForRunFrom` in `repos.ts`.** Use `and(eq(runId), sql\`${s.orders.tradeDate} >= ${fromDate}\`)` with `.orderBy(s.orders.id)`. Add it to `RepoSurface.orderRepo`. Switch `bookUnlocked`'s sell branch to `listForRunFrom(input.runId, input.filledOn)` and update the comment at `:137`. Add `>=` implementations to every fake. Run `bun run typecheck` to find any fake you missed.
- [ ] **Step 6: Run `bun test apps/server/test` and `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db.test.ts`.** Expected: all pass, including `a prior-day fill that empties the bucket also pulls and announces today legs`. Run `bun run typecheck`. Expected: exit 0.
- [ ] **Step 7: Commit** `fix: bound the sibling-cancel order read to the fill date onwards (#45)`.

### Task 2: Nearest-price matching, attribution notice, required notifier (#43, #48)

**Files:**
- Modify: `apps/server/src/domain/sell-match.ts` (new rung and return type)
- Rename: `apps/server/src/domain/sibling-notify.ts` → `apps/server/src/domain/booking-notify.ts`
- Modify: `apps/server/src/domain/booking.ts` (`BookingDeps`, `FillBookingDeps`, `runBooking`, `bookUnlocked`, `manualFill`), `apps/server/src/domain/confirm-pending.ts`
- Rename: `apps/server/src/wire/sibling-notifier.ts` → `apps/server/src/wire/booking-notifier.ts`
- Modify: `apps/server/src/http/booking-deps.ts`, `apps/server/src/wire/capture.ts:192-196`, `packages/telegram/src/i18n.ts`
- Create: `apps/server/test/sell-attribution.test.ts`
- Modify tests: `booking.test.ts` (matchSellOrder unit tests, `notifySiblingCancelled` call sites, `runBooking` return value), `vision-review.test.ts:287`, `http-sibling-notify.test.ts`, `wire.test.ts`, `packages/telegram/test/digest.test.ts`, `apps/server/test/booking-fakes.ts`

**Interfaces:**
- Consumes: `listForRunFrom` and `booking-fakes.ts` from Task 1.
- Produces (`sell-match.ts`):
  ```ts
  export type LegKind = 'sell_loc' | 'stop_sell'
  export interface SellLeg { orderId: number; bucketIdx: number; kind: LegKind; limitPrice: bigint; distance: bigint } // distance = |fill price - limitPrice|
  export interface SellAttribution { shares: number; price: bigint; chosen: SellLeg; alternatives: SellLeg[] } // alternatives non-empty, nearest first
  export interface SellMatch { order: OrderRow; attribution: SellAttribution | null }
  export function matchSellOrder(orders: OrderRow[], state: RunState, input: SellFillKey): SellMatch | null
  ```
- Produces (`booking-notify.ts`):
  ```ts
  export interface BookingNotifier {
    siblingCancelled(runId: number, order: OrderRow): Promise<void>
    sellAttributed(runId: number, attribution: SellAttribution): Promise<void>
  }
  export interface BookedOutcome { cancelledIds: number[]; attribution: SellAttribution | null }
  export function notifyBookingOutcome(runId: number, outcome: BookedOutcome, deps: { repos: { orderRepo: { get(id: number): Promise<OrderRow | null> } }; notify: BookingNotifier }): Promise<void>
  ```
- Produces (`booking.ts`): `BookingDeps = { repos; today }` loses `notifySiblingCancelled`. `export interface FillBookingDeps extends BookingDeps { notify: BookingNotifier }`. `runBooking(input, deps: FillBookingDeps): Promise<BookedOutcome>`, `bookUnlocked(input, deps: BookingDeps): Promise<BookedOutcome>`, `manualFill(..., deps: FillBookingDeps)`. `confirmPendingFill(..., deps: FillBookingDeps, ...)` lives in `confirm-pending.ts`. `booking.ts` re-exports `BookingNotifier`, `BookedOutcome` and `SellAttribution`.
- Produces (`wire/booking-notifier.ts`): `export interface BookingNotifierDeps` (the current `SiblingNotifierDeps` renamed, same fields: `repos.notificationRepo.insert`, `allowedChatIds`, `send`, `lang`) and `makeBookingNotifier(deps: BookingNotifierDeps): BookingNotifier`.
- Produces (`booking-fakes.ts`): `silentNotifier: BookingNotifier` and `recordingNotifier(): { notify: BookingNotifier; siblings: Array<{ runId: number; order: OrderRow }>; attributions: Array<{ runId: number; attribution: SellAttribution }> }`.

**Matching rule.** This replaces the header comment of `matchSellOrder`.
- **1a (unchanged):** an open `sell_loc` with `limitPrice === price`, read from `onDay` with no shares gate.
- **1b "nearest":** over `live`, collect every `sell_loc` with `price >= limitPrice` and every `stop_sell` with `price <= limitPrice`. Sort by `distance` ascending, then `sell_loc` before `stop_sell`, then `bucketIdx` ascending. The first entry wins.
- **1c:** `market_sell`, lowest `bucketIdx`.
- `attribution` is non-null only on rung 1b, and only when admissible legs exist on other buckets. Those legs, kept in the same sort order, are the `alternatives`.
- The header comment must also say why the old per-kind precedence was wrong across buckets: in the #43 scenario, a 96.50 stop fill was booked to another bucket's 91.00 target.

- [ ] **Step 1: Write the failing tests.** Put them in `apps/server/test/sell-attribution.test.ts`, using `fakeRepos` and `recordingNotifier`, with D = `2026-11-12`. Reuse the `setup(held, ords)` shape from `booking.test.ts:1213`; copy it into the new file rather than exporting it.
  - `a stop fill below another bucket's target books to the nearest leg (issue #43)`: held 0 (10 @ 100.00) and 9 (10 @ 88.00); orders 0 `sell_loc` 103.00 / `stop_sell` 97.00, 9 `sell_loc` 91.00 / `stop_sell` 85.40; sell 10 @ 96.50. Expect: fill bucket 0; bucket 0 `stop_sell` filled; bucket 0 `sell_loc` cancelled with reason `broker-filled`; bucket 9 legs both open; `attributions` = `[{ runId, attribution: { shares: 10, price: parseUsd('96.50'), chosen: { bucketIdx: 0, kind: 'stop_sell', limitPrice: parseUsd('97.00'), distance: parseUsd('0.50') }, alternatives: [{ bucketIdx: 9, kind: 'sell_loc', limitPrice: parseUsd('91.00'), distance: parseUsd('5.50') }] } }]` (match with `toMatchObject`; `orderId`s equal the inserted ids); `siblings` lists the bucket 0 `sell_loc`.
  - `equidistant target and stop resolve to the target`: same book, sell 10 @ 94.00. Expect bucket 9 `sell_loc` filled; `chosen.kind` `'sell_loc'`, distance `parseUsd('3.00')`; one alternative, bucket 0 `stop_sell`, distance `parseUsd('3.00')`.
  - `a target near the fill beats a loose stop on another bucket`: the existing reviewer scenario (bucket 0 stop 97.00, bucket 9 target 91.00, fill 91.50). Expect bucket 9, `chosen.distance` `parseUsd('0.50')`, alternative bucket 0 `stop_sell` distance `parseUsd('5.50')`.
  - `an unambiguous fill sends no attribution notice`: held 1 only, `pair`, sell 10 @ 96.50. Expect `attributions` `[]` and `siblings` of length 1.
  - `alternatives list every other admissible bucket, nearest first`: held 0, 1 and 2 at 100.00, 96.00 and 110.00; targets 103.00, 99.00 and 113.00; stops 97.00, 93.00 and 106.00; sell 10 @ 100.00. Admissible legs: bucket 1 target (1.00) and bucket 2 stop (6.00). Bucket 0's target needs ≥ 103.00 and its stop ≤ 97.00, so it is not admissible. Expect chosen bucket 1 `sell_loc`, alternatives `[bucket 2 stop_sell distance 6.00]`.
  - `market_sell ties resolve to the lowest bucket regardless of insertion order` (#48 gap): held 2, 5 and 7; `market_sell` orders inserted in bucket order 7, 5, 2; sell 10 @ 50.00. Expect fill bucket 2 and `attributions` `[]`.
  - `a failing attribution notice still lets the sibling notices through`: #43 scenario with `notify = { ...rec.notify, sellAttributed: async () => { throw new Error('telegram-down') } }` and `console.error` spied. Expect: one fill; `siblings` length 1; `console.error` called once.
  - `the attribution notice runs after the run lock is released`: mirror `booking.test.ts:1621`, but probe from `sellAttributed`.
  - `confirming a pending sell sends the attribution notice too`: the #43 scenario through `confirmPendingFill(pid, null, deps)`.
- [ ] **Step 2: Run `bun test apps/server/test/sell-attribution.test.ts`.** Expected: FAIL. The #43 test books bucket 9, and the tests that use `recordingNotifier` do not compile or run yet.
- [ ] **Step 3: Implement `matchSellOrder` returning `SellMatch | null` per the rule above.** Only the sort comparator is non-obvious:
  ```ts
  (a, b) => cmp(a.distance, b.distance) || kindRank(a.kind) - kindRank(b.kind) || a.bucketIdx - b.bucketIdx // kindRank: sell_loc 0, stop_sell 1
  ```
  Leave `openSellLegs` unchanged.
- [ ] **Step 4: Create `booking-notify.ts` (`git mv` from `sibling-notify.ts`).** `notifyBookingOutcome` first sends `attribution` (if any) through `notify.sellAttributed`, then each cancelled id through `notify.siblingCancelled` (lowest id first, as today). Each call gets its own try/catch that calls `console.error('booking notification failed:', runId, …)`.
- [ ] **Step 5: Update `booking.ts`.**
  - `bookUnlocked` returns `{ cancelledIds, attribution: match?.attribution ?? null }`, which is `null` for buys and fallbacks.
  - `runBooking` returns the outcome after `notifyBookingOutcome`.
  - `manualFill` and the types above change as listed in Interfaces.
  - To keep the file under 300 lines, move `rollStale`, `CANCEL_REASONS` and `cancelOrder` (`:243-265`) into `apps/server/src/domain/order-ops.ts`. Re-export them from `booking.ts` so every importer stays unchanged.
  - Update `confirm-pending.ts` the same way: the lock returns `BookedOutcome`, then call `notifyBookingOutcome`.
- [ ] **Step 6: Add the Telegram copy to `packages/telegram/src/i18n.ts`, next to `sibling-cancelled`.**
  - `'leg-sell_loc': { en: 'target', ko: '목표가 매도' }`
  - `'leg-stop_sell': { en: 'stop', ko: '손절 매도' }`
  - `'sell-attributed-alt': { en: 'bucket {bucket} {leg} (${limit}, ${distance} away)', ko: '버킷 {bucket} {leg} (${limit}, ${distance} 차이)' }`
  - `'sell-attributed'`:
    - en: `'ℹ️ Sell {shares} sh @ ${price} was booked to bucket {bucket} {leg} (${limit}, ${distance} away). Also possible: {alts}. A target fills at or above its limit and a stop at or below its trigger, so more than one order fit this price; the order whose price is nearest the fill wins.'`
    - ko: `'ℹ️ 매도 {shares}주 @ ${price} 체결을 버킷 {bucket} {leg} (${limit}, ${distance} 차이)에 기록했습니다. 다른 후보: {alts}. 목표가 매도는 지정가 이상에서, 손절 매도는 발동가 이하에서 체결되므로 이 가격에 해당하는 주문이 여러 개였고, 체결가에 가장 가까운 주문을 선택했습니다.'`
  - Alternatives are joined with `'; '`.
- [ ] **Step 7: Rename `wire/sibling-notifier.ts` → `wire/booking-notifier.ts` (`git mv`) and export `makeBookingNotifier`.**
  - Both methods share one per-chat broadcast loop: insert a notification row, then send. A failing chat is logged and does not stop the others, same as today.
  - `siblingCancelled` keeps the existing `sibling-cancelled` text byte-for-byte.
  - `sellAttributed` renders `sell-attributed`, filling `{alts}` from `sell-attributed-alt` and `{leg}` from `leg-<kind>`, with all prices passed through `formatUsd`.
  - Wire it into `http/booking-deps.ts` (`notify: makeBookingNotifier(...)`) and `wire/capture.ts` `onConfirm`.
- [ ] **Step 8: Run `bun run typecheck` and fix every site it reports.**
  - Deps passed to `runBooking`, `manualFill` or `confirmPendingFill` gain `notify: silentNotifier`. Sites that used `notifySiblingCancelled` get `notify: { ...silentNotifier, siblingCancelled: … }`. In `booking.test.ts`, `withNotifier` becomes a `siblingCancelled` override of the same kind.
  - Callers of `runBooking`'s result read `.cancelledIds`.
  - Update the `matchSellOrder` unit tests at `booking.test.ts:1688-1719` to read `?.order.id` / `?.order.bucketIdx`.
  - Rename `a target fill above its limit books to the highest qualifying target, not a loose stop` to `… books to the nearest leg, not a loose stop`, and `a target fill outranks a stop that also qualifies on price` to `a target nearer the fill outranks a looser stop`. Their assertions stay unchanged.
- [ ] **Step 9: Add copy and route-level tests.**
  - `packages/telegram/test/digest.test.ts`, test `sell-attributed explains the nearest-price choice in both languages`: render the #43 values through `t` and assert the exact en and ko strings from Step 6, with `{alts}` = `bucket 9 target ($91.00, $5.50 away)` (en) and `버킷 9 목표가 매도 ($91.00, $5.50 차이)` (ko).
  - `http-sibling-notify.test.ts`, test `an ambiguous manual sell records and sends the attribution notice before the sibling notice`. `createRun` seeds buckets in order, so bucket 0 gets 10 @ 100.0000 and bucket 1 gets 10 @ 88.0000. Insert the #43 orders on buckets 0 and 1 (0: 103.00 / 97.00, 1: 91.00 / 85.40) and POST a sell of 10 @ 96.50. Expect `f.sent` texts for chat `'42'` to be `[<sell-attributed en, alts "bucket 1 target ($91.00, $5.50 away)">, <sibling-cancelled for sell_loc bucket 0 (103.00)>]`, and `f.notifications` to hold the same two rows with `runId: id`.
  - `wire.test.ts`: in the `setupSell` override, also set `listForRunFrom`. Assert that the existing tests still pass unchanged; they are unambiguous, so no attribution text is sent.
- [ ] **Step 10: Run `bun test` and `bun run typecheck`.** Expected: all green, exit 0.
- [ ] **Step 11: Commit** `fix: attribute ambiguous sell fills to the nearest order price and explain the choice (#43)`.

### Task 3: Spec record, verification, PR

**Files:**
- Modify: `docs/superpowers/specs/2026-11-16-cut-loss-and-sim-drafts-design.md`, section "Booking a stop fill" (table at `:223-232` and the safety paragraph at `:234-240`) and Tests bullet at `:511-518`
- Modify: `AGENTS.md` repo map: `domain/sibling-notify.ts` → `domain/booking-notify.ts`, add `domain/order-ops.ts` and `domain/sell-match.ts` if missing, and `wire/sibling-notifier.ts` → `wire/booking-notifier.ts`

- [ ] **Step 1: Update the spec.**
  - Replace the table with 1a / 1b nearest / 1c `market_sell` / fallback, as defined in Task 2.
  - Add a dated paragraph, "Amended 2026-11-18 (#43)". It explains the cross-bucket collision with the 96.50 / 97.00 / 91.00 example, the tie-break ruling, and the attribution notice. The notice goes to the Notifications tab and Telegram, is sent only when another bucket's leg was admissible, and carries the copy keys from Task 2.
  - Fix the Tests bullet so it names the nearest-leg tests.
- [ ] **Step 2: Update `AGENTS.md`.** Run `bun test` and `bun run typecheck`. Expected: green.
- [ ] **Step 3: Run `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test`, then `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`.** Expected: all pass. `checkStopBooking` must still see exactly one push, because the 173.21 fill is unambiguous.
- [ ] **Step 4: Commit** `docs: record nearest-price sell attribution in the cut-loss spec`.
- [ ] **Step 5: Open the PR.** Body: `Closes #43, closes #45`; for #48, list the two bullets handled here ("notifySiblingCancelled optional", "market_sell tie-break untested"). Close #46 separately as already fixed by #49 (`apps/server/src/wire/capture.ts:23`, `apps/server/test/wire.test.ts:575`).
