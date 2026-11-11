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
  const [runId] = [await repos.runRepo.create({
    strategyKey: 'mean-reversion', ticker: 'RT', name: `rt-cancel-${Date.now()}`,
    poolCents: 100, costPpm: 0, stateJson: '{}',
  })]
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

Note: mirror however existing tests in this file create a run + order (check the top of the file; if `runRepo.create` returns the id directly, use that shape).

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

- [ ] **Step 1: Write the failing tests** in `booking.test.ts` (reuse the file's existing fixture builder; its fake order array holds rows like `{ runId, tradeDate, kind, bucketIdx, limitPrice, shares, status }`):

```ts
test('cancelOrder marks open order cancelled with reason', async () => {
  const f = makeFixture() // whatever the existing builder is called
  const id = await f.repos.orderRepo.insertOne({ runId: f.runId, tradeDate: '2026-11-11', kind: 'sell_loc', bucketIdx: 1, limitPrice: 200n, shares: 5, status: 'open' })
  const order = await cancelOrder(f.runId, id, 'strategy-change', f.deps)
  expect(order.status).toBe('cancelled')
  expect(order.cancelReason).toBe('strategy-change')
})
test('cancelOrder rejects unknown, foreign-run, and non-open orders', async () => {
  // expect cancelOrder(run, 99999, 'other', deps) → 'order-not-found'
  // order inserted with runId: otherRun → 'order-not-found'
  // order with status: 'filled' → 'order-not-open'; the row's status must stay 'filled'
})
test('cancelOrder rejects unknown reason', async () => {
  // expect cancelOrder(run, id, 'because-i-said-so', deps) → 'invalid-reason'; row stays 'open'
})
```

If the fake `orderRepo` has no per-row `insertOne`/id-returning insert, add one to the fake (fakes are test code — allowed), or use `insertMany` + the store array like neighboring tests do.

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
- Modify: `apps/server/src/http/app.ts` (`HttpDeps`)
- Modify: `apps/server/src/http/routes/runs.ts`
- Modify: `apps/server/src/main.ts` (wire new deps)
- Test: `apps/server/test/http.test.ts`, `packages/telegram/test/digest.test.ts`

**Interfaces:**
- Consumes: Task 2 `cancelOrder` / `CANCEL_REASONS`; `deps.repos.notificationRepo.insert({ runId, chatId, text })` (existing shape from `pipeline/day.ts`).
- Produces: `POST /api/runs/:id/orders/:orderId/cancel` — body `{ reason: string }`; 200 `{ ok: true }`, 400 `{ error: 'invalid-reason' }`, 404 `{ error: 'order-not-found' }`, 409 `{ error: 'order-not-open' }`. On success, for each `deps.allowedChats` entry: one `notificationRepo.insert({ runId, chatId, text })` and one `deps.sendText(chatId, text)`, where text = `tgT('order-cancelled', deps.digestLang, { kind, bucket, price, reason })` with `reason = tgT('reason-' + code, lang)` and `price = formatUsd(order.limitPrice)`; `tgT` is `t` from `@st/telegram/i18n`. New `HttpDeps` fields (required): `digestLang: 'en' | 'ko'`, `allowedChats: string[]`, `sendText: (chatId: string, text: string) => Promise<void>`. CATALOG gains keys `order-cancelled`, `reason-broker-filled`, `reason-strategy-change`, `reason-stale-price`, `reason-other`.

- [ ] **Step 1: Write the failing catalog test** in `packages/telegram/test/digest.test.ts`:

```ts
test('order-cancelled renders in both languages', () => {
  expect(t('order-cancelled', 'ko', { kind: 'sell_loc', bucket: 2, price: '$3.50', reason: t('reason-strategy-change', 'ko') }))
    .toBe('🚫 취소: sell_loc 버킷 2 — 전략 변경 ($3.50)')
  expect(t('order-cancelled', 'en', { kind: 'buy_loc', bucket: 0, price: '$1.00', reason: t('reason-broker-filled', 'en') }))
    .toBe('🚫 Cancelled: buy_loc bucket 0 — filled elsewhere at broker ($1.00)')
})
```

(import `t` from `'../src/i18n'` if the test file doesn't already.)

- [ ] **Step 2: Run to verify it fails**, then add the five CATALOG entries with exactly the strings above (en/ko pairs): `order-cancelled` en `'🚫 Cancelled: {kind} bucket {bucket} — {reason} ({price})'` / ko `'🚫 취소: {kind} 버킷 {bucket} — {reason} ({price})'`; `reason-broker-filled` `'filled elsewhere at broker'` / `'증권사에서 별도 체결'`; `reason-strategy-change` `'strategy change'` / `'전략 변경'`; `reason-stale-price` `'price no longer valid'` / `'가격 무효화'`; `reason-other` `'other'` / `'기타'`. Re-run → PASS.

- [ ] **Step 3: Write the failing route tests** in `http.test.ts`. Update the shared fake deps builder (one place): `digestLang: 'en'`, `allowedChats: ['42']`, and a `sendText` that pushes `{ chatId, text }` to an exported `sent: any[]` array (follow how the builder exposes `notifications` etc.).

```ts
test('cancel order: happy path stores reason, notifies each allowed chat', async () => {
  // insert an open order for the run via the fake orderRepo store, then:
  const res = await app.request('/api/runs/1/orders/<id>/cancel', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ reason: 'stale-price' }),
  })
  expect(res.status).toBe(200)
  const row = /* find the order in the fake store */
  expect(row.status).toBe('cancelled')
  expect(row.cancelReason).toBe('stale-price')
  expect(notifications.filter((n) => n.runId === 1)).toHaveLength(1)
  expect(notifications.find((n) => n.runId === 1)!.text).toContain('Cancelled')
  expect(sent).toEqual([{ chatId: '42', text: notifications.find((n) => n.runId === 1)!.text }])
})
test('cancel order: 400 invalid-reason, 404 unknown order, 409 not open', async () => {
  // reason 'nope' → 400 { error: 'invalid-reason' }, order still open, nothing sent
  // unknown orderId → 404 { error: 'order-not-found' }
  // status 'filled' order → 409 { error: 'order-not-open' }
})
test('cancel order succeeds with no allowed chats: 200, no notification rows, no sends', async () => {
  // same app, deps.allowedChats = [] → 200; notifications for the run stay empty; sent stays empty
})
```

Use the same auth/session helper the existing tests use.

- [ ] **Step 4: Run to verify they fail**, then implement:
  - `app.ts`: add `digestLang`, `allowedChats`, `sendText` to `HttpDeps`.
  - `runs.ts`: add `r.post('/runs/:id/orders/:orderId/cancel', ...)` — parse body with `.catch(() => ({}))`, validate `typeof reason === 'string' && (CANCEL_REASONS as readonly string[]).includes(reason)` is done *inside* `cancelOrder` (route just maps thrown messages: `invalid-reason`→400, `order-not-found`→404, `order-not-open`→409, anything else→422 like the pending routes). After success build the text and loop `allowedChats` doing insert + `sendText` (insert before send). Import `t as tgT` from `'@st/telegram/i18n'` and `formatUsd` from `'@st/core/money'` — check whether `runs.ts` already imports `formatUsd` (it imports `parseUsd`).
  - `main.ts`: `createApp({ ..., digestLang, allowedChats: tg?.allowedChatIds ?? [], sendText: send })`.

- [ ] **Step 5: Run the server suite + typecheck**

Run: `bun test apps/server/test/http.test.ts && bun run typecheck`
Expected: PASS / clean (this also compiles main.ts wiring).

- [ ] **Step 6: Commit**

```bash
git add packages/telegram/src/i18n.ts packages/telegram/test/digest.test.ts apps/server/src/http apps/server/src/main.ts apps/server/test/http.test.ts
git commit -m "feat: order cancel route with Telegram notification"
```

---

### Task 4: Web — cancel button, reason modal, reason display

**Files:**
- Modify: `apps/web/src/api.types.ts` (`OrderDto`), `apps/web/src/api.ts`, `apps/web/src/viewmodels.ts`, `apps/web/src/components/OrderTable.tsx`, `apps/web/src/pages/RunDetail.tsx`, `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Test: `apps/web/src/viewmodels.test.ts` (append)

**Interfaces:**
- Consumes: Task 3 route `POST /runs/:id/orders/:orderId/cancel`.
- Produces: `OrderDto.cancelReason: string | null`; `api.cancelOrder(runId: number, orderId: number, reason: string): Promise<void>`; `export const CANCEL_REASONS = ['broker-filled', 'strategy-change', 'stale-price', 'other'] as const` and `export function orderReasonText(o: { status: string; skipReason: string | null; cancelReason: string | null }, t: (key: string) => string): string` in `viewmodels.ts` (cancel reason wins on `cancelled` rows via `reasonKey('cancelReason', code)`, skip reason otherwise, `''` when neither or cancelReason is null); `OrderTable` gains optional prop `onCancel?: (orderId: number, reason: string) => Promise<void>` — when provided, an `orderColAction` column with a `t('orderCancelBtn')` button on `status === 'open'` rows opens a `Modal` (from `./ui`) with `Select` over `CANCEL_REASONS` and confirm/cancel buttons; RunDetail passes `onCancel` = `api.cancelOrder` then `reload()`.

- [ ] **Step 1: Write the failing viewmodels test** in `viewmodels.test.ts`:

```ts
test('orderReasonText: cancel reason wins, null-safe for old rows', () => {
  const t = (k: string) => `«${k}»`
  expect(orderReasonText({ status: 'cancelled', skipReason: null, cancelReason: 'stale-price' }, t)).toBe('«cancelReasonStalePrice»')
  expect(orderReasonText({ status: 'cancelled', skipReason: 'sell-capped', cancelReason: null }, t)).toBe('')
  expect(orderReasonText({ status: 'open', skipReason: 'no-bucket', cancelReason: null }, t)).toBe('«orderReasonNoBucket»')
  expect(orderReasonText({ status: 'open', skipReason: null, cancelReason: null }, t)).toBe('')
})
```

- [ ] **Step 2: Run to verify it fails** (`bun test apps/web`), then implement `CANCEL_REASONS` + `orderReasonText` in `viewmodels.ts` using the existing `reasonKey`.

- [ ] **Step 3: Wire API + types + copy.** `OrderDto` += `cancelReason: string | null;` (server rows now include it). Add `api.cancelOrder` POSTing `{ reason }` to `runs/${runId}/orders/${orderId}/cancel` using the existing request helper. Catalog keys — en.json: `"orderColAction": "Action"`, `"orderCancelBtn": "Cancel"`, `"orderCancelTitle": "Cancel order"`, `"orderCancelConfirm": "Cancel order"`, `"cancelReasonBrokerFilled": "Filled elsewhere at broker"`, `"cancelReasonStrategyChange": "Strategy change"`, `"cancelReasonStalePrice": "Price no longer valid"`, `"cancelReasonOther": "Other"`; ko.json: `"동작"`, `"취소"`, `"주문 취소"`, `"주문 취소"`, `"증권사에서 별도 체결"`, `"전략 변경"`, `"가격 무효화"`, `"기타"` (same keys).

- [ ] **Step 4: Implement the UI.** `OrderTable`: reason cell renders `orderReasonText(o, t)`; when `onCancel` is set, header `orderColAction` and, on open rows, a small `Button` that stores the clicked order in local state and opens `<Modal title={t('orderCancelTitle')}>` with a `Select` (options labeled `t(reasonKey('cancelReason', code))`), a busy-tracked confirm `Button variant="danger"` calling `onCancel(order.id, selectedReason)` then closing, and a plain cancel `Button` (`t('cancel')`, key already exists). `RunDetail`: `<OrderTable orders={...} onCancel={async (orderId, reason) => { await api.cancelOrder(id, orderId, reason); void reload(); }} />` wherever `<OrderTable>` is rendered.

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
