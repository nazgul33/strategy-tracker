# Planned Orders: Bucket Age + Cancellation Reason — Implementation Plan

**Goal:** Sell rows in "Planned orders" (web Sim replay + Telegram digest) show the bucket's age in trading days, and "Cancelled" rows show why they were cancelled next to the label.

**Architecture:** `computeOrders` stamps `ageDays` on every sell-side `PlannedOrder` it emits, read from `state.ages` at plan time — mandatory because `applySellFill` deletes the bucket's age once a sell books, so the stored `sim_day.planJson` is the only surviving record. The Telegram digest consumes `ageDays` (falling back to its existing `ages` argument for live runs and old plans) and gets its age clauses translated via the telegram i18n catalog. The web Sim replay renders `ageDays` in the bucket cell and derives each skip's reason by pairing skips with notices exactly the way `renderDigest` does (first unconsumed notice whose `params.bucket` matches), extracted into a unit-tested `skipReasons` viewmodel.

**Tech stack:** Bun, TypeScript monorepo (`packages/core`, `packages/strategies`, `packages/telegram`, `apps/web`), bun:test, React.

**Spec:** `docs/superpowers/specs/2026-11-11-planned-orders-age-cancel-design.md` (approved).

## Global constraints

- Money is bigint myriadths via `@st/core/money` — never floats (this plan adds no money math; prices pass through untouched).
- All user-facing copy goes through the en/ko catalogs — no hard-coded English in `digest.ts` or web components.
- Existing digest tests use **byte-exact** `toContain` assertions on line format (double spaces between tokens, em dash `—` in `age 21 — forced exit`); every existing assertion must keep passing **without edits** — that is the proof output is byte-identical for unstamped plans.
- No source file over ~300 lines; `packages/*` never import `apps/*`.
- Commit style `feat|fix|docs|test|chore:`; commit after each task.
- All commands run from the repo root (worktree root).

## Verified current-state facts (do not re-derive)

- `PlannedOrder` (`packages/core/src/domain.ts` :49): `{ kind: OrderKind; bucketIndex: number; limitPrice: bigint; shares: number }` — no age field. `DayPlan.skips: PlannedOrder[]` (:57).
- `computeOrders(run: Run, state: RunState, ctx: { lastClose: bigint }, params: MrParams = DEFAULT_MR_PARAMS)` (`packages/strategies/src/mean-reversion.ts` :63). Two sell-side pushes, **no skips push anywhere** (the sell-cap that produced skips was removed in 3775707 — web skip rows now only come from legacy stored plans):
  - held loop (:92–96): `orders.push({ kind: 'sell_loc', bucketIndex: b.index, limitPrice: target, shares: b.shares })`
  - force_sell loop (:101–104): `orders.push({ kind: 'market_sell', bucketIndex: b.index, limitPrice: 0n, shares: b.shares })`
- `RunState.ages: Record<number, number>` (`domain.ts` :28). `applyBuyFill` sets `ages[bucketIndex] = 0` (`fills.ts` :63); `applySellFill` `delete`s it (:109). Test helper `emptyState(10)`; tests build state with `applyBuyFill(s, i, shares, priceMyriadths, feeCents, isoDate)` and direct mutation (`state.buckets[i]!.state = 'held'`).
- `renderDigest(run, plan, ctx, lang, ages?)` (`packages/telegram/src/digest.ts` :9): `sellLocLine(o, lang)` (:56) has **no** age clause and renders `→ bucket ${o.bucketIndex}` (`bucket` untranslated even in ko); `marketSellLine(o, lang, ages?)` (:61) hard-codes `` `  (age ${age} — forced exit)` `` (English even in ko) when `ages?.[bucketIndex] !== undefined`. Skip↔notice pairing (:20–30): first *unconsumed* notice with `n.params?.bucket === o.bucketIndex`, **any code**; unconsumed notices render standalone (:31–34).
- Telegram catalog (`packages/telegram/src/i18n.ts`): `Record<string, { en: string; ko: string }>`, `{var}` placeholders, `t(code, lang, params?)`. **No `sell-capped` key** (removed with the cap in 3775707 — stays removed).
- Web `SimOrderDto` (`apps/web/src/api.types.ts` :131, `limitPrice` is `string`) used **only** by `SimPlanDto.orders/skips`; `SimPlanDto.notices` is inline `{ code: string; params?: Record<string, string | number> }[]` (:141). Server passes `planJson` through untouched (`apps/server/src/sim/sim.ts`), so one optional DTO field is the only server-side-visible change needed.
- Web Planned orders card (`apps/web/src/components/SimReplay.tsx` :129–176): one table; `planJson.orders.map(...)` rows then `planJson.skips.map(...)` rows (`opacity-60`, `<Badge tone="neutral">{t('orderStatusCancelled')}</Badge>`). Bucket cell: `<Td className="text-right tabular-nums">{o.bucketIndex + 1}</Td>`. Notices render below via `t(`digest.${n.code}`, n.params)`. `t` from `useT()` is `(key: string, params?: Record<string, string | number>) => string` (`apps/web/src/i18n/index.tsx` :30).
- Web catalogs `apps/web/src/i18n/{en,ko}.json` already carry `digest.*` keys (`digest.skip`, `digest.unconfirmed`, …) but **no** `digest.sell-capped`; `catalog.test.ts` enforces identical en/ko key sets and identical `{placeholder}` sets per key.

