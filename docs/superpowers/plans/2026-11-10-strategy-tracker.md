# Strategy Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-hosted Bun app that computes daily MeanReversion (떨사오팔) orders from Yahoo closes, guides the owner via Telegram, books fills from mPOP screenshots via a vision model, shows bucket progress on a web UI, and replays historical days in simulation mode — never placing orders itself.

**Architecture:** One Bun process (HTTP API + web UI, in-process scheduler, grammY long-polling bot) over MariaDB. A pure `core` domain + `strategies` package is shared by live trading and simulation. External services (Yahoo, vision endpoint, Telegram, calendar cross-check) sit behind injectable `fetch` so every piece is testable offline.

**Tech Stack:** Bun 1.2 workspaces, TypeScript strict, drizzle-orm + mysql2 (MariaDB 11), grammY, Hono, croner, React 18 + Vite + Tailwind + shadcn/ui + react-i18next, bun:test.

**Spec:** `docs/superpowers/specs/2026-11-10-strategy-tracker-design.md` (read it together with this plan; spec wins on conflicts).

## Global Constraints

- Runtime Bun ≥ 1.2; TypeScript `strict: true`; tests via `bun test` (no vitest).
- Storage MariaDB 11 only; schema via drizzle-kit migrations run at startup.
- Deploys as one app container + MariaDB via `docker-compose.yml`.
- File discipline: no source file > ~300 lines; split by responsibility; no flat god-modules.
- Money: prices are `bigint` in units of 1/10000 USD; trade cost is integer **ppm** (0.0001 % = 1 ppm); cash/fees integer cents; fee rounding half-up; **whole shares only**.
- Scheduling in `America/New_York` (croner tz); jobs must do nothing on Saturday and Sunday.
- All user-facing copy (web + Telegram) flows through en/ko message catalogs — no hardcoded strings.
- Never call a brokerage API; the app only guides. Telegram = long-polling only (no webhook).
- Every booking requires explicit confirmation; manual entry always available.

## Review Focus

Failure modes the design implies but no happy-path task tests — each line gets its pin-test added to the named task:

1. **Duplicate capture** (same screenshot sent twice) → second one must be rejected as duplicate; no double booking. (Task 10)
2. **Garbage from vision endpoint** (invalid JSON, non-numeric shares, missing side) → capture marked unparseable, nothing booked, owner asked to type fills. (Task 8)
3. **Partial sell then forced exit** (bucket sold down, then crosses 20 days) → MARKET SELL shows *remaining* shares, and replaces (not adds to) the sell LOC. (Task 6)
4. **Late booking** (capture arrives days after the fill) → bucket dated at real fill date, ages from there, ledger/cash consistent. (Task 10)
5. **DST / holiday / weekend boundaries** → 07:30 ET digest fires at 07:30 local ET across DST flips; Sunday-holiday observed Monday; early-close days unchanged; zero activity Sat/Sun. (Tasks 3, 12)

## File Structure

```
package.json  tsconfig.base.json  .env.example  .gitignore  AGENTS.md
Dockerfile  docker-compose.yml
packages/
  core/src/        money.ts domain.ts fills.ts index.ts      (+ core/test/*)
  calendar/src/    index.ts nyse-data.ts crosscheck.ts       (+ calendar/test/*)
  market-data/src/ yahoo.ts                                  (+ market-data/test/*)
  strategies/src/  mean-reversion.ts                         (+ strategies/test/*)
  ingest/src/      extract.ts prompt.ts                      (+ ingest/test/*)
  telegram/src/    digest.ts bot.ts                          (+ telegram/test/*)
apps/server/src/
  main.ts                                  # wire everything; start bot+scheduler+http
  db/schema.ts db/client.ts db/repos.ts                     # repos: thin typed wrappers
  domain/booking.ts                        # capture→pending→confirm, seeding, stale roll-up
  pipeline/day.ts                          # morning pipeline + 16:05 reminder (pure w/ deps)
  sim/sim.ts                               # simulateDays (pure) + runSim persistence
  http/app.ts http/auth.ts http/routes/{runs,fills,pending,sim,settings}.ts
apps/server/test/  booking.test.ts day.test.ts sim.test.ts http.test.ts
apps/web/src/      main.tsx App.tsx api.ts i18n.ts viewmodels.ts
  components/{Layout,ThemeLangToggle,BucketBoard,OrderTable,FillTable,SimReplay,forms/*}
  pages/{RunsList,RunDetail,Sim,Settings}.tsx
  i18n/en.json i18n/ko.json
```

---

### Task 1: Repo scaffold + AGENTS.md

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `packages/core/package.json`, `packages/core/src/money.ts` (placeholder `export const VERSION = '0.0.1'`), `packages/core/test/smoke.test.ts`, `.gitignore`, `.env.example`, `AGENTS.md`

**Interfaces:**
- Produces: workspace scripts `bun run typecheck` (`tsc -b`), `bun test` (recurses packages/), `@st/core` importable by other workspace packages.

