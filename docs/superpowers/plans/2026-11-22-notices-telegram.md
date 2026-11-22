# Notices and Telegram (plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Booking notices name their run and ticker, use one vocabulary for a sell leg, and are still recorded when no Telegram chat is allowed; Telegram confirm prompts carry working Yes/No buttons that reply in the chat they were pressed in.

**Architecture:** The booking notifier (`apps/server/src/wire/booking-notifier.ts`) looks the run up for its ticker, renders both notices from shared `leg-*` labels, and writes one `notifications` row with the sentinel chat id `web` when the allowed-chat list is empty. The production `send` moves out of `main.ts` into a typed seam (`apps/server/src/wire/send.ts`) that forwards the reply markup to grammy's `sendMessage`; the bot's callback handler passes the callback's own chat id to `onConfirm`, which drops the in-memory `lastChatId`.

**Tech Stack:** Bun, TypeScript, grammy 1.46, Hono, React (web Notifications tab), bun:test with happy-dom.

**Spec:** GitHub issues #56, #60 and the notifier / copy / wiring parts of #58; binding rulings 6 and 7 in `docs/superpowers/decisions/2026-11-22-followup-issues.md`.
**Models:** implementer subagents run on anthropic/claude-sonnet-5-5; per-task reviewers, the whole-branch reviewer and any plan amendments run on anthropic/claude-opus-5-5.
**Branch:** fix/followup-issues, shared by plans A to E, executed in order A, B, C, D, E. Code may have moved by the time this plan runs: locate by symbol, not line.

## Global Constraints

- English only in code, comments and docs; Korean only in the en/ko catalogs and in tests that pin catalog strings. Never Chinese or Cyrillic characters.
- All user-facing copy via the catalogs: Telegram copy in `packages/telegram/src/i18n.ts` (`CATALOG`), web copy in `apps/web/src/i18n/en.json` + `ko.json`. `packages/telegram/test/i18n.test.ts` requires every key to have non-empty en and ko text with the same `{placeholder}` set.
- No source file over ~300 lines; `packages/*` never import `apps/*`.
- Money stays bigint myriadths; render with `formatUsd` from `@st/core`.
- `fetch` and every outbound API stay injectable for tests.
- Commit style `feat|fix|docs|test|refactor|chore:`.
- Ruling 6: with no allowed chat, the booking notifier (attribution notice and sibling-cancel notice) writes one `notifications` row with chat id `web` and sends nothing. The manual cancel route (`http/routes/runs.ts`) and the morning pipeline are unchanged (the test "cancel order succeeds with no allowed chats: 200, no notification rows, no sends" in `apps/server/test/http-orders.test.ts` stays as is).
- Ruling 7: the production `send` passes the reply markup through; the confirm handler replies to the callback's chat; a prompt whose trade date was substituted is sent without buttons; Telegram confirms never keep the screenshot (`keepImage: false` / no keep option, as today).
- Plan A runs first and edits `wire/booking-notifier.ts` (`legParams`, market-leg alternatives) and the `sell-attributed*` / `leg-*` copy (tie wording). Build on whatever shape it left; locate by symbol. Change only what this plan names (run/ticker prefix, sibling copy, sentinel row, log label).

## Review Focus

1. A sibling cancel for a `market_sell` leg (its `limitPrice` is `0n`): the operator expects "bucket 2 market sell", never "$0.00". Pinned in Task 1 (`siblingCancelled names a market leg without a price`).
2. The run is missing when the notice renders (lookup returns null): the notice must still be recorded and sent, with ticker `?`, not throw. Pinned in Task 1 (`a run the repo no longer has renders its ticker as ?`).
3. A Yes/No button pressed after a server restart, or in a different allowed chat than the photo: the reply goes to the chat of the press. Pinned in Task 3 (`a button pressed with no photo since start replies in its own chat`, `the confirm reply goes to the chat the button was pressed in`).
4. A button pressed twice, or No pressed on a row already confirmed: the operator sees "Already handled" in that chat and the spinner stops. Pinned in Task 3 (`pressing a button on an already-handled row says already handled`) and in `bot.test.ts` (the callback is answered before `onConfirm` runs, and even when it throws).
5. The `bot` is created after `send` (main.ts builds the capture handlers before `createBot`): the seam must resolve the API on every call, not capture `null` once. Pinned in Task 4 (`resolves the API on every call`).

---
## File map

