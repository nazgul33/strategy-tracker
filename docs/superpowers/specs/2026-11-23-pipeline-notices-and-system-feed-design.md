# Pipeline notice robustness (#87), web-only trace + System notices (#86), run name in /orders (#85) — design

Small project: one shared server helper, per-run failure isolation in the
morning pipeline, one new read route, one web panel, a deep link into the run's
Notifications tab, and a Telegram copy change.

Amended after the plan review (2026-11-23): per-run failure isolation with an
atomic plan write and a same-day guard, capture replies stay in the feed, and a
multi-part digest is recorded as one notification.

## Why

- #87: in `apps/server/src/pipeline/day.ts`, `deps.send(...)` and
  `notificationRepo.insert(...)` are awaited unguarded. One blocked chat or one
  DB hiccup throws out of `runMorningPipeline`, and every remaining run gets no
  orders and no digest that morning.
- #87, wider: any other throw while one run is processed (the state load, the
  planning, the order insert, the state save) aborts the remaining runs the same
  way. The two writes are also separate statements: an order insert that
  succeeds followed by a state save that fails leaves today's orders without the
  aged state. And nothing guards a second run on the same day. Measured on this
  branch: running the morning pipeline twice doubles every run's orders for the
  day (120 → 240) and ages every held bucket twice (4 → 5). So the natural
  reaction to "a run failed" — press **Run morning pipeline** again — damages
  the runs that succeeded.
- A digest longer than one Telegram message is cut into parts, and each part is
  recorded as its own notification row, so one digest shows as several entries.
- #86: with Telegram not configured (`allowedChatIds` = `[]`), the closed,
  conflict, digest and reminder messages leave no trace. The conflict case is
  the worst: no orders are computed and nothing anywhere says why. The README
  promises the web UI stays fully usable without Telegram. Global notices
  (`runId: null`) are recorded today but the web never shows them: it only lists
  notifications per run (`GET /runs/:id/notifications`).
- #85: Telegram `/orders` shows ticker but not run, so two active runs on the
  same ticker cannot be told apart.

## Goals

- One failing chat (send or insert) is logged with context and never hides the
  other chats, the other runs, or the rest of the pipeline.
- A failure anywhere in one run's processing is caught, logged with the run id,
  counted as a failed run and reported to the operator by a per-run warning. The
  remaining runs still get their orders and digests.
- A failed run leaves nothing behind (its orders and its aged state are written
  together or not at all), and running the morning pipeline again the same day
  plans only the runs that have no orders for today. It never duplicates orders
  or ages a run twice.
- With no allowed chat, every pipeline / cron / cancel message is still recorded
  as one row with chat id `web` (`WEB_ONLY_CHAT_ID`).
- A digest is one notification per chat, however many Telegram messages it took.
- A **System notices** panel on the Runs list page lists **every** notification
  (run-scoped and global), newest first.
  - Clicking a run notice opens that run on the **Notifications tab** with that
    notice highlighted and scrolled into view (full text there).
  - Clicking a global notice (no run) expands it in place to its full text.
- `/orders` groups its lines under a per-run header.

## Non-goals

- No schema change, no migration.
- No change to the run's own Notifications tab other than honouring the deep
  link (tab + highlight).
- No change to the `MorningResult` values or their meaning: `'data-error'` still
  means every active run failed, `'sent'` anything else on an open day. What
  changes is that a run which throws now counts as one failed run instead of
  aborting the pipeline.
- No isolation for failures that belong to no run: a failing `runRepo.list()` or
  cross-check still rejects the whole pipeline (the cron logs it, the trigger
  route answers 500).
- No way to re-plan a run that already has orders for today (after a gap edit,
  say). The trigger used to do that by accident, with duplicate orders.
- No filter on the feed: every notification row is listed, including the bot's
  replies to a screenshot it could not read (`capture-bad-extract`, recorded
  with no run). Decided by the user.
- No retry of failed sends.
- No unread / acknowledged state, no live push or polling in the panel.

## Approaches

Where global notices surface on the web (picked by the user: A)
- **A. A System notices panel on the Runs list page** listing all notices, with
  deep links to runs. Picked: the operator sees "calendar conflict, no orders
  today" where they land, and each message is stored once.
- B. Copy each global notice into every active run's Notifications tab — no new
  route/UI, but duplicated rows and the operator must open a run to learn why
  there were no orders.
- C. Record only, no web surface — meets the letter of #86 but the conflict
  stays invisible.

Robustness (my call)
- **One shared broadcast helper** used by `day.ts`, the Dec 1 nudge
  (`pipeline/wire.ts`) and the order-cancel route (`http/routes/runs.ts`).
  Picked over per-site try/catch: five near-identical loops collapse to one
  tested function, and the `'web'` fallback comes for free everywhere.

Partial writes and retry (my call)
- **A. One transaction for the orders and the aged state, plus a same-day
  guard.** Picked: a failed run leaves nothing behind, so "today's orders exist
  for this run" means exactly "this run was planned and aged today", and the
  trigger can skip such a run. Costs one new repo method and its fakes.