- [ ] **Step 1: Create workspace root** — `package.json` with `"workspaces": ["packages/*", "apps/*"]`, scripts `typecheck`, `test`; `tsconfig.base.json` with `strict: true`, `module: "preserve"`, `moduleResolution: "bundler"`, `target: "esnext"`; per-package `package.json` (`name: "@st/core"`) + `tsconfig.json` extending base; root `.gitignore` (node_modules, .env, dist, data/).
- [ ] **Step 2: Write smoke test** — `packages/core/test/smoke.test.ts`: `expect(VERSION).toBe('0.0.1')`.
- [ ] **Step 3: Run `bun install && bun test && bun run typecheck`** — expect 1 pass, clean typecheck.
- [ ] **Step 4: Write `AGENTS.md`** — sections: Project overview (1 paragraph, link spec); Repo map (the File Structure tree above, trimmed); Commands (`bun install`, `bun test`, `bun run typecheck`, `bun run dev`, `docker compose up`); Conventions (file ≤ ~300 lines; packages/* never import apps/*; money via `@st/core/money` bigint myriadths — never float; cost in integer ppm; all user copy via en/ko catalogs; America/New_York schedules; `fetch` always injectable for tests; commit style `feat|fix|docs|test|chore:`).
- [ ] **Step 5: Write `.env.example`** — `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`, `VISION_BASE_URL`, `VISION_API_KEY`, `VISION_MODEL`, `APP_PASSWORD`, `SESSION_SECRET`, `DIGEST_LANG=en`.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "chore: workspace scaffold + AGENTS.md"`.

### Task 2: Money primitives (`@st/core/money`)

**Files:**
- Create: `packages/core/src/money.ts`; Test: `packages/core/test/money.test.ts`

**Interfaces:**
- Produces: `parseUsd(s: string): bigint` (throws on >4 decimals; `'340.23' → 3402300n`), `formatUsd(v: bigint): string` (exact, trailing zeros trimmed, min 2 dp), `roundDiv(n: bigint, d: bigint): bigint` (half-up, d>0), `centsFromUsd(v: bigint): number`, `feeCents(price: bigint, shares: number, ppm: number): number`, `const TICK_USD = 100n // $0.01`.
- Consumes: nothing.

- [ ] **Step 1: Write failing tests** — exact values: `parseUsd('340.23') === 3402300n`; `parseUsd('0.1') === 1000n`; `parseUsd('1.00001')` throws; `formatUsd(3402300n) === '340.23'`; `roundDiv(5n,2n) === 3n` and `roundDiv(-5n,2n) === -3n` (away-from-zero ties); `feeCents(3402300n, 100, 1) === 3` (0.0001 % of $34,023 = $0.034 → 3¢); `feeCents(3402300n, 100, 30) === 102` ($34,023 × 0.003 % = $1.0207 → 102¢); `feeCents(23456n, 7, 1) === 0`; `centsFromUsd(12345n) === 123` ($1.2345 = 123.45¢ → half-up 123).
- [ ] **Step 2: Run `bun test packages/core/test/money.test.ts`** — expect FAIL (module empty).
- [ ] **Step 3: Implement `money.ts`** — prices in 1e-4 USD; `feeCents = Number(roundDiv(price * BigInt(shares) * BigInt(ppm), 100_000_000n))`; `centsFromUsd = Number(roundDiv(v, 100n))`; parse/format via string math only (no floats anywhere).
- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: money primitives (bigint myriadths, ppm fees)"`.

### Task 3: Trading calendar (`@st/calendar`)

**Files:**
- Create: `packages/calendar/src/nyse-data.ts`, `packages/calendar/src/index.ts`, `packages/calendar/src/crosscheck.ts`; Test: `packages/calendar/test/calendar.test.ts`

**Interfaces:**
- Produces: `type ISODate = string // 'YYYY-MM-DD'`; `interface DayInfo { date: ISODate; open: boolean; holidayName?: { en: string; ko: string }; earlyCloseET?: string }`; `dayInfo(date: ISODate): DayInfo`; `isTradingDay(d): boolean`; `prevTradingDay(d): ISODate` / `nextTradingDay(d): ISODate` (strictly before/after); `async calendarCrossCheck(date: ISODate, fetchImpl?: typeof fetch): Promise<{ agree: boolean; remoteOpen?: boolean; error?: string }>` — queries `https://howmanytradingdays.com/api/status?date=…` (treat non-2xx/timeout ≥ 4 s as `{ agree: true, error }`, i.e. remote absence never blocks).
- Consumes: nothing.

- [ ] **Step 1: Write failing tests** — `dayInfo('2026-11-07').open === true` (Sat → `open:false`, no holidayName); `dayInfo('2026-11-26')` → closed, `holidayName.en === 'Thanksgiving'`; `dayInfo('2026-07-03')` → closed (Independence Day observed); `dayInfo('2026-11-11').open === true` (Veterans Day — NYSE OPEN, guard against bank-holiday confusion); `dayInfo('2026-07-02')` → open with `earlyCloseET === '13:00'`; `prevTradingDay('2026-11-09') === '2026-11-06'` (over weekend); `isTradingDay('2025-01-09') === false` (Carter day of mourning).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `nyse-data.ts`: `export const NYSE_YEARS: Record<string, { holidays: Array<{ date: ISODate; en: string; ko: string }>; earlyCloses: Array<{ date: ISODate; et: string }> }>` covering 2025–2027. 2026 (authoritative, from NYSE published calendar): Jan 1, Jan 19 MLK, Feb 16 Presidents, Apr 3 Good Friday, May 25 Memorial, Jun 19 Juneteenth, Jul 3 (observed), Sep 7 Labor, Nov 26 Thanksgiving, Dec 25 Christmas; early closes Jul 2, Nov 27, Dec 24 @ 13:00. **Verify 2025/2027 lists against https://www.nyse.com/publicdocs/nyse/ICE_NYSE_2026_Yearly_Trading_Calendar.pdf (and the 2027 edition) via webfetch before committing; 2025 includes Jan 9 (day of mourning).** Korean names: Thanksgiving `추수감사절`, Christmas `크리스마스`, etc. `dayInfo`: weekend → closed; else holiday table; `crosscheck.ts` per interface with injected fetch.
- [ ] **Step 4: Run tests — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: NYSE trading calendar + remote cross-check"`.

### Task 4: Market data (`@st/market-data`)

**Files:**
- Create: `packages/market-data/src/yahoo.ts`; Test: `packages/market-data/test/yahoo.test.ts`

**Interfaces:**
- Produces: `interface OHLCBar { date: ISODate; open: bigint; high: bigint; low: bigint; close: bigint }`; `fetchLastClose(ticker: string, fetchImpl?: typeof fetch): Promise<{ date: ISODate; close: bigint }>`; `fetchDailyBars(ticker: string, from: ISODate, to: ISODate, fetchImpl?: typeof fetch): Promise<OHLCBar[]>`.
- Consumes: `parseUsd` from `@st/core` (Task 2) — not needed here; prices arrive numeric in JSON: convert with `BigInt(Math.round(x * 10000))` (Yahoo quotes are ≤ 4 dp; this is the one documented float touchpoint).

- [ ] **Step 1: Write failing tests** with fake `fetchImpl` returning canned Yahoo chart JSON (fixture inline): chart endpoint shape `{ chart: { result: [{ timestamp: [...], indicators: { quote: [{ open:[], high:[], low:[], close:[] }] } }] } }`. Assert: `fetchDailyBars` maps bar 0 to `{ date: '2026-02-02' /* ET date from UTC epoch */, close: 3520000n /* $352 */ }`, skips null bars; `fetchLastClose` returns the **last non-null** bar; empty/`{chart:{error:...}}` response throws `MarketDataError('no-data')`; HTTP 500 throws `MarketDataError('http')`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `GET https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?period1=…&period2=…&interval=1d` (epoch seconds, `period2` = `to`+1 day); `fetchLastClose` uses `range=10d`; epoch→ET date via `new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })`; error class exported.
- [ ] **Step 4: Run tests — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: yahoo market-data client"`

