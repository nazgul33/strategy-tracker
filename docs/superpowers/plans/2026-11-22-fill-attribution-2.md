# Fill attribution 2 and bucket override (plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Book every sell fill to the bucket that really sold (same-close exits, late captures, second partials, market sells), tell the operator when it was a judgement call, and let the operator force the bucket on a manual fill or a pending confirm.

**Architecture:** `apps/server/src/domain/sell-match.ts` becomes the one place that decides a sell's bucket: the combined matching rule (pool of open and stale legs on the fill day, shares gate, exact-price rung, exact-share rung, nearest price, market sell), the fallback moved in from `booking.ts`, and the forced-bucket path. `bookUnlocked` only flips the matched order when the fill empties its bucket. The attribution notice gains the rule that decided and market-sell legs. The web gets one shared `BucketSelect` used by the manual fill dialog and the pending row; `GET /api/pending` carries each row's held buckets.

**Tech Stack:** Bun + TypeScript, Hono, React (happy-dom tests), `bun:test`.

**Spec:** GitHub issues #52, #53, #54, #55, #57 and the attribution parts of #58; binding rulings 1 to 5 in `docs/superpowers/decisions/2026-11-22-followup-issues.md`; amends `docs/superpowers/specs/2026-11-16-cut-loss-and-sim-drafts-design.md` section "Booking a stop fill".
**Models:** implementer subagents run on anthropic/claude-sonnet-5-5; per-task reviewers, the whole-branch reviewer and any plan amendments run on anthropic/claude-opus-5-5.
**Branch:** fix/followup-issues, shared by plans A to E, executed in order A, B, C, D, E. Code may have moved by the time this plan runs: locate by symbol, not line.

## Global Constraints