- B. Only reorder the writes. Insert-then-save leaves orders without the aged
  state; save-then-insert leaves an aged state without orders, and a retry then
  ages twice (an early forced exit). Either way the retry still duplicates the
  healthy runs.
- C. Catch and warn only, document that the trigger must not be pressed twice.
  The warning would then invite the very action that corrupts the other runs.

Multi-part digest (picked by the user)
- **Record once, send in parts.** Telegram still gets one message per part
  (length limit); the notification row holds the whole digest. Picked over
  merging at read time: both the feed and the run's own Notifications tab show
  one entry, and no reader has to know about parts.

`/orders` format (my call, from #85's two options)
- **Group under a per-run header** reusing `status-run-line`
  (`Run #{id} {ticker}`), matching `/status`. Picked over inlining `run #3` into
  every line: shorter lines, same look as `/status`.

## Design

### Server — shared broadcast helper

- New module (e.g. `apps/server/src/wire/broadcast.ts`) exporting a function
  that, given `{ allowedChatIds, send, notificationRepo }`, a `runId | null`,
  the text and a log context, does:
  - no allowed chat → insert one row with chat id `WEB_ONLY_CHAT_ID`;
  - otherwise, for each chat: insert the row, then send. The insert and the send
    are guarded **separately** (my call): a failed insert must not stop the
    Telegram message, and a failed send must not lose the record. Each failure is
    `console.error`-logged with the context (notice kind, run id, chat id).
  - never throws.
- The text is either one string (recorded and sent as is) or a recorded text
  plus the parts to send. In the second form each chat gets **one** row holding
  the recorded text, inserted before any part is sent, and then every part in
  order. Each part's send is guarded on its own: a failed part is logged (with
  its part number) and the later parts and the other chats still go out.
- `WEB_ONLY_CHAT_ID` moves to the new module (re-exported from
  `booking-notifier.ts` if needed so existing imports keep working — builder's
  call). `makeBookingNotifier`'s internal `broadcast` is replaced by the shared
  helper; its current behaviour (insert then send, per-chat isolation, `web`
  fallback) is preserved, and its tests stay green.
- `day.ts`: the closed notice, conflict warning, data-error warning, the digest
  and `runReminder` all go through the helper. A failure for one run's digest
  does not stop the next run. The digest is one call: recorded text = its parts
  joined with a blank line, parts sent one by one.
- `pipeline/wire.ts` Dec 1 nudge and the order-cancel route in
  `http/routes/runs.ts` use the helper too. The cancel route therefore no longer
  returns 500 after a successful cancel when Telegram fails.

### Server — one failing run never stops the others (`pipeline/day.ts`)

- Everything done for one run sits in one `try`: the close fetch, the price
  persist, the locked span (state load, `advanceDay`, `computeOrders`, the
  write) and the digest. A throw is logged with the run id and ticker, counts as
  a failed run, and sends the per-run warning `warn-run-error` through the
  helper (so it is recorded for the run, `web` row included). The loop goes on.
  The existing data-error path is unchanged.
- New copy `warn-run-error` (telegram catalog, mirrored as
  `digest.warn-run-error` in the web catalogs like `digest.warn-data-error`):
  - en: `Morning pipeline error — run #{id} {ticker}: today's orders could not
    be planned. Check this run's Orders tab in the web app; if today's orders
    are missing, run the morning pipeline again.`
  - ko: `아침 파이프라인 오류 — 런 #{id} {ticker}: 오늘 주문을 계획하지
    못했습니다. 웹 앱에서 이 런의 주문 탭을 확인하고, 오늘 주문이 없으면 아침
    파이프라인을 다시 실행하세요.`
  (one line each in the catalogs; wrapped here.)
- **Atomic plan write.** The pipeline writes today's orders and the aged state
  through one new repo method that runs both in one DB transaction (orders
  first, then the state). There is no state in which the orders exist without
  the aged state or the reverse. No schema change.
- **Same-day guard.** Only the pipeline creates order rows, and a run with a
  held bucket always gets at least one order, so "this run has an order dated
  today" means "this run was planned and aged today" (a run with no order has no
  held bucket, so aging it is a no-op; planning it again only repeats its
  digest). A run with an order dated today is
  skipped: no fetch, no write, no digest, no notice, and it counts as completed.
  The check runs before the close fetch (an already planned run cannot raise a
  data-error warning) and again as the first step inside the run lock (two
  pipelines running at once cannot both plan a run).
- So after a morning where one run failed, **Run morning pipeline** plans that
  run and leaves the others alone. The scheduled run after a manual one on the
  same day is quiet for the same reason.
- **Stale roll.** `rollStale` runs once before the loop. If it throws, the
  failure is logged and the pipeline carries on with no stale linkage. This is
  safe: planning reads only the run state and the close; booking matches a fill
  to `open` and `stale` orders alike; and tomorrow's roll picks the same orders
  up (they are still open and older than tomorrow), so the "unconfirmed orders"
  line appears a day late instead of never. No notice is sent for it.
- `MorningResult`: failed = data-error runs + runs that threw; completed = runs
  planned now + runs skipped as already planned. `'data-error'` when at least
  one failed and none completed, else `'sent'` — the existing rule.

