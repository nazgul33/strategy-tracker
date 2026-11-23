# Pipeline notice robustness (#87), web-only trace + System notices (#86), run headers in /orders (#85) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A failing Telegram send or notification insert never aborts the pipeline, every notice leaves a row even with no Telegram chat, the Runs page lists all notices with deep links into the run, and Telegram `/orders` groups orders under a per-run header.

**Architecture:** One never-throwing server helper (`wire/broadcast.ts`) replaces every per-chat send/insert loop (morning pipeline, reminder, December nudge, order-cancel route, booking notifier). A new read route `GET /api/notifications` pages over all notification rows by descending id and collapses the per-chat rows of one broadcast into one entry (pure grouping in `domain/notice-feed.ts`). The web adds a `SystemNotices` panel under the runs table and a `?tab=notifications&notice=<id>` query on the run hash route.

**Tech Stack:** Bun + TypeScript, Hono, Drizzle (MariaDB), React + Tailwind, `bun:test` + happy-dom.

**Spec:** `docs/superpowers/specs/2026-11-23-pipeline-notices-and-system-feed-design.md` (issues #85, #86, #87)

## Global Constraints

- No schema change, no migration. No change to which runs fail or to `MorningResult` values. No retry of failed sends. No unread state, no polling.
- The web-only chat id is the literal `web` (`WEB_ONLY_CHAT_ID`).
- Telegram copy, verbatim (`packages/telegram/src/i18n.ts`): `orders-line` en `#{id} {kind} {shares} sh @ ${price}`, ko `#{id} {kind} {shares}주 @ ${price}`. `status-run-line` and `orders-run-missing` are unchanged.
- New web copy, verbatim (`apps/web/src/i18n/{en,ko}.json`, inserted between `statWinRate` and `tabFills`, in this order):
  - `systemNoticesOlder`: en `Show older`, ko `이전 알림 더 보기`
  - `systemNoticesSource`: en `Source`, ko `출처`
  - `systemNoticesSystem`: en `System`, ko `시스템`
  - `systemNoticesTitle`: en `System notices`, ko `시스템 알림`
- All user-facing copy via the en/ko catalogs; en and ko carry the same keys and placeholders; web catalog keys stay in `localeCompare` order (`apps/web/src/catalog.test.ts`).
- English only in code and comments. Never Chinese or Cyrillic characters. Korean appears only in catalog values and in test expectations of catalog output.
- No source file over ~300 lines; `packages/*` never import `apps/*`; commit style `feat|fix|docs|test|refactor|chore:`.
- `apps/server/src/pipeline/day.ts` keeps its `plan.notices.push({ code: 'unconfirmed', ... })` line untouched: `apps/web/src/catalog.test.ts` reads it from source.
- `bun test` and `bun run typecheck` both pass at the end of every task. Baseline before Task 1: 1563 pass, 66 skip, 0 fail.
- DB-backed tests self-skip without `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test`.

## Decisions (the spec's "builder's call" items)

- Helper: `broadcastNotice` in `apps/server/src/wire/broadcast.ts`. `WEB_ONLY_CHAT_ID` moves there with **no** re-export (its only importer, `day.ts`, stops needing it).
- Failure log shape: `console.error(label, kind, { runId, ...extra, chatId }, String(e))`, default label `notice failed:`. It does not name the failed step (insert or send): the existing booking-notifier tests pin this exact four-argument shape and must stay green unchanged.
- The December nudge becomes `runDecemberNudge(deps)` in `day.ts` (next to `runReminder`) so it is testable; the cron in `pipeline/wire.ts` only calls it.
- Feed route: `GET /api/notifications?before=<id>&limit=<n>` → `{ entries, nextBefore }`. Default limit 20, max 100 (larger values clamp to 100). A `before` or `limit` that is not a canonical positive integer (`parseId`) → 400 `invalid before` / `invalid limit`.
- Grouping: a row joins the entry being built when `runId` and `text` are equal **and its chat id is not already in that entry**. The last clause is an addition to the spec: one broadcast writes at most one row per chat, so a repeated chat means a new message (two daily reminders with nothing between them stay two entries).
- `nextBefore` is the smallest row id inside the last returned entry, or `null` when nothing older exists.
- The run ticker is joined server-side (`ticker: string | null`); the web shows `#<id> <ticker>` or `#<id>` when null.
- Web: the panel requests the server default page (sends only `before`). The deep link recognises only `tab=notifications`; `notice` is read only together with it. The highlight marks only the row whose id matches (`aria-current="true"` + `bg-primary/10`).
- The empty state reuses `notifEmpty`; column headers reuse `notifColDate` / `notifColBody`; the chat line reuses `notifColChat` / `notifChatWeb`.
- New day-pipeline tests go in a new file `apps/server/test/day-notices.test.ts` built on `makeFakes()` from `http-fakes.ts` (`day.test.ts` is already 466 lines and its fakes are file-local).

## Review Focus

1. The operator presses **Run morning pipeline** on the Runs page (the conflict case): the System notices panel must show the new notice without a browser reload. Pinned in Task 5.
2. The same text sent twice in a row to the same chat (two daily reminders with no digest between, a web-only operator with no active run): two entries, never one. Pinned in Task 4.
3. **Show older** fails mid-list (server down): the rows already loaded stay on screen and the button retries. Pinned in Task 5.
4. The database and Telegram are both down for a chat, or the insert fails right after a successful order cancel: nothing throws, both failures are logged, the next chat still gets its message and the cancel still answers `{ ok: true }`. Pinned in Tasks 1 and 2.
5. A deep link whose notice id is not in the run's list, or a second deep link followed while the same run is already open: the Notifications tab opens without a highlight in the first case, and the highlight moves in the second. Pinned in Task 6.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/server/src/wire/broadcast.ts` (new) | `WEB_ONLY_CHAT_ID`, `broadcastNotice`: record + send one notice to every allowed chat, never throws |
| `apps/server/src/wire/booking-notifier.ts` | renders booking notices; delegates delivery to `broadcastNotice` |
| `apps/server/src/pipeline/day.ts` | morning pipeline, reminder, December nudge; all notices via `broadcastNotice` |
| `apps/server/src/pipeline/wire.ts` | cron schedule only |
| `apps/server/src/http/routes/runs.ts` | order-cancel notice via `broadcastNotice` |
| `apps/server/src/wire/capture.ts` | `/orders` grouped by run |
| `apps/server/src/domain/notice-feed.ts` (new) | `loadNoticePage`: grouping + cursor paging over `listBefore` |
| `apps/server/src/http/routes/notifications.ts` (new) | `GET /notifications`: query parsing, ticker join |
| `apps/server/src/domain/repo-types.ts`, `db/repos.ts`, `test/http-fakes.ts` | `NotificationRepo.listBefore` |
| `apps/web/src/components/SystemNotices.tsx` (new) | the panel: load, Show older, expand, links |
| `apps/web/src/components/hooks.tsx`, `App.tsx`, `pages/RunDetail.tsx`, `components/RunPanels.tsx`, `components/NoticeList.tsx` | deep link: parse → initial tab → highlight + scroll |

---

### Task 1: Shared `broadcastNotice` helper, adopted by the booking notifier

**Files:**
- Create: `apps/server/src/wire/broadcast.ts`
- Create: `apps/server/test/broadcast.test.ts`
- Modify: `apps/server/src/wire/booking-notifier.ts` (remove `WEB_ONLY_CHAT_ID` and the inner `broadcast`)
- Modify: `apps/server/src/pipeline/day.ts:7` (import `WEB_ONLY_CHAT_ID` from `../wire/broadcast`; nothing else yet)
- Modify: `apps/web/src/components/NoticeList.tsx:23` (the comment names `apps/server/src/wire/broadcast.ts`)
- Modify: `apps/server/test/booking-notifier.test.ts` (one added test; existing tests unchanged)
- Modify: `AGENTS.md` (repo map: `wire/broadcast.ts`; test list: `broadcast`)

**Interfaces:**
- Produces (`apps/server/src/wire/broadcast.ts`):

```ts
export const WEB_ONLY_CHAT_ID = 'web'

// Generic over the run id so a caller whose repo only takes numeric run ids (booking notifier) stays sound.
export interface BroadcastDeps<R extends number | null = number | null> {
  allowedChatIds: string[]
  send: (chatId: string, text: string) => Promise<void>
  notificationRepo: { insert(n: { runId: R; chatId: string; text: string }): Promise<unknown> }
}

export interface NoticeLog {
  kind: string                      // e.g. 'digest', 'closed', 'sell-attributed'
  label?: string                    // console.error prefix, default 'notice failed:'
  extra?: Record<string, unknown>   // merged into the logged object, e.g. { orderId }
}

export async function broadcastNotice<R extends number | null>(
  deps: BroadcastDeps<R>, runId: R, text: string, log: NoticeLog,
): Promise<void>
```

- [ ] **Step 1: Write the failing tests** in `apps/server/test/broadcast.test.ts`

```ts
import { describe, test, expect, spyOn } from 'bun:test'
import { broadcastNotice, WEB_ONLY_CHAT_ID } from '../src/wire/broadcast'

function harness(allowedChatIds: string[], fail: { send?: string[]; insert?: string[] } = {}) {
  const rows: Array<{ runId: number | null; chatId: string; text: string }> = []
  const sent: Array<{ chatId: string; text: string }> = []
  const events: string[] = []
  const deps = {
    allowedChatIds,
    send: async (chatId: string, text: string) => {
      events.push(`send:${chatId}`)
      if (fail.send?.includes(chatId)) throw new Error('telegram-down')
      sent.push({ chatId, text })
    },
    notificationRepo: {
      insert: async (n: { runId: number | null; chatId: string; text: string }) => {
        events.push(`insert:${n.chatId}`)
        if (fail.insert?.includes(n.chatId)) throw new Error('db-down')
        rows.push(n)
      },
    },
  }
  return { deps, rows, sent, events }
}
```

Each test spies `console.error` (`spyOn(console, 'error').mockImplementation(() => {})`, restored in `finally`) and awaits `broadcastNotice(h.deps, runId, 'hi', log)` without a `try`: a throw fails the test.

| Test name | Call | Assertions |
| --- | --- | --- |
| `no allowed chat: one web row, nothing sent` | `harness([])`, `runId null`, `{ kind: 'closed' }` | `WEB_ONLY_CHAT_ID` is `'web'`; `rows` equals `[{ runId: null, chatId: 'web', text: 'hi' }]`; `sent` equals `[]`; no error logged |
| `each chat is recorded, then sent` | `harness(['a', 'b'])`, `runId 7`, `{ kind: 'digest' }` | `events` equals `['insert:a', 'send:a', 'insert:b', 'send:b']`; `rows` has `runId: 7` for `a` and `b` |
| `a failing send keeps the row and the other chats` | `harness(['a', 'b'], { send: ['a'] })`, `runId 7`, `{ kind: 'digest' }` | `rows.map(chatId)` equals `['a', 'b']`; `sent.map(chatId)` equals `['b']`; `errors.mock.calls` equals `[['notice failed:', 'digest', { runId: 7, chatId: 'a' }, 'Error: telegram-down']]` |
| `a failing insert still sends to that chat` | `harness(['a', 'b'], { insert: ['a'] })` | `sent.map(chatId)` equals `['a', 'b']`; `rows.map(chatId)` equals `['b']`; one log ending `'Error: db-down'` |
| `insert and send both failing for a chat logs both and moves on` | `harness(['a', 'b'], { insert: ['a'], send: ['a'] })` | `errors` called 2 times, both with `chatId: 'a'`; `rows` and `sent` each hold only `b` |
| `a failing web-only insert is logged, not thrown` | `harness([], { insert: ['web'] })`, `runId null`, `{ kind: 'conflict' }` | `errors.mock.calls` equals `[['notice failed:', 'conflict', { runId: null, chatId: 'web' }, 'Error: db-down']]` |
| `label and extra shape the log line` | `harness(['a'], { send: ['a'] })`, `runId 7`, `{ kind: 'sell-attributed', label: 'booking notice failed:', extra: { orderId: 12 } }` | `errors.mock.calls[0]` equals `['booking notice failed:', 'sell-attributed', { runId: 7, orderId: 12, chatId: 'a' }, 'Error: telegram-down']` |

Add to `apps/server/test/booking-notifier.test.ts` (describe `booking notifier: sellAttributed`):

```ts
test('a chat whose insert fails still gets the message', async () => {
  const sent: string[] = []
  const notifier = makeBookingNotifier({
    repos: {
      notificationRepo: { insert: async (n) => { if (n.chatId === '42') throw new Error('db-down') } },
      runRepo: { get: async () => ({ ticker: 'AAPL' }) },
    },
    allowedChatIds: ['42', '43'],
    send: async (chatId) => { sent.push(chatId) },
    lang: 'en',
  })
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await notifier.sellAttributed(7, attribution)
    expect(sent).toEqual(['42', '43'])
    expect(errors.mock.calls).toEqual([['booking notice failed:', 'sell-attributed', { runId: 7, orderId: null, chatId: '42' }, 'Error: db-down']])
  } finally { errors.mockRestore() }
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/server/test/broadcast.test.ts apps/server/test/booking-notifier.test.ts`
Expected: FAIL — `Cannot find module '../src/wire/broadcast'`; the new notifier test fails with `sent` equal to `['43']`.

- [ ] **Step 3: Implement `broadcastNotice`** in `apps/server/src/wire/broadcast.ts` (signature above)

No chat → one insert with `WEB_ONLY_CHAT_ID`. Otherwise, per chat in order: insert, then send, each in its own `try`. Every caught error is one `console.error(log.label ?? 'notice failed:', log.kind, { runId, ...log.extra, chatId }, String(e))`. The function never rejects.

- [ ] **Step 4: Adopt it in `makeBookingNotifier`**

Delete the inner `broadcast` and the `WEB_ONLY_CHAT_ID` export; both call sites call `broadcastNotice({ allowedChatIds: deps.allowedChatIds, send: deps.send, notificationRepo: deps.repos.notificationRepo }, runId, text, { kind: notice, label: 'booking notice failed:', extra: { orderId } })`. `BookingNotifierDeps` is unchanged. Update the block comment above `makeBookingNotifier` (delivery rules now live in `broadcast.ts`), the `day.ts` import path and the `NoticeList.tsx` comment.

- [ ] **Step 5: Run to verify they pass**

Run: `bun test apps/server/test/broadcast.test.ts apps/server/test/booking-notifier.test.ts apps/server/test/http-sibling-notify.test.ts && bun test && bun run typecheck`
Expected: PASS, 0 fail; typecheck prints no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/wire/broadcast.ts apps/server/src/wire/booking-notifier.ts apps/server/src/pipeline/day.ts apps/server/test/broadcast.test.ts apps/server/test/booking-notifier.test.ts apps/web/src/components/NoticeList.tsx AGENTS.md
git commit -m "fix: share one never-throwing notice broadcast helper (#87)"
```

---

### Task 2: Pipeline, reminder, December nudge and order-cancel notices go through the helper

**Files:**
- Modify: `apps/server/src/pipeline/day.ts` (the five send/insert loops; new `runDecemberNudge`)
- Modify: `apps/server/src/pipeline/wire.ts:29-40` (nudge cron body)
- Modify: `apps/server/src/http/routes/runs.ts:265-276` (order-cancel notice)
- Create: `apps/server/test/day-notices.test.ts`
- Modify: `apps/server/test/http-orders.test.ts` (one test rewritten, two added)
- Modify: `AGENTS.md` (test list: `day-notices`)

**Interfaces:**
- Consumes: `broadcastNotice`, `BroadcastDeps`, `NoticeLog` from Task 1.
- Produces: `export async function runDecemberNudge(deps: DayDeps): Promise<void>` in `apps/server/src/pipeline/day.ts`. Notice kinds logged by the pipeline: `'closed' | 'conflict' | 'data-error' | 'digest' | 'reminder' | 'december-nudge'`; by the cancel route: `'order-cancelled'` with `extra: { orderId }`. All use the default label.

- [ ] **Step 1: Write the failing tests** in `apps/server/test/day-notices.test.ts`

```ts
import { describe, test, expect, spyOn } from 'bun:test'
import { emptyState } from '@st/core'
import { DEFAULT_MR_PARAMS } from '@st/strategies'
import { runDecemberNudge, runMorningPipeline, runReminder, type DayDeps } from '../src/pipeline/day'
import { makeFakes } from './http-fakes'

// Runs get ids 1, 2, ... and names 'T', 'A', so a digest's first line is 'T  TSLA' / 'A  AAPL'.
async function setup(over: Partial<DayDeps> = {}, tickers: string[] = ['TSLA', 'AAPL']) {
  const f = makeFakes()
  for (const ticker of tickers) {
    const st = emptyState(10)
    st.cashCents = 1000000
    await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: ticker[0]!, poolCents: 1000000, costPpm: 30, initialRunState: st })
  }
  const sent: { chatId: string; text: string }[] = []
  const deps: DayDeps = {
    today: () => '2026-11-06',
    fetchLastClose: async () => ({ date: '2026-11-05', close: 3402300n }),
    crossCheck: async () => ({ agree: true }),
    send: async (chatId, text) => { sent.push({ chatId, text }) },
    allowedChatIds: ['c1', 'c2'],
    repos: f.repos,
    params: () => DEFAULT_MR_PARAMS,
    digestLang: 'en',
    ...over,
  }
  return { f, deps, sent }
}
const head = (text: string) => text.split('\n')[0]
const rowsOf = (f: ReturnType<typeof makeFakes>) => f.notifications.map((n) => ({ runId: n.runId, chatId: n.chatId, text: n.text }))
const CONFLICT = 'Calendar conflict — local and remote calendars disagree. No orders today, please check manually'
const WARN = (id: number, tk: string) => `Market data error — run #${id} ${tk}: last close unavailable or stale. Today's orders for this run could not be computed.`
```

Tests (spy `console.error` wherever a failure is injected):

`describe('pipeline notices survive a failing chat or insert')`
- `a chat whose send fails does not hide the other chat or the next run`: `deps.send` throws `Error('telegram-down')` for `c1`, records otherwise.
  `expect(await runMorningPipeline(deps)).toBe('sent')`;
  `expect(sent.map((s) => [s.chatId, head(s.text)])).toEqual([['c2', 'T  TSLA'], ['c2', 'A  AAPL']])`;
  `expect(f.notifications.map((n) => [n.runId, n.chatId])).toEqual([[1, 'c1'], [1, 'c2'], [2, 'c1'], [2, 'c2']])`;
  `expect(errors).toHaveBeenCalledWith('notice failed:', 'digest', { runId: 1, chatId: 'c1' }, 'Error: telegram-down')`.
- `a notification insert failing for one run does not stop the next run`: wrap `f.repos.notificationRepo.insert` to throw `Error('db-down')` when `n.runId === 1`.
  Result `'sent'`; `expect(new Set(f.orders.map((o) => o.runId))).toEqual(new Set([1, 2]))`;
  `expect(sent.filter((s) => s.chatId === 'c1').map((s) => head(s.text))).toEqual(['T  TSLA', 'A  AAPL'])`;
  `expect(f.notifications.map((n) => n.runId)).toEqual([2, 2])`.
- `a data-error warning that cannot be sent does not stop the next run`: `fetchLastClose` returns `{ date: '2026-11-04', close: 3402300n }` for `TSLA`; `deps.send` throws when the text includes `'Market data error'`.
  Result `'sent'`; `f.orders.every((o) => o.runId === 2)` and `f.orders.length > 0`;
  `expect(rowsOf(f).slice(0, 2)).toEqual([{ runId: 1, chatId: 'c1', text: WARN(1, 'TSLA') }, { runId: 1, chatId: 'c2', text: WARN(1, 'TSLA') }])`.
- `a closed-day notice that no chat accepts still returns closed`: `today: () => '2026-11-26'`, `send` always throws.
  Result `'closed'`; `expect(rowsOf(f).map((r) => [r.chatId, r.text])).toEqual([['c1', 'Market closed (Thanksgiving)'], ['c2', 'Market closed (Thanksgiving)']])`.
- `reminder and December nudge carry on past a failing chat`: `send` throws for `c1`; `await runReminder(deps); await runDecemberNudge(deps)` both resolve; `sent.map((s) => s.chatId)` equals `['c2', 'c2']`; 4 rows.

`describe('with no Telegram chat every notice leaves one web row')` — all with `allowedChatIds: []`, all assert `sent` equals `[]`:
- `closed` (`today: () => '2026-11-26'`): result `'closed'`; `rowsOf(f)` equals `[{ runId: null, chatId: 'web', text: 'Market closed (Thanksgiving)' }]`.
- `conflict` (`crossCheck: async () => ({ agree: false })`): result `'conflict'`; `rowsOf(f)` equals `[{ runId: null, chatId: 'web', text: CONFLICT }]`; `f.orders` equals `[]`.
- `digest` (tickers `['TSLA']`): result `'sent'`; `f.notifications.map((n) => [n.runId, n.chatId, head(n.text)])` equals `[[1, 'web', 'T  TSLA']]`.
- `reminder`: `await runReminder(deps)`; `rowsOf(f)` equals `[{ runId: null, chatId: 'web', text: '16:05 fill capture reminder' }]`.
- `December nudge`: `await runDecemberNudge(deps)`; `rowsOf(f)` equals `[{ runId: null, chatId: 'web', text: "December — time to load next year's NYSE calendar" }]`.

In `apps/server/test/http-orders.test.ts`:
- Rewrite `cancel order succeeds with no allowed chats: 200, no notification rows, no sends` as `cancel order with no allowed chats: 200, one web row, no sends`: same setup; replace the notification assertion with
  `expect(f.notifications.filter((n) => n.runId === runId).map((n) => n.chatId)).toEqual(['web'])` and `expect(f.notifications[0]!.text).toContain('Cancelled')`; keep `f.sent` empty.
- Add `cancel order: a failing Telegram send still answers ok and keeps the row`: build deps with `makeDeps(f)`, set `deps.send = async () => { throw new Error('telegram-down') }`, cancel an open order with reason `'other'`.
  `res.status` 200; body `{ ok: true }`; order status `'cancelled'`; `f.notifications.map((n) => n.chatId)` equals `['42']`;
  `expect(errors.mock.calls).toEqual([['notice failed:', 'order-cancelled', { runId, orderId: id, chatId: '42' }, 'Error: telegram-down']])`.
- Add `cancel order: a failing notification insert still answers ok and still sends`: `f.repos.notificationRepo.insert = async () => { throw new Error('db-down') }`.
  Status 200, body `{ ok: true }`; `f.sent` has one message to `'42'` containing `'Cancelled'`; one error logged ending `'Error: db-down'`.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/server/test/day-notices.test.ts apps/server/test/http-orders.test.ts`
