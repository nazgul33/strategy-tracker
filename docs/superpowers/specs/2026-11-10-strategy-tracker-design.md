# Strategy Tracker — Design

Date: 2026-11-10
Status: approved (2026-11-10)

## Intent and why

A personal, self-hosted tool that **guides** the owner's daily stock trading and keeps the books.
The owner places every order himself on 삼성증권 mPOP (Korean mobile app, US stocks). The program
computes what to order, notifies via Telegram, reads screenshots of actual fills, and tracks
progress — it never touches a brokerage API or places anything.

Why: the strategy's daily math (bucket budgets, LOC prices, sell targets, ages, forced exits) is
tedious and error-prone by hand, and fill bookkeeping from screenshots is pure drudgery. The
owner wants the calculations and ledger automated while keeping full human control of execution.

## Goals

- Daily Telegram digests per strategy run: buy LOC, sell LOCs, forced market sells, skip notices.
- Fill capture intake: mPOP screenshots via Telegram → vision extraction → user confirmation → booked.
- Web UI showing progress per run: every bucket's shares, entry price, age (trading days); P&L.
- Multiple concurrent runs of the same strategy, same or different tickers, each with its own name.
- Manual pool updates at any time.
- Onboard existing positions: seeding a new run with current buckets (shares, entry price,
  fill date) and opening cash.
- i18n from day one: English + Korean UI strings, browser-default language, toggle in header;
  Telegram digests follow the configured language.
- Simulation mode: replay historical trading days through the same engine, step day by day,
  see exactly the digests and bucket boards that would have been produced.
- One-container deployment + MariaDB.

## Non-goals

- Order execution, brokerage integration (hard boundary — the program only guides).
- Multi-user accounts, authentication beyond a Telegram chat allowlist and a simple web login.
- Intraday monitoring, real-time streaming, mid-day re-pricing. One decision point per day.
- Multi-exchange support (US market only for now).

## Anti-goals

- Silent corruption of the books from a vision misread — every booking requires explicit
  confirmation; manual override always available in UI.
- A tool that requires public HTTPS/static IP to function (Telegram bot uses long-polling).
- A design where a new strategy requires touching core/engine code.

## Constraints (fixed by owner)

- Runtime: **Bun**. Storage: **MariaDB**. Deployment: **container** (docker-compose with MariaDB).
- Code organization: modular packages, each file human-readable size; no sprawling flat modules.
- UI: modern; dark/light theme, user-selected via icon in upper-right corner, persisted.
- Vision extraction goes to a **configurable OpenAI-compatible endpoint** (base URL, model, key).
- Notifications: **Telegram**. Trading platform: **삼성증권 mPOP mobile captures** (vertical
  screenshots of the 체결내역 screen; multiple images per evening possible; Korean labels,
  US-stock rows; only filled orders appear in captures).
- Schedule in `America/New_York` (DST handled by tz). Never check/update on Saturday or Sunday.
- Trade cost configurable as a percent, granularity down to **0.0001 %**.

## Approaches considered

1. **One Bun process, modular internal packages — CHOSEN.** Single app hosts HTTP (API + web UI),
   in-process scheduler, and Telegram long-polling bot. One container + MariaDB. Long-polling
   avoids any public endpoint. Chosen because: single user; simplest deploy and state model;
   the pure strategy engine is shared with simulation mode; if load ever demands it, the bot and
   scheduler can be split into a worker process without touching package boundaries.
2. Two processes (web + worker, DB-as-queue). Better blast radius, but a jobs table and doubled
   compose for a single user is tax on a problem that does not exist yet. Rejected for now.
3. Microservices (web/api/bot/queue/redis). Contradicts the one-container constraint. Rejected.

UI: **React + Vite + Tailwind + shadcn/ui** (dashboard tables, dialogs, toasts; dark/light is
solved). Considered SvelteKit (leaner, no advantage here) and server-rendered HTMX (harder to
keep "modern"). Chose React for ecosystem legibility to future maintainers/agents.

## System architecture

One Bun process. Internal packages (monorepo `packages/`, entry app `apps/server`, UI `apps/web`):