### Server — global feed route

- `NotificationRepo` gains a paged listing across all runs, newest first, by
  descending id with an optional `before` id cursor and a limit (real repo in
  `db/repos.ts`, fakes in `test/http-fakes.ts` and any other fake that
  implements the repo). The existing `notifications` primary key covers
  `ORDER BY id DESC` with `id < ?`; no new index.
- New route `GET /notifications?before=<id>&limit=<n>` (auth like the others;
  default and max limit e.g. 20 / 100 — builder's call). The response is one
  entry **per message, not per chat**: adjacent rows (by id) with the same
  `runId` and `text` collapse into one entry carrying every row's chat id and
  the newest id as its anchor. The limit counts entries. The response carries a
  cursor for "Show older" (e.g. the smallest row id consumed) — exact shape is
  the builder's call, but a group must never be split across two pages in a way
  that shows it twice.
- A row joins an entry only if that entry has no row for the same chat yet: one
  broadcast writes at most one row per chat, so a repeated chat is a new message
  (two daily reminders in a row stay two entries).
- Every row is listed. The bot's "could not read fills" replies are recorded
  with no run and so show as **System** entries; they are kept on purpose.
- Each entry carries `runId` and, for run entries, the run's ticker (joined
  server-side or resolved by the web from `listRuns`, which the Runs list page
  already loads — builder's call; a deleted/missing run falls back to
  `#<id>`).

### Web — System notices panel (`apps/web/src/pages/RunsList.tsx` + a new component)

- A new component (e.g. `components/SystemNotices.tsx`) rendered below the runs
  table in its own `Card` with a section title. It loads the first page on mount
  and has a **Show older** button that appends the next page; the button hides
  when there is no more.
- Each row: date-time, a source label (`#3 NVDA` for run notices, a localized
  "System" for global ones), and the **first line** of the text.
  - Run row: a link to `#/runs/<runId>?tab=notifications&notice=<id>`.
  - Global row: a button toggling an inline full-text view (pre-wrapped),
    showing the chat list too (`web only` via the existing `notifChatWeb`).
- Empty and error states reuse the existing `EmptyNote` / `ErrorNote` + retry
  patterns. All copy via `en.json` / `ko.json` (keys sorted; parity test).

### Web — deep link into the run

- `parseHash` keeps returning `{ page: 'run', id }` but also exposes the query
  (`tab`, `notice`) so `RunDetailPage` can start on the Notifications tab.
  Invalid or missing params behave as today (Orders tab).
- `NotificationsPanel` / `NoticeList` take an optional highlighted notice id:
  rows whose id is in the highlighted message's group (or simply the matching
  id — the anchor id is a real row id) get a visible highlight and the first one
  is scrolled into view once loaded.

### Telegram — `/orders` (`apps/server/src/wire/capture.ts`)

- `onOrders` groups today's orders by run, ordered by run id; each group starts
  with `status-run-line` (`Run #{id} {ticker}`), followed by its `orders-line`
  rows; groups separated by a blank line.
- `orders-line` drops `{ticker}` (it is in the header): en
  `#{id} {kind} {shares} sh @ ${price}`, ko `#{id} {kind} {shares}주 @ ${price}`.
- A run missing from `runRepo.list()` gets the header from the existing
  `orders-run-missing` copy (`run #{id}`).

## Tests

- New helper: no chats → one `web` row; one chat's send throws → other chats
  still sent and recorded, no throw; one insert throws → that chat still sent;
  recorded text + parts → one row per chat, every part sent, a failed part does
  not stop the later parts.
- Day pipeline (`apps/server/test/day*.test.ts`): `send` throws for one chat →
  other chats still get the digest; `insert` throws for one run → the next run
  still gets orders and digest; with `allowedChatIds: []` the closed, conflict,
  digest and reminder each leave one `web` row (conflict with `runId: null`); a
  digest of two parts → two sends and one row per chat.
- Per-run isolation: the plan write throws for one run → that run has no orders
  and an unchanged state, gets the warning, and the next run is planned; planning
  throws → the same; every run failing → `'data-error'`; a second pipeline run
  the same day plans only the failed run, with no duplicate order and no second
  aging for the others; two pipelines at once plan each run once; a failing
  stale roll does not stop the morning.
- DB suite: the plan write stores orders and state together, and a failing state
  write rolls the orders back.
- Order-cancel route: Telegram failure still returns `{ ok: true }`.
- Global route: newest first, grouping of per-chat duplicates, `before`
  paging without repeats, limit clamping.
- Web: the panel renders run and system rows, first-line preview, link href,
  inline expand, Show older appends; `parseHash` tab/notice parsing; RunDetail
  opens on Notifications with the row highlighted.
- `wire.test.ts`: `/orders` with two runs on the same ticker shows two headers
  with their own orders; missing run header.
- DB suite (`apps/server/test/db*.test.ts`): the real paged listing.

## Left to the builder

- Module, component and helper names; exact route response shape; page size
  constants; highlight styling (use existing theme tokens).
