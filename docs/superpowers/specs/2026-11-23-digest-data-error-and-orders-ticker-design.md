# Named data-error warning (#75) and ticker in /orders (#83) — design

Small change, two independent fixes in the Telegram surface.

## Why

- #75: the morning digest's market-data warning names no run, so a run whose
  ticker went delisted produces an anonymous warning every day and the
  operator cannot tell which run to stop.
- #83: `/orders` prints a blank ticker on every line in production (order rows
  have no ticker), so with several active runs the operator cannot tell which
  order belongs to which ticker. The existing test passes only because its
  fake row carries a `ticker` field real rows never have.

## Goals

- #75: one warning message per failed run, naming the run id and ticker,
  saying today's orders *for this run* could not be computed (other runs still
  get their digests).
- #75: each warning's notification row is recorded against that run
  (`runId: run.id`), one row per chat actually sent to — no more rows for
  messages that were never sent.
- #83: every `/orders` line shows the ticker of the order's run.
- #83: the wire test uses real-shaped order rows (no `ticker`) and fails if the
  run lookup is missing.

## Non-goals

- No change to which runs fail, the stale-close rule, or the `MorningResult`
  values (`'data-error'` only when every active run failed).
- No reason detail in the warning (thrown fetch vs stale date) — same text for
  both paths.
- No schema change, no change to `orderRepo.listForDate` or `OrderRecord`, so no
  DB-suite pin for #83.

## Approaches

#75 (picked by the user: A)
- **A. One message per failed run** — sent inside the loop, logged against
  the run. Picked: names the run directly and ties the log row to it.
- B. One combined message after the loop listing all failed runs — less noise
  when several fail, but lands after the digests and belongs to no single run.

#83 (my call)
- **`onOrders` looks the runs up once** (`runRepo.list()` → map id → ticker).
  Picked: local to `wire/capture.ts`, no repo/type/query change.
- `listForDate` joins `strategy_runs` — rejected: changes the `OrderRecord`
  shape that booking and every fake share, for one display line.

## Design

### #75 — `apps/server/src/pipeline/day.ts`, `packages/telegram/src/i18n.ts`

- `warn-data-error` copy gains `{id}` and `{ticker}`:
  - en: `Market data error — run #{id} {ticker}: last close unavailable or stale. Today's orders for this run could not be computed.`
  - ko: `시세 데이터 오류 — 런 #{id} {ticker}: 최근 종가를 가져올 수 없습니다. 오늘 런의 주문을 계산할 수 없습니다.`
    (ko wording from the user; the en line was aligned to it and the em dash
    kept for consistency with the rest of the catalog — my call.)
- Both failure paths (fetch throws; close date ≠ previous trading day) render
  that text with the run's id and ticker, send it to every allowed chat, and
  insert one notification row per chat with `runId: run.id`. The `warnedData`
  once-only flag goes away; the duplicated block becomes one local helper.
- Mirror the same copy in `apps/web/src/i18n/{en,ko}.json`
  (`digest.warn-data-error`) so the two catalogs stay in sync (my call; the web
  does not render it today).

### #83 — `apps/server/src/wire/capture.ts`, `packages/telegram/src/i18n.ts`

- `onOrders` calls `deps.repos.runRepo.list()` once when there are orders,
  builds a `Map<runId, ticker>`, and passes the run's ticker to `orders-line`.
  The `OrderRecord & { ticker?: string }` cast and its comment are removed.
- Orders whose run is not found (`orders` has no foreign key to runs) show
  `run #{id}` in the ticker slot, via a new catalog key `orders-run-missing`
  (en `run #{id}`, ko `런 #{id}`) (my call).
- Line format of `orders-line` is unchanged.

## Tests

- `apps/server/test/day.test.ts`: (d) asserts the warning names `#1 TSLA` and
  the notification row has `runId` 1; (d2) asserts the single warning names
  `BADA` and not `AAPL`; a new case with two failed runs and two chats asserts
  one warning per run per chat, each naming its own run, notification rows
  matching sends one for one.
- `apps/server/test/wire.test.ts`: the `onOrders` test uses a plain
  `OrderRecord` (no `ticker`), ticker coming from the run (`NVDA`); a second
  order whose run is absent shows `run #<id>`.

## Left to the builder

- Helper naming and placement inside `day.ts`. The copy above is fixed
  verbatim.