### Task 5: Core domain + fill state machine (`@st/core`)

**Files:**
- Create: `packages/core/src/domain.ts`, `packages/core/src/fills.ts`, `packages/core/src/index.ts`; Test: `packages/core/test/fills.test.ts`

**Interfaces:**
- Produces (in `domain.ts`): `BucketState = 'empty' | 'held' | 'force_sell'`; `interface Bucket { index: number; state: BucketState; shares: number; buyPrice: bigint; filledOn: ISODate }` (`filledOn: ''` when empty); `ClosedBucket { index; shares; buyPrice; soldPrice: bigint; buyFeeCents: number; sellFeeCents: number; openedOn; closedOn }`; `interface RunState { buckets: Bucket[]; cashCents: number; closed: ClosedBucket[] }`; `Run { id; name; ticker; strategyKey: 'mean-reversion'; costPpm: number; poolCents: number; status: 'active'|'paused'|'closed' }`; `Notice { code: string; params?: Record<string, string | number> }`; `DayContext { tradeDate: ISODate; lastClose: bigint; lastCloseDate: ISODate }`; `OrderKind = 'buy_loc' | 'sell_loc' | 'market_sell'`; `PlannedOrder { kind: OrderKind; bucketIndex: number; limitPrice: bigint; shares: number }`; `DayPlan { orders: PlannedOrder[]; skips: PlannedOrder[]; notices: Notice[] }` (`skips` items carry `limitPrice` + reason in `notices`).
- Produces (in `fills.ts`): `emptyState(bucketCount: number): RunState`; `advanceDay(state: RunState): RunState` — buckets older than 20 trading days flip `held → force_sell` (age = count of `advanceDay` calls since the fill, stored as internal map `ages: Record<index, number>` inside `RunState`; add field `ages: Record<number, number>`); `applyBuyFill(state, bucketIndex, shares, price, feeCents): RunState`; `applySellFill(state, bucketIndex, shares, price, feeCents): RunState`.
- Consumes: Task 2 money.

- [ ] **Step 1: Write failing tests** — buy: `applyBuyFill(emptyState(10), 0, 55, 3402300n, 34)` → bucket 0 `held`, shares 55, `cashCents` decreased by `Number(3402300n*55n/100n)+34` (= 1,871,265 + 34 = 1,871,299; leftover budget never parked — cash only moves on fills). Sell partial: bucket held 300 @ 100.00 → `applySellFill(…, 120, 1020000n, 21)` → still `held` 180 shares, `closed` unchanged. Sell full: remaining 180 sold → bucket `empty` (shares 0, buyPrice 0n), `closed` gains entry with realized cents `roundDiv((soldPrice - buyPrice) * BigInt(shares), 100n) − buyFee − sellFee` (myriadths → cents; assert exact on $100 buy / $102 sell / 180 sh / 20+21¢ fees: 36,000 − 41 = `35959`). Partial sell **more than held shares** throws. Buy into non-empty bucket throws. `advanceDay`: 20 calls on a held bucket keeps `held`; the 21st flips it to `force_sell`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — pure functions; throw `DomainError` on rule violations; `ages` reset on buy, incremented per held/force_sell bucket per `advanceDay`.
- [ ] **Step 4: Run tests — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: core domain + bucket fill state machine"`