- English only in code, comments, docs and commit messages (the Korean in this plan's copy tables is catalog content, to be pasted verbatim); Korean only in `packages/telegram/src/i18n.ts`, `apps/web/src/i18n/ko.json` and in tests that pin those strings. Never Chinese or Cyrillic characters.
- All user-facing copy via the en/ko catalogs; `apps/web/src/i18n/{en,ko}.json` keep their keys in `localeCompare` order and expose the same keys (pinned by `apps/web/src/catalog.test.ts`).
- Money is bigint myriadths (`@st/core/money`), never float; fees in integer cents.
- No source file over ~300 lines; split by responsibility. `apps/server/src/domain/booking.ts` is at 284 lines: this plan moves the sell bucket choice out of it, it must not grow.
- `packages/*` never import `apps/*`. `fetch` stays injectable.
- Commit style `feat|fix|docs|test|refactor|chore:`; one commit per task at least.
- Do not touch `broadcast`, `siblingCancelled` or the per-chat failure log in `apps/server/src/wire/booking-notifier.ts` (plan B owns them); this plan changes only the `sellAttributed` rendering there.
- Repository typing (`RepoSurface` `any`s, #67) is plan E: do not retype `RepoSurface` here.

## Review Focus

1. Several targets filling at one close, confirmed in any order (the strategy's normal exit): every fill lands in its own bucket and none fails `no-bucket-for-sell`. Pinned in Task 2 (two buckets both orders, three buckets all six orders).
2. A fill dated yesterday confirmed after the morning roll, where a bucket was emptied since: a stale exact-price leg on the emptied bucket must not throw `bucket-not-held`; the fill books to the bucket that can hold it. Pinned in Task 2.
3. A forced bucket that is empty, too small, out of range, or given on a buy: a 422 with a code the web localizes, and nothing is persisted (no fill, no ledger row, no order flip, pending row still pending). Pinned in Task 3 (domain) and Task 4 (HTTP).
4. The global Pending page showing rows from two runs: each row offers only its own run's held buckets. Pinned in Task 4 (server, per run) and Task 5 (web).
5. A bucket chosen, then the side switched to buy: no `bucketIdx` is sent (manual dialog and pending row), so the buy books normally. Pinned in Task 5.

## The combined matching rule (after this plan)

This text is the new header comment of `matchSellOrder` (Task 2 writes it) and, in prose, the spec amendment (Task 6).

- **Pool.** Orders of this run, dated on the fill's trade date, of a sell-side kind (`sell_loc`, `stop_sell`, `market_sell`), with status `open` or `stale`. `filled` and `cancelled` orders never take part. A `stale` order is one whose day ended without a booked fill, which is what a late-captured fill is (ruling 2).
- **Gate.** A pool order passes when its bucket is not `empty` and holds at least `fill.shares`.
- **Admissible.** A gated order that fits the price: `sell_loc` when `price >= limitPrice`, `stop_sell` when `price <= limitPrice` (the trigger), `market_sell` at any price.
- **Rungs, first hit wins:**
  1. **Exact price.** The exact-price legs are the **open** `sell_loc` orders of the pool with `limitPrice === price` (stale orders never take this rung: a stale leg on a bucket emptied since would throw for a fill that belongs elsewhere). Among the exact-price legs whose bucket passes the gate, the one with `shares === fill.shares` wins when there is exactly one such leg, else the lowest bucket. If exact-price legs exist but none passes the gate, the lowest-bucket one is returned anyway, so an exact-price print its bucket cannot cover fails loudly in `applySellFill` (`too-many-shares` / `bucket-not-held`) instead of landing in another bucket. An exact-price print is the strongest signal there is.
  2. **Shares** (ruling 1). Only when rung 1 found no exact-price leg at all: exactly one admissible order has `shares === fill.shares` (targets, stops and market sells together; open, or stale on the fill day): that order. None or several: next rung.
  3. **Nearest.** Admissible `sell_loc` and `stop_sell` together: smallest `|price - limitPrice|`, then `sell_loc` before `stop_sell`, then lowest `bucketIdx`.
  4. **Market.** The lowest-bucket admissible `market_sell`.
  5. **Fallback** (no order matched): the lowest non-empty bucket holding at least `fill.shares`, no order flipped; none: `no-bucket-for-sell`.
- **Attribution.** The admissible orders on buckets other than the chosen one; price legs in rung-3 order, then market sells by bucket. Non-empty and the leg was chosen by rung 1, 3 or 4: the match carries an attribution with the rule that decided (`price` for rungs 1 and 3, `market` for rung 4). A leg chosen by rung 2 (share count) carries none: the fill is not ambiguous in practice, and a normal multi-target exit would otherwise send a notice for every fill but the last. The fallback carries none.
- **Flip** (ruling 3, in `bookUnlocked`). The matched order flips to `filled` only when the fill empties its bucket; a partial fill leaves it as it was (`open` or `stale`), so the rest of that leg stays a candidate. An emptying fill also cancels every other `open` sell-side order of that bucket and run dated on or after the fill's trade date (`openSellLegs`, unchanged), whichever rung or the fallback chose the bucket.
- **Forced bucket** (ruling 5, Task 3). With `bucketIdx` given, matching is skipped: the bucket is the operator's, validated by `applySellFill`. The order flipped (on emptying) is that bucket's pool order that fits the price, chosen by these rungs restricted to that bucket (exactly one leg with `shares === fill.shares`, then nearest price with target before stop, then market), with no gate; none fits: nothing flips. No attribution.

**How the interactions resolve (each pinned by a Task 2 test):**

- Stale leg, exact price, bucket emptied since: never in rung 1; rung 2, rung 3 or the fallback decides (test "a stale exact-price target on a bucket emptied since is not read without the gate").
- Stale leg, exact price, bucket too small: skipped; the same fixture with an open leg fails `too-many-shares` (test "a stale exact-price target that cannot cover the fill is skipped, where an open one fails loudly").
- Partially filled target that stays open, a later fill at its exact price too big for what is left, another bucket at that price fits: rung 1 prefers the gated leg (test "after a partial, a same-price fill too big for what is left goes to the other bucket at that price"). Without the "gated first" half of rung 1 this case would regress to a 422, because before ruling 3 the partially filled order was `filled` and invisible.
- Partially filled target, later fill at its exact price too big for what is left, no other bucket at that price: still fails loudly (test "a partially filled exact-price target still fails loudly when no bucket at that price can cover the fill").
- Rung 1 before rung 2: an open exact-price target whose bucket cannot cover the fill still fails loudly, even when another bucket's admissible leg has exactly the fill's size (existing test "an exact target match with impossible shares fails loudly instead of landing elsewhere", unchanged).
- Two buckets with the same exact-price target, only one leg sized like the fill: that bucket wins, not the lowest one (test "on a shared exact-price target the leg sized like the fill wins").

## Already done

- #53 "a prior-day fill that empties the bucket also pulls today's legs": the `>= fromTradeDate` cancel exists (`openSellLegs` in `apps/server/src/domain/sell-match.ts`, test "a prior-day fill that empties the bucket also pulls and announces today legs" in `apps/server/test/booking.test.ts`). Only the realistic stale fixture is missing; Task 2 adds it.

No other item of #52, #53, #54, #55, #57 or the attribution parts of #58 is fixed on this branch (`git log` at `42795c3`; `matchSellOrder` still filters `status === 'open'`, `bookUnlocked` still flips on every fill, no `bucketIdx` input exists).

## Not in this plan

- #57 moving an already booked fill to another bucket: out of scope by ruling 5 (delete and re-book through the fill edit path).
- #57 recording on the fill that its bucket was forced: ruling 5 (no new column).
- #57 "the attribution notice could say how to correct it": deleting the fill and re-booking with a bucket does not restore the orders the first booking flipped or cancelled, so a one-line hint would oversell the remedy; left until a real re-attribution path exists.
- #52 a partial fill whose share count happens to equal another bucket's leg size books to that bucket: the accepted cost of ruling 1 (no notice is sent for a share-count pick, controller ruling).
- #55 ranking a `market_sell` above a nearer price leg when share counts do not decide: ruling 4 keeps price ranking unchanged.
- #58 the attribution and sibling-cancel messages do not name run or ticker, and use different words for one leg: plan B.
- #58 Korean text is machine-written: #50 (needs a human reader); the new Korean strings here carry the same caveat.
- #58 `allowedChatIds` optional, per-chat failure log label, `orders` index, `RepoSurface.orderRepo.listForRunFrom` typing, `silentNotifier` on fixtures that never book: plans B, C and E (not attribution items).
- #58 `apps/server/test/db.test.ts` "orderRepo.listForRunFrom bounds by trade date and run" cannot fail without `.orderBy`: it can only start to fail once an index makes the scan order differ from id order, so it belongs with plan C's `orders(run_id, trade_date)` index migration.

## Decisions for human review

- The exact-price rung stays first (controller ruling): among open exact-price targets whose bucket can cover the fill, the one sized like the fill wins, else the lowest bucket; if none can cover it, the lowest one is returned so the booking fails with `too-many-shares` as today. The exact-share rung (ruling 1) applies only when no open exact-price target exists. Cost: an exact-price print with shares its bucket cannot cover still needs the operator, even when another bucket's leg has exactly that size.
- The "gated first" half of the exact-price rung is needed because ruling 3 keeps partially filled legs open; without it a second fill at a shared target price would 422. Cost if wrong: none found.
- Stale legs never take the exact-price rung (issue #53 asks for this). Cost: a late fill at a stale leg's exact price that the bucket cannot cover books elsewhere instead of failing loudly.
- The share rung compares the fill to the order's `shares` (the ruling's words), not to what the bucket still holds; "exactly one" counts legs, not buckets. In production a bucket has at most one admissible leg per day (target and stop are disjoint, `market_sell` only on force-sell buckets), so both readings agree. Cost: a hand-built fixture with two fitting legs on one bucket falls through to price distance.
- **[REVIEW]** No attribution notice when the exact share count decided (controller ruling): a normal multi-target exit sends none. A notice is sent only when another bucket had an admissible leg and the leg was chosen by the exact-price rung, by price distance, or by a market sell. Cost: a share-count pick that is wrong (ruling 1's cost case) is not announced.
- **[REVIEW]** The notice copy is restructured: the chosen leg is rendered like an alternative, and one of two closing sentences explains the rule that decided (price, with the full order and tie order spelled out; market). `SellAttribution` gains `rule: 'price' | 'market'`.
- **[REVIEW]** A fill matched by the market-sell rung now sends a notice when another bucket also had an admissible leg (for example two force-sold buckets on one day). Ruling 4 lists market legs as alternatives; the notice for a market-chosen fill follows from it.
- The forced-bucket path considers that bucket's `open` and `stale` orders on the fill day (ruling 5 says "open leg"; ruling 2 makes stale legs candidates, and a forced late fill should flip the same leg an automatic one would). Cost: a stale order shows `filled`.
- A late buy flips a `stale` `buy_loc` dated on its fill day, as #53 asks for consistency. Cost: the orders table shows `filled` instead of `stale` for that day.
- Errors: a `bucketIdx` that is not a non-negative integer, or one sent with a buy, is `invalid-bucket` (422 on both routes, like `invalid-shares` and `invalid-side` today); a bucket past the run's bucket count is the existing `bucket-not-found` (422). Cost: a client expecting 400 gets 422.
- **[REVIEW]** `GET /api/pending` rows gain `heldBuckets: { index, shares }[]` (one bucket-state read per distinct run, alongside the existing run read), so the global Pending page can offer each row its own run's buckets.
- A bucket chosen on a pending row is not a vision correction: it does not open the keep/discard screenshot prompt and is not written to the vision review record.
- The selector option reads "Bucket N · S sh" (existing `bucketLabel` and `bucketShares` keys); a chosen bucket that is no longer held after a reload stays selected (shown as "Bucket N") and the server answers `bucket-not-held`, rather than silently reverting to Automatic.

## Issue closing

- #52: closed by this plan.
- #53: closed by this plan (sell path, realistic stale fixture, buy-path consistency).
- #54: closed by this plan.
- #55: closed by this plan (notice and share rung; price ranking deliberately unchanged per ruling 4).
- #57: partly: moving an already booked fill and recording a forced bucket stay out (ruling 5); the correction hint in the notice is left (see Not in this plan).
- #58: partly: this plan does the tie wording, `toLeg` cast and `live.find(...)!`, the attribution test-strictness items except the `db.test.ts` one, and the spec wording items; the rest is plans B, C, E.

## Existing tests whose expectation changes (deliberately)

| File | Test | New expectation | Task |
| --- | --- | --- | --- |
| `apps/server/test/booking.test.ts` | "(d) sell" | partial 5 of 10: bucket 1's `sell_loc` stays `open` | 2 |
| `apps/server/test/booking.test.ts` | "market_sell matching" | partial 4 of 10: the `market_sell` stays `open` | 2 |
| `apps/server/test/booking.test.ts` | "a stale stop order never matches" | renamed "a stale stop dated on the fill day matches like an open one": fill in bucket 3, stop `filled` | 2 |
| `apps/server/test/booking.test.ts` | "a partial stop fill cancels nothing and still flips its own order to filled" | renamed "a partial stop fill cancels nothing and leaves its own order open": stop `open` | 2 |
| `apps/server/test/booking.test.ts` | "the sibling cancel only touches the filled bucket, its own trade date and open orders" | unchanged result; the fixture comment "already filled by an earlier partial fill" becomes "already filled, so not open" | 2 |
| `apps/server/test/booking.test.ts` | "a sell reads only the orders from its fill date onwards" | fixture gains an earlier-dated open order; asserts the rows the read returned are all on or after `D` and the earlier order stays `open` | 2 |
| `apps/server/test/booking.test.ts` | `matchSellOrder` "returns null for an empty bucket, a wrong run, a wrong date and a non-open status" | `stale` moves out of the null list into a new test (below) | 2 |
| `apps/server/test/booking.test.ts` | `matchSellOrder` "an exact-price target is returned even when its bucket cannot cover the fill" | adds: a `stale` exact-price target on the empty bucket 0 returns `null` | 2 |
| `apps/server/test/sell-attribution.test.ts` | "a stop fill below another bucket's target books to the nearest leg (issue #43)" | attribution also matches `rule: 'price'` | 2 |
| `apps/server/test/sell-attribution.test.ts` | "two other admissible buckets are listed nearest first, whatever the insertion order" | bucket 1 buys at 88.00 with target 90.00: alternatives `[bucket 2 stop 102.00 (5.50), bucket 1 target 90.00 (6.50)]` | 2 |
| `apps/server/test/sell-attribution.test.ts` | "market_sell ties resolve to the lowest bucket regardless of insertion order" | renamed "... and list the other market sells": one attribution, `rule: 'market'`, chosen bucket 2, alternatives buckets 5 then 7 | 2 |
| `apps/server/test/booking-notifier.test.ts` | fixture `attribution` and `text` | fixture gains `rule: 'price'`; `text` is the new copy | 1 |
| `packages/telegram/test/digest.test.ts` | "sell-attributed explains the nearest-price choice in both languages" | rewritten for the new params and copy (en and ko) | 1 |
| `apps/server/test/http-sibling-notify.test.ts` | "an ambiguous manual sell records and sends the attribution notice before the sibling notice" | `attributed` is the new copy | 1 |

`scripts/e2e-cutloss.ts` `checkStopBooking` asserts exactly one push after the 30-share fill at 173.21. Under the new rule that fill has one admissible leg (bucket 1's stop; bucket 0's stop at 172.25 does not fit 173.21, its target was cancelled earlier, bucket 1's target is far above), so the share rung picks it (no exact-price target exists), there is no other bucket to list, and no attribution notice is sent (a share-count pick never sends one). The emptying fill still flips the stop and cancels bucket 1's target. **No change to the e2e assertions**; Task 6 runs the smoke to confirm.

If any test outside this table fails after a task, stop and report which rung or which flip change caused it; do not update its expectation without that analysis.

---
## File map

| File | Change | Task |
| --- | --- | --- |
| `apps/server/src/domain/sell-match.ts` | leg union, `rule`, combined rule, `{ order, leg }` pairs, fallback moved in (`pickSellBucket`), forced bucket (`matchForcedLeg`) | 1, 2, 3 |
| `packages/telegram/src/i18n.ts` | `sell-attributed` restructured, `sell-attributed-alt-market`, `leg-market_sell`, two `sell-attributed-why-*` (price, market) | 1 |
| `apps/server/src/wire/booking-notifier.ts` | `sellAttributed` renders market legs and the rule sentence (nothing else) | 1 |
| `apps/server/src/domain/booking.ts` | sell branch calls `pickSellBucket`; flip only on emptying; buy flips a stale `buy_loc`; `BookInput.bucketIdx`, `manualFill` `bucketIdx`, `invalid-bucket` | 2, 3 |
| `apps/server/src/domain/confirm-pending.ts` | `ConfirmOverrides.bucketIdx` passed to `bookUnlocked` | 3 |
| `apps/server/src/http/routes/pending.ts` | `GET /pending` rows carry `heldBuckets` | 4 |
| `apps/server/src/http/routes/runs.ts` | none (the body already reaches `manualFill`); pinned by Task 4 tests | 4 |
| `apps/web/src/api.types.ts`, `apps/web/src/api.ts`, `apps/web/src/viewmodels.ts` | `HeldBucketDto`, `heldBuckets`, `bucketIdx` on both inputs, `heldBucketsOf` | 5 |
| `apps/web/src/components/forms/BucketSelect.tsx` (new) | shared "Automatic + held buckets" select | 5 |
| `apps/web/src/components/forms/FillDialog.tsx`, `apps/web/src/pages/RunDetail.tsx` | selector in add mode when side is sell | 5 |
| `apps/web/src/components/forms/PendingRow.tsx`, `PendingTable.tsx` | bucket column, choice state, `bucketIdx` override | 5 |
| `apps/web/src/i18n/en.json`, `ko.json` | `fillBucket`, `fillBucketAuto`, `fillErr.bucket-not-found`, `fillErr.invalid-bucket`, `pendingColBucket` | 5 |
| `docs/superpowers/specs/2026-11-16-cut-loss-and-sim-drafts-design.md`, `AGENTS.md` | spec amendment and #58 wording; repo map | 6 |

New test files: `apps/server/test/sell-fixture.ts` (shared fixture, not a test), `apps/server/test/sell-matching.test.ts`, `apps/server/test/sell-bucket-override.test.ts`, `apps/server/test/http-bucket-override.test.ts`, `apps/web/src/components/forms/FillDialogBucket.test.tsx`, `apps/web/src/components/forms/PendingTableBucket.test.tsx`.

Other plans touch some of these files later (B: `booking-notifier.ts`, the `sell-attributed` copy; C: `pending.ts`, `runs.ts`, `confirm-pending.ts`; D: `PendingRow.tsx`, `FillDialog.tsx`). This plan runs first; they locate by symbol.

---

### Task 1: Attribution notice shape and copy (market legs, the deciding rule, tie wording)

No matching behaviour changes in this task: the matcher still emits only price legs and always `rule: 'price'`. It prepares the types and the copy Task 2 needs.

**Files:**
- Modify: `apps/server/src/domain/sell-match.ts` (types only; `attribute` sets `rule: 'price'`)
- Modify: `packages/telegram/src/i18n.ts` (keys next to `sell-attributed`)
- Modify: `apps/server/src/wire/booking-notifier.ts` (`legParams` and `sellAttributed` only; plan B edits this file after you)
- Test: `packages/telegram/test/digest.test.ts`, `apps/server/test/booking-notifier.test.ts`, `apps/server/test/http-sibling-notify.test.ts`

**Interfaces:**
- Produces (in `sell-match.ts`, replacing `LegKind` and the single-shape `SellLeg`):
  ```ts
  export type PriceLegKind = 'sell_loc' | 'stop_sell'
  // distance = |fill price - limitPrice|
  export interface PriceLeg { orderId: number; bucketIdx: number; kind: PriceLegKind; limitPrice: bigint; distance: bigint }
  export interface MarketLeg { orderId: number; bucketIdx: number; kind: 'market_sell' }
  export type SellLeg = PriceLeg | MarketLeg
  // price: the exact-price rung or price distance decided; market: the market-sell rung.
  // A share-count pick carries no attribution, so it has no rule value.
  export type AttributionRule = 'price' | 'market'
  export interface SellAttribution { shares: number; price: bigint; rule: AttributionRule; chosen: SellLeg; alternatives: SellLeg[] }
  ```
- Produces (catalog keys, `packages/telegram/src/i18n.ts`): `sell-attributed` with params `{shares, price, chosen, alts, why}`; `sell-attributed-alt` unchanged (`{bucket, leg, limit, distance}`); new `sell-attributed-alt-market` (`{bucket, leg}`), `leg-market_sell`, `sell-attributed-why-price`, `sell-attributed-why-market` (each `{shares}`).

Exact copy (en / ko):

| Key | en | ko |
| --- | --- | --- |
| `leg-market_sell` | `market sell` | `시장가 매도` |
| `sell-attributed-alt-market` | `bucket {bucket} {leg}` | `버킷 {bucket} {leg}` |
| `sell-attributed` | `ℹ️ Sell {shares} sh @ ${price} was booked to {chosen}. Also possible: {alts}. {why}` | `ℹ️ 매도 {shares}주 @ ${price} 체결을 {chosen}에 기록했습니다. 다른 후보: {alts}. {why}` |
| `sell-attributed-why-price` | `A target fills at or above its limit, a stop at or below its trigger and a market sell at any price, so more than one order fit this price. A target at exactly the fill price wins; otherwise the only order for exactly {shares} shares, if there is one; otherwise the order whose price is nearest the fill, a target before a stop at an equal distance, then the lowest bucket.` | `목표가 매도는 지정가 이상에서, 손절 매도는 발동가 이하에서, 시장가 매도는 어떤 가격에서도 체결되므로 이 가격에 해당하는 주문이 여러 개였습니다. 지정가가 체결가와 같은 목표가 매도가 우선하고, 없으면 정확히 {shares}주인 주문이 하나뿐일 때 그 주문이, 그것도 아니면 체결가에 가장 가까운 주문이 선택되며, 차이가 같으면 목표가 매도가 손절 매도보다 우선하고 그다음은 낮은 버킷이 우선합니다.` |
| `sell-attributed-why-market` | `No target or stop fit this price and no single order is for exactly {shares} shares, so the market sell of the lowest bucket wins.` | `이 가격에 맞는 목표가 매도나 손절 매도가 없고 정확히 {shares}주인 주문도 하나로 정해지지 않아 가장 낮은 버킷의 시장가 매도를 선택했습니다.` |

Below, `WHY_PRICE_10` is the en `sell-attributed-why-price` text with `{shares}` = `10`; declare it as a string constant in each test file that uses it.

- [ ] **Step 1: Rewrite the digest copy test**

In `packages/telegram/test/digest.test.ts` replace "sell-attributed explains the nearest-price choice in both languages" with "sell-attributed names the chosen leg, the alternatives and the deciding rule in both languages":

```ts
const leg = (lang: 'en' | 'ko', bucket: number, kind: string, limit: string, distance: string) =>
  t('sell-attributed-alt', lang, { bucket, leg: t(`leg-${kind}`, lang), limit, distance })
const render = (lang: 'en' | 'ko') => t('sell-attributed', lang, {
  shares: 10, price: '96.50', chosen: leg(lang, 0, 'stop_sell', '97.00', '0.50'),
  alts: leg(lang, 9, 'sell_loc', '91.00', '5.50'), why: t('sell-attributed-why-price', lang, { shares: 10 }),
})
expect(render('en')).toBe(`ℹ️ Sell 10 sh @ $96.50 was booked to bucket 0 stop ($97.00, $0.50 away). Also possible: bucket 9 target ($91.00, $5.50 away). ${WHY_PRICE_10}`)
expect(render('ko')).toBe('ℹ️ 매도 10주 @ $96.50 체결을 버킷 0 손절 매도 ($97.00, $0.50 차이)에 기록했습니다. 다른 후보: 버킷 9 목표가 매도 ($91.00, $5.50 차이). 목표가 매도는 지정가 이상에서, 손절 매도는 발동가 이하에서, 시장가 매도는 어떤 가격에서도 체결되므로 이 가격에 해당하는 주문이 여러 개였습니다. 지정가가 체결가와 같은 목표가 매도가 우선하고, 없으면 정확히 10주인 주문이 하나뿐일 때 그 주문이, 그것도 아니면 체결가에 가장 가까운 주문이 선택되며, 차이가 같으면 목표가 매도가 손절 매도보다 우선하고 그다음은 낮은 버킷이 우선합니다.')
```

Plus, in the same test: `t('sell-attributed-alt-market', lang, { bucket: 3, leg: t('leg-market_sell', lang) })` is `bucket 3 market sell` / `버킷 3 시장가 매도`; `t('leg-stop_sell', 'en')` is `stop`; `sell-attributed-why-market` with `{ shares: 10 }` equals the table text with 10 substituted, en and ko; and there is no `sell-attributed-why-shares` key (`t` returns the code itself).

- [ ] **Step 2: Update the notifier tests**

In `apps/server/test/booking-notifier.test.ts`: add `rule: 'price'` to the `attribution` fixture; `text` becomes `` `ℹ️ Sell 10 sh @ $96.50 was booked to bucket 0 stop ($97.00, $0.50 away). Also possible: bucket 1 target ($92.00, $4.50 away); bucket 2 stop ($102.00, $5.50 away). ${WHY_PRICE_10}` ``. Add to `describe('booking notifier: sellAttributed')`:

- "a market-sell alternative renders without a limit or distance": `{ shares: 10, price: 99.00, rule: 'price', chosen: { orderId: 21, bucketIdx: 5, kind: 'sell_loc', limitPrice: 98.50, distance: 0.50 }, alternatives: [{ orderId: 22, bucketIdx: 0, kind: 'sell_loc', limitPrice: 97.85, distance: 1.15 }, { orderId: 23, bucketIdx: 3, kind: 'market_sell' }] }` (prices via `parseUsd`) renders `` `ℹ️ Sell 10 sh @ $99.00 was booked to bucket 5 target ($98.50, $0.50 away). Also possible: bucket 0 target ($97.85, $1.15 away); bucket 3 market sell. ${WHY_PRICE_10}` ``.
- "the closing sentence follows the rule that decided": `rule: 'market'`, chosen `{ orderId: 31, bucketIdx: 2, kind: 'market_sell' }`, alternatives `[{ orderId: 32, bucketIdx: 5, kind: 'market_sell' }]`, price 50.00 renders `ℹ️ Sell 10 sh @ $50.00 was booked to bucket 2 market sell. Also possible: bucket 5 market sell. No target or stop fit this price and no single order is for exactly 10 shares, so the market sell of the lowest bucket wins.`

In `apps/server/test/http-sibling-notify.test.ts` "an ambiguous manual sell records and sends the attribution notice before the sibling notice", `attributed` becomes `` `ℹ️ Sell 10 sh @ $96.50 was booked to bucket 0 stop ($97.00, $0.50 away). Also possible: bucket 1 target ($91.00, $5.50 away). ${WHY_PRICE_10}` `` (spell the string out in the test file).

- [ ] **Step 3: Run the tests to see them fail**

Run: `bun test packages/telegram/test/digest.test.ts apps/server/test/booking-notifier.test.ts apps/server/test/http-sibling-notify.test.ts`
Expected: FAIL (old copy; `rule` missing from the type).

- [ ] **Step 4: Implement**

- `sell-match.ts`: the types above; `toLeg` returns `PriceLeg`; `attribute` adds `rule: 'price'`. Update the header comment's last sentences only where they name the types (Task 2 rewrites it).
- `i18n.ts`: the five keys, next to the existing `sell-attributed*` and `leg-*` keys.
- `booking-notifier.ts`: replace `legParams` with `legText(leg: SellLeg): string` (`market_sell` renders `sell-attributed-alt-market` with `leg: t('leg-market_sell')`; a price leg renders `sell-attributed-alt` as today). `sellAttributed` passes `chosen: legText(attribution.chosen)`, `alts` (joined with `'; '` as today), and `why: t(`sell-attributed-why-${attribution.rule}`, lang, { shares })`. `t` substitutes in one pass, so the pre-rendered `{why}` and `{chosen}` values are not re-scanned.

- [ ] **Step 5: Run the tests to see them pass, and typecheck**

Run: `bun test packages/telegram apps/server/test/booking-notifier.test.ts apps/server/test/http-sibling-notify.test.ts apps/server/test/sell-attribution.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/domain/sell-match.ts packages/telegram/src/i18n.ts apps/server/src/wire/booking-notifier.ts packages/telegram/test/digest.test.ts apps/server/test/booking-notifier.test.ts apps/server/test/http-sibling-notify.test.ts
git commit -m "feat: attribution notice names the deciding rule and can render market-sell legs"
```

---
### Task 2: The combined matching rule and the partial-fill flip (#52, #53, #54, #55, #58)

**Files:**
- Modify: `apps/server/src/domain/sell-match.ts` (`matchSellOrder` rewritten; `pickSellBucket` added; `openSellLegs` comment)
- Modify: `apps/server/src/domain/booking.ts` (`bookUnlocked` sell branch, buy lookup, flip)
- Create: `apps/server/test/sell-fixture.ts`, `apps/server/test/sell-matching.test.ts`
- Modify tests: `apps/server/test/booking.test.ts`, `apps/server/test/sell-attribution.test.ts` (rows marked Task 2 in the table above)

**Interfaces:**
- Consumes: Task 1 types (`SellLeg`, `PriceLeg`, `MarketLeg`, `AttributionRule`, `SellAttribution`).
- Produces (in `sell-match.ts`):
  ```ts
  export interface SellFillKey { runId: number; filledOn: ISODate; shares: number; price: bigint }
  export interface SellMatch { order: OrderRow; attribution: SellAttribution | null }
  export function matchSellOrder(orders: OrderRow[], state: RunState, input: SellFillKey): SellMatch | null
  // The whole sell-side choice: matchSellOrder, else the fallback. Throws DomainError('no-bucket-for-sell').
  export interface SellPick { bucketIdx: number; orderId: number | null; attribution: SellAttribution | null }
  export function pickSellBucket(orders: OrderRow[], state: RunState, input: SellFillKey): SellPick
  ```
- Produces (test fixture `apps/server/test/sell-fixture.ts`):
  ```ts
  export const D: ISODate = '2026-11-12'
  export const Y: ISODate = '2026-11-11'
  export type Held = { idx: number; shares: number; buy: string }
  export type Ord = { idx: number; kind: 'sell_loc' | 'stop_sell' | 'market_sell'; price?: string; shares?: number; status?: string; tradeDate?: ISODate }
  // A 10-bucket run (costPpm 0) holding `held`, with `ords` inserted in the given order. An order's shares default to
  // what its bucket holds (the strategy sizes legs that way), else 10; market_sell limitPrice is 0n; tradeDate defaults to D.
  export async function sellSetup(held: Held[], ords: Ord[]): Promise<{ f: ReturnType<typeof fakeRepos>; deps: FillBookingDeps; rec: ReturnType<typeof recordingNotifier>; runId: number }>
  export const sellAt: (runId: number, shares: number, price: string, deps: FillBookingDeps, filledOn?: ISODate) => Promise<void>  // manualFill, filledOn defaults to D
  export const orderOf: (f, idx: number, kind: string, tradeDate?: ISODate) => any  // tradeDate defaults to D
  export const fillsOf: (f) => Array<[shares: number, bucketIdx: number]>  // sell fills in booking order
  export const heldShares: (f, runId: number) => Promise<number[]>  // buckets[i].shares
  export const book43: (tradeDate?: ISODate, status?: string) => Ord[]  // bucket 0 target 103.00 / stop 97.00, bucket 9 target 91.00 / stop 85.40
  export const held43: Held[]  // bucket 0: 10 @ 100.00, bucket 9: 10 @ 88.00
  ```
  `deps.today` is `D`; `deps.notify` is `rec.notify`.

- [ ] **Step 1: Write the fixture and the failing matcher tests**

`apps/server/test/sell-matching.test.ts`, using only `sell-fixture.ts`:

`describe('the share count decides when no exact-price target exists (#52)')`
- For each order in `[[10, 20], [20, 10]]`: "two targets filling at one close book to their own buckets, `<order>`". Held `0: 10 @ 100.00`, `1: 20 @ 101.00`; orders `0 sell_loc 103.00`, `1 sell_loc 104.00`; every fill at `105.00`. Expect `fillsOf(f)` equal `order.map((n) => [n, n === 10 ? 0 : 1])`, both targets `filled`, `heldShares` all zero, and `rec.attributions` `[]` (a share-count pick sends no notice).
- For each of the six permutations of `[10, 20, 30]`: "three targets filling at one close book to their own buckets, `<order>`". Adds `2: 30 @ 99.00` with `sell_loc 102.00`; expect each fill in its own bucket (10 to 0, 20 to 1, 30 to 2), all three targets `filled`, `rec.attributions` `[]`.
- "a same-close exit sends no notice, but a price-distance pick at the same close does": held `0: 10 @ 100.00`, `1: 10 @ 101.00`; orders `0 sell_loc 103.00`, `1 sell_loc 104.00` (both 10 shares, so the share rung cannot decide); 10 @ 105.00 books to bucket 1 (1.00 away against 2.00) and `rec.attributions` has length 1, matching `{ attribution: { rule: 'price', chosen: { bucketIdx: 1, kind: 'sell_loc', distance: parseUsd('1.00') }, alternatives: [{ bucketIdx: 0, kind: 'sell_loc', limitPrice: parseUsd('103.00'), distance: parseUsd('2.00') }] } }`.
- "the share count outranks price distance across a target and a stop": held `0: 10 @ 100.00` (target 103.00, stop 97.00), `9: 4 @ 88.00` (target 91.00, stop 85.40); fill 4 @ 96.50 books to bucket 9 (its target is the one 4-share leg), bucket 9's target `filled`, bucket 0's legs `open`, `rec.attributions` `[]`.
- "on a shared exact-price target the leg sized like the fill wins": held `0: 20 @ 100.00`, `1: 10 @ 100.00`; orders `0 sell_loc 103.00` (20 shares), `1 sell_loc 103.00` (10 shares); 10 @ 103.00 books to bucket 1, not the lower bucket 0; bucket 1's target `filled`, bucket 0's target `open`; the exact-price rung decided with another admissible bucket, so `rec.attributions` has length 1, matching `{ attribution: { rule: 'price', chosen: { bucketIdx: 1, kind: 'sell_loc', distance: 0n }, alternatives: [{ bucketIdx: 0, kind: 'sell_loc', distance: 0n }] } }`.
- The existing `booking.test.ts` "an exact target match with impossible shares fails loudly instead of landing elsewhere" stays unchanged and green: bucket 0's open 103.00 target is an exact-price leg its bucket cannot cover, so rung 1 returns it and the booking fails with `too-many-shares`, before the share rung is reached.

`describe('stale legs on the fill day (#53)')`
- "a late fill after the morning roll books to the leg that took it and pulls only that bucket's legs for today": orders `book43(Y, 'stale')` then `book43(D, 'open')`; `sellAt(runId, 10, '91.20', deps, Y)`. Expect: last fill bucket 9; `orderOf(f, 9, 'sell_loc', Y).status === 'filled'`; `orderOf(f, 9, 'stop_sell', Y).status === 'stale'`; today's bucket 9 target and stop `{ status: 'cancelled', cancelReason: 'broker-filled' }`; today's bucket 0 legs `open`; `rec.siblings.map((s) => s.order.id)` equals today's bucket 9 `[sell_loc, stop_sell]` ids; `rec.attributions[0].attribution` matches `{ rule: 'price', chosen: { bucketIdx: 9, kind: 'sell_loc', distance: parseUsd('0.20') }, alternatives: [{ bucketIdx: 0, kind: 'stop_sell', limitPrice: parseUsd('97.00'), distance: parseUsd('5.80') }] }`.
- "a partial late fill leaves the stale leg stale and cancels nothing": same fixture, 4 @ 91.20 dated `Y`: bucket 9 holds 6, every order keeps its status, `rec.siblings` empty.
- "a stale exact-price target on a bucket emptied since is not read without the gate": held `1: 10 @ 96.00` only; orders `0 sell_loc 103.00 stale Y` (bucket 0 empty), `1 sell_loc 99.00 stale Y`; 5 @ 103.00 dated `Y` (5, so the share rung cannot pick bucket 1's 10-share leg) books to bucket 1 with no `bucket-not-held`; bucket 1 holds 5 and both orders stay `stale`.
- "a stale exact-price target that cannot cover the fill is skipped, where an open one fails loudly": held `0: 5 @ 100.00`, `1: 15 @ 90.00`; orders `0 sell_loc 103.00`, `1 sell_loc 92.00 shares 10`, all `stale` dated `Y`; 12 @ 103.00 dated `Y` books to bucket 1. The same fixture with both orders `open` and dated `D`, 12 @ 103.00 dated `D`, rejects with `{ kind: 'too-many-shares' }` and books nothing.

`describe('a partial fill keeps its order open (#54)')`
- "two partials of one stop both book to its bucket": `held43`, `book43()`; 4 @ 96.50 then 6 @ 96.50. After the first: bucket 0 stop and target `open`, `rec.siblings` empty. After the second: `fillsOf` `[[4, 0], [6, 0]]`, bucket 0 stop `filled`, target `cancelled` (`broker-filled`), bucket 9 legs `open`, `heldShares[9] === 10`, `rec.attributions` length 2, both choosing bucket 0's stop.
- "three partials of one stop": 3, 3, 4 @ 96.50; all in bucket 0; stop `open` until the third, then `filled`.
- "three partials of one target": 3, 3, 4 @ 103.50; all in bucket 0 (0.50 away against bucket 9's 12.50); target `filled` and stop `cancelled` after the third only.
- "two buckets sharing a target price take partials in bucket order": held `0: 10 @ 100.00`, `1: 10 @ 100.00`; each with `sell_loc 103.00` and `stop_sell 97.00`; fills 4, 6, 10 @ 103.20: `fillsOf` `[[4, 0], [6, 0], [10, 1]]`, both targets `filled`, both stops `cancelled`.
- "after a partial, a same-price fill too big for what is left goes to the other bucket at that price": held `0: 10 @ 100.00`, `1: 12 @ 100.00`, both `sell_loc 103.00`; fills 4 @ 103.00 then 10 @ 103.00: `fillsOf` `[[4, 0], [10, 1]]`, both targets `open`, `heldShares` `[6, 2, ...]`.
- "a partially filled exact-price target still fails loudly when no bucket at that price can cover the fill": held `0: 10 @ 100.00`, `1: 15 @ 90.00`; orders `0 sell_loc 103.00`, `1 sell_loc 92.00 shares 10`; 4 @ 103.00 books to bucket 0; then 8 @ 103.00 rejects `{ kind: 'too-many-shares' }`, one sell fill only.

`describe('market sells (#55)')` goes in `apps/server/test/sell-attribution.test.ts` (its `setup` already takes `market_sell`; add an optional `shares` to its `Ord`, defaulting to 10):
- "a market_sell on another bucket is listed after the price legs": held `0: 10 @ 95.00`, `3: 10 @ 100.00`, `5: 10 @ 96.00`; orders `0 sell_loc 97.85`, `3 market_sell`, `5 sell_loc 98.50`; 10 @ 99.00 books to bucket 5; attribution `{ rule: 'price', chosen: { bucketIdx: 5, kind: 'sell_loc', distance: parseUsd('0.50') }, alternatives: [{ bucketIdx: 0, kind: 'sell_loc', distance: parseUsd('1.15') }, { bucketIdx: 3, kind: 'market_sell' }] }`; bucket 3's `market_sell` stays `open`.
- "a market_sell whose size matches the fill wins over a price leg on another bucket": held `0: 20 @ 95.00` (`sell_loc 97.85`, shares 20), `3: 10 @ 100.00` (`market_sell`, shares 10); 10 @ 99.00 books to bucket 3, `market_sell` `filled`, bucket 0's target `open`; `rec.attributions` `[]` (the share rung decided).
- Change "market_sell ties resolve to the lowest bucket regardless of insertion order" to "... and list the other market sells": `rec.attributions` length 1, `{ rule: 'market', chosen: { bucketIdx: 2, kind: 'market_sell' }, alternatives: [{ bucketIdx: 5, kind: 'market_sell' }, { bucketIdx: 7, kind: 'market_sell' }] }`.
- Add (#58) "confirming a pending sell sends the attribution notice after the run lock is released": the probe of "the attribution notice runs after the run lock is released", driven through `confirmPendingFill(pid, null, deps)` on a pending 10 @ 96.50 row; `seen === 'free'`.

Also make every other Task 2 row of the "Existing tests whose expectation changes" table, in `booking.test.ts` and `sell-attribution.test.ts`. The two new `matchSellOrder` unit tests: "returns a stale order dated on the fill day, never a filled or cancelled one" (`o({ status: 'stale' })` returns id 1; `filled` and `cancelled` return `null`), and in "an exact-price target is returned even when its bucket cannot cover the fill" add `expect(matchSellOrder([o({ bucketIdx: 0, status: 'stale' })], state, input)).toBeNull()`. Add to `booking.test.ts` next to "(c) buy confirm": "a late buy flips a stale buy_loc dated on its fill day" (a `buy_loc` `stale` dated on the fill date flips to `filled`).

- [ ] **Step 2: Run them to see them fail**

Run: `bun test apps/server/test/sell-matching.test.ts apps/server/test/sell-attribution.test.ts apps/server/test/booking.test.ts`
Expected: FAIL (same-close cases end in `no-bucket-for-sell`, stale legs ignored, partial legs flip to `filled`, market legs missing from alternatives).

- [ ] **Step 3: Rewrite `matchSellOrder`, add `pickSellBucket`**

Replace the header comment with the rule in "The combined matching rule" section above (Pool, Gate, Admissible, rungs 1 to 4 and null, Attribution, and one sentence that the caller flips the order only on emptying). Keep the #43 paragraph that explains why kinds are not ranked by a fixed precedence.

Build `{ order: OrderRow; leg: SellLeg }` pairs once, through `legOf(o: OrderRow, price: bigint): SellLeg | null`, which switches on `o.kind` and returns `null` for any non-sell kind: no `as` cast, and every rung returns the pair's `order` (no `live.find(...)!`). Rungs as specified; alternatives are the admissible pairs on other buckets, price legs in rung-3 order then market legs by `bucketIdx`; a rung-2 (share count) pick returns `attribution: null`.

`pickSellBucket` returns `{ bucketIdx: match.order.bucketIdx, orderId: match.order.id, attribution }` on a match, else the fallback moved verbatim from `bookUnlocked` (`orderId: null`, `attribution: null`), else throws `new DomainError('no-bucket-for-sell')` (import from `@st/core`).

In `openSellLegs`, replace "a leg an earlier partial fill already flipped to filled must not be reported again" with: open is load-bearing: a stale leg's day is over at the broker and a filled or cancelled leg is no longer live, so neither is pulled or announced.

- [ ] **Step 4: Change `bookUnlocked`**

- The sell branch becomes: read `listForRunFrom` as today, call `pickSellBucket`, take `bucketIdx`, `matchedOrderId` and `attribution` from it, then `applySellFill`. `booking.ts` must end shorter than it started.
- The buy lookup accepts `status === 'open' || status === 'stale'`.
- Flip: compute `const emptied = input.side === 'sell' && next.buckets[bucketIdx]!.state === 'empty'`; cancel siblings when `emptied` (unchanged call); flip `matchedOrderId` to `filled` when `input.side === 'buy' || emptied`. Update the comment above the cancel: a partial fill leaves both legs live, cancels nothing and leaves the matched order as it was, so its rest stays a candidate.

- [ ] **Step 5: Run the tests to see them pass**

Run: `bun test apps/server`
Expected: PASS. A failure outside the table needs the analysis described below the table, not an expectation edit.

- [ ] **Step 6: Typecheck and commit**

Run: `bun run typecheck` (clean).

```bash
git add apps/server/src/domain/sell-match.ts apps/server/src/domain/booking.ts apps/server/test/sell-fixture.ts apps/server/test/sell-matching.test.ts apps/server/test/sell-attribution.test.ts apps/server/test/booking.test.ts
git commit -m "fix: book sells by exact price, then exact share count, admit stale legs of the fill day, keep partially filled orders open"
```

---
### Task 3: Operator-chosen bucket in the domain (#57)

**Files:**
- Modify: `apps/server/src/domain/sell-match.ts` (`matchForcedLeg`; `pickSellBucket` takes `bucketIdx`)
- Modify: `apps/server/src/domain/booking.ts` (`BookInput.bucketIdx`, `invalid-bucket`, `manualFill`)
- Modify: `apps/server/src/domain/confirm-pending.ts` (`ConfirmOverrides.bucketIdx`; plan C later reorders the keep write in this file, locate by symbol)
- Create: `apps/server/test/sell-bucket-override.test.ts`

**Interfaces:**
- Consumes: Task 2 `pickSellBucket`, `SellFillKey`, `sell-fixture.ts`.
- Produces:
  ```ts
  // sell-match.ts. The fill's bucket is the operator's: which of that bucket's orders on the fill day (open or
  // stale, sell-side, fitting the price) did it take? First exactly one with shares === fill.shares, then the
  // nearest price leg (sell_loc before stop_sell on a tie), then a market_sell; null when none fits. No gate:
  // applySellFill validates the bucket.
  export function matchForcedLeg(orders: OrderRow[], input: SellFillKey & { bucketIdx: number }): OrderRow | null
  // bucketIdx given (not null/undefined): { bucketIdx, orderId: matchForcedLeg(...)?.id ?? null, attribution: null }
  export function pickSellBucket(orders: OrderRow[], state: RunState, input: SellFillKey & { bucketIdx?: number | null }): SellPick
  // booking.ts
  interface BookInput { /* existing fields */ bucketIdx?: number | null }  // null/undefined = automatic
  manualFill(runId, fill: Omit<RawFill, 'ticker' | 'date'> & { filledOn: ISODate; bucketIdx?: number | null }, deps)
  // confirm-pending.ts
  interface ConfirmOverrides { /* existing fields */ bucketIdx?: number | null }  // sell only; null/undefined = automatic
  ```
- Error codes: `new Error('invalid-bucket')` from `bookUnlocked` when `bucketIdx` is given and the side is not `sell`, or it is not a non-negative integer (`Number.isInteger(x) && x >= 0`); thrown before any read that leads to a write. Out of range, empty and too small come from `applySellFill`: `DomainError` `bucket-not-found`, `bucket-not-held`, `too-many-shares`.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/sell-bucket-override.test.ts` (fixture from `sell-fixture.ts`; call `manualFill(runId, { side: 'sell', shares, price, filledOn, bucketIdx }, deps)` directly):

- "a forced bucket books there and flips the leg that fits the price": `held43`, `book43()`; 10 @ 96.50 with `bucketIdx: 9`. Last fill bucket 9; bucket 9 `sell_loc` `filled`; bucket 9 `stop_sell` `{ status: 'cancelled', cancelReason: 'broker-filled' }`; bucket 0 legs `open`; `rec.attributions` `[]`; `rec.siblings` ids `[bucket 9 stop_sell id]`.
- "a forced bucket with no leg that fits the price flips nothing and still cancels its legs when emptied": 10 @ 88.00 with `bucketIdx: 9` (88.00 is under the 91.00 target and over the 85.40 stop): both bucket 9 legs `cancelled` (`broker-filled`), in id order in `rec.siblings`.
- "a forced partial fill leaves the fitting leg open and cancels nothing": 4 @ 96.50 with `bucketIdx: 9`: `heldShares[9] === 6`, all four orders `open`, `rec.siblings` empty.
- "within a forced bucket the leg whose size matches the fill wins": held `0: 10 @ 90.00`; orders `0 sell_loc 95.00 shares 7`, `0 market_sell shares 10`; 10 @ 99.00 with `bucketIdx: 0`: `market_sell` `filled`, `sell_loc` `cancelled`.
- "a forced late fill flips the stale leg of its day": `book43(Y, 'stale')` then `book43(D, 'open')`; 10 @ 91.20 dated `Y` with `bucketIdx: 9`: `orderOf(f, 9, 'sell_loc', Y).status === 'filled'`, today's bucket 9 legs `cancelled`, today's bucket 0 legs `open`.
- "a forced bucket that is not held, too small or out of range books nothing": `held43`, `book43()`; `bucketIdx: 4` with 10 shares rejects `{ kind: 'bucket-not-held' }`; `bucketIdx: 0` with 11 shares rejects `{ kind: 'too-many-shares' }`; `bucketIdx: 10` rejects `{ kind: 'bucket-not-found' }`. After all three: `f._stores.fills` and `f._stores.ledger` empty, every order `open`, `heldShares` unchanged.
- "a bucketIdx on a buy, or one that is not a non-negative integer, is invalid-bucket": a buy of 5 @ 50.00 with `bucketIdx: 4`, and sells of 10 @ 96.50 with `bucketIdx` `1.5`, `-1` and `'9' as any`, each reject with message `invalid-bucket`; nothing persisted (same checks as above).
- "bucketIdx null books automatically": 10 @ 96.50 with `bucketIdx: null` books to bucket 0 and sends the attribution notice, exactly as without the field.
- "a confirm override bucketIdx books the pending sell to that bucket": pending sell 10 @ 96.50 dated `D` (insert as in `sell-attribution.test.ts`); `confirmPendingFill(pid, { bucketIdx: 9 }, deps)`; last fill bucket 9, the pending row `confirmed` with its stored `bucketIdx` 9, `rec.attributions` `[]`.
- "a confirm that turns the row into a buy with a bucketIdx is invalid-bucket and leaves the row pending": `confirmPendingFill(pid, { side: 'buy', bucketIdx: 9 }, deps)` rejects `invalid-bucket`; the row is still `pending`, no fill.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test apps/server/test/sell-bucket-override.test.ts`
Expected: FAIL (the bucket is ignored; buys and malformed values are accepted).

- [ ] **Step 3: Implement**

- `sell-match.ts`: `matchForcedLeg` reuses the pair builder and the rung helpers of Task 2 restricted to the one bucket, without the gate; `pickSellBucket` short-circuits on a given `bucketIdx`. Add one line to the `matchSellOrder` header pointing at `matchForcedLeg` for the forced path.
- `booking.ts`: the `invalid-bucket` check at the top of `bookUnlocked`; pass `bucketIdx: input.bucketIdx` into `pickSellBucket`; `manualFill` forwards `fill.bucketIdx`. `booking.ts` must stay at or under the length it had before Task 2.
- `confirm-pending.ts`: `ConfirmOverrides.bucketIdx`, passed as `bucketIdx: overrides?.bucketIdx ?? null` to `bookUnlocked` (the side check happens there, after the side override is resolved). Extend the `ConfirmOverrides` comment: `bucketIdx` forces the sell's bucket, sell only.

- [ ] **Step 4: Run the server suite**

Run: `bun test apps/server && bun run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/domain/sell-match.ts apps/server/src/domain/booking.ts apps/server/src/domain/confirm-pending.ts apps/server/test/sell-bucket-override.test.ts
git commit -m "feat: book a sell to an operator-chosen bucket on manual fills and pending confirms"
```

---

### Task 4: HTTP surface for the bucket override (#57)

**Files:**
- Modify: `apps/server/src/http/routes/pending.ts` (`GET /pending` only; plan C later changes id parsing here, locate by symbol)
- No change: `apps/server/src/http/routes/runs.ts` `POST /runs/:id/fills` (its body already reaches `manualFill`, and generic errors already answer `422 { error: e.message }`) and `POST /pending/:id/confirm` (overrides are passed through)
- Create: `apps/server/test/http-bucket-override.test.ts`
- Modify: `apps/server/test/http-pending-routes.test.ts` ("looks each distinct run up once, concurrently")

**Interfaces:**
- Consumes: Task 3 (`manualFill` and `ConfirmOverrides` accept `bucketIdx`).
- Produces: each `GET /api/pending` row gains `heldBuckets: Array<{ index: number; shares: number }>`: the buckets of that row's run whose state is not `empty`, ascending by index; `[]` when the run does not exist. One `bucketRepo.loadState` per distinct run, run concurrently with the existing `runRepo.get` per run (extend the existing per-run map to carry both values).

- [ ] **Step 1: Write the failing tests**

`apps/server/test/http-bucket-override.test.ts`, using `makeFakes`, `makeDeps`, `loginAs`, `createRun`, `json` from `http-fakes.ts`; a run seeded with `buckets: [{ shares: 10, buyPrice: '100.0000', filledOn: '2026-11-02' }, { shares: 10, buyPrice: '88.0000', filledOn: '2026-11-02' }]` and the four #43 orders on `D = '2026-11-10'` (copy the setup of "an ambiguous manual sell ..." in `http-sibling-notify.test.ts`):

- "POST /runs/:id/fills with bucketIdx books the sell to that bucket": body `{ side: 'sell', shares: 10, price: '96.50', filledOn: D, bucketIdx: 1 }` → 200; the sell fill has `bucketIdx: 1`; `f.states.get(id)!.buckets` bucket 1 `empty`, bucket 0 `held`.
- "POST /runs/:id/fills rejects a bad bucket with 422 and books nothing": `bucketIdx: 'x'` → `422 { error: 'invalid-bucket' }`; `bucketIdx: 5` → `422 { error: 'bucket-not-held' }`; a buy with `bucketIdx: 0` → `422 { error: 'invalid-bucket' }`; no fill added.
- "POST /pending/:id/confirm with overrides.bucketIdx books there": pending sell 10 @ `965000n` dated `D`; body `{ overrides: { bucketIdx: 1 } }` → `200 { ok: true, archived: true }`; the sell fill in bucket 1.
- "POST /pending/:id/confirm with a bucketIdx on a buy is 422 invalid-bucket and the row stays pending".
- "GET /api/pending lists each row's own run's held buckets": run A as above plus run B seeded `[{ shares: 5, ... }]`; one pending row each; rows' `heldBuckets` are `[{ index: 0, shares: 10 }, { index: 1, shares: 10 }]` and `[{ index: 0, shares: 5 }]`.
- "GET /api/pending gives a row whose run is gone no buckets": a pending row with `runId: 999` → `heldBuckets: []` (and the default `costPpm`, as today).

In `http-pending-routes.test.ts` "looks each distinct run up once, concurrently", also wrap `f.repos.bucketRepo.loadState` and expect its calls, sorted, to equal `[runId, otherRun]`.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test apps/server/test/http-bucket-override.test.ts apps/server/test/http-pending-routes.test.ts`
Expected: the POST cases already pass after Task 3 (they pin the wiring); the `heldBuckets` cases FAIL.

- [ ] **Step 3: Implement `heldBuckets` in `GET /pending`**

- [ ] **Step 4: Run the server suite**

Run: `bun test apps/server && bun run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/http/routes/pending.ts apps/server/test/http-bucket-override.test.ts apps/server/test/http-pending-routes.test.ts
git commit -m "feat: pending list carries each run's held buckets; pin bucketIdx on the fill and confirm routes"
```

---
**Controller amendment (cross-plan check, overrides this task's Interfaces where they differ):** `heldBuckets` is computed per distinct run (the runs looked up concurrently with each other) as `const run = await runRepo.get(id)`; only if `run` is non-null, `await bucketRepo.loadState(id)`; otherwise `heldBuckets: []`. Do not call `loadState` for a run that does not exist: the real repo throws on a missing run and the fake returns `undefined`. Add a test: a pending row whose run is gone gets `heldBuckets: []` and the route answers 200.

### Task 5: Web bucket selector on the manual fill dialog and the pending row (#57)

**Controller amendment (cross-plan check):** this task is done in two parts by two implementers, each with its own commit and review.
- **Part 5a — manual fill dialog:** `api.types.ts`, `api.ts` (the `bucketIdx` field), `heldBucketsOf` in `viewmodels.ts`, the new `BucketSelect.tsx`, `FillDialog.tsx`, `RunDetail.tsx`, the catalog keys `fillBucket`, `fillBucketAuto` and the `fillErr.*` keys, and the fill-dialog tests (`FillDialogBucket.test.tsx`, the `api.test.ts` and `viewmodels` additions). Commit: `feat: choose the bucket a manual sell is booked to`.
- **Part 5b — pending row:** the `heldBuckets` fixtures, the bucket column in `PendingRow.tsx` / `PendingTable.tsx`, the `pendingColBucket` key, and `PendingTableBucket.test.tsx`. Commit: `feat: choose the bucket a pending sell is booked to`.
Keep `FillDialog.tsx` at or under ~300 lines (it is 287 before this task): keep the bucket field's markup inside `BucketSelect`.

**Files:**
- Modify: `apps/web/src/api.types.ts` (`HeldBucketDto`, `PendingFillDto.heldBuckets`, `PendingOverrides.bucketIdx`, `ManualFillInput.bucketIdx`)
- Modify: `apps/web/src/api.ts` (`ApiErrorCode` gains `'invalid-bucket'`; `addManualFill` sends `bucketIdx` when defined)
- Modify: `apps/web/src/viewmodels.ts` (`heldBucketsOf`)
- Create: `apps/web/src/components/forms/BucketSelect.tsx`
- Modify: `apps/web/src/components/forms/FillDialog.tsx`, `apps/web/src/pages/RunDetail.tsx` (plan D later edits `FillDialog.tsx`, locate by symbol)
- Modify: `apps/web/src/components/forms/PendingRow.tsx`, `apps/web/src/components/forms/PendingTable.tsx` (plan D later edits both for phone width, locate by symbol)
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Modify fixtures: `apps/web/src/testing/pendingRow.ts`, `components/forms/PendingRow.test.tsx` (`ROW`), `components/forms/PendingDefaultFee.test.tsx` (`ROW`): add `heldBuckets: []`; `tsc -p apps/web --noEmit` lists any other literal that needs it
- Tests: `apps/web/src/api.test.ts`, `apps/web/src/viewmodels.test.ts`, `apps/web/src/pages/RunDetail.test.tsx`, new `components/forms/FillDialogBucket.test.tsx`, new `components/forms/PendingTableBucket.test.tsx`

**Interfaces:**
- Consumes: Task 4 (`heldBuckets` on `GET /api/pending`), Task 3 (`bucketIdx` accepted on both POSTs).
- Produces:
  ```ts
  // api.types.ts
  export interface HeldBucketDto { index: number; shares: number }
  interface PendingFillDto { /* existing */ heldBuckets: HeldBucketDto[] }  // the row's own run, non-empty buckets
  interface PendingOverrides { /* existing */ bucketIdx?: number }          // sell only; omitted = automatic
  interface ManualFillInput { /* existing */ bucketIdx?: number }           // sell only; omitted = automatic
  // viewmodels.ts
  export function heldBucketsOf(buckets: BucketDto[]): HeldBucketDto[]      // state !== 'empty', by index
  // components/forms/BucketSelect.tsx; value '' = Automatic, otherwise the bucket index as text
  export function BucketSelect(props: { value: string; held: HeldBucketDto[]; onChange: (value: string) => void; 'aria-label': string; 'data-testid'?: string }): JSX.Element
  // FillDialog.tsx
  interface FillDialogProps { /* existing */ heldBuckets?: HeldBucketDto[] }  // add mode only; default []
  // PendingRow.tsx
  interface PendingRowProps { /* existing */ bucket: string; onBucketChange: (value: string) => void }
  ```
- `BucketSelect` renders a `Select` with `<option value="">{t('fillBucketAuto')}</option>`, then one option per held bucket labelled `` `${t('bucketLabel', { n: index })} · ${t('bucketShares', { shares })}` `` ("Bucket 2 · 10 sh" / "버킷 2 · 10주"). When `value` is not `''` and not among `held`, it adds one option for it labelled `t('bucketLabel', { n })`, so a choice that went stale stays visible and is sent (the server answers `bucket-not-held`).
- Catalog keys (insert in `localeCompare` order in both files):

| Key | en | ko |
| --- | --- | --- |
| `fillBucket` | `Bucket` | `버킷` |
| `fillBucketAuto` | `Automatic` | `자동` |
| `fillErr.bucket-not-found` | `This run has no bucket with that number.` | `이 런에는 해당 번호의 버킷이 없습니다.` |
| `fillErr.invalid-bucket` | `A bucket can only be chosen for a sell.` | `버킷은 매도에만 지정할 수 있습니다.` |
| `pendingColBucket` | `Bucket` | `버킷` |

- [ ] **Step 1: Write the failing tests**

- `api.test.ts`: "addManualFill sends bucketIdx only when given" (`{ ..., bucketIdx: 2 }` posts `bucketIdx: 2`; without it the body has no `bucketIdx` key); "confirmPending carries a bucketIdx override" (`{ bucketIdx: 3 }` posts `{ overrides: { bucketIdx: 3 } }`).
- `viewmodels.test.ts`: "heldBucketsOf keeps held and force-sell buckets in index order": buckets `[1 held 10, 0 empty 0, 2 force_sell 7]` give `[{ index: 1, shares: 10 }, { index: 2, shares: 7 }]`.
- `FillDialogBucket.test.tsx` (setup copied from `FillDialog.test.tsx`; render add mode with `heldBuckets: [{ index: 0, shares: 10 }, { index: 2, shares: 7 }]`):
  - "no bucket selector while the side is buy": no `[data-testid="manualBucketSelect"]`.
  - "a sell offers Automatic and the run's held buckets": after selecting sell, the select's option texts are `['Automatic', 'Bucket 0 · 10 sh', 'Bucket 2 · 7 sh']` and its value is `''`.
  - "Automatic posts no bucketIdx": the POST body has no `bucketIdx` key.
  - "a chosen bucket is posted as bucketIdx": choose `'2'`, add: body `bucketIdx: 2`.
  - "a bucket chosen and then the side switched to buy posts no bucketIdx".
  - "edit mode has no bucket selector" (a `fill` prop).
  - "a bucket-not-held answer reads localized": POST stub `422 { error: 'bucket-not-held' }` shows `This bucket is not currently held.`.
- `PendingTableBucket.test.tsx` (setup copied from `PendingTable.test.tsx`; `PendingTable` rendered without `runId`; the GET returns two rows: `{ ...ROW, id: 9, runId: 7, side: 'sell', detected: { ...ROW.detected!, side: 'sell' }, heldBuckets: [{ index: 0, shares: 10 }, { index: 3, shares: 4 }] }` and `{ ...ROW, id: 10, runId: 8, side: 'sell', detected: { ...ROW.detected!, side: 'sell' }, heldBuckets: [{ index: 1, shares: 5 }] }`):
  - "each sell row offers its own run's held buckets": row 9's select options `['Automatic', 'Bucket 0 · 10 sh', 'Bucket 3 · 4 sh']`, row 10's `['Automatic', 'Bucket 1 · 5 sh']` (locate selects by `aria-label` `Bucket` inside each `tr`).
  - "an untouched confirm posts no overrides": body `{}` for row 9 (Automatic is not an edit).
  - "a chosen bucket is posted as an override without opening the screenshot prompt": choose `'3'` on row 9, Confirm: no `[role=dialog]`, body `{ overrides: { bucketIdx: 3 } }`.
  - "a bucket chosen and then the side switched to buy posts no bucketIdx": after answering the keep prompt (a side change is a vision correction), the posted `overrides` equal `{ side: 'buy' }`.
  - "a buy row shows no bucket selector": with `ROW` (side buy).
- `RunDetail.test.tsx`: "the fill dialog offers the run's held buckets when the side is sell": a run whose `state.buckets` holds bucket 1 with 20 shares; open the dialog (`tabManual`), select sell; options `['Automatic', 'Bucket 1 · 20 sh']`.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test apps/web`
Expected: the new tests FAIL; the catalog test fails until both catalogs carry the new keys.

- [ ] **Step 3: Implement**

- Types, `ApiErrorCode`, `addManualFill` (`if (fill.bucketIdx !== undefined) body.bucketIdx = fill.bucketIdx`), `heldBucketsOf`, `BucketSelect`, catalog keys.
- `FillDialog.tsx`: `const [bucket, setBucket] = useState('')`; in add mode, when `side === 'sell'`, a `Field` labelled `t('fillBucket')` holding `BucketSelect` with `data-testid="manualBucketSelect"` and `aria-label={t('fillBucket')}`, placed after the side select; `input.bucketIdx = side === 'sell' && bucket !== '' ? Number(bucket) : undefined`.
- `RunDetail.tsx`: the add-mode `FillDialog` gets `heldBuckets={heldBucketsOf(run.state.buckets)}`.
- `PendingTable.tsx`: `const [buckets, setBuckets] = useState<Record<number, string>>({})`; the bucket choice is not part of `RowValues`, so `pendingEdits`, `asksAboutImage` and the review dialog never see it. `buildOverrides(r, v, bucket)` adds `bucketIdx: Number(bucket)` when `v.side === 'sell' && bucket !== ''`. New header `Th` `t('pendingColBucket')` after the fee column.
- `PendingRow.tsx`: a `Td` after the fee cell: `BucketSelect` (`aria-label={t('fillBucket')}`) when `values.side === 'sell'`, empty otherwise.

- [ ] **Step 4: Run the web suite and typecheck**

Run: `bun test apps/web && bun run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat: choose the sell bucket on the manual fill dialog and on pending rows"
```

---

### Task 6: Spec amendment, repo map, full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-11-16-cut-loss-and-sim-drafts-design.md` (section "Booking a stop fill" and the "Tests" list)
- Modify: `AGENTS.md` (repo map: `test/` areas)

- [ ] **Step 1: Amend "Booking a stop fill"**

- Replace the rungs paragraph ("The chain is therefore ..."), the table and the gate paragraph after it with the combined rule (Pool, Gate, Admissible, rungs 1 to 5, Attribution, Flip, Forced bucket) from this plan's "The combined matching rule" section, as a table plus short paragraphs. Keep the #43 amendment paragraph as history.
- Add **Amended 2026-11-22 (#52 to #55, #57)** after the 2026-11-18 amendment: one short paragraph per issue saying what changed and why (the rulings' "Why" lines), and that ruling 1 reverses the 2026-11-18 "price distance only" ruling.
- Rewrite the "Tie-break" bullet: an open target at exactly the fill price first (among those that can cover the fill, the one sized like the fill, else the lowest bucket; none can: fail loudly); then the share count (ruling 1, only when no exact-price target exists); then price distance; target before stop and lowest bucket break exact distance ties only.
- Rewrite the "Attribution notice" bullet: sent when another bucket had an admissible leg and the leg was chosen by the exact-price rung, by price distance or by the market-sell rung, never when the share count decided (controller ruling: a normal multi-target exit sends none); market-sell legs are listed after price legs; a forced bucket or the fallback carries no notice; keys `sell-attributed`, `sell-attributed-alt`, `sell-attributed-alt-market`, `sell-attributed-why-price`, `sell-attributed-why-market`, `leg-sell_loc`, `leg-stop_sell`, `leg-market_sell`. Leave the no-chat sentence as it is (plan B changes it).
- Known limitations: items 1 to 4 each become "Addressed 2026-11-22 (#54 / #55 / #53 / #52): ..." in one line; item 3's line states the full condition (the fill falls to the fallback and, when it empties the fallback bucket, the sibling cancel pulls that bucket's legs for today). Item 5 stays word for word (plan B).
- Sibling cancel: the first bullet says that a sell that empties its bucket, whichever leg, rung, fallback or forced bucket booked it, cancels every `open` sell-side order (`sell_loc`, `stop_sell`, `market_sell`) of that run and bucket dated on or after the fill's trade date, with `broker-filled`; a fill for an earlier day confirmed after the morning re-plan therefore also cancels **today's** freshly planned legs. The partial bullet: a partial fill cancels nothing and leaves the matched order as it was (`open` or `stale`) until a fill empties the bucket (ruling 3); drop "partial-fill order accounting is out of scope here".
- Add a **Bucket override** subsection after "Sibling cancel": ruling 5 as built (fields, validation codes, leg choice via `matchForcedLeg`, no notice, no new column, `heldBuckets` on `GET /api/pending`, the web selector).

- [ ] **Step 2: Amend the Tests list**

- The `booking.test.ts` and `sell-attribution.test.ts` bullets: name the changed pins (stale stop matches, partial leaves the order open, market alternatives, the 90.00 nearest-first fixture, the `confirmPendingFill` lock probe).
- Add bullets for `sell-matching.test.ts` (same-close permutations, stale legs, partials, the exact-price interactions), `sell-bucket-override.test.ts`, `http-bucket-override.test.ts`, `FillDialogBucket.test.tsx`, `PendingTableBucket.test.tsx`.
- `http-sibling-notify.test.ts` bullet: "over HTTP against the in-memory fakes of `http-fakes.ts`, with the real notifier".
- Merge the two `packages/telegram/test/digest.test.ts` bullets into one naming the stop line and every `sell-attributed*` and `leg-*` key (`leg-sell_loc`, `leg-stop_sell`, `leg-market_sell`), en and ko.

- [ ] **Step 3: Repo map**

In `AGENTS.md`, the `test/` line of `apps/server/` gains `sell-matching, sell-bucket-override, http-bucket-override` among the areas and `sell-fixture.ts` among the helpers; `components/forms/` gains `BucketSelect`.

- [ ] **Step 4: Full verification**

Run: `bun test`
Expected: all pass (DB-gated files skip).

Run: `bun run typecheck`
Expected: clean.

Run (test DB per AGENTS.md): `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` and `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`
Expected: all pass; the e2e cut-loss step still reports exactly one sibling-cancel push (no assertion was changed). If the test DB is not running, say so in the hand-off instead of claiming the DB runs passed.

Run: `rg -n '[\p{Han}\p{Cyrillic}]' --glob '!node_modules' .`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-11-16-cut-loss-and-sim-drafts-design.md AGENTS.md
git commit -m "docs: amend the sell matching spec for share count, stale legs, partial fills, market alternatives and the bucket override"
```