Expected: FAIL — `day-notices.test.ts` does not load (`runDecemberNudge` is not exported by `day.ts`); in `http-orders.test.ts` the rewritten test sees no `web` row and the two new tests get status 500.

- [ ] **Step 3: Route every notice in `day.ts` through the helper**

Add one module-level helper `notify(deps: DayDeps, runId: number | null, text: string, kind: string): Promise<void>` that calls `broadcastNotice({ allowedChatIds: deps.allowedChatIds, send: deps.send, notificationRepo: deps.repos.notificationRepo }, runId, text, { kind })`. Replace the closed loop (`'closed'`, `null`), the conflict loop (`'conflict'`, `null`), the body of `warnDataError` (`'data-error'`, `run.id`), the digest chunk loop (`'digest'`, `run.id`, one call per chunk) and the `runReminder` loop (`'reminder'`, `null`). Drop the `WEB_ONLY_CHAT_ID` import. Add `runDecemberNudge`: text `t('december-nudge', deps.digestLang)`, `runId` `null`, kind `'december-nudge'`, no trading-day check. Leave the `plan.notices.push` line and everything inside `withRunLock` untouched.

- [ ] **Step 4: Call it from the cron and the cancel route**

`pipeline/wire.ts`: the nudge cron body becomes `await runDecemberNudge(deps)` inside the existing `try` (log lines unchanged; drop the now-unused `t` import). `http/routes/runs.ts`: replace the `for (const chatId of deps.allowedChatIds)` loop with one `await broadcastNotice({ allowedChatIds: deps.allowedChatIds, send: deps.send, notificationRepo: deps.repos.notificationRepo }, id, text, { kind: 'order-cancelled', extra: { orderId } })`.