- `core` — domain model: runs, pools, buckets, orders, fills, ledger. Pure, no I/O.
- `strategies` — strategy plugin interface + implementations. `MeanReversion` (떨사오팔) first.
  Interface (shape, names builder's call): config schema; morning digest computation
  (`computeOrders(state, marketCtx) → orders/notices`); fill application
  (`applyFills(state, confirmedFills) → state`); progress view model for UI.
- `market-data` — Yahoo Finance: chart endpoint (latest close), query endpoint (daily OHLC
  history for simulation). Sanity check: returned bar's date must equal calendar's last
  trading day, else warn.
- `calendar` — trading-day logic: weekend skip; committed NYSE official holiday + early-close
  data file (source of truth, from NYSE's published yearly calendar, refreshed manually when
  published — app nudges every December); optional free remote calendar API as cross-check.
  File-vs-API conflict ⇒ warning in digest, orders held until owner rules. Yahoo candle dates
  are used only to sanity-check price freshness, never for open/closed decisions.
- `telegram` — grammY long-polling bot; chat-ID allowlist (first `/start` from an allowlisted
  ID claims it); digest rendering (in the configured language, en/ko); inline Yes/No
  confirmation for bookings; photo intake; `/status`, `/orders`, `/help` commands.
- `ingest` — capture pipeline: store image → call OpenAI-compatible chat-completions with
  tuned extraction prompt (mPOP 체결내역) → structured pending fills → owner confirms on
  Telegram → booked to ledger. Unparseable capture ⇒ ask owner to type fills manually (bot or UI).
- `server` — Hono HTTP API + serves built web UI; simple bearer/session login (single owner).
- `scheduler` — in-process cron (timezone-aware): weekday 07:30 ET check-and-digest;
  16:05 ET fill reminder (trading days only); December calendar nudge.

Startup runs migrations. Graceful shutdown on SIGTERM.

## Domain model (MariaDB, via drizzle-orm)

- `strategy_runs`: id, name (user-given, unique), strategy key (`mean-reversion`), ticker,
  params JSON, trade cost ppm, status (active/paused/closed), created_at.
- `pool_edits`: run_id, amount, effective_at — current pool = latest edit; bucket budget =
  pool ÷ 10.
- `buckets`: run_id, index 0–9, state (`empty` | `held` | `force_sell`), shares, buy_price,
  filled_on_date, age_trading_days. Partial fills keep the bucket alive with its real share
  count — see Partial fills below.
- `orders`: run_id, trade_date, kind (`buy_loc` | `sell_loc` | `market_sell`), bucket index,
  limit_price, shares, status (`suggested` | `filled` | `skipped` | `stale`), reason for skips.
- `fills`: run_id, order_id?, ticker, side, shares, price, fee, filled_at,
  source (`capture` | `manual`), status (`pending` | `confirmed` | `rejected`).
- `captures`: run_id?, image blob/path, raw extraction JSON, notes.
- `ledger`: cash and realized-P&L entries (cents), linked to confirmed fills.
- `notifications`: digest log (what was sent when) — also powers the UI "digest history" view.
- `sim_runs` + shadow copies (`sim_buckets`, `sim_orders`, `sim_fills`, `sim_ledger`): fully
  separate namespace; sim runs are disposable and never reference live tables.

**Money & precision**: trade cost stored as integer **ppm** (0.0001 % = 1 ppm). Prices
DECIMAL(12,4) USD. Cash/fees in cents with fee = price × shares × ppm rounded to the cent
(half-up) for ledger; exact decimal kept in order/fill rows. Whole shares only.

## Strategy: MeanReversion (떨사오팔)

Config: ticker; pool (editable); 10 buckets; tick $0.01; max age 20
trading days; trade cost ppm (per run). Bucket budget = pool ÷ 10 (recomputed on pool edits;
held buckets keep their actual entry economics — only new orders use the new budget).

**Run creation & seeding**: a run starts with a pool amount and may be **seeded** with the
owner's existing positions — manually entered buckets (shares, entry price, fill date) and an
opening cash figure — so the books match reality on day one. Seeded entries are ledger rows
with source `manual`.

Every open trading day at ~07:30 ET (never Sat/Sun; holiday ⇒ "Market closed today — <reason>"
and nothing else that day):

1. Fetch last trading day's close `C` (freshness-sanity-checked).
2. **Buy — one per day**: if fewer than 10 buckets `held`: LOC buy at `C − $0.01`,
   shares = `floor(bucket budget ÷ (C − $0.01))`. If all buckets held: digest says
   "no buy — no bucket available". If shares = 0 (price too high for a bucket): digest says so.
3. **Sells — many per day**: for each `held` bucket: LOC sell at
   `buy_price + $0.01 + 2 × (buy_price × ppm)`. Every such sell goes into the digest (no cap).
4. **Forced exit**: any bucket unsold past 20 trading days ⇒ `MARKET SELL today` instruction.
5. Send digest (Telegram + logged for UI history).

At 16:05 ET (open trading days only): "send today's fills" reminder. On holiday mornings the
day is fully off — no 07:30 digest, no 16:05 reminder.

Booking flow: confirmed fills mark matching suggested orders `filled`, create/empty buckets,
write ledger.

**Partial fills** (owner-approved): partial *buy* → bucket exists with the actually-filled
shares; the unused bucket budget returns to cash. Partial *sell* → bucket stays `held` with the
remaining shares; next day's digest re-offers the sell for the remainder at the same target
price. Bucket age keeps counting from the original fill date regardless of partials.

**Unbooked fills** (owner-approved): a suggested order not confirmed by day end is assumed
unfilled (status `stale`) and the next morning's digest still goes out — with a loud warning
line listing yesterday's unconfirmed orders. Late booking is always allowed: a capture booked
after its trade date creates/updates the bucket dated at the **real fill date**, and age counts
from there. A forgotten capture degrades to a warning, never to silent ledger drift.

**Progress view** (UI + `/status`): per bucket: shares, entry price, age (trading days), state;
per run: cash, exposure, realized P&L, win rate of closed buckets.

## Simulation mode

- Inputs: ticker, start/end dates, starting pool, ppm — same config shape as a live run.
- Engine: identical strategy code fed by Yahoo daily OHLC, day by day.
- Fill model (documented approximation; free data has no deep intraday bars):
  - Buy LOC: fills on trade date if `low ≤ limit`; fill price `min(limit, open)`.
  - Sell LOC: fills if `high ≥ limit`; fill price `max(limit, open)`.
  - Market sell: fills at `open` (morning limit-on-open order).
- Output: day-by-day replay UI — each step shows the exact digest that *would* have been sent
  plus bucket board and P&L curve. No Telegram. Separate sim tables; disposable runs.

## Web UI

- Runs list (each run's card: ticker, name, P&L, bucket occupancy) → run detail: bucket board,
  order history, fills ledger, digest history, P&L.
- Simulation page: configure + day-step replay.
- Settings: vision endpoint config, chat allowlist display, per-run trade cost, pool edit,
  UI language (en/ko).
- Theme: manual dark/light toggle icon top-right, persisted (localStorage), initial value from
  system preference. Language toggle sits beside it.
- **i18n from day one**: English and Korean message catalogs, react-i18next, default from
  browser, persisted choice. All UI strings go through the catalog — no hardcoded copy.

## Operations

- `docker-compose`: `app` (multi-stage Dockerfile, bun) + `mariadb` (volume, healthcheck).
- Config via env: DB URL, Telegram token + allowlist, vision base URL/model/key, timezone pins.
- Migrations on startup; structured logs; graceful shutdown.

## Settled builder calls (spot-check while reading)

From the design reviewer's pass, resolved consistently:

- On a morning when a bucket is both past max age and would otherwise get a sell LOC: the
  forced `MARKET SELL` **replaces** the sell LOC — one instruction per bucket per day.
- A buy order fills the **lowest free bucket index**.
- Reporting semantics: `cash = opening pool + confirmed sell proceeds − buys − fees`;
  realized P&L booked when a bucket fully closes; win rate = closed buckets in profit ÷ all
  closed buckets.
- Stale/missing price data on an open morning follows the calendar-conflict pattern:
  warn and hold orders until the owner rules (or fetch retry), never guess a close.
- Simulation trading days come from the OHLC bars returned for the ticker in the requested
  range (Yahoo omits holidays from its series).

## Left to the builder

Exact library picks within the stack (drizzle vs kysely, croner vs hand-rolled cron, Hono vs
Elysia), package/folder naming, digest wording, the mPOP extraction prompt (tuned against real
screenshots during implementation), and UI details beyond the named views.