### Task 6: MeanReversion strategy (`@st/strategies`)

**Files:**
- Create: `packages/strategies/src/mean-reversion.ts`, `packages/strategies/src/index.ts`; Test: `packages/strategies/test/mean-reversion.test.ts`

**Interfaces:**
- Consumes: `@st/core` types (`Run`, `RunState`, `DayContext`, `DayPlan`, `PlannedOrder`, `Notice`, `Bucket`) and money.
- Produces: `const MEAN_REVERSION = 'mean-reversion'`; `interface MrParams { bucketCount: number; tick: bigint; sellCapBps: number; maxAgeDays: number }`; `DEFAULT_MR_PARAMS = { bucketCount: 10, tick: 100n, sellCapBps: 13000, maxAgeDays: 20 }`; `bucketBudgetCents(poolCents: number): number` (floor ÷10); `buyShares(budgetCents: number, limit: bigint): number` (floor); `sellTarget(buyPrice: bigint, costPpm: number, tick: bigint): bigint`; `computeOrders(run: Run, params: MrParams, state: RunState, ctx: DayContext): DayPlan`; `progressView(state: RunState): { heldCount: number; cashCents: number; exposureCents: number; realizedCents: number; winRate: number | null }` (win = closed bucket with realized > 0; null when no closed).

- [ ] **Step 1: Write failing tests** — constants math first: `sellTarget(3402300n, 30, 100n) === 3402300n + 100n + BigInt(round(3402300 * 2 * 30 / 1e6))` (assert the literal result); `bucketBudgetCents(1_000_000) === 100_000`; `buyShares(100_000, 3402300n) === 2` ($1,000 ÷ $340.23 = 2.94 → 2). Then `computeOrders` with run `poolCents 1_000_000`, `costPpm 30`, `ctx.lastClose 3402300n`, fresh state: orders = `[buy_loc bucket 0 @ 3402200n × 2]` (lowest empty index). All 10 held → no buy, `notices` contains `{ code: 'no-bucket-available' }`. Price too high for a bucket (pool $50, C=$340) → `notices` contains `{ code: 'shares-zero', params: { price: '340.22' } }` and no buy. Held bucket 3 bought @ 3411300n age 2, C = 3402300n → `sell_loc bucket 3` at `sellTarget(...)`. Sell target ≥ `C × 13000 / 10000` → order absent from `orders`, present in `skips` with matching notice `{ code: 'sell-capped', params: { bucket: 4, price: '455.10' } }`. `force_sell` bucket 1 with 120 shares → `market_sell bucket 1 shares 120` and **no** `sell_loc` for bucket 1 (forced replaces LOC — Review Focus 3). Age 20 `held` still gets `sell_loc`, age 21 only via `force_sell` state (advanceDay did the flip in Task 5).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `sellTarget = buyPrice + tick + roundDiv(buyPrice * 2n * BigInt(costPpm), 1_000_000n)`; cap compare via `target * 10000n >= lastClose * BigInt(sellCapBps)`; order array order: buy, sells (by bucket asc), market sells last.
- [ ] **Step 4: Run tests — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: MeanReversion order computation + progress view"`

### Task 7: Vision extraction (`@st/ingest`)

**Files:**
- Create: `packages/ingest/src/prompt.ts`, `packages/ingest/src/extract.ts`; Test: `packages/ingest/test/extract.test.ts`

**Interfaces:**
- Produces: `interface VisionConfig { baseUrl: string; apiKey: string; model: string; maxTokens: number }`; `interface RawFill { side: 'buy' | 'sell'; ticker: string; shares: number; price: string; fee?: string }`; `type ExtractResult = { ok: true; fills: RawFill[] } | { ok: false; reason: 'http' | 'unparseable' | 'empty'; detail: string }`; `extractFills(images: Array<{ base64: string; mime: string }>, cfg: VisionConfig, fetchImpl?: typeof fetch): Promise<ExtractResult>`; `validateFill(f: RawFill): boolean`.
- Consumes: money (validate price string parses).

