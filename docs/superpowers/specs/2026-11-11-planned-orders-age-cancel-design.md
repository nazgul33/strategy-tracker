# Planned orders: bucket age + cancelled reason — design

Date: 2026-11-11 · Status: awaiting sign-off

## Purpose

The "Planned orders" view (web Sim replay **and** morning Telegram digest) should:

- show how old the bucket is (in trading days) on **sell** orders, and
- append the **reason** right after the "Cancelled" label on skipped orders.

## Context (verified in code)

- `RunState.ages` already tracks trading-day age per bucket (`advanceDay` bumps it
  every morning *before* `computeOrders` runs).
- `applySellFill` **deletes** the bucket's age on close → post-fill state can never
  answer "how old was it when sold". The age must be captured at plan time, on the order.
- The digest already: (a) shows `(age N — forced exit)` on market sells (English clause
  hard-coded for both langs), (b) appends a skip reason by pairing each skip with the
  first unconsumed notice whose `params.bucket` matches the bucket index.
- The web SimReplay Planned-orders table shows neither age nor skip reason.
- `plan.skips` had exactly one producer — the sell cap, removed today (3775707).
  New plans emit no skips; **previously stored sim runs still render them**, and
  their `sell-capped` notice key was deleted from the web catalog, so those legacy
  rows now render with no (or raw-key) explanation.

## Changes

### 1. `PlannedOrder.ageDays?: number` — `@st/core/domain`

- `computeOrders` sets `ageDays = state.ages[b.index]` on every `sell_loc` and
  `market_sell` order. Never set on `buy_loc`.
- Passes through sim persistence untouched (plain number).
- `apps/web/src/api.types.ts` plan-order DTO type gains `ageDays?: number`.

### 2. Telegram digest (`packages/telegram`)

- `sellLocLine`: append the age clause when known.
- `marketSellLine`: read `o.ageDays` first, fall back to the existing `ages` arg
  (keeps callers/tests that pass only `ages` working).
- New i18n entries `age` and `age-forced` (en/ko) replace the hard-coded clause:
  en `(age {n})` / `(age {n} — forced exit)`, ko `({n}일차)` / `({n}일차 — 강제 청산)`.

### 3. Web (`apps/web`)

- SimReplay Planned-orders bucket cell shows `4 · 12d` (age muted) on sell rows
  with `ageDays`. Catalog key `simOrderAge`: en `{n}d` / ko `{n}일`.
- SimReplay skip rows: new pure helper `skipReasons(plan)` in `viewmodels.ts`
  mirroring the digest pairing (skip i ↔ first unconsumed notice with
  `params.bucket === bucketIndex`); render `Cancelled` badge followed by
  ` — {t('digest.' + code, params)}` in muted text. No reason when no notice pairs.
- Re-add `digest.sell-capped` to the **web** en/ko catalogs (legacy stored plans
  reference it): en `sell capped (price {price})`, ko `매도 상한 (가격 {price})`.

## Non-goals

- No `reason` field on `PlannedOrder` — the skip↔notice pairing convention stays.
- No age on buy rows; OrderTable / pending pages untouched.
- Telegram i18n does **not** re-add `sell-capped` (live plans can't produce it).

## Tests

- `packages/strategies/test`: `ageDays` from `state.ages` on sell_loc & market_sell,
  absent on buy_loc.
- `packages/telegram/test/digest.test.ts`: sell_loc age clause en + ko; market-sell
  age via `ageDays`, with `ages`-arg fallback.
- `apps/web/src/viewmodels.test.ts`: `skipReasons` — pairing, multiple skips distinct
  notices, no matching notice → no reason. Catalog parity test picks up new keys.
- Full gate: `bun test` + `bun run typecheck`.