| File | Responsibility in this plan |
| --- | --- |
| `packages/telegram/src/i18n.ts` | New `sibling-cancelled` / `sibling-cancelled-market` copy, run/ticker prefix on `sell-attributed`, `leg-market_sell` if plan A did not add it, new `capture-date-substituted` copy |
| `apps/server/src/wire/booking-notifier.ts` | Run lookup for the ticker, shared leg words, `web` sentinel row, structured failure log |
| `packages/telegram/src/bot.ts` | Callback handler passes its chat id and answers the callback first |
| `apps/server/src/wire/capture.ts` | `onConfirm(chatId, ...)`, no `lastChatId`, no buttons on a substituted-date prompt, "already handled" on a handled No, `allowedChatIds` required |
| `apps/server/src/wire/send.ts` (new) | `makeSend`: the production `send`, typed as `CaptureDeps['send']` |
| `apps/server/src/main.ts` | Uses `makeSend` |
| `apps/web/src/components/NoticeList.tsx` + `i18n/{en,ko}.json` | Chat `web` shown as "web only" / "웹 전용" |
| Tests | `apps/server/test/{booking-notifier,http-sibling-notify,wire,send,vision-review}.test.ts`, `packages/telegram/test/{digest,bot}.test.ts`, `apps/web/src/components/NoticeList.test.tsx`, `scripts/e2e.ts`, `scripts/e2e-cutloss.ts` |
| Docs | `docs/superpowers/specs/2026-11-16-cut-loss-and-sim-drafts-design.md`, `README.md` |

## Exact copy (all of it, decided here)

Telegram `CATALOG` (`packages/telegram/src/i18n.ts`):

| Key | en | ko |
| --- | --- | --- |
| `sibling-cancelled` (replaces) | `⚠️ Run #{id} {ticker}: cancel bucket {bucket} {leg} (${limit}) at your broker — the other leg already filled, so this order is no longer needed.` | `⚠️ 런 #{id} {ticker}: 증권사에서 버킷 {bucket} {leg} (${limit}) 주문을 취소하세요 — 반대편 주문이 이미 체결되어 이 주문은 더 이상 필요하지 않습니다.` |
| `sibling-cancelled-market` (new) | `⚠️ Run #{id} {ticker}: cancel bucket {bucket} {leg} at your broker — the other leg already filled, so this order is no longer needed.` | `⚠️ 런 #{id} {ticker}: 증권사에서 버킷 {bucket} {leg} 주문을 취소하세요 — 반대편 주문이 이미 체결되어 이 주문은 더 이상 필요하지 않습니다.` |
| `sell-attributed` (prefix only) | replace the leading `ℹ️ Sell {shares} sh` with `ℹ️ Run #{id} {ticker}: sell {shares} sh`; the rest of the sentence stays exactly as plan A left it | replace the leading `ℹ️ 매도 {shares}주` with `ℹ️ 런 #{id} {ticker}: 매도 {shares}주`; the rest stays as plan A left it |
| `leg-market_sell` (only if plan A did not add it) | `market sell` | `시장가 매도` |
| `capture-date-substituted` (replaces) | `⚠️ No usable trade date was read from the screenshot, so the capture date {date} was used. Check the date and confirm this fill in the web app's Pending view.` | `⚠️ 스크린샷에서 사용할 수 있는 거래일을 읽지 못해 캡처한 날짜 {date}을(를) 사용했습니다. 웹 앱의 '확인 대기'에서 날짜를 확인한 뒤 이 체결을 확정하세요.` |

The leg words are the same in both notices: `bucket {bucket} {leg} (${limit}` with `{leg}` from `leg-<kind>` (`target`, `stop`, `market sell`). If plan A gave `leg-market_sell` a different en/ko label, keep plan A's label and use it wherever this plan writes `market sell` / `시장가 매도`.

Web catalogs: `notifChatWeb` — en `web only`, ko `웹 전용` (insert in key order next to `notifColChat`).

---

### Task 1: Booking notices name the run and ticker and share the leg words (#58 copy)

**Files:**
- Modify: `packages/telegram/src/i18n.ts` (keys `sibling-cancelled`, `sibling-cancelled-market`, `sell-attributed`, `leg-market_sell` — plan A edited `sell-attributed*` / `leg-*` before you; locate by key)
- Modify: `apps/server/src/wire/booking-notifier.ts` (`BookingNotifierDeps`, `siblingCancelled`, `sellAttributed`; plan A edited `legParams` and the alternatives rendering — keep its shape)
- Test: `apps/server/test/booking-notifier.test.ts`, `packages/telegram/test/digest.test.ts`, `apps/server/test/http-sibling-notify.test.ts`, `apps/server/test/wire.test.ts` (describe `capture confirm — sibling leg cancelled by a bucket-emptying sell`), `scripts/e2e-cutloss.ts`

