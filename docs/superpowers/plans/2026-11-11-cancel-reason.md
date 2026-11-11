# Cancel-Reason Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cancelling a limit order from the web requires picking one of four reasons; the reason is stored, shown in the orders table, and pushed to Telegram.

**Architecture:** New `orders.cancel_reason` column + `orderRepo.get/setStatus(reason)` (Task 1) → `cancelOrder` domain function enforcing open-only, same-run, valid-reason (Task 2) → `POST /runs/:id/orders/:orderId/cancel` route that also renders the telegram `order-cancelled` text, records notifications and sends to allowed chats (Task 3) → web Cancel button + reason dropdown modal + reason display (Task 4).

**Tech Stack:** Bun, TypeScript, Hono, Drizzle (mysql-core), Grammy-free server-side telegram i18n, React + i18next-style catalogs.

**Spec:** `docs/superpowers/specs/2026-11-11-cancel-reason-design.md`

## Global Constraints

- All user-facing copy through en/ko catalogs (`apps/web/src/i18n/{en,ko}.json`, `packages/telegram/src/i18n.ts` CATALOG).
- Money stays bigint myriadths; format for display via `formatUsd` from `@st/core/money`.
- Reason codes (exact kebab strings, used in DB, API and catalogs): `broker-filled`, `strategy-change`, `stale-price`, `other`.
- No source file > ~300 lines; `packages/*` never import `apps/*`.
- Existing tests are assertions-invisible: do not edit existing test expectations; only add tests (updating a test *fake's* method signature to match a widened interface is allowed).
- Commit style: `feat|fix|docs|test|chore:`.
- Run everything from the repo root (worktree root).

## Review Focus

- Cancelling an order that is already `filled`/`stale`/`cancelled` → 409 `order-not-open`, no status change, no Telegram send (pinned in Task 2 + Task 3).
- Missing, non-string, or unknown `reason` body → 400 `invalid-reason`, order untouched (Task 2 + Task 3).
- `orderId` belonging to a different run (or unknown) → 404 `order-not-found` (Task 2 + Task 3).
- Bot disabled / `allowedChats` empty → cancel still succeeds, zero notification rows, no crash (Task 3).
- Old `cancelled` rows with `cancelReason: null` in the web table render exactly as before (empty reason cell) (Task 4).

---

### Task 1: DB column + order repo support

**Files:**
- Modify: `apps/server/src/db/schema.ts` (the `orders` table)
- Create: `apps/server/db/migrations/*_*.sql` (generated)
- Modify: `apps/server/src/db/repos.ts` (`orderRepo`)
- Test: `apps/server/test/db.test.ts` (append inside the existing `describeIf` block)

**Interfaces:**
- Consumes: nothing new.
- Produces: `orders.cancelReason` (`varchar('cancel_reason', { length: 32 })`, nullable) on the selected row shape; `orderRepo.get(id: number): Promise<any | null>`; `orderRepo.setStatus(id: number, status: string, cancelReason?: string): Promise<void>` — when `cancelReason` is provided it is written together with `status`.

- [ ] **Step 1: Write the failing integration test** in `apps/server/test/db.test.ts`, inside `describeIf('db integration', ...)`:

```ts
test('order cancel reason round trip', async () => {
  const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'RT' + Date.now(), name: `rt-cancel-${Date.now()}`, poolCents: 1000, costPpm: 10 })
  await repos.orderRepo.insertMany([{
    runId, tradeDate: '2026-11-11', kind: 'sell_loc', bucketIdx: 0,
    limitPrice: 35000000n, shares: 5, status: 'open',
  }])
  const rows = await repos.orderRepo.listForDate('2026-11-11')
  const open = rows.find((o: any) => o.runId === runId)
  expect(open).toBeTruthy()
  expect(open.cancelReason).toBeNull()

  const fetched = await repos.orderRepo.get(open.id)
  expect(fetched!.id).toBe(open.id)
  expect(await repos.orderRepo.get(999999999)).toBeNull()

  await repos.orderRepo.setStatus(open.id, 'cancelled', 'stale-price')
  const after = await repos.orderRepo.get(open.id)
  expect(after!.status).toBe('cancelled')
  expect(after!.cancelReason).toBe('stale-price')

  await repos.orderRepo.setStatus(open.id, 'open') // legacy call: must not clear nor set a reason
  expect((await repos.orderRepo.get(open.id))!.cancelReason).toBe('stale-price')
})
```

Match the real `runRepo.create` signature — `apps/server/src/db/repos.ts:27` takes `{ strategyKey, ticker, name, poolCents, costPpm, initialRunState? }` and resolves to the numeric `runId` (see the `'orders markStale'` test at `db.test.ts:49-62` for the exact call shape). There is no `stateJson` parameter.

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL="mysql://root:test@127.0.0.1:3307/st_test" bun test apps/server/test/db.test.ts`
Expected: FAIL (`cancelReason` undefined — column missing / `orderRepo.get` not a function).

- [ ] **Step 3: Add the column** in `apps/server/src/db/schema.ts` `orders` table, next to `skipReason`:

```ts
cancelReason: varchar('cancel_reason', { length: 32 }),
```

Then generate the migration from the repo root: `bun run --cwd apps/server db:generate` (creates a new SQL + meta snapshot in `apps/server/db/migrations/`; it must contain `ALTER TABLE \`orders\` ADD \`cancel_reason\` varchar(32);`).