- [ ] **Step 1: Write failing tests** with fake `fetchImpl` — (a) well-formed OpenAI-compatible response whose `content` is `{"fills":[{"side":"매수","ticker":"TSLA","shares":"120","price":"340.22","fee":"1.23"}...]}`-style JSON wrapped/annotated in prose → `ok:true` with normalized `side:'buy'` (prompt requires JSON object; parser must also strip ``` fences); (b) `content` = `"I can't read this"` → `{ ok:false, reason:'unparseable' }`, `fills` never present; (c) HTTP 401 → `reason:'http'`; (d) `{"fills":[]}` → `reason:'empty'`; (e) `POST` body assertions: URL `${cfg.baseUrl}/chat/completions`, header `Authorization: Bearer …`, content parts include `image_url` data URI `data:image/png;base64,…`, `response_format: { type: 'json_object' }`; (f) `validateFill`: `{shares: 120.5}` false, `{side:'sell', shares: 10, price:'3e5'}` false (price must match `/^\d+(\.\d{1,4})?$/`), well-formed true. (Review Focus 2.)
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `prompt.ts` exports `MPOP_FILL_EXTRACTION_PROMPT` (English meta-instructions, quoting the Korean mPOP 체결내역 labels: 매매구분 buy/sell = 매수/매도, 종목명/주문, 체결가, 체결수량, 체결시간; one image group per call; emit exactly `{"fills":[{side,ticker,shares,price,fee}]}`, empty array if no rows; numeric strings without commas). `extract.ts`: single POST, all images as data URIs; tolerant JSON find (first `{`…last `}`); reject entries failing `validateFill`.
- [ ] **Step 4: Run tests — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: mPOP capture vision extraction"`

### Task 8: DB schema + repos (`apps/server/db`)

**Files:**
- Create: `apps/server/src/db/schema.ts`, `apps/server/src/db/client.ts`, `apps/server/src/db/repos.ts`, `apps/server/db/` migrations via drizzle-kit (`bun run db:generate`); Test: `apps/server/test/db.test.ts`

**Interfaces:**
- Produces (drizzle `mysql-core` tables mirroring spec §Domain model): `strategy_runs`, `pool_edits`, `buckets`, `orders` (+ `skip_reason` nullable), `captures` (+ `image_hash` unique per run), `pending_fills` (+ `capture_id`, `filled_on`, `status pending|confirmed|rejected`, edited-allowed fields), `fills` (confirmed, `source capture|manual|seed`), `ledger`, `notifications` (+ `chat_id`, `text`, `sent_at`), `sim_runs` + `sim_days` (per-day JSON snapshots) — plus `getRepos(db)` returning `{ runRepo, orderRepo, fillRepo, pendingRepo, captureRepo, ledgerRepo, notificationRepo, bucketRepo }` with methods used by Task 9–12: `runRepo.list/get/create/updateStatus`, `bucketRepo.saveState(runId, state)`, `bucketRepo.loadState(runId): RunState`, `orderRepo.insertMany/listForDate/markStale(date)`, `fillRepo.insert`, `pendingRepo.insert/listPending/decide`, `captureRepo.hasHash/insert`, `ledgerRepo.insert/listForRun`, `notificationRepo.insert`.
- Consumes: `@st/core` `RunState` shape (bucket `ages` map serialized in `strategy_runs.state_json` alongside cash/closed — store whole `RunState` JSON on run row plus normalized `buckets` rows for UI queries; single writer keeps them consistent).

- [ ] **Step 1: Configure drizzle** — `drizzle.config.ts` (dialect mysql, out `apps/server/db/migrations`); note in migrations README: startup applies them via `migrate()`.
- [ ] **Step 2: Write failing integration test** guarded `describeIf(!!process.env.TEST_DATABASE_URL)` — create temp run, `saveState` a state with 3 held buckets, reload → deep-equal (bigint prices survive as strings — `loadState` rehydrates via `BigInt()`); `captureRepo.hasHash` true after insert, unique-violation caught → `false`… (assert `hasHash` true/false semantics used by Task 9 dedupe).
- [ ] **Step 3: Run** `docker compose -f docker-compose.test.yml up -d db` is overkill; instead instruct: `TEST_DATABASE_URL=mysql://… bun test apps/server/test/db.test.ts` against a local MariaDB (document in AGENTS.md); if `TEST_DATABASE_URL` unset the suite prints `skip` and passes.
- [ ] **Step 4: Implement schema + repos; generate migration; test PASS (or documented skip).**
- [ ] **Step 5: Commit** — `git commit -am "feat: drizzle schema, migrations, repositories"`

### Task 9: Booking service (`apps/server/domain/booking`)

**Files:**
- Create: `apps/server/src/domain/booking.ts`; Test: `apps/server/test/booking.test.ts`

**Interfaces:**
- Consumes: `@st/ingest` `ExtractResult`, `@st/core` fills/domain, Task 8 repo shapes (tests use an in-memory fake implementing `getRepos`' surface).
- Produces: `sha256(buf: Uint8Array): string`; `ingestCapture(runId: string, image: { base64: string; mime: string }, extract: ExtractResult, deps: BookingDeps): Promise<'duplicate' | 'rejected' | { pending: PendingFill[] }>`; `confirmPendingFill(pendingId: string, overrides: { shares?: number; price?: string; filledOn?: ISODate } | null, deps): Promise<void>`; `manualFill(runId: string, fill: RawFill & { filledOn: ISODate }, deps): Promise<void>`; `rollStale(tradeDate: ISODate, deps): Promise<OrderRow[]>`; `seedRun(runId: string, seed: { cashCents: number; buckets: Array<{ shares: number; buyPrice: string; filledOn: ISODate }> }, deps): Promise<void>`.

- [ ] **Step 1: Write failing tests (fake repos, no DB)** —
  (a) duplicate: same image bytes into `ingestCapture` twice → second returns `'duplicate'`, zero new pending rows (Review Focus 1).
  (b) rejected: `ExtractResult {ok:false}` → `'rejected'`, capture stored with error reason.
  (c) confirm buy: pending buy 55 sh @ 340.22 today, run cash 1_000_000 → state bucket 0 held 55, cash −cost−fee; matching `buy_loc` order for the **real fill date** → `filled` (if none suggested — late booking — proceed anyway).
  (d) confirm sell: matches oldest `held` bucket whose `buyPrice` decimal equals a suggested sell's limit for that date, else oldest held with `shares ≥ fill.shares`; remainder stays held (partial).
  (e) **late booking** (Review Focus 4): `overrides.filledOn = '2026-11-03'` while today is `2026-11-06` → `bucket.filledOn === '2026-11-03'` and `state.ages[bucket]` seeded from `prevTradingDay` count between; ledger row carries both booked-at and filled-on.
  (f) `rollStale('2026-11-05')` flips `suggested` orders of that date → `stale`, returns them grouped per run; run state unchanged.
  (g) `seedRun` sets buckets + `ages` via calendar trading-day count from each `filledOn`, cash, and `source:'seed'` ledger entries.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — one transaction per confirm (repo-level `tx` from drizzle); order-matching rules above with explicit priority comment; `sha256` via `crypto.subtle`.
- [ ] **Step 4: Run tests — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: booking service (captures→pending→confirmed ledger)"`

### Task 10: Telegram digest renderer + bot (`@st/telegram`)

**Files:**
- Create: `packages/telegram/src/digest.ts`, `packages/telegram/src/i18n.ts`, `packages/telegram/src/bot.ts`; Test: `packages/telegram/test/digest.test.ts`

**Interfaces:**
- Consumes: `DayPlan`/`Notice`/`RunState`, `progressView`, `@st/calendar` (closed reasons).
- Produces: `renderDigest(run: Run, plan: DayPlan, ctx: DayContext, lang: 'en' | 'ko'): string[]` (message chunks ≤ 4000 chars); `renderClosed(day: DayInfo, lang): string`; `renderReminder(lang): string`; `createBot(deps: BotDeps): Bot` with `BotDeps = { token: string; allowedChatIds: string[]; deps for booking/pipeline callbacks: onPhoto(chatId, image), onConfirm(cbData, approved), onStatus(chatId), onOrders(chatId) }`.

- [ ] **Step 1: Write failing tests for the renderers (pure; bot itself is wired, not unit-tested)** — digest for a plan {1 buy, 2 sells, 1 market_sell, 1 skip} contains lines in order with exact formatting: `Buy  LOC  29 sh  @ 340.22  → bucket 0`, `Market  SELL  120 sh  bucket 1  (age 21 — forced exit)`, skip notice text from code `'sell-capped'`, unconfirmed warning line `⚠️ 3 unconfirmed orders from 2026-11-05` when `notices` carries `{code:'unconfirmed', params:{count:3,date:'2026-11-05'}}`; `ko` variant renders 매수/매도 and `크리스마스` holiday; `renderClosed` for `2026-11-26` mentions Thanksgiving/추수감사절.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `i18n.ts`: shared message catalog `Record<code, {en,ko}>` used by digest renderer (web has its own react-i18next catalogs — both translate the same notice codes; keep the code list in one doc-comment). `bot.ts`: grammY, allowlist gate (unlisted chat → silent), `/start /status /orders /help`, photo handler → `onPhoto`, inline keyboard Yes/No on pending cards → `onConfirm`.
- [ ] **Step 4: Run tests — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: telegram bot + en/ko digest renderer"`

### Task 11: Daily pipelines (`apps/server/pipeline`)

**Files:**
- Create: `apps/server/src/pipeline/day.ts`, `apps/server/src/pipeline/wire.ts`; Test: `apps/server/test/day.test.ts`

**Interfaces:**
- Consumes: `@st/calendar`, `@st/market-data`, `computeOrders`, `advanceDay`, `rollStale`, `renderDigest`, `saveState/loadState`, `orderRepo.insertMany`, `notificationRepo.insert`, send callback.
- Produces: `interface DayDeps { today: () => ISODate /* ET */; fetchLastClose; send(chatId: string, text: string): Promise<void>; allowedChatIds: string[]; repos; params(run): MrParams; digestLang: 'en' | 'ko' }`; `runMorningPipeline(deps): Promise<'weekend' | 'closed' | 'conflict' | 'data-error' | 'sent'>`; `runReminder(deps): Promise<void>`; `wire.ts`: croner jobs `'30 7 * * 1-5'` and `'5 16 * * 1-5'` with `timezone: 'America/New_York'` + December nudge `'0 8 1 12 *'`.

- [ ] **Step 1: Write failing tests with fakes** — frozen `today()`; two active runs (TSLA, AAPL): (a) Sat → `'weekend'`, zero sends; (b) holiday Wed Nov 11 (2026, Veterans Day) → `'closed'`, one send per chat containing `Market closed today` + `Veterans Day`, orders NOT computed; (c) normal day: per run digest sent, orders persisted `suggested` with trade_date, `advanceDay` ran exactly once (bucket age +1 — assert saved state), notification rows recorded; (d) `fetchLastClose` date ≠ `prevTradingDay(today)` → `'data-error'`, warning send, **no orders** (never guess a close); (e) `calendarCrossCheck` conflict → `'conflict'` + hold + warning; (f) yesterday's unresolved → warning line present, digest still sent (unbooked-fills policy); (g) `runReminder` on trading day sends reminder text, on holiday sends nothing.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — morning order of operations exactly: weekend → calendar (file) → crosscheck → stale-roll from last trading day → fetch+sanity close → per run: loadState → advanceDay → computeOrders → persist → render+send → notify-insert. `wire.ts` thin croner.
- [ ] **Step 4: Run tests — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: morning digest + fill-reminder pipelines"`

### Task 12: HTTP API (`apps/server/http`) + auth

**Files:**
- Create: `apps/server/src/http/app.ts`, `http/auth.ts`, `http/routes/runs.ts`, `http/routes/fills.ts`, `http/routes/pending.ts`, `http/routes/sim-stub.ts` (empty router placeholder), `http/routes/settings.ts`; Test: `apps/server/test/http.test.ts`

**Interfaces:**
- Consumes: repos, booking service, `progressView`, pipeline deps (manual `/api/trigger/morning` for debugging).
- Produces: `createApp(deps: HttpDeps): Hono` — `POST /api/login {password}` vs `APP_PASSWORD` → HttpOnly `st_session` cookie (HMAC via `SESSION_SECRET`, 30 d) or `Authorization: Bearer <same token>`; all `/api/*` except login require it; `GET /api/health → { ok: true }`; runs: `POST /api/runs {name,ticker,costPpm,poolCents,params?,seed?}` (seed via Task 9 `seedRun`), `GET /api/runs`, `GET /api/runs/:id` (+`progressView` output), `POST /api/runs/:id/pool {amountCents}` (row in pool_edits, recompute nothing for held buckets), `PATCH /api/runs/:id {status}`; `GET /api/runs/:id/orders?date=`, `/fills`, `/notifications`; pending: `GET /api/pending`, `POST /api/pending/:id/confirm {overrides?}`, `POST /api/pending/:id/reject`; manual: `POST /api/runs/:id/fills` (→ `manualFill`); settings: `GET/PUT /api/settings` (vision model/base, digestLang — key masked). Static web mount placeholder `app.get('/healthz')` skipped — keep `GET /` serving `apps/web/dist/index.html` when built.

- [ ] **Step 1: Write failing tests** via `app.request()` with fake repos — login cookie issued only for correct password, protected route 401 without it; create run → appears in list with zero buckets + pool echoed; create run **with seed** → buckets seeded, `source:'seed'` ledger; `POST /pool` changes `poolCents` and adds pool_edits row; manual fill on a run books like Task 9; pending confirm route calls confirm with overrides; `POST /api/trigger/morning` returns pipeline result string (fake deps).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — token: `base64url(expiry) + '.' + HMAC-SHA256(payload, SESSION_SECRET)`, verify constant-time-ish (`crypto.timingSafeEqual`).
- [ ] **Step 4: Run tests — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: Hono API + single-owner auth"`

### Task 13: Simulation mode (`apps/server/sim`)

**Files:**
- Create: `apps/server/src/sim/sim.ts`; Test: `apps/server/test/sim.test.ts`

**Interfaces:**
- Consumes: `OHLCBar[]`, `computeOrders`, `advanceDay`, apply-fill functions, money.
- Produces: `interface SimInput { name: string; ticker: string; from: ISODate; to: ISODate; poolCents: number; costPpm: number; params?: Partial<MrParams> }`; `interface SimDay { date: ISODate; plan: DayPlan; fills: RawFill[]; cashCents: number; heldCount: number }`; `simulateDays(cfg: Run, params: MrParams, bars: OHLCBar[]): SimDay[]` (pure); `runSim(input, deps: { fetchDailyBars; repos }): Promise<SimRunRow>` persists `sim_runs`/`sim_days` (JSON snapshots); routes `POST /api/sim`, `GET /api/sim/:id`, `GET /api/sim` in `http/routes/sim.ts` (replace sim-stub).

- [ ] **Step 1: Write failing tests for `simulateDays`** — 3 fabricated bars (TSLA 350/340/345 with H/L straddling limits): day 1 seeds nothing (first bar only sets the initial `lastClose`); day 2: buy LOC `low ≤ limit` → filled at `min(limit, open)` (assert both branches with two scenarios incl. gap-down where `open < limit` fills at open), bucket 0 held, cash math; day 3: sell LOC fills iff `high ≥ target` at `max(target, open)`; unfilled buy leaves state untouched, bucket stays free next day; forced `market_sell` fills at `close`. `DayPlan` for each simulated day must equal what `computeOrders` returns (digest fidelity = replayability).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — loop from bar index 1; each iteration: `advanceDay` → `computeOrders(run, params, state, { tradeDate: bar.date, lastClose: prevBar.close, … })` → resolve plan orders against bar → apply fills → push `SimDay`.
- [ ] **Step 4: Run tests — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: simulation replay engine + API"`

### Task 14: Web UI (`apps/web`)

**Files:**
- Create: `apps/web/{package.json,vite.config.ts,tailwind.config.ts,index.html}`, `src/{main.tsx,App.tsx,api.ts,viewmodels.ts}`, `src/i18n.ts src/i18n/en.json src/i18n/ko.json`, `src/components/{Layout.tsx,ThemeLangToggle.tsx,BucketBoard.tsx,OrderTable.tsx,FillTable.tsx,NoticeList.tsx}`, `src/pages/{Login,RunsList,RunDetail,Sim,Settings}.tsx`, shadcn/ui primitives (button/table/dialog/card/dialog); Test: `apps/web/src/viewmodels.test.ts`

**Interfaces:**
- Consumes: Task 12/13 API JSON shapes (documented in `api.ts` return types).
- Produces: `apps/web/dist` static build; `viewmodels.ts` exports `bucketBoard(state): Array<{ index; label; state: 'held'|'force_sell'|'free'; shares; entry: string; ageDays: number }>`, `pnlBadge(realizedCents): { tone: 'pos' | 'neg' | 'zero'; text: string }`, `formatMoney(cents): string`.

- [ ] **Step 1: Write failing tests for viewmodels** (bun test, pure TS): `bucketBoard` keeps all 10 slots ordered with age from `state.ages`; `pnlBadge(35959).tone === 'pos'`, `pnlBadge(0).tone === 'zero'`; `formatMoney(1871269) === '$18,712.69'`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement viewmodels + tests pass.**
- [ ] **Step 4: Build the app** — Layout with header: app title, runs/sim/settings nav, `ThemeLangToggle` top-right (Sun/Moon icon cycling light/dark persisted to `localStorage`, `prefers-color-scheme` as initial; separate `EN/한` pill). RunsList cards (name, ticker, P&L via `pnlBadge`, `held/10` occupancy). RunDetail: `BucketBoard` (10 cards; age + shares + entry; `force_sell` amber), order/fill/notice tables, pool-edit + manual-fill + seed-on-create dialogs. Sim page: form → day-step timeline (◀/▶ + keyboard) rendering each `SimDay.plan` in the same row layout as Telegram digest lines + running cash/P&L. Settings page per spec. All copy through react-i18next catalogs (en/ko; notice codes translated same as Task 10 list); `api.ts` typed fetch wrapper sending cookie creds; Vite dev proxy `/api → http://localhost:8080`.
- [ ] **Step 5: `cd apps/web && bun run build` succeeds; `bun test` passes; typecheck clean.**
- [ ] **Step 6: Commit** — `git commit -am "feat: web UI (runs, bucket board, sim replay, settings; en/ko + theme)"`

### Task 15: Wiring + container deployment

**Files:**
- Modify: `apps/server/src/main.ts` (create), `Dockerfile`, `docker-compose.yml`; Create: `README.md` (quickstart only — AGENTS.md owns the rest)

**Interfaces:**
- Consumes: everything. Produces: `docker compose up` → healthy app at `:8080`, Telegram bot long-polling, cron active, migrations applied.

- [ ] **Step 1: `main.ts`** — load env (zod-validate, fail fast with named missing vars) → drizzle client + `migrate()` → repos → createApp → serve on `PORT` → `createBot` + `start()` only when `TELEGRAM_BOT_TOKEN` set → croner wires (tz America/New_York); SIGTERM: stop bot, stop cron, close server, exit 0.
- [ ] **Step 2: `Dockerfile`** — stage 1 `oven/bun:1.2` builds web (`bun --cwd apps/web run build`); stage 2 slim bun image, `bun install --frozen-lockfile --production`, copy app sources + dist, `USER bun`, `CMD ["sh","-c","bun db:migrate && bun apps/server/src/main.ts"]`; `.dockerignore`.
- [ ] **Step 3: `docker-compose.yml`** — services: `db` (`mariadb:11.4`, volume, healthcheck `healthcheck.sh --connect --innodb_initialized`), `app` (build ., depends_on db healthy, env from .env, ports 8080:8080).
- [ ] **Step 4: Verify** — `docker compose up -d --build && curl -sf localhost:8080/api/health` → `{"ok":true}`; if Docker is unavailable on the dev machine, run `bun apps/server/src/main.ts` locally against a local MariaDB and curl health — the plan requires one of the two verified before shipping.
- [ ] **Step 5: Commit** — `git commit -am "feat: container deployment + startup wiring"`

### Task 16: End-to-end smoke + docs polish

**Files:**
- Create: `scripts/e2e.ts`; Modify: `AGENTS.md` (test matrix section), `README.md`

- [ ] **Step 1: Write `scripts/e2e.ts`** — end-to-end on a scratch DATABASE_URL: create run via API (with seed), fake-vision server (`Bun.serve`) + `VISION_BASE_URL` pointed at it, push a capture through `ingestCapture` → confirm → assert digest text renders via `renderDigest` and bucket board VM shows the bucket; run `simulateDays` on fixture bars; exit 0.
- [ ] **Step 2: `bun scripts/e2e.ts` passes; full `bun test`, `bun run typecheck` pass.**
- [ ] **Step 3: AGENTS.md test matrix** (which suites need TEST_DATABASE_URL, how to run e2e, how to regenerate NYSE calendar data) + README quickstart (copy .env.example, set 4 required vars, compose up, first `/start` claims chat, open :8080).
- [ ] **Step 4: Commit** — `git commit -am "test: e2e smoke + operator docs"`

---

## Self-review notes (written after plan completion)

- Spec coverage: every spec section maps to a task — seeding (9/12), i18n (10/14), calendar conflict (3/11), forced-exit replace rule (5/6), sim tables (8/13), container (15), December nudge (11), late booking (9), duplicates (9).
- Review Focus pins: (1) 9a, (2) 7b/f, (3) 6 forced-vs-LOC, (4) 9e, (5) 3 tests + 11a/b.
- Type consistency: `computeOrders(run, params, state, ctx)`, `advanceDay`, `applyBuyFill/applySellFill`, `renderDigest(run, plan, ctx, lang)`, `extractFills(images, cfg, fetchImpl)` used identically in all later tasks.