---

### Task 1: Domain — stamp `ageDays` on sell-side planned orders

**Files**
- Modify: `packages/core/src/domain.ts` (`PlannedOrder`)
- Modify: `packages/strategies/src/mean-reversion.ts` (`computeOrders`)
- Test: `packages/strategies/test/mean-reversion.test.ts`

**Interfaces**
- Produces: `PlannedOrder.ageDays?: number` — consumed by `packages/telegram/src/digest.ts` (Task 2), `apps/web/src/api.types.ts` + `SimReplay.tsx` (Task 3). Persisted into `sim_day.planJson` untouched; old plans simply lack it.

- [ ] **Step 1: Write the failing test** — append inside the existing `describe('computeOrders', …)` block in `packages/strategies/test/mean-reversion.test.ts` (its imports already include `computeOrders`, `emptyState`, `applyBuyFill`):

```ts
  test('sell orders carry the bucket age stamped at plan time; buys do not', () => {
    const run = { id: 1, name: 'r', ticker: 'X', strategyKey: 'mean-reversion' as const, costPpm: 30, poolCents: 1_000_000, status: 'active' as const }
    let state = emptyState(10)
    state = applyBuyFill(state, 0, 10, 3402200n, 34, '2026-11-02')
    state = applyBuyFill(state, 1, 5, 3402200n, 17, '2026-10-01')
    state.ages[0] = 15
    state.ages[1] = 101
    state.buckets[1]!.state = 'force_sell'
    const plan = computeOrders(run, state, { lastClose: 3402300n })
    const buy = plan.orders.find((o) => o.kind === 'buy_loc')!
    const loc = plan.orders.find((o) => o.kind === 'sell_loc')!
    const forced = plan.orders.find((o) => o.kind === 'market_sell')!
    expect(buy.bucketIndex).toBe(2) // lowest empty bucket
    expect(buy.ageDays).toBeUndefined()
    expect(loc.bucketIndex).toBe(0)
    expect(loc.ageDays).toBe(15)
    expect(forced.bucketIndex).toBe(1)
    expect(forced.ageDays).toBe(101)
  })
```

- [ ] **Step 2: Run to verify it fails** — `bun test packages/strategies/test/mean-reversion.test.ts` → new test FAILS (`ageDays` is `undefined` where 15/101 expected). Existing tests still pass.

- [ ] **Step 3: Implement.** In `packages/core/src/domain.ts`, extend `PlannedOrder` (:49):

```ts
export interface PlannedOrder {
  kind: OrderKind
  bucketIndex: number
  limitPrice: bigint
  shares: number
  /** Bucket age (trading days, post-morning bump) stamped at plan time; sell
   * orders only. Required because applySellFill deletes the bucket's age, so
   * the stored plan is the only surviving record for the sim replay. */
  ageDays?: number
}
```

In `packages/strategies/src/mean-reversion.ts` `computeOrders`, add `ageDays: state.ages[b.index] ?? 0` to the two sell pushes (held loop → `sell_loc`, force_sell loop → `market_sell`):