- [ ] **Step 4: Implement repo methods** in `apps/server/src/db/repos.ts` `orderRepo`:

```ts
async get(id: number) {
  const rows = await db.select().from(s.orders).where(eq(s.orders.id, id))
  return rows[0] ?? null
},
```

and widen `setStatus` to `(id: number, status: string, cancelReason?: string)`, setting `{ status, ...(cancelReason !== undefined ? { cancelReason } : {}) }` in the existing single-row update.

- [ ] **Step 5: Run the DB tests to verify they pass**

Run: `TEST_DATABASE_URL="mysql://root:test@127.0.0.1:3307/st_test" bun test apps/server/test/db.test.ts`
Expected: PASS (migrations auto-apply in `beforeAll`).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/db/migrations apps/server/src/db/repos.ts apps/server/test/db.test.ts
git commit -m "feat: cancel_reason column with orderRepo.get and reason-aware setStatus"
```

---

### Task 2: `cancelOrder` domain function

**Files:**
- Modify: `apps/server/src/domain/booking.ts`
- Test: `apps/server/test/booking.test.ts` (append; widen the fake `orderRepo.setStatus` to accept the third arg and add a fake `get`)

**Interfaces:**
- Consumes: Task 1 `orderRepo.get` / `setStatus(id, status, reason?)` (also on the test fake).
- Produces: `export const CANCEL_REASONS = ['broker-filled', 'strategy-change', 'stale-price', 'other'] as const` and
  `export async function cancelOrder(runId: number, orderId: number, reason: string, deps: BookingDeps): Promise<any>` in `booking.ts` — resolves with the updated order row (`status: 'cancelled'`, `cancelReason: reason`); throws `Error('invalid-reason')`, `Error('order-not-found')` (unknown id **or** different run), or `Error('order-not-open')` (status !== 'open'). `RepoSurface.orderRepo` gains `get(id: number): Promise<any | null>` and the optional `cancelReason` on `setStatus`.

- [ ] **Step 1: Write the failing tests** in `booking.test.ts`. The file exports a shared `fakeRepos()` builder (~:25) returning `{ repos, _stores: { runs, orders, fills, pending, captures, ledger } }`; there is **no** `makeFixture`. Every test does its own `const f = fakeRepos()` and `const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }`. The fake `orderRepo` (~:57-67) has `insertMany` that pushes `{ id: orderSeq++, ...o }` onto the shared `orders` array and returns nothing — so insert via `insertMany` and read the id back from `f._stores.orders`. Two fakes must be widened (fakes are test code — allowed): add `async get(id: number) { return orders.find((x) => x.id === id) ?? null }` and make `setStatus` accept `(id, status, cancelReason?)` applying `if (cancelReason !== undefined) o.cancelReason = cancelReason`.

```ts
test('cancelOrder marks open order cancelled with reason', async () => {
  const f = fakeRepos()
  const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'C1', name: 'c1', poolCents: 100, costPpm: 0 })
  await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-11', kind: 'sell_loc', bucketIdx: 1, limitPrice: 200n, shares: 5, status: 'open' }])
  const id = f._stores.orders[0].id
  const order = await cancelOrder(runId, id, 'strategy-change', { repos: f.repos as any, today: '2026-11-11' })
  expect(order.status).toBe('cancelled')
  expect(order.cancelReason).toBe('strategy-change')
})
test('cancelOrder rejects unknown, foreign-run, and non-open orders', async () => {
  // cancelOrder(runId, 99999, 'other', deps) → rejects 'order-not-found'
  // order whose runId is a different run → 'order-not-found'
  // order with status: 'filled' → 'order-not-open'; assert the stored row's status is still 'filled'
})
test('cancelOrder rejects unknown reason', async () => {
  // cancelOrder(runId, id, 'because-i-said-so', deps) → rejects 'invalid-reason'; stored row stays 'open'
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/server/test/booking.test.ts`
Expected: FAIL (`cancelOrder` not exported / fake missing `get`).

- [ ] **Step 3: Implement** `CANCEL_REASONS` + `cancelOrder` in `booking.ts` per the Interfaces block: validate reason first (no DB touch), then `orderRepo.get`, then run/status checks, then `setStatus(orderId, 'cancelled', reason)`, then return the merged row. Update the `RepoSurface.orderRepo` type.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/server/test/booking.test.ts` — all green, existing expectations untouched.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/domain/booking.ts apps/server/test/booking.test.ts
git commit -m "feat: cancelOrder domain function with reason validation"
```

---

### Task 3: HTTP route + Telegram notification + telegram copy

**Files:**
- Modify: `packages/telegram/src/i18n.ts` (CATALOG)
- Modify: `apps/server/src/http/app.ts` (`HttpDeps` — two new required fields)
- Modify: `apps/server/src/http/routes/runs.ts`
- Modify: `apps/server/src/main.ts` (wire new deps)
- Test: `apps/server/test/http.test.ts`, `packages/telegram/test/digest.test.ts`
- Modify (fake widening forced by the new required `HttpDeps` fields — there are three `HttpDeps` construction sites): `apps/server/test/sim.test.ts` (its own local `makeDeps`, ~:223), `scripts/e2e.ts` (`const httpDeps: HttpDeps`, ~:91)

**Interfaces:**
- Consumes: Task 2 `cancelOrder` / `CANCEL_REASONS`; `deps.repos.notificationRepo.insert({ runId, chatId, text })` (existing shape, used by `pipeline/day.ts:130`).
- Produces: `POST /api/runs/:id/orders/:orderId/cancel` — body `{ reason: string }`; 200 `{ ok: true }`, 400 `{ error: 'invalid-reason' }`, 404 `{ error: 'order-not-found' }`, 409 `{ error: 'order-not-open' }`. On success, for each `deps.allowedChatIds` entry: one `notificationRepo.insert({ runId, chatId, text })` then one `deps.send(chatId, text)` (insert first — the durable record wins over the transport, unlike `day.ts`'s send-first order; ruling in the ledger), where text = `tgT('order-cancelled', deps.defaultSettings.digestLang, { kind, bucket, price, reason })` with `reason = tgT('reason-' + code, lang)`, `bucket = order.bucketIdx` (raw, 0-based, matching `packages/telegram/src/digest.ts:29,53`) and `price = formatUsd(order.limitPrice)` (no `$` — `formatUsd` in `packages/core/src/money.ts` returns `"3.50"`, and no telegram string in this repo carries a currency sign); `tgT` is `t` from `@st/telegram/i18n` (server-side precedent: `pipeline/day.ts:6`). New `HttpDeps` fields (required, named to match `DayDeps`): `allowedChatIds: string[]`, `send: (chatId: string, text: string) => Promise<void>`. No new `digestLang` field — `deps.defaultSettings.digestLang` already exists (`app.ts:22`). CATALOG gains keys `order-cancelled`, `reason-broker-filled`, `reason-strategy-change`, `reason-stale-price`, `reason-other`.
- Note: there is no `HttpError` class and no `app.onError` in this repo — every route maps its own errors inline (`pending.ts:14-18`, `runs.ts:105-113`), so the new route does the same.

- [ ] **Step 1: Write the failing catalog test** in `packages/telegram/test/digest.test.ts`. That file does **not** import `t` today (it imports `renderDigest, renderClosed, renderReminder` from `'../src/digest'`) — add `import { t } from '../src/i18n';` to its import block:

```ts
test('order-cancelled renders in both languages', () => {
  expect(t('order-cancelled', 'ko', { kind: 'sell_loc', bucket: 2, price: '3.50', reason: t('reason-strategy-change', 'ko') }))
    .toBe('🚫 취소: sell_loc 버킷 2 — 전략 변경 (3.50)')
  expect(t('order-cancelled', 'en', { kind: 'buy_loc', bucket: 0, price: '1.00', reason: t('reason-broker-filled', 'en') }))
    .toBe('🚫 Cancelled: buy_loc bucket 0 — filled elsewhere at broker (1.00)')
})
```

(`t`'s interpolator is `{name}` single-brace — `packages/telegram/src/i18n.ts:46-51`.)

- [ ] **Step 2: Run to verify it fails**, then add the five CATALOG entries with exactly the strings above (en/ko pairs): `order-cancelled` en `'🚫 Cancelled: {kind} bucket {bucket} — {reason} ({price})'` / ko `'🚫 취소: {kind} 버킷 {bucket} — {reason} ({price})'`; `reason-broker-filled` `'filled elsewhere at broker'` / `'증권사에서 별도 체결'`; `reason-strategy-change` `'strategy change'` / `'전략 변경'`; `reason-stale-price` `'price no longer valid'` / `'가격 무효화'`; `reason-other` `'other'` / `'기타'`. Re-run → PASS.

- [ ] **Step 3: Write the failing route tests** in `http.test.ts`. There is no auth helper in this file — copy the inline login used by every existing test (`const lr = await app.request('/api/login', …)` → `const auth = { Authorization: `Bearer ${token}` }`), and see the neighbouring POST test at ~:281 for shape. Update the shared builders in one place:
  - `makeFakes()` (~:7): add `sent: { chatId: string; text: string }[]` alongside the existing `orders` / `notifications` arrays and add it to the returned object; the fake `orderRepo` needs `async get(id) { return orders.find((x) => x.id === id) ?? null }` and its `setStatus` must accept and apply an optional third `cancelReason` arg (`if (cancelReason !== undefined) o.cancelReason = cancelReason`).
  - `makeDeps(fakes)` (~:104): add `allowedChatIds: ['42']` and `send: async (chatId: string, text: string) => { fakes.sent.push({ chatId, text }) }`.

```ts
test('cancel order: happy path stores reason, notifies each allowed chat', async () => {
  // push an open order onto the fake `orders` store, then POST /api/runs/<runId>/orders/<id>/cancel
  const res = await app.request(`/api/runs/${runId}/orders/${id}/cancel`, {
    method: 'POST', headers: auth, body: JSON.stringify({ reason: 'stale-price' }),
  })
  expect(res.status).toBe(200)
  const row = orders.find((o) => o.id === id)!
  expect(row.status).toBe('cancelled')
  expect(row.cancelReason).toBe('stale-price')
  expect(notifications.filter((n) => n.runId === runId)).toHaveLength(1)
  expect(notifications.find((n) => n.runId === runId)!.text).toContain('Cancelled')
  expect(sent).toEqual([{ chatId: '42', text: notifications.find((n) => n.runId === runId)!.text }])
})
test('cancel order: 400 invalid-reason, 404 unknown order, 409 not open', async () => {
  // reason 'nope' → 400 { error: 'invalid-reason' }, order still open, notifications/sent unchanged
  // unknown orderId → 404 { error: 'order-not-found' }
  // status 'filled' order → 409 { error: 'order-not-open' }, row stays 'filled'
})
test('cancel order succeeds with no allowed chats: 200, no notification rows, no sends', async () => {
  // deps.allowedChatIds = [] → 200; notifications for the run stay empty; sent stays empty
})
```

- [ ] **Step 4: Run to verify they fail**, then implement:
  - `app.ts`: add `allowedChatIds: string[]` and `send: (chatId: string, text: string) => Promise<void>` to `HttpDeps` (do NOT add `digestLang` — `defaultSettings.digestLang` already exists).
  - `runs.ts`: add `r.post('/runs/:id/orders/:orderId/cancel', ...)`. Follow the file's inline style: `const body = await c.req.json().catch(() => ({}))`, then
    ```ts
    try {
      await cancelOrder(id, orderId, body?.reason, { repos: deps.repos as any, today: deps.today() })
    } catch (e: any) {
      const code = e?.message
      if (code === 'invalid-reason') return c.json({ error: 'invalid-reason' }, 400)
      if (code === 'order-not-found') return c.json({ error: 'order-not-found' }, 404)
      if (code === 'order-not-open') return c.json({ error: 'order-not-open' }, 409)
      return c.json({ error: code ?? 'error' }, 422)
    }
    ```
    then build the text and loop `deps.allowedChatIds` doing insert **then** `deps.send` (insert first, per the Interfaces note). Add imports: `cancelOrder` from `../../domain/booking`, `t as tgT` from `'@st/telegram/i18n'`, and `formatUsd` next to the existing `parseUsd` from `'@st/core/money'`.
  - `main.ts`: add `allowedChatIds: tg?.allowedChatIds ?? []` and `send` to the `createApp({...})` call (the local `send` function at ~:29 and `tg` at ~:46 are both in scope there).
  - `apps/server/test/sim.test.ts` (its own local `makeDeps`, ~:223) and `scripts/e2e.ts` (~:91) construct `HttpDeps` too — add `allowedChatIds: []` and a no-op/`sends`-pushing `send` to each so `bun run typecheck` stays clean. Do not change their assertions.

- [ ] **Step 5: Run the server suite + typecheck**

Run: `bun test apps/server/test/http.test.ts && bun run typecheck`
Expected: PASS / clean (typecheck also compiles main.ts, sim.test.ts and scripts/e2e.ts wiring).

- [ ] **Step 6: Commit**

```bash
git add packages/telegram/src/i18n.ts packages/telegram/test/digest.test.ts apps/server/src/http apps/server/src/main.ts apps/server/test/http.test.ts apps/server/test/sim.test.ts scripts/e2e.ts
git commit -m "feat: order cancel route with Telegram notification"
```

---

### Task 4: Web — cancel button, reason modal, reason display

**Files:**
- Modify: `apps/web/src/api.types.ts` (`OrderDto`), `apps/web/src/api.ts`, `apps/web/src/viewmodels.ts`, `apps/web/src/components/OrderTable.tsx`, `apps/web/src/components/RunPanels.tsx` (`OrdersPanel`), `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Test: `apps/web/src/viewmodels.test.ts` (append)

**Interfaces:**
- Consumes: Task 3 route `POST /api/runs/:id/orders/:orderId/cancel`.
- Produces: `OrderDto.cancelReason: string | null` (server `listForRun` does `select()` on the whole table, so the field arrives once Task 1 lands); `api.cancelOrder(runId: number, orderId: number, reason: string): Promise<void>`; `export const CANCEL_REASONS = ['broker-filled', 'strategy-change', 'stale-price', 'other'] as const` and `export function orderReasonText(o: { status: string; skipReason: string | null; cancelReason: string | null }, t: (key: string) => string): string` in `viewmodels.ts` (cancel reason wins on `cancelled` rows via `reasonKey('cancelReason', code)`, skip reason otherwise, `''` when neither or `cancelReason` is null); `OrderTable` gains optional prop `onCancel?: (orderId: number, reason: string) => Promise<void>` — when provided, a trailing `orderColAction` column with a `t('orderCancelBtn')` button on `status === 'open'` rows opens a `Modal` (from `./ui`) with a `Select` over `CANCEL_REASONS` plus confirm/cancel buttons; `OrdersPanel` supplies `onCancel` = `api.cancelOrder(runId, …)` then its **own** `reload()`.
- Facts to code against: `Modal` has exactly `{ title, onClose, children }` — no `onConfirm`/footer props (`apps/web/src/components/ui.tsx:157`), so buttons are children, following the run-close confirm modal at `apps/web/src/pages/RunDetail.tsx:174-191`. `Button` variants are `'primary' | 'secondary' | 'danger'` with a `busy` prop. `Select` is a plain `React.SelectHTMLAttributes<HTMLSelectElement>`. There is no `OrderRow` type in `apps/web` — `OrderTable` takes `OrderDto[]`, imported as `import type { OrderDto } from '../api';` (api.ts re-exports `api.types.ts`). The reason cell today renders `o.skipReason ? t(enumLabelKey('orderReason', o.skipReason)) : '—'`, so the empty state is an **em dash**, not an empty string.
- Catalog files are FLAT JSON with literal camelCase keys (`apps/web/src/i18n/catalog.ts` merges `en.json` + `ko.json` side by side), so `"cancelReasonStalePrice"` is a literal top-level key. Keys `cancel` ("Cancel"/"취소") and `confirm` ("Confirm"/"확인") already exist — reuse them, do not add `orderCancelConfirm`. `apps/web/src/catalog.test.ts` fails the suite if en/ko key sets or `{placeholder}` sets diverge, so add every new key to BOTH files in the same commit.

- [ ] **Step 1: Write the failing viewmodels test** in `viewmodels.test.ts`:

```ts
test('orderReasonText: cancel reason wins, null-safe for old rows', () => {
  const t = (k: string) => `«${k}»`;
  expect(orderReasonText({ status: 'cancelled', skipReason: null, cancelReason: 'stale-price' }, t)).toBe('«cancelReasonStalePrice»');
  expect(orderReasonText({ status: 'cancelled', skipReason: 'sell-capped', cancelReason: null }, t)).toBe('«orderReasonSellCapped»');
  expect(orderReasonText({ status: 'open', skipReason: 'no-bucket', cancelReason: null }, t)).toBe('«orderReasonNoBucket»');
  expect(orderReasonText({ status: 'open', skipReason: null, cancelReason: null }, t)).toBe('');
});
```

- [ ] **Step 2: Run to verify it fails** (`bun test apps/web`), then implement `CANCEL_REASONS` + `orderReasonText` in `viewmodels.ts` using the existing `reasonKey` (`apps/web/src/viewmodels.ts:21` — it is `enumLabelKey` under another name). The rule is exactly three branches, in this order: `o.cancelReason` → `t(reasonKey('cancelReason', o.cancelReason))`; else `o.skipReason` → `t(reasonKey('orderReason', o.skipReason))`; else `''`. Status is not consulted — that is what keeps a legacy `cancelled` row that carries a `skipReason` rendering exactly what it renders today (the reason cell in `OrderTable.tsx` is status-independent), and no row can have both reasons in practice because the cancel path never writes `skip_reason`.

- [ ] **Step 3: Wire API + types + copy.** `OrderDto` += `cancelReason: string | null;`. Add `api.cancelOrder` POSTing `{ reason }` to `runs/${runId}/orders/${orderId}/cancel` via the file's existing `send`/`call` helper (copy the style of an existing mutating method; `call` already throws `ApiError(status, errorString)`). Catalog keys — en.json: `"orderColAction": "Action"`, `"orderCancelBtn": "Cancel"`, `"orderCancelTitle": "Cancel order"`, `"cancelReasonBrokerFilled": "Filled elsewhere at broker"`, `"cancelReasonStrategyChange": "Strategy change"`, `"cancelReasonStalePrice": "Price no longer valid"`, `"cancelReasonOther": "Other"`; ko.json (same keys): `"동작"`, `"취소"`, `"주문 취소"`, `"증권사에서 별도 체결"`, `"전략 변경"`, `"가격 무효화"`, `"기타"`.

- [ ] **Step 4: Implement the UI.** `OrderTable`: reason cell renders `orderReasonText(o, t) || '—'` (keeps the old em-dash rendering for rows with no reason, satisfying the byte-exact display constraint); when `onCancel` is provided, render the extra `Th` and, on `status === 'open'` rows, a small `Button variant="secondary"` that stores the clicked order id in local state and opens `<Modal title={t('orderCancelTitle')} onClose={…}>` holding a `Select` (options labelled `t(reasonKey('cancelReason', code))` over `CANCEL_REASONS`, defaulting to the first), a `Button variant="danger" busy={busy}` labelled `t('confirm')` that calls `onCancel(orderId, selected)` and closes on success (surfacing a thrown message like `RunDetail`'s `actionError` does with `ErrorNote`), and a plain `Button` labelled `t('cancel')` that just closes. `OrdersPanel` in `RunPanels.tsx`: `<OrderTable orders={data ?? []} onCancel={async (orderId, reason) => { await api.cancelOrder(runId, orderId, reason); reload(); }} />`.

- [ ] **Step 5: Verify** — `bun test apps/web && bun run typecheck && bun run --cwd apps/web build` all green (build proves the bundle picks it up).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat: web cancel button with reason dropdown modal and display"
```

---

### Task 5: Whole-branch verification

- [ ] **Step 1:** `TEST_DATABASE_URL="mysql://root:test@127.0.0.1:3307/st_test" bun test` → 0 fail (baseline was 224 pass; every new test included).
- [ ] **Step 2:** `bun run typecheck` → clean.
- [ ] **Step 3:** `TEST_DATABASE_URL="mysql://root:test@127.0.0.1:3307/st_test" bun scripts/e2e.ts` → green (never touches st_test tables).
- [ ] **Step 4:** `git log --oneline main..HEAD` → four feature commits; `git status` clean.