**Interfaces:**
- Consumes: `BookingNotifier` (`apps/server/src/domain/booking-notify.ts`, unchanged), `OrderRow`, `SellAttribution` (`domain/sell-match.ts`, as plan A left them).
- Produces: `BookingNotifierDeps.repos` gains `runRepo: { get(id: number): Promise<{ ticker: string } | null> }`. Both real callers already pass repos that have it (`http/booking-deps.ts` `fillBookingDeps`, `wire/capture.ts` `onConfirm`), so no caller change. Task 2 builds on the same file.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/booking-notifier.test.ts`: the `harness` repos gain `runRepo: { get: async (id: number) => (id === 7 ? { ticker: 'AAPL' } : null) }`. Update the `text` constant by replacing its leading `ℹ️ Sell 10 sh` with `ℹ️ Run #7 AAPL: sell 10 sh` (rest unchanged from what plan A left). Add `describe('booking notifier: siblingCancelled', ...)` with an order fixture `{ id: 12, runId: 7, tradeDate: '2026-11-10', kind, bucketIdx, limitPrice, shares: 10, status: 'cancelled' }`:

```ts
test('siblingCancelled names the run, ticker and leg in the attribution notice\'s words', async () => {
  const { notifier, sent } = harness(['42'])
  await notifier.siblingCancelled(7, order({ kind: 'sell_loc', bucketIdx: 1, limitPrice: parseUsd('103.00') }))
  expect(sent).toEqual([{ chatId: '42', text: '⚠️ Run #7 AAPL: cancel bucket 1 target ($103.00) at your broker — the other leg already filled, so this order is no longer needed.' }])
})
test('siblingCancelled renders a stop leg', ...)            // bucketIdx 0, stop_sell 97.00 -> '... cancel bucket 0 stop ($97.00) at your broker — ...'
test('siblingCancelled names a market leg without a price', ...) // bucketIdx 2, market_sell, limitPrice 0n -> '⚠️ Run #7 AAPL: cancel bucket 2 market sell at your broker — the other leg already filled, so this order is no longer needed.'
test('siblingCancelled renders in ko', ...)                 // lang 'ko', sell_loc bucket 1 103.00 -> '⚠️ 런 #7 AAPL: 증권사에서 버킷 1 목표가 매도 ($103.00) 주문을 취소하세요 — 반대편 주문이 이미 체결되어 이 주문은 더 이상 필요하지 않습니다.'
test('a run the repo no longer has renders its ticker as ?', ...) // runId 8 -> text starts with '⚠️ Run #8 ?: cancel bucket 1 target ($103.00)', and is still recorded and sent
```

(`harness` gains an optional `lang` argument, default `'en'`.)

`packages/telegram/test/digest.test.ts`:
- `sibling-cancelled tells the operator to pull the leg, in both languages`: params `{ id: 7, ticker: 'AAPL', bucket: 3, leg: t('leg-stop_sell', lang), limit: '97.00' }`; en `⚠️ Run #7 AAPL: cancel bucket 3 stop ($97.00) at your broker — the other leg already filled, so this order is no longer needed.`; ko `⚠️ 런 #7 AAPL: 증권사에서 버킷 3 손절 매도 ($97.00) 주문을 취소하세요 — 반대편 주문이 이미 체결되어 이 주문은 더 이상 필요하지 않습니다.`
- New `sibling-cancelled-market omits the price, in both languages`: `{ id: 7, ticker: 'AAPL', bucket: 2, leg: t('leg-market_sell', lang) }` -> the two market strings from the copy table.
- `sell-attributed ...` (title as plan A left it): add `id: 7, ticker: 'AAPL'` to the params; expected en/ko gain the prefixes from the copy table.
- New `the attribution and sibling notices describe one leg in the same words`: for `{ bucket: 1, leg: t('leg-sell_loc', lang), limit: '103.00' }`, both `t('sell-attributed-alt', lang, { ...p, distance: '6.50' })` and `t('sibling-cancelled', lang, { id: 7, ticker: 'AAPL', ...p })` contain `bucket 1 target ($103.00` (en) and `버킷 1 목표가 매도 ($103.00` (ko).

`apps/server/test/http-sibling-notify.test.ts`: every pinned sibling text becomes `` `⚠️ Run #${id} AAPL: cancel bucket 0 target ($103.00) at your broker — the other leg already filled, so this order is no longer needed.` ``; the ko test expects `` `⚠️ 런 #${id} AAPL: 증권사에서 버킷 0 목표가 매도 ($103.00) 주문을 취소하세요 — 반대편 주문이 이미 체결되어 이 주문은 더 이상 필요하지 않습니다.` ``; the `attributed` constant gets the `ℹ️ Run #${id} AAPL: sell 10 sh` prefix; `confirming a pending sell over HTTP notifies as well` asserts `toContain('bucket 0 target ($103.00)')`.

`apps/server/test/wire.test.ts`, describe `capture confirm — sibling leg cancelled by a bucket-emptying sell`: `text` becomes `'⚠️ Run #1 NVDA: cancel bucket 0 target ($103.00) at your broker — the other leg already filled, so this order is no longer needed.'`; in `a Telegram outage on the notice never fails the confirm` the throw condition becomes `text.startsWith('⚠️ Run #1 NVDA: cancel')`.