- [ ] **Step 5: Run to verify they pass**

Run: `bun test apps/server/test/day-notices.test.ts apps/server/test/day.test.ts apps/server/test/http-orders.test.ts && bun test && bun run typecheck`
Expected: PASS, 0 fail (including `apps/web/src/catalog.test.ts`, which reads `day.ts`).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/pipeline/day.ts apps/server/src/pipeline/wire.ts apps/server/src/http/routes/runs.ts apps/server/test/day-notices.test.ts apps/server/test/http-orders.test.ts AGENTS.md
git commit -m "fix: pipeline, reminder, nudge and order-cancel notices never throw and always leave a row (#86, #87)"
```

---

### Task 3: Telegram `/orders` groups orders under a per-run header (#85)

**Files:**
- Modify: `packages/telegram/src/i18n.ts:57` (`orders-line`)
- Modify: `apps/server/src/wire/capture.ts:257-276` (`onOrders`)
- Modify: `apps/server/test/wire.test.ts:905-927` (two tests rewritten, one added)
- Modify: `README.md:144` (`/orders` — today's open orders, grouped by run)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `/orders` message format: groups ordered by ascending run id, each `<header>\n<line>\n<line>`, groups joined by `\n\n`. Header is `status-run-line` for a run found in `runRepo.list()` (any status), `orders-run-missing` otherwise. Lines keep the order `orderRepo.listForDate` returned.

- [ ] **Step 1: Rewrite and add the failing tests** in `apps/server/test/wire.test.ts`

In `onOrders lists orders due today and says so when empty` replace the last expectation with:

```ts
expect(h.sent[1]!.text).toBe(
  'Run #1 NVDA\n#1 buy_loc 10 sh @ $170.00\n\nRun #2 AAPL\n#2 sell_loc 5 sh @ $200.00\n\nrun #9\n#3 buy_loc 1 sh @ $50.00',
);
```

In `onOrders names a missing run in Korean` replace the expectation with `expect(h.sent[0]!.text).toBe('런 #9\n#3 buy_loc 1주 @ $50.00');`

Add:

```ts
test('onOrders tells two runs on the same ticker apart, ordered by run id', async () => {
  const h = makeCapture({ runs: [activeRun(3, 'NVDA'), activeRun(1, 'NVDA')] });
  const base = { bucketIdx: 0, tradeDate: '2026-11-10', status: 'open', skipReason: null, cancelReason: null } as const;
  const orders: OrderRecord[] = [
    { ...base, id: 1, runId: 3, kind: 'buy_loc', limitPrice: parseUsd('170.00'), shares: 10 },
    { ...base, id: 2, runId: 1, kind: 'sell_loc', limitPrice: parseUsd('200.00'), shares: 5 },
    { ...base, id: 3, runId: 3, kind: 'sell_loc', limitPrice: parseUsd('190.00'), shares: 10 },
  ];
  h.repos.orderRepo.listForDate = async () => orders;
  await h.handlers.onOrders('777');
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]!.text).toBe(
    'Run #1 NVDA\n#2 sell_loc 5 sh @ $200.00\n\nRun #3 NVDA\n#1 buy_loc 10 sh @ $170.00\n#3 sell_loc 10 sh @ $190.00',
  );
});

