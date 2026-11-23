# Pipeline notice robustness (#87), web-only trace + System notices (#86), run name in /orders (#85) — design

Small project: one shared server helper, one new read route, one web panel, a
deep link into the run's Notifications tab, and a Telegram copy change.

## Why

- #87: in `apps/server/src/pipeline/day.ts`, `deps.send(...)` and
  `notificationRepo.insert(...)` are awaited unguarded. One blocked chat or one
  DB hiccup throws out of `runMorningPipeline`, and every remaining run gets no
  orders and no digest that morning.
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
- With no allowed chat, every pipeline / cron / cancel message is still recorded
  as one row with chat id `web` (`WEB_ONLY_CHAT_ID`).
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
- No change to which runs fail or to `MorningResult` values.
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
- `WEB_ONLY_CHAT_ID` moves to the new module (re-exported from
  `booking-notifier.ts` if needed so existing imports keep working — builder's
  call). `makeBookingNotifier`'s internal `broadcast` is replaced by the shared
  helper; its current behaviour (insert then send, per-chat isolation, `web`
  fallback) is preserved, and its tests stay green.
- `day.ts`: the closed notice, conflict warning, data-error warning, each digest
  chunk, and `runReminder` all go through the helper. A failure for one run's
  digest does not stop the next run.
- `pipeline/wire.ts` Dec 1 nudge and the order-cancel route in
  `http/routes/runs.ts` use the helper too. The cancel route therefore no longer
  returns 500 after a successful cancel when Telegram fails.

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
  still sent and recorded, no throw; one insert throws → that chat still sent.
- `apps/server/test/day.test.ts`: `send` throws for one chat → other chats still
  get the digest; `insert` throws for one run → the next run still gets orders
  and digest; with `allowedChatIds: []` the closed, conflict, digest and
  reminder each leave one `web` row (conflict with `runId: null`).
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
