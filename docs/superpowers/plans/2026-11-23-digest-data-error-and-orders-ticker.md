# Named data-error warning (#75) and ticker in /orders (#83) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The morning digest's market-data warning names the failed run, one message per failed run; Telegram `/orders` shows each order's ticker.

**Architecture:** #75 is local to `runMorningPipeline` (`apps/server/src/pipeline/day.ts`): both failure paths call one helper that renders the run-named warning, sends it to every allowed chat and logs one notification row per chat against the run. #83 is local to `onOrders` (`apps/server/src/wire/capture.ts`): one `runRepo.list()` call builds an id → ticker map. No schema, repo or type changes.

**Tech Stack:** Bun + TypeScript, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-11-23-digest-data-error-and-orders-ticker-design.md`

## Global Constraints

- `warn-data-error` copy, verbatim (both in `packages/telegram/src/i18n.ts` and `apps/web/src/i18n/{en,ko}.json` key `digest.warn-data-error`):
  - en: `Market data error — run #{id} {ticker}: last close unavailable or stale. Today's orders for this run could not be computed.`
  - ko: `시세 데이터 오류 — 런 #{id} {ticker}: 최근 종가를 가져올 수 없습니다. 오늘 런의 주문을 계산할 수 없습니다.`
- New key `orders-run-missing`, verbatim: en `run #{id}`, ko `런 #{id}` (telegram catalog only).
- `orders-line` copy unchanged.
- All user-facing copy via the en/ko catalogs; en and ko carry the same placeholders.
- No source file over ~300 lines; commit style `feat|fix|docs|test|refactor|chore:`.
- `bun test` and `bun run typecheck` both pass at the end of every task.

## Review Focus

1. An order whose run is archived/closed — `/orders` must still show its ticker (look up all runs, not only active ones). Pinned in Task 2.
2. An order whose run no longer exists (`orders` has no FK) — shows `run #<runId>`, never blank. Pinned in Task 2.
3. Several failed runs and several chats — every chat gets one warning per failed run, each naming its own run, and notification rows match sends one for one. Pinned in Task 1.
4. Korean digest language — the ko copy renders with the run's id and ticker. Pinned in Task 1 (warning) and Task 2 (fallback).
5. One run fails, another succeeds — the warning names only the failed run and the healthy run's digest still goes out. Pinned in Task 1 (d2).

---

### Task 1: Name the run in the morning data-error warning (#75)

**Files:**
- Modify: `packages/telegram/src/i18n.ts` (`warn-data-error` entry)
- Modify: `apps/server/src/pipeline/day.ts:66-101` (failure paths in the per-run loop)
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json` (`digest.warn-data-error`)
- Test: `apps/server/test/day.test.ts`

**Interfaces:**
- Consumes: `t(code, lang, params)` from `@st/telegram/i18n`; `deps.repos.notificationRepo.insert({ runId, chatId, text })`.
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the failing tests** in `apps/server/test/day.test.ts`

Define once near the top of the describe block:

```ts
const WARN_EN = (id: number, tk: string) => `Market data error — run #${id} ${tk}: last close unavailable or stale. Today's orders for this run could not be computed.`
```

Change `(d) data-error` (single TSLA run id 1, chat `c1`, stale close date): keep the existing assertions, and add

```ts
expect(sends).toEqual([WARN_EN(1, 'TSLA')])
expect(f.notifications.map((n) => ({ runId: n.runId, chatId: n.chatId, text: n.text }))).toEqual([
  { runId: 1, chatId: 'c1', text: WARN_EN(1, 'TSLA') },
])
```

Change `(d2)`: keep its assertions, and add

```ts
const warnings = sends.filter((s) => s.includes('Market data error'))
expect(warnings).toEqual([WARN_EN(badId, 'BADA')])
expect(f.notifications.filter((n) => n.text.includes('Market data error')).map((n) => n.runId)).toEqual([badId])
```

Add `(d3) every failed run gets its own named warning in every chat`: runs created in order `BADA` (fetch throws), `STAL` (returns `{ date: '2026-11-04', ... }`, stale for today `2026-11-06`), `AAPL` (returns `{ date: '2026-11-05', close: 3402300n }`, with `cashCents = 1000000`); `allowedChatIds: ['c1', 'c2']`; `send` records `{ chatId, text }`. Assert:

```ts
expect(r).toBe('sent')
const warns = sent.filter((s) => s.text.includes('Market data error'))
expect(warns).toEqual([
  { chatId: 'c1', text: WARN_EN(1, 'BADA') },
  { chatId: 'c2', text: WARN_EN(1, 'BADA') },
  { chatId: 'c1', text: WARN_EN(2, 'STAL') },
  { chatId: 'c2', text: WARN_EN(2, 'STAL') },
])
expect(f.notifications.filter((n) => n.text.includes('Market data error')).map((n) => ({ runId: n.runId, chatId: n.chatId, text: n.text }))).toEqual(
  warns.map((w, i) => ({ runId: i < 2 ? 1 : 2, chatId: w.chatId, text: w.text })),
)
expect(sent.some((s) => s.text.includes('AAPL') && !s.text.includes('Market data error'))).toBe(true)
```

Add `(d4) data-error warning in Korean`: as (d) with `digestLang: 'ko'`; assert

```ts
expect(sends).toEqual(['시세 데이터 오류 — 런 #1 TSLA: 최근 종가를 가져올 수 없습니다. 오늘 런의 주문을 계산할 수 없습니다.'])
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/server/test/day.test.ts`
Expected: FAIL — (d), (d2), (d3), (d4) fail on the warning text / notification `runId` / warning count.

- [ ] **Step 3: Update the copy**

Set `warn-data-error` in `packages/telegram/src/i18n.ts` and `digest.warn-data-error` in both web JSON catalogs to the Global Constraints text (web keys stay where they are; ordering is unchanged).

- [ ] **Step 4: Implement in `day.ts`**

Inside the per-run loop, replace both duplicated failure blocks with one local helper (e.g. `async function warnDataError(run: RunRow): Promise<void>`) that renders `t('warn-data-error', lang, { id: run.id, ticker: run.ticker })`, and for each allowed chat sends it then inserts `{ runId: run.id, chatId, text }`. Both failure paths do `numFailed++`, call the helper, `continue`. Remove `warnedData`. The `MorningResult` logic is unchanged.

- [ ] **Step 5: Verify**

Run: `bun test apps/server/test/day.test.ts packages/telegram apps/web/src/catalog.test.ts`
Expected: PASS.
Run: `bun test` and `bun run typecheck`
Expected: 0 failures; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/telegram/src/i18n.ts apps/server/src/pipeline/day.ts apps/server/test/day.test.ts apps/web/src/i18n/en.json apps/web/src/i18n/ko.json
git commit -m "fix: name the run in the morning data-error warning (#75)"
```