```ts
orders.push({ kind: 'sell_loc', bucketIndex: b.index, limitPrice: target, shares: b.shares, ageDays: state.ages[b.index] ?? 0 })
```
```ts
orders.push({ kind: 'market_sell', bucketIndex: b.index, limitPrice: 0n, shares: b.shares, ageDays: state.ages[b.index] ?? 0 })
```

Surrounding code stays as-is. Do **not** touch the buy push.

- [ ] **Step 4: Run tests** — `bun test packages/strategies packages/core` → green. (The `toEqual` at :36 pins a buy order and `plan.skips` at :70 pins `[]` — neither gains `ageDays`.)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/domain.ts packages/strategies/src/mean-reversion.ts packages/strategies/test/mean-reversion.test.ts
git commit -m "feat: stamp bucket age on planned sell orders"
```

---

### Task 2: Telegram digest — translated age clauses, `ageDays` first

**Files**
- Modify: `packages/telegram/src/i18n.ts`
- Modify: `packages/telegram/src/digest.ts`
- Test: `packages/telegram/test/digest.test.ts`

**Interfaces**
- Consumes: `PlannedOrder.ageDays` (Task 1).
- Produces: catalog keys `age` / `age-forced` (telegram-only); digest line formats `Sell  LOC  {shares} sh  @ {price}  → bucket {i}  (age {n})` and `Market  SELL  {shares} sh  bucket {i}  (age {n} — forced exit)`; ko clauses `(…일 경과)` / `(…일 경과 — 강제 청산)` — the rest of the ko lines keeps the current mixed `매도 … bucket N` shape. No callers outside `renderDigest` (signature unchanged), so `apps/server/src/pipeline/day.ts` needs no change.

- [ ] **Step 1: Write the failing tests** — append inside the existing `describe('digest', …)` block in `packages/telegram/test/digest.test.ts` (module already imports `renderDigest`, `run`, `ctx`, `DayPlan`):

```ts
  test('sell loc line shows age when known', () => {
    const plan: DayPlan = {
      orders: [{ kind: 'sell_loc', bucketIndex: 2, limitPrice: 3500000n, shares: 10, ageDays: 21 }],
      skips: [],
      notices: [],
    }
    const out = renderDigest(run, plan, ctx, 'en').join('\n')
    expect(out).toContain('Sell  LOC  10 sh  @ 350.00  → bucket 2  (age 21)')
  })
  test('stamped ageDays wins over the ages argument', () => {
    const plan: DayPlan = {
      orders: [{ kind: 'market_sell', bucketIndex: 1, limitPrice: 0n, shares: 120, ageDays: 21 }],
      skips: [],
      notices: [],
    }
    const out = renderDigest(run, plan, ctx, 'en', { 1: 5 }).join('\n')
    expect(out).toContain('Market  SELL  120 sh  bucket 1  (age 21 — forced exit)')
  })
  test('ko age clauses translated', () => {
    const plan: DayPlan = {
      orders: [
        { kind: 'sell_loc', bucketIndex: 0, limitPrice: 3500000n, shares: 10, ageDays: 21 },
        { kind: 'market_sell', bucketIndex: 1, limitPrice: 0n, shares: 120, ageDays: 120 },
      ],
      skips: [],
      notices: [],
    }
    const out = renderDigest(run, plan, ctx, 'ko').join('\n')
    expect(out).toContain('→ bucket 0  (21일 경과)')
    expect(out).toContain('매도  MARKET  120 sh  bucket 1  (120일 경과 — 강제 청산)')
  })
```

- [ ] **Step 2: Run to verify they fail** — `bun test packages/telegram/test/digest.test.ts` → the 3 new tests FAIL (no age on sell-loc line; `ageDays` ignored; ko emits English `(age … )`). All existing tests must still pass.

- [ ] **Step 3: Implement.** In `packages/telegram/src/i18n.ts`, add to the catalog (next to `'skip'`):

```ts
  'age': { en: 'age {n}', ko: '{n}일 경과' },
  'age-forced': { en: 'age {n} — forced exit', ko: '{n}일 경과 — 강제 청산' },
```

In `packages/telegram/src/digest.ts`: change the sell-loc loop (:17) to `for (const o of sellLocs) lines.push(sellLocLine(o, lang, ages))` and replace the two line builders (:56–68) with:

```ts
function orderAge(o: PlannedOrder, ages?: Record<number, number>): number | undefined {
  return o.ageDays ?? ages?.[o.bucketIndex]
}