`scripts/e2e-cutloss.ts`: build `expected` with `t('sibling-cancelled', 'en', { id: runId, ticker: 'NVDA', bucket: 1, leg: t('leg-sell_loc', 'en'), limit: formatUsd(BigInt(sellLoc1.limitPrice)) })` (import `t` from `@st/telegram/i18n`; drop the `CATALOG` import if unused).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/server/test/booking-notifier.test.ts packages/telegram/test/digest.test.ts apps/server/test/http-sibling-notify.test.ts apps/server/test/wire.test.ts`
Expected: FAIL on the new texts (old copy rendered).

- [ ] **Step 3: Implement**

Copy: edit the keys exactly as in the copy table. Notifier: add `runRepo` to `BookingNotifierDeps.repos`; a private `async function runParams(runId: number): Promise<{ id: number; ticker: string }>` returning `{ id: runId, ticker: run?.ticker ?? '?' }` (a throwing lookup propagates; `notifyBookingOutcome` already logs and swallows it). `siblingCancelled` picks `'sibling-cancelled-market'` when `order.kind === 'market_sell'`, else `'sibling-cancelled'`, with params `{ ...runParams, bucket: order.bucketIdx, leg: t(\`leg-${order.kind}\`, lang), limit: formatUsd(order.limitPrice) }`. `sellAttributed` spreads the same `runParams` into its `sell-attributed` params. Do not touch plan A's alternative rendering.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test apps/server/test/booking-notifier.test.ts packages/telegram/test apps/server/test/http-sibling-notify.test.ts apps/server/test/wire.test.ts && bun run typecheck`
Expected: PASS (including `i18n.test.ts` placeholder parity), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/telegram/src/i18n.ts apps/server/src/wire/booking-notifier.ts apps/server/test/booking-notifier.test.ts packages/telegram/test/digest.test.ts apps/server/test/http-sibling-notify.test.ts apps/server/test/wire.test.ts scripts/e2e-cutloss.ts
git commit -m "fix: booking notices name the run and ticker and describe a leg in one vocabulary"
```

### Task 2: With no allowed chat, booking notices are recorded for the web (#56, #58 log label)

**Files:**
- Modify: `apps/server/src/wire/booking-notifier.ts` (`broadcast`, new export `WEB_ONLY_CHAT_ID`)
- Modify: `apps/web/src/components/NoticeList.tsx`, `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Create: `apps/web/src/components/NoticeList.test.tsx`
- Modify: `docs/superpowers/specs/2026-11-16-cut-loss-and-sim-drafts-design.md` (plan A edits this spec's "Booking a stop fill" section first; locate by text), `README.md` (env table row `TELEGRAM_BOT_TOKEN`)
- Test: `apps/server/test/booking-notifier.test.ts`, `apps/server/test/http-sibling-notify.test.ts`, `apps/server/test/wire.test.ts`

**Interfaces:**
- Consumes: Task 1's notifier (`runParams`, the two notice texts).
- Produces: `export const WEB_ONLY_CHAT_ID = 'web'` in `booking-notifier.ts`. The web cannot import the server, so `NoticeList.tsx` compares against the literal `'web'` with a one-line comment naming `WEB_ONLY_CHAT_ID`.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/booking-notifier.test.ts`:
- Replace `with no allowed chats nothing is recorded or sent` by `with no allowed chats one row is recorded for the web and nothing is sent`: `harness([])`, `sellAttributed(7, attribution)` -> `rows` `[{ runId: 7, chatId: 'web', text }]`, `sent` `[]`.
- Same for `siblingCancelled` (`with no allowed chats the sibling notice is recorded for the web`).
- `a failing web-only insert is logged, not thrown`: insert throws -> `sellAttributed` resolves; `console.error` called once with `['booking notice failed:', 'sell-attributed', { runId: 7, orderId: null, chatId: 'web' }, 'Error: db-down']`.
- In `a chat whose send fails does not stop the next chat`, assert `errors.mock.calls[0]` toEqual `['booking notice failed:', 'sell-attributed', { runId: 7, orderId: null, chatId: '42' }, 'Error: telegram-down']`.
- New `a failing sibling send logs the order id as its own field`: `harness(['42'], '42')`, `siblingCancelled(7, order({ id: 12, ... }))` -> call args `['booking notice failed:', 'sibling-cancelled', { runId: 7, orderId: 12, chatId: '42' }, 'Error: telegram-down']`.

`apps/server/test/http-sibling-notify.test.ts`: replace `with no allowed chats the booking succeeds and nothing is sent` by `with no allowed chats the booking succeeds, nothing is sent and the notice is recorded for the web`: status 200, `f.sent` `[]`, `f.notifications` mapped to `{ runId, chatId, text }` equals `[{ runId: id, chatId: 'web', text: <Task 1 sibling text for bucket 0 target $103.00> }]`. `a partial manual fill sends nothing` stays as is.

`apps/server/test/wire.test.ts`, sibling describe: new `with no allowed chats the Telegram confirm records the notice for the web`: `setupSell({ allowedChatIds: [] })`, `handlers.onConfirm(\`yes:${pid}\`, true)` (Task 3 later adds the chat id argument to every call) -> `fakes.notifications` `[{ runId: 1, chatId: 'web', text }]`; no sent entry carries that text.

`apps/web/src/components/NoticeList.test.tsx` (same happy-dom + `LangProvider` scaffold as `components/RunHistory.test.tsx`): render two `NotificationDto` rows, chat ids `'web'` and `'42'`; the chat cells read `web only` and `42`. A second test sets `localStorage['st-lang'] = 'ko'` before render (clear it after) and expects `웹 전용`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/server/test/booking-notifier.test.ts apps/server/test/http-sibling-notify.test.ts apps/server/test/wire.test.ts apps/web/src/components/NoticeList.test.tsx`
Expected: FAIL (no rows written with no chats; raw `web` in the cell; old log label).

- [ ] **Step 3: Implement**

`broadcast(runId: number, text: string, notice: 'sell-attributed' | 'sibling-cancelled', orderId: number | null)`: when `deps.allowedChatIds` is empty, insert one row `{ runId, chatId: WEB_ONLY_CHAT_ID, text }` and send nothing; otherwise the current per-chat loop. Every failure (insert or send, either branch) logs `console.error('booking notice failed:', notice, { runId, orderId, chatId }, String(e))` and continues. Update the comment above `makeBookingNotifier` to say a run with no allowed chat still gets its row. `NoticeList`: the chat cell renders `t('notifChatWeb')` when `n.chatId === 'web'`; add `notifChatWeb` to both web catalogs (copy table).

Docs, spec "Booking a stop fill": in the "Attribution notice" bullet replace "with no allowed chats nothing is written or sent" by "with no allowed chats one row with chat id `web` is written (shown as "web only" in the Notifications tab) and nothing is sent; the sibling-cancel notice does the same"; delete the known limitation "With no allowed chats no notice reaches the operator ..." (renumber if plan A left a numbered list); in the Tests list, the `booking-notifier.test.ts` bullet says "one `web` row with no allowed chats" instead of "nothing with no allowed chats". README `TELEGRAM_BOT_TOKEN` row: append "; booking notices are still recorded in the run's Notifications tab (chat `web`)".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test && bun run typecheck`
Expected: PASS, typecheck clean. (`http-orders.test.ts` "cancel order succeeds with no allowed chats ..." still passes: ruling 6 leaves that route alone.)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/wire/booking-notifier.ts apps/server/test/booking-notifier.test.ts apps/server/test/http-sibling-notify.test.ts apps/server/test/wire.test.ts apps/web/src/components/NoticeList.tsx apps/web/src/components/NoticeList.test.tsx apps/web/src/i18n/en.json apps/web/src/i18n/ko.json docs/superpowers/specs/2026-11-16-cut-loss-and-sim-drafts-design.md README.md
git commit -m "fix: record booking notices for the web when no Telegram chat is allowed"
```

### Task 3: Telegram confirm replies in the pressing chat; no buttons on a substituted-date prompt (#60 parts 1–2, #58 `allowedChatIds`)

**Files:**
- Modify: `packages/telegram/src/bot.ts` (`BotDeps.onConfirm`, the `callback_query:data` handler)
- Create: `packages/telegram/test/bot.test.ts`
- Modify: `apps/server/src/wire/capture.ts` (`CaptureDeps.allowedChatIds`, `makeCaptureHandlers`: remove `lastChatId`, `sendOutcome` prompt loop, `onConfirm`)
- Modify: `packages/telegram/src/i18n.ts` (`capture-date-substituted`, copy table)
- Test: `apps/server/test/wire.test.ts`, `apps/server/test/vision-review.test.ts` (describe `Telegram reject`), `scripts/e2e.ts`

**Interfaces:**
- Produces: `BotDeps.onConfirm(chatId: string, cbData: string, approved: boolean): Promise<void> | void` (chat id first, like `onPhoto` / `onStatus`). The handlers object returned by `makeCaptureHandlers` has `onConfirm(chatId: string, cbData: string, approved: boolean): Promise<void>`, so `main.ts` keeps passing `handlers.onConfirm` unchanged.
- Produces: `CaptureDeps.allowedChatIds: string[]` (required, no default; the `?? []` in `onConfirm` goes).

Decided behaviour for a press on a row that is no longer pending (Yes or No, including a row id that does not exist): the callback is answered (spinner stops) and the pressing chat gets `confirm-err-already-handled` ("Already handled — this fill was already confirmed or rejected."). Yes already maps `pending-not-pending` / `pending-not-found-or-not-pending` to it; No currently sends `duplicate-capture` and changes to `confirm-err-already-handled`. The buttons are left on the message (not edited away).

- [ ] **Step 1: Write the failing tests**

`packages/telegram/test/bot.test.ts` (no network): build `createBot({ token: '1:x', allowedChatIds: ['111'], onPhoto, onConfirm: spy, onStatus, onOrders })`, set `bot.botInfo = { id: 1, is_bot: true, first_name: 'b', username: 'b', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false }` (the required fields of `UserFromGetMe` in grammy 1.46's types; match whatever the installed type requires), and capture API calls with `bot.api.config.use(async (_prev, method, payload) => { calls.push({ method, payload }); return { ok: true, result: true } as never })`. Feed `bot.handleUpdate({ update_id: 1, callback_query: { id: 'cb1', from: { id: 5, is_bot: false, first_name: 'u' }, chat_instance: 'ci', data: 'yes:9', message: { message_id: 3, date: 0, chat: { id: 111, type: 'private', first_name: 'u' } } } } as never)`.
- `a pressed button calls onConfirm with the callback's chat id`: spy called once with `('111', 'yes:9', true)`; `'no:9'` gives `('111', 'no:9', false)`.
- `the callback is answered before onConfirm runs`: record order in one array (`answerCallbackQuery` from `calls`, `onConfirm` from the spy) -> `['answerCallbackQuery', 'onConfirm']`, and the answer payload has `callback_query_id: 'cb1'`.
- `the callback is answered even when onConfirm throws`: spy throws -> `handleUpdate` rejects, and `calls` holds the `answerCallbackQuery`.
- `a press in a chat that is not allowed does nothing`: chat id 222 -> spy not called, no API call.

`apps/server/test/wire.test.ts`:
- Every `handlers.onConfirm(\`...\`, bool)` call gains the chat id `'777'` as first argument (the photo chat in these tests).
- `makeCapture` passes `allowedChatIds: opts.allowedChatIds ?? []` (add `allowedChatIds?: string[]` to its opts); the `extract failure ...` test passes `allowedChatIds: []`.
- `DATE_NOTICE_EN` becomes `'⚠️ No usable trade date was read from the screenshot, so the capture date 2026-11-10 was used. Check the date and confirm this fill in the web app\'s Pending view.'`.
- `a fill with no date carries the substitution notice` -> rename `a fill with no date carries the substitution notice and no buttons`; `expect(h.sent[0]!.extra).toBeUndefined()`.
- `a date the extractor dropped as too far from today gets the same notice`: also `extra` undefined.
- `a readable date carries no notice`: also `expect(h.sent[0]!.extra).toEqual({ reply_markup: buildPendingKeyboard(String(h.pending[0]!.id)) })`.
- `the notice is rendered in ko`: `toContain('웹 앱의 \'확인 대기\'에서 날짜를 확인한 뒤')`.
- New describe `capture onConfirm — reply target`:
  - `the confirm reply goes to the chat the button was pressed in`: `onPhoto('777', ...)`, `onConfirm('888', \`yes:${p.id}\`, true)` -> `h.sent.at(-1)` is `{ chatId: '888', text: 'Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 into bucket 0' }`; a reject from `'888'` goes to `'888'` too.
  - `a button pressed with no photo since start replies in its own chat`: insert a pending buy directly with `h.repos.pendingRepo.insert({ runId: 1, captureId: null, bucketIdx: null, side: 'buy', ticker: 'NVDA', shares: 10, price: parseUsd('180.50'), fee: null, filledOn: '2026-11-10' })`, then `onConfirm('999', \`yes:${id}\`, true)` -> every sent entry has `chatId: '999'`.
  - `pressing a button on an already-handled row says already handled`: for each of `[yes then yes]`, `[yes then no]`, `[no then no]`, `[no then yes]`, in en and ko, the last sent text is `confirm-err-already-handled` (`'Already handled — this fill was already confirmed or rejected.'` / `'이미 처리되었습니다 — 이 체결은 이미 확정되었거나 거부되었습니다.'`) sent to the pressing chat; and `onConfirm('777', 'no:4242', false)` (no such row) gives the same.
- Sibling describe (`setupSell`): pass `'111'` as the chat id; in the outage test the surviving `Booked NVDA sell 10 sh` reply goes to `'111'` (assert the chat id).

`apps/server/test/vision-review.test.ts`, describe `Telegram reject`: `telegram()` passes `allowedChatIds: []`; calls gain `'777'`; `a repeat reject sends the duplicate message and archives nothing more` -> rename `a repeat reject says already handled and archives nothing more`, expecting `[t('rejected-line', 'en'), t('confirm-err-already-handled', 'en')]`.

`scripts/e2e.ts`: the capture handlers get `allowedChatIds: ['chat-1']`; the capture `send` records `extra` (`captureMsgs: { text: string; extra?: Record<string, unknown> }[]`, adjust the `.some(...)` checks to `m.text`); the substituted-prompt check uses the new `capture-date-substituted` en text (`capture date 2026-11-09 was used. Check the date and confirm this fill in the web app's Pending view.`) and adds `m.extra === undefined` with the label `'capture-booked prompt and capture-date notice verbatim, no buttons'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/telegram/test/bot.test.ts apps/server/test/wire.test.ts apps/server/test/vision-review.test.ts`
Expected: FAIL (onConfirm receives no chat id; prompt still has buttons; repeat reject says duplicate).

- [ ] **Step 3: Implement**

`bot.ts` handler: gate on the callback's chat as today; `try { await ctx.answerCallbackQuery() } catch (e) { console.error('[bot] answerCallbackQuery failed:', String(e)) }`; then `await deps.onConfirm(chatId, data, data.startsWith('yes:'))`. `capture.ts`: delete `lastChatId` and its assignment in `onPhoto`; `onConfirm(chatId, cbData, approved)` uses its own `chatId` for every reply; on `rejectPendingFill` returning `null` send `t('confirm-err-already-handled', lang)`; in `sendOutcome` send `{ reply_markup: buildPendingKeyboard(String(row.id)) }` only when `row.detectedFilledOn !== null`, otherwise call `deps.send(chatId, text)` with two arguments; `allowedChatIds: string[]` required with its comment updated ("chats told about booking notices; empty: recorded for the web only"). Copy: `capture-date-substituted` per the copy table. Keep `keepImage: false` on reject and no keep option on confirm.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test && bun run typecheck`
Expected: PASS, typecheck clean (`main.ts` still compiles: it passes `handlers.onConfirm` and `env.telegram?.allowedChatIds ?? []`).

- [ ] **Step 5: Commit**

```bash
git add packages/telegram/src/bot.ts packages/telegram/test/bot.test.ts packages/telegram/src/i18n.ts apps/server/src/wire/capture.ts apps/server/test/wire.test.ts apps/server/test/vision-review.test.ts scripts/e2e.ts
git commit -m "fix: Telegram confirm replies in the chat it was pressed in; no buttons on a substituted-date prompt"
```

### Task 4: The production `send` forwards the reply markup (#60 part 4)

**Files:**
- Create: `apps/server/src/wire/send.ts`
- Modify: `apps/server/src/main.ts` (the inline `send`)
- Create: `apps/server/test/send.test.ts`

**Interfaces:**
- Consumes: `CaptureDeps['send']` from `apps/server/src/wire/capture.ts`.
- Produces:
  - `export interface MessageApi { sendMessage(chatId: string, text: string, other?: Record<string, unknown>): Promise<unknown> }` (grammy's `bot.api` is assignable to it with no cast; checked against grammy 1.46).
  - `export function makeSend(getApi: () => MessageApi | null, log: (line: string) => void = console.log): CaptureDeps['send']` — `getApi()` is read on every call; `null` logs `` `[send:${chatId}] ${text.slice(0, 120)}` `` and returns; otherwise `await api.sendMessage(chatId, text, extra)` with `extra` passed through untouched (also when `undefined`).

- [ ] **Step 1: Write the failing test**

`apps/server/test/send.test.ts`:
- `forwards the reply markup to sendMessage`: fake api records `[chatId, text, other]`; `await makeSend(() => api)('111', 'Booked ...', { reply_markup: buildPendingKeyboard('5') })` -> calls `[['111', 'Booked ...', { reply_markup: buildPendingKeyboard('5') }]]`.
- `a plain message reaches sendMessage with no options`: `send('111', 'hi')` -> `[['111', 'hi', undefined]]`.
- `without a bot it logs and sends nothing`: `makeSend(() => null, (l) => lines.push(l))('42', 'x'.repeat(200))` -> `lines` `['[send:42] ' + 'x'.repeat(120)]`.
- `resolves the API on every call`: `let api: MessageApi | null = null`; one send logs; assign `api`; the next send reaches `sendMessage`.
- `grammy's bot API satisfies MessageApi`: `const api: MessageApi = createBot({ token: '1:x', allowedChatIds: [], onPhoto() {}, onConfirm() {}, onStatus() {}, onOrders() {} }).api; expect(typeof api.sendMessage).toBe('function')` — the assignment is the compile-time check that `main.ts` needs no cast.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/server/test/send.test.ts`
Expected: FAIL (`../src/wire/send` not found).

- [ ] **Step 3: Implement `makeSend` in `apps/server/src/wire/send.ts` and use it in `main.ts`**

In `main.ts` replace the inline `send` with `const send: CaptureDeps['send'] = makeSend(() => bot?.api ?? null)` (import `type CaptureDeps` from `./wire/capture`), keeping `let bot` declared before it and the comment about logging without a token. The same `send` still feeds `dayDeps` and `createApp`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Run the DB-backed smoke (if the test DB is up)**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`
Expected: every line `ok`, including `capture-booked prompt and capture-date notice verbatim, no buttons` and `one sibling-cancel push to the allowed chat`. If the DB is not running, say so in the report instead of claiming the smoke passed.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/wire/send.ts apps/server/src/main.ts apps/server/test/send.test.ts
git commit -m "fix: production Telegram send forwards the reply markup so confirm prompts carry their buttons"
```

---

**Controller amendment (cross-plan check) for Task 4:** add `wire/send.ts` to the `wire/` line of the `AGENTS.md` repo map and include `AGENTS.md` in the Task 4 commit.

## Already done

Nothing in this plan's scope. Checked on `42795c3`: `CaptureDeps.allowedChatIds` is still optional (`apps/server/src/wire/capture.ts`, `allowedChatIds?: string[]`, `deps.allowedChatIds ?? []` in `onConfirm`); the failure log still folds the order id into the label (`booking-notifier.ts`, `` `sibling-cancel order ${order.id}` ``); `main.ts` `send` still drops its third argument; `onConfirm` still replies to `lastChatId`; the notifier loop still writes nothing with no chats.

## Not in this plan

- #60 part 3 (`archived` ignored on the Telegram paths): left. Telegram never keeps the screenshot, so an archive failure there has nothing for the operator to do in that chat; `confirmPendingFill` / `rejectPendingFill` already log it (`vision review archive failed:`).
- #56 option 3 (one run-level row instead of one row per chat, removing duplicates with two chats): left; ruling 6 picked the sentinel row only.
- #56 for the manual cancel route and the morning pipeline: unchanged by ruling 6.
- #58 Korean text is machine-written: needs a native reader (#50).
- #58 `orders(run_id, trade_date)` index: plan C.
- #58 typing items (`listForRunFrom` typed `any[]`, `toLeg` cast and `live.find(...)!`): plan E (typing) / plan A (sell-match).
- #58 `notify: silentNotifier` on fixtures that never book: test tidiness, left to plan E's typing pass over fixtures.
- #58 test strictness items and spec wording items (limitation 3, sibling-cancel bullet, Tests list bullets): plan A (attribution and cut-loss spec text).
- #58 attribution tie wording (`sell-attributed` "nearest the fill wins"): plan A.

## Decisions for human review

- **[REVIEW]** Notices name the run as `Run #<id> <ticker>` (ko `런 #<id> <ticker>`), not the run's name: matches `/status` (`status-run-line`) and the capture copy (`run #{id}`). Cost if wrong: the operator maps an id to a name in the web.
- **[REVIEW]** The sibling-cancel notice now says `cancel bucket 0 target ($103.00)` instead of `Cancel sell_loc bucket 0 (103.00)`: same leg words and `$` price as the attribution notice. A `market_sell` sibling gets a variant with no price. Cost if wrong: operators used to the raw kind see new words.
- A notice whose run lookup returns null renders ticker `?` and is still recorded and sent. Cost if wrong: a cryptic `Run #8 ?` line (runs are not deleted, so practically unreachable).
- **[REVIEW]** The web Notifications tab shows chat `web` as "web only" / "웹 전용". Cost if wrong: one label.
- The failure log becomes `console.error('booking notice failed:', <notice>, { runId, orderId, chatId }, error)`, one grep-able label for both notices. Cost if wrong: log readers grepping the old `sibling-cancel order <id> message failed:` find nothing.
- **[REVIEW]** `capture-date-substituted` copy changes to "Check the date and confirm this fill in the web app's Pending view." because that prompt no longer has buttons (the old copy said "instead of confirming here"). Cost if wrong: copy only.
- **[REVIEW]** Pressing No on a row already handled says "Already handled ..." (was "Duplicate capture ..."), matching Yes; a missing row id says the same. Cost if wrong: copy only.
- The bot answers the callback before running the confirm (a failed answer is logged and ignored), so the spinner stops even when booking throws; the buttons stay on the message after a press. Cost if wrong: a second press is possible and answered "Already handled".
- `CaptureDeps.allowedChatIds` is required; the `wire.test.ts` `makeCapture` helper defaults it to `[]` (notices go to `web` rows, nothing extra sent). Cost if wrong: none outside tests.
- The production `send` lives in `apps/server/src/wire/send.ts` (`makeSend`) so it can be tested without starting `main.ts`. Cost if wrong: one more small file.

## Issue closing

- **#56:** closed by this plan (booking notices; the other writers stay "no chats, no rows" by ruling 6 — say so in the closing comment).
- **#60:** closed by this plan (parts 1, 2, 4 fixed; part 3 left with the reason above — name it in the closing comment).
- **#58:** partly: this plan fixes the run/ticker naming and leg vocabulary of both notices, the required `allowedChatIds` and the failure log label. Remains: tie wording, test strictness and spec wording (plan A), the `orders` index (plan C), typing items and `silentNotifier` fixtures (plan E), Korean review (#50).