test('onOrders renders the run header in Korean', async () => {
  const h = makeCapture({ runs: [activeRun(1, 'NVDA')], lang: 'ko' });
  const order: OrderRecord = { id: 1, runId: 1, bucketIdx: 0, kind: 'buy_loc', limitPrice: parseUsd('170.00'), shares: 10, tradeDate: '2026-11-10', status: 'open', skipReason: null, cancelReason: null };
  h.repos.orderRepo.listForDate = async () => [order];
  await h.handlers.onOrders('777');
  expect(h.sent[0]!.text).toBe('런 #1 NVDA\n#1 buy_loc 10주 @ $170.00');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/server/test/wire.test.ts -t onOrders`
Expected: FAIL — the texts still read `#1 buy_loc NVDA 10 sh @ $170.00` with no headers.

- [ ] **Step 3: Change the `orders-line` copy** to the Global Constraints text (drop `{ticker}` in en and ko).

- [ ] **Step 4: Group in `onOrders`**

After the empty check: one `runRepo.list()` → `Map<runId, ticker>`; bucket the orders by `runId`, walk run ids ascending, emit the header then one `orders-line` per order (`id`, `kind`, `shares`, `price: formatUsd(o.limitPrice)`), join groups with a blank line, one `deps.send`.

- [ ] **Step 5: Run to verify they pass**

Run: `bun test apps/server/test/wire.test.ts packages/telegram && bun test && bun run typecheck`
Expected: PASS, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add packages/telegram/src/i18n.ts apps/server/src/wire/capture.ts apps/server/test/wire.test.ts README.md
git commit -m "feat: group Telegram /orders under per-run headers (#85)"
```

---

### Task 4: Global notifications feed — `listBefore`, grouping, `GET /api/notifications`

**Files:**
- Create: `apps/server/src/domain/notice-feed.ts`
- Create: `apps/server/src/http/routes/notifications.ts`
- Modify: `apps/server/src/domain/repo-types.ts:47-50` (`NotificationRepo`)
- Modify: `apps/server/src/db/repos.ts:216-219` (real `listBefore`; import `lt`, `desc`)
- Modify: `apps/server/src/http/app.ts` (register the router)
- Modify: `apps/server/test/http-fakes.ts:140-143` (fake `listBefore`; the file ends near 303 lines, accepted)
- Modify: `apps/server/test/repo-surface-types.test.ts` (one pin in `_restPins`)
- Create: `apps/server/test/notice-feed.test.ts`, `apps/server/test/http-notifications.test.ts`, `apps/server/test/db-notifications.test.ts`
- Modify: `AGENTS.md` (repo map: `domain/notice-feed.ts`, route `notifications`; test list: `notice-feed`)

**Interfaces:**
- Consumes: `parseId` (`apps/server/src/http/params.ts`), `HttpDeps` (`apps/server/src/http/app.ts`).
- Produces:

```ts
// repo-types.ts — newest first (id descending); only rows with id < before when before is not null
interface NotificationRepo { listBefore(before: number | null, limit: number): Promise<NotificationRow[]> }

// domain/notice-feed.ts
export const NOTICE_PAGE_DEFAULT = 20
export const NOTICE_PAGE_MAX = 100
/** id and sentAt come from the newest row; chatIds are in ascending row-id order. */
export interface NoticeEntry { id: number; runId: number | null; text: string; sentAt: string; chatIds: string[] }
export interface NoticePage { entries: NoticeEntry[]; nextBefore: number | null }
export async function loadNoticePage(repo: Pick<NotificationRepo, 'listBefore'>, before: number | null, limit: number): Promise<NoticePage>

// http/routes/notifications.ts
export function notificationsRouter(deps: HttpDeps): Hono
// GET /api/notifications?before=<id>&limit=<n>
// 200 { entries: Array<NoticeEntry & { ticker: string | null }>, nextBefore: number | null }
```

- [ ] **Step 1: Write the failing grouping tests** in `apps/server/test/notice-feed.test.ts`

```ts
import { describe, test, expect } from 'bun:test'
import { loadNoticePage } from '../src/domain/notice-feed'

// rows get ids 1..n in the order given (oldest first)
function feed(rows: Array<[runId: number | null, chatId: string, text: string]>) {
  const all = rows.map(([runId, chatId, text], i) => ({ id: i + 1, runId, chatId, text, sentAt: `t${i + 1}` }))
  const repo = {
    listBefore: async (before: number | null, limit: number) =>
      all.filter((r) => before === null || r.id < before).sort((a, b) => b.id - a.id).slice(0, limit),
  }
  return { repo, all }
}
const ids = (p: { entries: { id: number }[] }) => p.entries.map((e) => e.id)
```

| Test name | Rows (oldest first) | Call | Expected |
| --- | --- | --- | --- |
| `an empty table is an empty last page` | none | `(null, 20)` | `{ entries: [], nextBefore: null }` |
| `newest first, one entry per distinct message` | `[5,'a','x']`, `[5,'a','y']`, `[null,'a','z']` | `(null, 20)` | `ids` `[3, 2, 1]`; entry 0 equals `{ id: 3, runId: null, text: 'z', sentAt: 't3', chatIds: ['a'] }` |
| `per-chat rows of one broadcast collapse, anchored on the newest row` | `[5,'a','x']`, `[5,'b','x']` | `(null, 20)` | entries equal `[{ id: 2, runId: 5, text: 'x', sentAt: 't2', chatIds: ['a', 'b'] }]` |
| `the same text for another run is another entry` | `[5,'a','x']`, `[6,'a','x']` | `(null, 20)` | `ids` `[2, 1]` |
| `the same text repeated to the same chat is another entry` | `[null,'web','r']`, `[null,'web','r']` | `(null, 20)` | `ids` `[2, 1]`; `chatIds` `[['web'], ['web']]` |
| `the same text broadcast twice to two chats is two entries` | `[null,'a','r']`, `[null,'b','r']`, `[null,'a','r']`, `[null,'b','r']` | `(null, 20)` | `ids` `[4, 2]`; `chatIds` `[['a','b'], ['a','b']]` |
| `rows that are not adjacent do not collapse` | `[5,'a','x']`, `[5,'a','y']`, `[5,'b','x']` | `(null, 20)` | `ids` `[3, 2, 1]` |
| `pages never repeat or split a group` | 5 messages `m1..m5`, each to `'a'` then `'b'` (10 rows) | `(null, 2)`, then `(nextBefore, 2)` twice | pages `ids` `[10, 8]` / `[6, 4]` / `[2]`; `nextBefore` `7`, `3`, `null`; every entry has `chatIds` `['a','b']` |
| `a group wider than the page is still whole` | 2 messages, each to `'a'`, `'b'`, `'c'` (6 rows) | `(null, 1)`, then `(4, 1)` | first: `ids` `[6]`, `chatIds` `['a','b','c']`, `nextBefore` `4`; second: `ids` `[3]`, `nextBefore` `null` |
| `exactly one full page has no next page` | 2 distinct rows | `(null, 2)` | `ids` `[2, 1]`; `nextBefore` `null` |
| `rows written after page one do not shift page two` | 4 distinct rows; after the first call push 2 more into `all` (ids 5, 6) | `(null, 2)`, then `(nextBefore, 2)` | first `ids` `[4, 3]`, `nextBefore` `3`; second `ids` `[2, 1]` |

Also write `apps/server/test/db-notifications.test.ts` — `describeIf` + `beforeAll` exactly as in `apps/server/test/db.test.ts:14-23` (shared `st_test`, inserts only):

```ts
test('listBefore pages newest first below the cursor', async () => {
  const mark = `nb-${Date.now()}-${process.pid}`
  const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'NB', name: mark, poolCents: 1000, costPpm: 10 })
  await repos.notificationRepo.insert({ runId: null, chatId: 'web', text: `${mark}-1` })
  await repos.notificationRepo.insert({ runId, chatId: '42', text: `${mark}-2` })
  await repos.notificationRepo.insert({ runId, chatId: '43', text: `${mark}-3` })
  const top = await repos.notificationRepo.listBefore(null, 3)
  expect(top.map((r) => [r.runId, r.chatId, r.text])).toEqual([[runId, '43', `${mark}-3`], [runId, '42', `${mark}-2`], [null, 'web', `${mark}-1`]])
  expect(top[0]!.id).toBeGreaterThan(top[1]!.id)
  expect(top[1]!.id).toBeGreaterThan(top[2]!.id)
  expect(typeof top[0]!.sentAt).toBe('string')
  expect((await repos.notificationRepo.listBefore(top[0]!.id, 2)).map((r) => r.id)).toEqual([top[1]!.id, top[2]!.id])
  expect((await repos.notificationRepo.listBefore(top[2]!.id, 1000)).every((r) => r.id < top[2]!.id)).toBe(true)
  expect(await repos.notificationRepo.listBefore(null, 1)).toHaveLength(1)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/notice-feed.test.ts apps/server/test/db-notifications.test.ts`
Expected: FAIL — `Cannot find module '../src/domain/notice-feed'`; `repos.notificationRepo.listBefore is not a function`.

- [ ] **Step 3: Add `listBefore` to the repo type, the real repo and the HTTP fake; implement `loadNoticePage`**

- `repo-types.ts`: add the method to `NotificationRepo` (`RepoSurface` keeps `Pick<NotificationRepo, 'insert'>`).
- `db/repos.ts`: `select().from(s.notifications).where(before === null ? undefined : lt(s.notifications.id, before)).orderBy(desc(s.notifications.id)).limit(limit)`.
- `test/http-fakes.ts`: `async listBefore(before: number | null, limit: number) { return notifications.filter((n) => before === null || n.id < before).sort((a, b) => b.id - a.id).slice(0, limit) }`.
- `repo-surface-types.test.ts`, in `_restPins`: `// @ts-expect-error the page cursor is a row id or null` above `await r.notificationRepo.listBefore('5', 20)`.
- `loadNoticePage`: read rows newest first in batches of `limit * 2 + 1` (`listBefore(cursor, batch)`, cursor = the last row id of the previous batch, starting from `before`). A row joins the entry being built when `runId` and `text` match and its `chatId` is not yet in that entry; otherwise it starts a new entry. Stop when entry `limit + 1` has been started or a batch comes back shorter than asked. Return the first `limit` entries; `nextBefore` is the smallest row id of the last returned entry when entry `limit + 1` was started, else `null`.

- [ ] **Step 4: Run to verify they pass**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/notice-feed.test.ts apps/server/test/db-notifications.test.ts && bun run typecheck`
Expected: PASS; typecheck clean (the fake and real repo both satisfy `NotificationRepo`).

- [ ] **Step 5: Write the failing route tests**

`apps/server/test/http-notifications.test.ts` — harness: `makeFakes`, `makeDeps`, `loginAs`, `createRun` from `./http-fakes`, `FAKE_CREATED_AT` from `./booking-fakes`; `const add = (runId: number | null, chatId: string, text: string) => f.repos.notificationRepo.insert({ runId, chatId, text })`; `get(path)` returns `{ status, body }`.

- `401 without a token`: `app.request('/api/notifications')` → status 401.
- `lists every notice newest first, grouped, with the run ticker`: `createRun(app, auth, { name: 'r', ticker: 'AAPL', costPpm: 0, poolCents: 100 })` (id 1); `add(1, '42', 'digest')`, `add(1, '43', 'digest')`, `add(null, '42', 'closed')`, `add(99, 'web', 'orphan')`.

```ts
expect(await get('/api/notifications')).toEqual({ status: 200, body: {
  entries: [
    { id: 4, runId: 99, ticker: null, text: 'orphan', sentAt: FAKE_CREATED_AT, chatIds: ['web'] },
    { id: 3, runId: null, ticker: null, text: 'closed', sentAt: FAKE_CREATED_AT, chatIds: ['42'] },
    { id: 2, runId: 1, ticker: 'AAPL', text: 'digest', sentAt: FAKE_CREATED_AT, chatIds: ['42', '43'] },
  ],
  nextBefore: null,
} })
```

- `pages 20 at a time by default and before continues without repeats`: 25 rows `add(null, '42', `n${i}`)`. First page ids `[25..6]`, `nextBefore` `6`; `/api/notifications?before=6` ids `[5..1]`, `nextBefore` `null`.
- `limit is honoured and clamped to 100`: 105 distinct rows. `?limit=2` → ids `[105, 104]`, `nextBefore` `104`; `?limit=1000` → 100 entries, `nextBefore` `6`.
- `a malformed cursor or limit is a 400`: `?before=abc`, `?before=0`, `?before=1.5` → `{ status: 400, body: { error: 'invalid before' } }`; `?limit=0`, `?limit=abc` → `{ status: 400, body: { error: 'invalid limit' } }`.

- [ ] **Step 6: Run to verify they fail**

Run: `bun test apps/server/test/http-notifications.test.ts`
Expected: FAIL — every authenticated request answers 404 (the 401 test already passes: the auth middleware covers every path).

- [ ] **Step 7: Implement `notificationsRouter` and register it**

`GET /notifications`: `before` absent → `null`, else `parseId` (null → 400 `invalid before`); `limit` absent → `NOTICE_PAGE_DEFAULT`, else `parseId` (null → 400 `invalid limit`), then `Math.min(n, NOTICE_PAGE_MAX)`. Call `loadNoticePage(deps.repos.notificationRepo, before, limit)`. When any entry has a run id, one `deps.repos.runRepo.list()` builds an id → ticker map; each entry gets `ticker` (`null` for a global notice or a run not in the list). In `app.ts` add `app.route('/api', notificationsRouter(deps))` next to the other routers.

- [ ] **Step 8: Run to verify everything passes**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server && bun test && bun run typecheck`
Expected: PASS, 0 fail.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/domain/notice-feed.ts apps/server/src/domain/repo-types.ts apps/server/src/db/repos.ts apps/server/src/http/routes/notifications.ts apps/server/src/http/app.ts apps/server/test/http-fakes.ts apps/server/test/repo-surface-types.test.ts apps/server/test/notice-feed.test.ts apps/server/test/http-notifications.test.ts apps/server/test/db-notifications.test.ts AGENTS.md
git commit -m "feat: paged global notifications feed, one entry per message (#86)"
```

---

### Task 5: System notices panel on the Runs page

**Files:**
- Create: `apps/web/src/components/SystemNotices.tsx`, `apps/web/src/components/SystemNotices.test.tsx`
- Modify: `apps/web/src/api.types.ts` (after `NotificationDto`), `apps/web/src/api.ts` (`Api.listNotices` + implementation)
- Modify: `apps/web/src/pages/RunsList.tsx` (render the panel; refresh after the morning trigger)
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json` (four keys, Global Constraints)
- Modify: `apps/web/src/api.test.ts`, `apps/web/src/pages/RunsList.test.tsx`
- Modify: `README.md:136-137` (Telegram section), `AGENTS.md` (components list: `SystemNotices`)

**Interfaces:**
- Consumes: `GET /api/notifications` response from Task 4.
- Produces:

```ts
// api.types.ts
/** One message of the global feed: the per-chat rows of one broadcast collapsed; `id` is the newest row's id. */
export interface NoticeEntryDto extends Omit<NotificationDto, 'chatId'> { ticker: string | null; chatIds: string[] }
export interface NoticePageDto { entries: NoticeEntryDto[]; nextBefore: number | null }

// api.ts — GET /api/notifications, or /api/notifications?before=<id> when given
listNotices(before?: number): Promise<NoticePageDto>

// components/SystemNotices.tsx — no props; the page remounts it (key) to reload
export function SystemNotices()
```

- Run-notice link format (Task 6 parses it): `#/runs/<runId>?tab=notifications&notice=<entry.id>`.
- DOM contract the tests rely on: a `Card` with `SectionTitle` `systemNoticesTitle`; one `<tr>` per entry in `<tbody>`; cells in order date (`isoDateTime(sentAt)`), source, message. Source is `#<runId> <ticker>`, `#<runId>` when the ticker is null, or `systemNoticesSystem` for a global notice. The message cell holds the preview as a direct child — an `<a>` for a run notice, a `<button type="button" aria-expanded>` for a global one — and, when a global notice is expanded, the full text (`whitespace-pre-wrap`) and a line `<notifColChat>: <chats joined by ', '>` with `web` shown as `notifChatWeb`, both inside the same cell. The preview is the first non-blank line of the text, trimmed.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/api.test.ts`:

```ts
describe('listNotices', () => {
  test('sends the before cursor only when given', async () => {
    const urls: string[] = [];
    const http: Http = async (url) => { urls.push(url); return Response.json({ entries: [], nextBefore: null }); };
    const api = createApi(http, { getToken: () => null });
    expect(await api.listNotices()).toEqual({ entries: [], nextBefore: null });
    await api.listNotices(9);
    expect(urls).toEqual(['/api/notifications', '/api/notifications?before=9']);
  });
});
```

`apps/web/src/components/SystemNotices.test.tsx` — harness copied from `NoticeList.test.tsx` (GlobalRegistrator, dynamic imports, `LangProvider` render helper) plus `installFetchStub` / `restoreFetch` and the `flush()` helper from `RunsList.test.tsx`. Fixtures:

```ts
const PAGE1 = { nextBefore: 9, entries: [
  { id: 12, runId: 3, ticker: 'NVDA', text: 'Growth  NVDA\nTrade date: 2026-11-20\nBuy 2 @ $170.00', sentAt: '2026-11-20T12:30:00.000Z', chatIds: ['42', '43'] },
  { id: 10, runId: null, ticker: null, text: 'Calendar conflict — local and remote calendars disagree.\nNo orders today, please check manually', sentAt: '2026-11-20T12:30:00.000Z', chatIds: ['web', '42'] },
  { id: 9, runId: 8, ticker: null, text: '\n  orphan  \nsecond line', sentAt: '2026-11-19T12:30:00.000Z', chatIds: ['42'] },
] };
const PAGE2 = { nextBefore: null, entries: [
  { id: 4, runId: null, ticker: null, text: '16:05 fill capture reminder', sentAt: '2026-11-18T21:05:00.000Z', chatIds: ['42'] },
] };
// The cursor route comes first: the stub matches by substring in declaration order.
const older = { url: '/api/notifications?before=9', status: 200, json: PAGE2 as unknown };
const first = { url: '/api/notifications', status: 200, json: PAGE1 as unknown };
const cells = (n: number) => [...container.querySelectorAll(`tbody tr td:nth-child(${n})`)].map((el) => el.textContent ?? '');
const previews = () => [...container.querySelectorAll('tbody tr td:nth-child(3) > a, tbody tr td:nth-child(3) > button')].map((el) => el.textContent ?? '');
```

Reset `first` / `older` to these values in `beforeEach`, then `installFetchStub([older, first])`.

| Test name | Steps | Assertions |
| --- | --- | --- |
| `lists run and system rows with a first-line preview` | render, flush | text contains `System notices`; `cells(2)` equals `['#3 NVDA', 'System', '#8']`; `previews()` equals `['Growth  NVDA', 'Calendar conflict — local and remote calendars disagree.', 'orphan']`; text does not contain `Buy 2 @` |
| `a run row links to the run's Notifications tab with the notice id` | render, flush | `container.querySelector('a[href="#/runs/3?tab=notifications&notice=12"]')!.textContent` is `'Growth  NVDA'`; `a[href="#/runs/8?tab=notifications&notice=9"]` exists |
| `a system row expands in place to its full text and chats, and collapses again` | click the `button` in row 2; then click it again | after the first click: `aria-expanded` is `'true'`, text contains `No orders today, please check manually` and `Chat: web only, 42`, still 3 `tbody tr`; after the second: `aria-expanded` `'false'`, the second line is gone |
| `Show older appends the next page and then hides` | click the button whose text is `Show older`, flush | `previews()` has 4 items, the last `'16:05 fill capture reminder'`, the first still `'Growth  NVDA'`; no `Show older` button |
| `no Show older button when the first page is the last` | `first.json = { ...PAGE1, nextBefore: null }` | no button with text `Show older` |
| `an empty feed shows the empty note` | `first.json = { entries: [], nextBefore: null }` | text contains `No notifications.`; no `tbody` |
| `a failed first load shows the error and Retry reloads it` | `first.status = 500`, render, flush; set `first.status = 200`, click `Retry`, flush | first an element with `role="alert"` and no `tbody`; then `previews()` has 3 items |
| `a failed Show older keeps the loaded rows and can be retried` | `older.status = 500`, click `Show older`, flush; set `older.status = 200`, click `Show older`, flush | after the failure: `role="alert"` present, `previews()` still 3 items, the button still there; after the retry: 4 items, no alert |
| `renders its chrome in Korean` | `localStorage.setItem('st-lang', 'ko')`, render, flush | text contains `시스템 알림` and `이전 알림 더 보기`; `cells(2)[1]` is `'시스템'` |

`apps/web/src/pages/RunsList.test.tsx` — change the `beforeEach` stub to the routes below (module-level `let noticeGets = 0; let page = …`, reset in `beforeEach`), keep the existing test, add two:

```ts
installFetchStub([
  { method: 'POST', url: '/api/trigger/morning', json: { result: '"conflict"' } },
  { url: '/api/notifications', get json() { noticeGets += 1; return page; } },
  { url: '/api/runs', json: [RUN] },
]);
```

- `shows the System notices panel under the runs table`: `page` holds one global entry with text `'16:05 fill capture reminder'`; text contains `System notices` and `16:05 fill capture reminder`; `noticeGets` is 1.
- `reloads the notices after the morning trigger`: after the first render set `page` to hold one more global entry `{ id: 2, …, text: 'Calendar conflict — check manually' }`, click the button with text `Run morning pipeline`, flush; `noticeGets` is 2 and the text contains `Calendar conflict — check manually`.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/web/src/components/SystemNotices.test.tsx apps/web/src/pages/RunsList.test.tsx apps/web/src/api.test.ts`
Expected: FAIL — `Cannot find module './SystemNotices'`; `api.listNotices is not a function`; the Runs list shows no `System notices`.

- [ ] **Step 3: Add the DTOs, `listNotices` and the four catalog keys** (shapes and copy above; keys between `statWinRate` and `tabFills` in both files).

- [ ] **Step 4: Implement `SystemNotices`**

First page through `useAsync(() => api.listNotices(), [])` (it already handles 401); older pages appended in local state with their own busy and error state; expanded ids in a `Set`. States: `Spinner` while loading; `ErrorNote` + `Button` `retry` on a failed first load; `EmptyNote` `notifEmpty` for no entries; otherwise the `TableWrap` table (headers `notifColDate`, `systemNoticesSource`, `notifColBody`) and, while `nextBefore !== null`, a `Button` `systemNoticesOlder` with `busy` during the request. A failed older-page request shows an `ErrorNote` above the button and leaves the rows and the button in place. Long previews are cut with CSS (`truncate`), not in code.

- [ ] **Step 5: Mount it in `RunsListPage`**

Below the runs `Card`: `<SystemNotices key={noticesKey} />` with `const [noticesKey, setNoticesKey] = useState(0)`; `triggerMorning`'s `finally` bumps the key so the panel remounts and reloads page one after a trigger, successful or not.

- [ ] **Step 6: Update the docs**

`README.md` Telegram section, first sentence: with no bot, every pipeline, reminder and order notice is still recorded (chat `web`) and listed under **System notices** on the Runs page. `AGENTS.md`: add `SystemNotices` to the components list.

- [ ] **Step 7: Run to verify they pass**

Run: `bun test apps/web && bun test && bun run typecheck`
Expected: PASS, 0 fail (including the catalog parity, ordering and placeholder tests).

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/SystemNotices.tsx apps/web/src/components/SystemNotices.test.tsx apps/web/src/api.ts apps/web/src/api.types.ts apps/web/src/api.test.ts apps/web/src/pages/RunsList.tsx apps/web/src/pages/RunsList.test.tsx apps/web/src/i18n/en.json apps/web/src/i18n/ko.json README.md AGENTS.md
git commit -m "feat: System notices panel on the Runs page (#86)"
```

---

### Task 6: Deep link from a notice to the run's Notifications tab

**Files:**
- Modify: `apps/web/src/components/hooks.tsx:92-114` (`Route`, `parseHash`)
- Modify: `apps/web/src/App.tsx:23-24` (`run` case)
- Modify: `apps/web/src/pages/RunDetail.tsx:43,50,233` (props, initial tab, panel prop)
- Modify: `apps/web/src/components/RunPanels.tsx:200-205` (`NotificationsPanel`)
- Modify: `apps/web/src/components/NoticeList.tsx`
- Test: `apps/web/src/components/hooks.test.tsx`, `apps/web/src/components/NoticeList.test.tsx`, `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: the link format `#/runs/<runId>?tab=notifications&notice=<id>` from Task 5.
- Produces:

```ts
// hooks.tsx — tab and notice keys are absent (not undefined-valued) when not recognised
type Route = … | { page: 'run'; id: number; tab?: 'notifications'; notice?: number } | …

// RunDetail.tsx
export function RunDetailPage(props: { id: number; initialTab?: 'notifications'; highlightNoticeId?: number })
// RunPanels.tsx
export function NotificationsPanel(props: { runId: number; highlightId?: number })
// NoticeList.tsx
export function NoticeList(props: { notifications: NotificationDto[]; highlightId?: number })
```

- The highlighted `<tr>` carries `aria-current="true"` and the class `bg-primary/10`; it is scrolled into view once per mount with `scrollIntoView({ block: 'center' })`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/components/hooks.test.tsx`:

```ts
it('reads the notifications tab and the notice id from a run link', () => {
  expect(parseHash('#/runs/3?tab=notifications&notice=12')).toStrictEqual({ page: 'run', id: 3, tab: 'notifications', notice: 12 });
  expect(parseHash('#/runs/3?tab=notifications')).toStrictEqual({ page: 'run', id: 3, tab: 'notifications' });
});

it('ignores an unknown tab, a malformed notice, and a notice without the tab', () => {
  for (const q of ['tab=bogus&notice=12', 'notice=12', 'tab=', '']) {
    expect(parseHash(`#/runs/3?${q}`)).toStrictEqual({ page: 'run', id: 3 });
  }
  for (const n of ['abc', '0', '-1', '1e3', '1.5', '']) {
    expect(parseHash(`#/runs/3?tab=notifications&notice=${n}`)).toStrictEqual({ page: 'run', id: 3, tab: 'notifications' });
  }
});

it('other pages ignore the query', () => {
  expect(parseHash('#/pending?tab=notifications&notice=1')).toStrictEqual({ page: 'pending' });
  expect(parseHash('#/runs?tab=notifications')).toStrictEqual({ page: 'runs' });
});
```

`apps/web/src/components/NoticeList.test.tsx` (import `spyOn` from `bun:test`; spy `window.Element.prototype.scrollIntoView` with `mockImplementation(() => {})`, restore in `finally`):

```ts
const marked = () => [...container.querySelectorAll('tbody tr[aria-current="true"]')].map((el) => el.textContent ?? '');
```

- `marks the highlighted notice and scrolls it into view once`: render with `highlightId: 2`; `marked()` has 1 item containing `'sold'`; the spy was called 1 time; re-render the same props through the same root (`await act(() => root.render(…))`, not the `render` helper, which creates a new root) → still 1 call.
- `an unknown highlight id marks nothing and does not scroll`: `highlightId: 99` → `marked()` equals `[]`; 0 calls; `chatCells()` still equals `['web only', '42']`.
- `without a highlight id no row is marked`: `marked()` equals `[]`; 0 calls.

`apps/web/src/App.test.tsx` — new `describe('App notice deep link')` with its own stub and an `open(hash)` helper (set `window.location.hash`, `setToken('test-token')`, create the root, render `App`, `flush()`); same `afterEach` cleanup as the existing describe:

```ts
const NOTES = [
  { id: 1, runId: 1, chatId: 'web', text: 'cancel the other leg', sentAt: '2026-11-10T14:30:00.000Z' },
  { id: 2, runId: 1, chatId: 'web', text: 'sold', sentAt: '2026-11-10T14:31:00.000Z' },
];
installFetchStub([
  { url: '/price-history', json: { start: '2026-11-04', bars: [] } },
  { url: '/orders', json: [] },
  { url: '/fills', json: [] },
  { url: '/notifications', json: NOTES },
  { url: '/api/runs/1', json: runDto(1, 'First run') },
]);
const marked = () => [...document.querySelectorAll('tbody tr[aria-current="true"]')].map((el) => el.textContent ?? '');
```

- `opens the run on the Notifications tab with the notice highlighted`: `open('#/runs/1?tab=notifications&notice=2')`; text contains `First run` and `cancel the other leg`; `marked()` has 1 item containing `'sold'`; `buttonByText('Alerts').className` contains `bg-primary`.
- `a second deep link on the same run moves the highlight`: after the first `open`, set the hash to `#/runs/1?tab=notifications&notice=1`, dispatch `hashchange` inside `act`, flush; `marked()` has 1 item containing `'cancel the other leg'`.
- `a notice id the run does not have opens the tab without a highlight`: `open('#/runs/1?tab=notifications&notice=99')`; text contains `sold`; `marked()` equals `[]`.
- `an unknown tab opens on Orders as before`: `open('#/runs/1?tab=bogus&notice=2')`; text contains `First run` and does not contain `cancel the other leg`.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/web/src/components/hooks.test.tsx apps/web/src/components/NoticeList.test.tsx apps/web/src/App.test.tsx`
Expected: FAIL — `parseHash` returns `{ page: 'run', id: 3 }` for the tab link; `marked()` is empty; the deep link lands on the Orders tab.

- [ ] **Step 3: Parse the query in `parseHash`**

Split the hash once into path and query (`URLSearchParams`). Only the `runs/<id>` branch reads it: `tab === 'notifications'` sets `tab`; `notice` is set only together with it and only when it matches `/^[1-9]\d*$/`. Every other branch is unchanged.

- [ ] **Step 4: Thread the props through**

- `App.tsx`: `<RunDetailPage key={`${route.id}:${route.tab ?? ''}:${route.notice ?? ''}`} id={route.id} initialTab={route.tab} highlightNoticeId={route.notice} />` — the key makes a changed query remount the page.
- `RunDetail.tsx`: `useState<Tab>(initialTab ?? 'orders')`; pass `highlightId={highlightNoticeId}` to `NotificationsPanel`.
- `RunPanels.tsx`: forward `highlightId` to `NoticeList`.
- `NoticeList.tsx`: mark the matching row (attribute and class above) and scroll it into view in an effect keyed on `highlightId`.

- [ ] **Step 5: Run to verify they pass**

Run: `bun test apps/web && bun test && bun run typecheck`
Expected: PASS, 0 fail.

- [ ] **Step 6: Final verification of the branch**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test`
Expected: 0 fail, no DB test skipped.
Run (from the repo root): `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`
Expected: the smoke finishes without a failed check and drops its scratch database.
Run: `wc -l apps/server/src/pipeline/day.ts apps/server/src/http/routes/runs.ts apps/server/src/wire/capture.ts apps/web/src/pages/RunsList.tsx apps/web/src/pages/RunDetail.tsx apps/web/src/api.ts apps/web/src/api.types.ts apps/web/src/components/SystemNotices.tsx`
Expected: every file at or under ~300 lines.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/hooks.tsx apps/web/src/components/hooks.test.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/pages/RunDetail.tsx apps/web/src/components/RunPanels.tsx apps/web/src/components/NoticeList.tsx apps/web/src/components/NoticeList.test.tsx
git commit -m "feat: deep link from a system notice to the run's Notifications tab (#86)"
```
