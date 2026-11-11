# Capture auto-split — design delta (2026-11-11)

## Problem

mPOP 체결내역 screenshots often contain fills for several tickers at once. The current
auto-route in `apps/server/src/wire/capture.ts` aborts the whole capture if *any* extracted
ticker has no unique active run, and pinned mode (`/capture N`) books *every* extracted fill
into the pinned run — including wrong-ticker fills. Both behaviors force manual cleanup.

## Domain invariants (verified in schema + repos)

- **One run ↔ one ticker.** `strategy_runs.ticker` is a single NOT NULL column; the only
  updates to the table are `updateStatus` and `updatePool` — the ticker is fixed at creation.
- **Pool ↔ run is 1:1.** `pool_cents` lives on the run row; `pool_edits` is keyed by
  `run_id`. A pool is never shared between runs.
- **Nothing enforces one *active* run per ticker** — multiple runs (each with its own pool)
  may share a ticker by design. Ticker routing must therefore handle the ambiguous case.

## Behavior (chosen: filter + tell)

### Auto-route (no numeric caption)

Group extracted fills by ticker. For each ticker group, independently:

| Ticker resolves to | Action |
| --- | --- |
| exactly one active run | ingest that group into the run (pending fills as today) |
| zero active runs | skip group; send `capture-no-run` one-liner |
| 2+ active runs | skip group; send `capture-ambiguous` one-liner |

One unresolvable ticker never blocks the other groups; nothing is ever booked to the wrong
run. Messages are sent in ticker-extract order.

### Pinned mode (`7`, `#7`, `/capture 7`)

Keep only fills whose ticker equals `run.ticker` (pinned runs may be paused/closed as today):

- No fill matches → send `capture-pin-nomatch`, book nothing (a wrong pin can no longer
  book foreign fills).
- Some fills have other tickers → book the matching ones and send `capture-pin-skipped`
  listing the ignored tickers.

## i18n (packages/telegram/src/i18n.ts)

Reuse `capture-no-run`, `capture-ambiguous`. New keys (en + ko):

- `capture-pin-skipped` — "Ignored {tickers} — not the ticker of run #{id}."
- `capture-pin-nomatch` — "No {ticker} fills in this image — run #{id} unchanged."

## Scope

`apps/server/src/wire/capture.ts` (onPhoto), `packages/telegram/src/i18n.ts` (+2 keys),
`apps/server/test/wire.test.ts` (flip 4 tests, add 1). No schema, no booking changes —
dedup stays per (runId, imageHash).