---

### Task 2: Show each order's ticker in Telegram /orders (#83)

**Files:**
- Modify: `packages/telegram/src/i18n.ts` (add `orders-run-missing` right after `orders-line`)
- Modify: `apps/server/src/wire/capture.ts:257-270` (`onOrders`; drop the `OrderRecord` import if it becomes unused)
- Test: `apps/server/test/wire.test.ts:905-914`

**Interfaces:**
- Consumes: `deps.repos.runRepo.list(): Promise<RunRow[]>` (all runs, any status); `activeRun(id, ticker)` and `makeCapture({ runs, lang })` test helpers already in `wire.test.ts`.
- Produces: nothing other tasks use.

- [ ] **Step 1: Rewrite the failing test** `onOrders lists orders due today and says so when empty`

Keep the empty case. Replace the order part: runs `[activeRun(1, 'NVDA'), { ...activeRun(2, 'AAPL'), status: 'closed' }]`; orders typed plainly as `OrderRecord[]` (no `ticker` field, no intersection type):
- `{ id: 1, runId: 1, kind: 'buy_loc', limitPrice: parseUsd('170.00'), shares: 10, ... }`
- `{ id: 2, runId: 2, kind: 'sell_loc', limitPrice: parseUsd('200.00'), shares: 5, ... }`
- `{ id: 3, runId: 9, kind: 'buy_loc', limitPrice: parseUsd('50.00'), shares: 1, ... }` (run 9 does not exist)

(all with `bucketIdx: 0, tradeDate: '2026-11-10', status: 'open', skipReason: null, cancelReason: null`). Assert:

```ts
expect(h.sent[1]!.text).toBe('#1 buy_loc NVDA 10 sh @ $170.00\n#2 sell_loc AAPL 5 sh @ $200.00\n#3 buy_loc run #9 1 sh @ $50.00')
```

Add `onOrders names a missing run in Korean`: `makeCapture({ runs: [], lang: 'ko' })`, one order `{ id: 3, runId: 9, kind: 'buy_loc', limitPrice: parseUsd('50.00'), shares: 1, ... }`; assert

```ts
expect(h.sent[0]!.text).toBe('#3 buy_loc 런 #9 1주 @ $50.00')
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/server/test/wire.test.ts -t onOrders`
Expected: FAIL — tickers render blank.

- [ ] **Step 3: Add the catalog key** `orders-run-missing` (Global Constraints copy).

- [ ] **Step 4: Implement in `onOrders`**

After the empty check, call `deps.repos.runRepo.list()` once, build `Map<number, string>` of run id → ticker, and pass `tickers.get(o.runId) ?? t('orders-run-missing', lang, { id: o.runId })` as `ticker`. Remove the cast and its comment.

- [ ] **Step 5: Verify**

Run: `bun test apps/server/test/wire.test.ts packages/telegram`
Expected: PASS.
Run: `bun test` and `bun run typecheck`
Expected: 0 failures; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/telegram/src/i18n.ts apps/server/src/wire/capture.ts apps/server/test/wire.test.ts
git commit -m "fix: show each order's ticker in Telegram /orders (#83)"
```