function sellLocLine(o: PlannedOrder, lang: Lang, ages?: Record<number, number>): string {
  const verb = lang === 'ko' ? '매도' : 'Sell'
  const age = orderAge(o, ages)
  const ageClause = age !== undefined ? `  (${t('age', lang, { n: age })})` : ''
  return `${verb}  LOC  ${o.shares} sh  @ ${formatUsd(o.limitPrice)}  → bucket ${o.bucketIndex}${ageClause}`
}

function marketSellLine(o: PlannedOrder, lang: Lang, ages?: Record<number, number>): string {
  const age = orderAge(o, ages)
  const ageClause = age !== undefined ? `  (${t('age-forced', lang, { n: age })})` : ''
  if (lang === 'ko') {
    return `매도  MARKET  ${o.shares} sh  bucket ${o.bucketIndex}${ageClause}`
  }
  return `Market  SELL  ${o.shares} sh  bucket ${o.bucketIndex}${ageClause}`
}
```

The en catalog values reproduce the current hard-coded clause byte-for-byte, so the existing `en market sell age exact` test must pass untouched. Note `orderAge`'s `??`: age 0 is a real age and must render.

- [ ] **Step 4: Run tests** — `bun test packages/telegram` → all pass, zero existing assertions edited.

- [ ] **Step 5: Commit**

```bash
git add packages/telegram/src/i18n.ts packages/telegram/src/digest.ts packages/telegram/test/digest.test.ts
git commit -m "feat: show and translate bucket age in digest sell lines"
```

---

### Task 3: Web — age in the bucket cell, reason next to Cancelled

**Files**
- Modify: `apps/web/src/api.types.ts` (`SimOrderDto`)
- Modify: `apps/web/src/viewmodels.ts` (new `skipReasons`)
- Modify: `apps/web/src/components/SimReplay.tsx`
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Test: `apps/web/src/viewmodels.test.ts`

**Interfaces**
- Consumes: `PlannedOrder.ageDays` on `planJson` (Task 1; arrives as `ageDays?: number` on the plan DTO), legacy `skips`/`notices` on old stored plans.
- Produces: `skipReasons(plan, t): Map<number, string>` (0-based bucket index → translated reason text); catalog keys `simOrderAge`, `digest.sell-capped` in web catalogs.

- [ ] **Step 1: Write the failing tests** — append to `apps/web/src/viewmodels.test.ts` (add `skipReasons` to its `./viewmodels` import and `SimPlanDto` to its `./api` type imports — match that file's existing import style):

```ts
describe('skipReasons', () => {
  const t = (key: string, vars?: Record<string, string | number>) =>
    key === 'digest.sell-capped' ? `sell capped (price ${vars?.price})` : key;

  test('pairs a skip with the first unconsumed notice for its bucket', () => {
    const plan = {
      orders: [],
      skips: [{ kind: 'sell_loc', bucketIndex: 3, limitPrice: '0', shares: 10 }],
      notices: [
        { code: 'sell-capped', params: { bucket: 3, price: 340 } },
      ],
    } as unknown as SimPlanDto;
    expect(skipReasons(plan, t).get(3)).toBe('sell capped (price 340)');
  });

  test('pairing matches on bucket regardless of notice code — first wins', () => {
    const plan = {
      orders: [],
      skips: [{ kind: 'sell_loc', bucketIndex: 3, limitPrice: '0', shares: 10 }],
      notices: [
        { code: 'other', params: { bucket: 3 } },
        { code: 'sell-capped', params: { bucket: 3, price: 340 } },
      ],
    } as unknown as SimPlanDto;
    // Pins renderDigest semantics (digest.ts:22): findIndex takes the first
    // *unconsumed* notice with a matching bucket param, whatever its code.
    expect(skipReasons(plan, t).get(3)).toBe('digest.other');
  });

  test('a skip with no matching notice gets no reason', () => {
    const plan = {
      orders: [],
      skips: [{ kind: 'sell_loc', bucketIndex: 1, limitPrice: '0', shares: 10 }],
      notices: [{ code: 'sell-capped', params: { bucket: 5, price: 340 } }],
    } as unknown as SimPlanDto;
    expect(skipReasons(plan, t).has(1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `bun test apps/web/src/viewmodels.test.ts` → fails to import `skipReasons`.

- [ ] **Step 3: Implement.**

`apps/web/src/api.types.ts` — in `SimOrderDto` add `ageDays?: number;` (old stored plans lack it).

`apps/web/src/viewmodels.ts` — add (import `SimPlanDto` alongside its existing `./api` type imports):

```ts
/** Skip rows → their cancellation reason, paired the same way as the Telegram
 * digest: first unconsumed notice whose `bucket` param matches (0-based). */
export function skipReasons(
  plan: SimPlanDto,
  t: (key: string, vars?: Record<string, string | number>) => string,
): Map<number, string> {
  const out = new Map<number, string>();
  const notices = plan.notices ?? [];
  const used = new Set<number>();
  for (const s of plan.skips ?? []) {
    const idx = notices.findIndex((n, i) => !used.has(i) && n.params?.bucket === s.bucketIndex);
    if (idx >= 0) {
      used.add(idx);
      out.set(s.bucketIndex, t(`digest.${notices[idx].code}`, notices[idx].params));
    }
  }
  return out;
}
```

`apps/web/src/components/SimReplay.tsx` — in the component that renders the Planned orders card (has `day` and `const t = useT()` in scope), compute `const reasons = skipReasons(day.planJson, t);` before the return, add `skipReasons` to its `../viewmodels` import, then:

Orders map bucket cell (:151) becomes:

```tsx
<Td className="text-right tabular-nums">
  {o.bucketIndex + 1}
  {o.kind !== 'buy_loc' && o.ageDays !== undefined && (
    <span className="ml-1 text-xs text-muted-foreground">· {t('simOrderAge', { n: o.ageDays })}</span>
  )}
</Td>
```

Skips map (:156–165) — same bucket-cell treatment (no `kind` guard needed; skips are sell-side and the field only exists on stamped sells), and its first cell becomes:

```tsx
<Td>
  <Badge tone="neutral">{t('orderStatusCancelled')}</Badge>
  {reasons.has(o.bucketIndex) && (
    <span className="ml-1 text-xs text-muted-foreground">· {reasons.get(o.bucketIndex)}</span>
  )}
</Td>
```

Catalogs — `apps/web/src/i18n/en.json`, keeping each key in the file's existing sorted neighborhood (`digest.sell-capped` between `digest.no-bucket-available` and `digest.shares-zero`; `simOrderAge` among the `sim*` keys):

```json
"digest.sell-capped": "sell capped (price {price})",
"simOrderAge": "{n}d",
```

`apps/web/src/i18n/ko.json`:

```json
"digest.sell-capped": "매도 상한 (가격 {price})",
"simOrderAge": "{n}일",
```

(`digest.sell-capped` matches the removed-in-3775707 telegram wording only as a web-only legacy key so notices on old sim runs render instead of falling through to the raw key. Do **not** re-add it to the telegram catalog.)

- [ ] **Step 4: Run tests + typecheck** — `bun test apps/web` → all pass including `catalog.test.ts` (key & placeholder parity). Then `bun run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api.types.ts apps/web/src/viewmodels.ts apps/web/src/viewmodels.test.ts apps/web/src/components/SimReplay.tsx apps/web/src/i18n/en.json apps/web/src/i18n/ko.json
git commit -m "feat: show bucket age and cancellation reason in sim planned orders"
```

---

### Task 4: Full verification

- [ ] `bun test` → 0 failures (was 207 pass / 7 skip / 5 new tests → expect ~212 pass / 7 skip; exact pass count may differ, **failures must be 0**).
- [ ] `bun run typecheck` → clean.
- [ ] `git status` → only untracked files are the spec + this plan; commit them:

```bash
git add docs/superpowers/specs/2026-11-11-planned-orders-age-cancel-design.md docs/superpowers/plans/2026-11-11-planned-orders-age-cancel.md
git commit -m "docs: planned orders age and cancellation reason spec and plan"
```

## Out of scope (per spec)

- No `reason` field on `PlannedOrder`; no age on buy rows; `OrderTable`/pending flow untouched.
- No DB migration; no backfill of old sim runs.
- `sell-capped` stays out of the telegram catalog; no new skip producer.
