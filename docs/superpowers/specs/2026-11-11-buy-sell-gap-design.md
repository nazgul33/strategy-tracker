# Buy gap / sell gap — design

Date: 2026-11-11 · Status: approved by operator (2026-11-11)

## Purpose

Per-run configurable price offsets for the order-limit formulas:

- **Buy gap** — a positive percent describing how far below the close the buy
  limit sits. Unset/0 keeps today's default of `close − $0.01`.
- **Sell gap** — a positive percent describing how far above the bucket's
  **buy price** the sell limit sits. Unset/0 keeps today's profit-lock formula.

The simulator replays with the same gaps. All user-facing copy in en/ko.

## Formulas (exact, myriadth bigint; 1 USD = 10 000n)

New helpers in `@st/core/money`:

```
ceilDiv(n, d)        // ceiling integer division, throws d <= 0
ceilCents(v)         // round myriadths UP to the next cent  = ceilDiv(v, 100n) * 100n
floorCents(v)        // round myriadths DOWN to the next cent (v >= 0)
```

In `@st/strategies` (pure, exported for tests):

```
buyLimit(lastClose, buyGapPpm):
  buyGapPpm === 0  ->  ceilCents(lastClose - 100n)                  // -$0.01 default, cent-rounded
  else             ->  ceilCents(lastClose * (1_000_000n - ppm) / 1_000_000n)

sellLimit(buyPrice, costPpm, shares, sellGapPpm):
  sellGapPpm === 0 ->  sellTarget(buyPrice, costPpm, shares)        // legacy formula, bit-identical
  else             ->  floorCents(buyPrice * (1_000_000n + ppm) / 1_000_000n)
```

Notes:

- Buy uses **ceiling**, sell uses **truncate**, precision 2 decimals — per operator.
- The buy default path gains cent-rounding (`ceilCents`). For 2-decimal closes this is a
  no-op; for sub-cent closes (Yahoo data) it now yields a price mPOP actually accepts.
- The sell default path is deliberately left bit-identical ("keep current formula").
- `computeOrders` calls `buyLimit`/`sellLimit`; digest, morning pipeline, pending review
  and sim all inherit the change with no further wiring.
- `force_sell` (market) orders are unaffected.

## Representation & validation

- Both gaps are stored as **integer ppm** (parts per million), `0 = unset`,
  like `costPpm`. 1% = 10 000 ppm; granularity 0.0001%.
- Server validation: `Number.isInteger(x) && 0 <= x <= 1_000_000` (≤ 100%).
  A 100% buy gap yields limit 0 → existing `shares-zero` notice path handles it.
- Web inputs are **percent** text (e.g. `0.5`, up to 4 decimals, ≤ 100), converted
  to/from ppm at the API boundary.

## Storage

`strategy_runs` gains `buy_gap_ppm int notNull default 0`, `sell_gap_ppm int notNull default 0`.
`sim_runs` gains the same two columns (so stored sim runs show what was used).
Migration `0003` via `db:generate` (plain ADD COLUMNs, no hand-edit needed).
`Run` in `@st/core/domain` gains `buyGapPpm: number; sellGapPpm: number`.

## API

- `POST /runs` — optional `buyGapPpm`, `sellGapPpm` in body, validated as above, default 0.
- `POST /runs/:id/gaps` — `{ buyGapPpm, sellGapPpm }`, both required, same validation.
  Mirrors the `POST /runs/:id/pool` pattern; 404 on unknown run. Editable anytime.
- Run rows returned by `GET /runs` / `GET /runs/:id` now carry the two fields.

## Sim

- `SimInput` gains optional `buyGapPpm` / `sellGapPpm` (validated same way, default 0);
  the synthetic `Run` gets them, so `computeOrders` in the replay uses the gaps.
  Forced-exit (market sell at last open) is unaffected.
- `SimRepoSurface.insertRun` and `sim_runs` persistence include both fields.

## Web UI

- **CreateRunForm**: two percent fields (blank = 0) with en/ko labels + hint of the formula.
- **Run detail (RunPanels)**: gap edit form, same shape as the pool edit, pre-filled,
  posts to `/runs/:id/gaps`.
- **Sim form**: two percent fields beside pool/cost.
- **Run/Sim display**: run header and stored sim-run rows show current gaps (percent);
  unset (0) renders as the default marker (−$0.01 / legacy target).
- i18n: all new strings in `en.json` + `ko.json`.

## Non-goals

- No gap fields on MrParams / paramsJson; no per-bucket gaps; no gap presets;
  no change to fees, pool, or the legacy sell formula; no Telegram command to edit gaps.

## Tests

- `packages/core/test/money`: `ceilDiv`, `ceilCents`, `floorCents` incl. exact-cent no-ops.
- `packages/strategies/test`: `buyLimit`/`sellLimit` defaults, ceiling/truncate boundaries
  (e.g. close 34.5678 + 0.5% gap), 0 and 100% edges, legacy sell bit-identical pins.
- `apps/server/test/http.test.ts`: POST /runs validation (rejects non-integer, negative,
  > 1 000 000), defaults 0; `POST /runs/:id/gaps` happy + 400 + 404.
- `apps/server/test/sim.test.ts`: sim plan prices follow gaps; stored sim run persists them.
- `apps/web`: form conversion percent⇄ppm, display formatting.
