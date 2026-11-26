# All-runs Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Dashboard page that shows, per strategy, the current value of its active and paused runs (shares at the last stored close, plus cash) with a total per strategy.

**Architecture:** One read-only endpoint `GET /api/dashboard` computes everything on the server with the existing integer money code (a pure builder plus a loader in `domain/dashboard.ts`); the web page only displays it. The morning job gains one step that stores the last close for every ticker of an active or paused run whose stored close is behind, so paused runs stay current.

**Tech Stack:** Bun + TypeScript, Hono, drizzle-orm on MariaDB, React + Vite + Tailwind, `bun test` (happy-dom for the web).

**Spec:** `docs/superpowers/specs/2026-11-26-runs-dashboard-design.md` — read it first; it is binding.

## Global Constraints

- Work only in the worktree `/Users/nazgul33/.local/share/opencode/worktree/c34a7d/runs-dashboard`, branch `feat/runs-dashboard`. Run commands from the worktree root.
- **Database for this branch:** every DB-gated command uses `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_dash` (Task 1 creates it). Never run anything against `st_test`.
- **Never touch these containers:** `mariadb_st_prod`, `stratagy_tracker_prod`, `mariadb_st_staging`, `strategy_tracker_staging`.
- No new table, no migration, no schema change. `bun run --cwd apps/server db:generate < /dev/null` must keep printing "No schema changes, nothing to migrate".
- The existing run lists, run pages and their server responses do not change: `GET /api/runs`, `GET /api/runs/:id`, `GET /api/vr/runs`, `GET /api/vr/runs/:id` answer exactly as on `main`. The morning messages do not change. (Tasks 5 and 6, added on the owner's decision, are the two stated exceptions: stored closes become one session newer in the evening, and `POST /api/runs/:id/pool` also moves the run's stored cash.)
- Money is integer only: cents are `number`, prices `bigint` ten-thousandths of a dollar; prices leave the API as strings (`jsonBig`). No floats.
- Counted runs: status `active` or `paused`. Closed runs are neither listed nor counted.
- `DayDeps` and `HttpDeps` gain no new required top-level field.
- No source file over ~300 lines. `scripts/e2e.ts` is at 295: at most an import and one call are added.
- All user-facing copy through `apps/web/src/i18n/{en,ko}.json` (same keys, `localeCompare`-sorted, same placeholders, no Hanzi in ko; VR strings write "Pool").
- No files outside the worktree. English only in code, comments and commit messages; Korean only in the ko catalog.
- Tests are written before the code they test. Commit style: `feat|fix|docs|test|refactor|chore:`.

## Review Focus

1. **A run holds shares and its ticker has no stored close.** Expected: no stock value, value = cash, the row says the close is missing, the strategy total is marked incomplete. Pinned in Task 1 and Task 3.
2. **Closes of different dates on one page.** Expected: the page date is the newest close used; the older row shows its own date and is marked; its strategy total is marked. Pinned in Task 1 and Task 3.
3. **A VR run just created (no shares, no stored close).** Expected: the VR list still reports no value; the dashboard counts its Pool and marks nothing. Pinned in Task 1.
4. **The landing page fails to load or the sign-in has expired.** Expected: an error with a retry, or the sign-in page; never a blank page. Pinned in Task 3.
5. **The close catch-up fails for a ticker.** Expected: logged; the morning job's result and messages are exactly what they would have been. Pinned in Task 2.

## File Structure

- `apps/server/src/domain/dashboard.ts` — the dashboard types, the pure `buildDashboard`, and `loadDashboard` (reads runs, books, closes, waiting counts).
- `apps/server/src/http/routes/dashboard.ts` — `GET /dashboard`.
- `apps/server/src/pipeline/close-catchup.ts` — `catchUpCloses`, called from `pipeline/day.ts`.
- `apps/web/src/api.dashboard.ts` — DTO types and `dashboardApi.get()`.
- `apps/web/src/pages/Dashboard.tsx` — the page.
- `scripts/e2e-dashboard.ts` — the smoke step.

---

### Task 1: The dashboard computation and its endpoint

**Files:**
- Create: `apps/server/src/domain/dashboard.ts`, `apps/server/src/http/routes/dashboard.ts`, `apps/server/test/dashboard.test.ts`, `apps/server/test/http-dashboard.test.ts`
- Modify: `apps/server/src/http/app.ts` (mount the route next to the others, behind the same auth)

**Interfaces:**
- Consumes: `runRepo.list()`, `bucketRepo.loadState(runId)`, `pendingRepo.listPending()`, `vrRunRepo.list()`, `vrFillRepo.listForRun`, `vrCashRepo.listForRun`, `vrPendingRepo.countPending`, `priceHistoryRepo.listForTicker(ticker)` (ascending by trade date), all already on `HttpRepoSurface`; `vrBooks`, `evalCents` from `@st/strategies`; `toEngineFill` and `lastCloseOf` from `domain/vr/view.ts`.
- Produces (in `domain/dashboard.ts`):

```ts
export type DashboardStrategy = 'mean-reversion' | 'value-rebalancing'
export interface DashboardRunInput {
  id: number; name: string; ticker: string; status: 'active' | 'paused' | 'closed'
  shares: number; cashCents: number; waiting: number
  lastClose: { date: ISODate; close: bigint } | null   // newest stored close of the ticker
}
export interface DashboardRow {
  id: number; name: string; ticker: string; status: 'active' | 'paused'
  shares: number
  close: bigint | null; closeDate: ISODate | null      // both null when shares is 0 or no close is stored
  closeMark: 'missing' | 'older' | null
  stockCents: number | null                             // null only when closeMark is 'missing'
  cashCents: number; valueCents: number; waiting: number
}
export interface DashboardGroup { strategy: DashboardStrategy; totalCents: number; incomplete: boolean; olderClose: boolean; runs: DashboardRow[] }
export interface Dashboard { today: ISODate; closeDate: ISODate | null; groups: [DashboardGroup, DashboardGroup] }

export function buildDashboard(i: { today: ISODate; mr: readonly DashboardRunInput[]; vr: readonly DashboardRunInput[] }): Dashboard
export async function loadDashboard(deps: { repos: DashboardRepos; today: ISODate }): Promise<Dashboard>
```

`DashboardRepos` is a `Pick` of the repositories named under Consumes, so `HttpRepoSurface` satisfies it and tests can pass the existing fakes (`makeHttpFakes` / `makeVrFakes`).

Rules for `buildDashboard` (the spec's "What is counted"):
- Groups come in the fixed order mean-reversion, value-rebalancing, both always present. Rows are the inputs with status `active` or `paused`, ascending by id.
- A row with `shares === 0`: `close` and `closeDate` null, `stockCents` 0, `closeMark` null.
- A row with shares and a close: `stockCents = evalCents(shares, close)`.
- A row with shares and no close: `stockCents` null, `closeMark: 'missing'`, value = cash.
- `valueCents = (stockCents ?? 0) + cashCents`; a group's `totalCents` is the sum of its rows' `valueCents`.
- `Dashboard.closeDate` is the newest `closeDate` among all rows of both groups (null when no row uses a close). A row whose `closeDate` is earlier gets `closeMark: 'older'`.
- `incomplete` = some row of the group is `'missing'`; `olderClose` = some row of the group is `'older'`.

Rules for `loadDashboard`:
- MR: for each run of `runRepo.list()` that is not closed, `shares` = the sum of `shares` over the buckets whose state is not `'empty'`, `cashCents` = the state's `cashCents`, `waiting` = the number of rows of `pendingRepo.listPending()` with that run id.
- VR: for each run of `vrRunRepo.list()` that is not closed, `vrBooks(fills.map(toEngineFill), moves)` gives `shares` and `poolCents` (the cash); `waiting` = `vrPendingRepo.countPending(run.id)`.
- `lastClose` = `lastCloseOf(await priceHistoryRepo.listForTicker(ticker))`, read once per distinct ticker.
- Reads only; no run lock.

HTTP: `GET /api/dashboard` → `200` with `jsonBig(await loadDashboard({ repos: deps.repos, today: deps.today() }))`. Without a session it answers as every other protected route does.

- [ ] **Step 1: Create the branch database**

```bash
docker exec st-mariadb-test mariadb -uroot -ptest -e "CREATE DATABASE IF NOT EXISTS st_test_dash"
```

- [ ] **Step 2: Write the failing tests**

`dashboard.test.ts`, on `buildDashboard` with hand-built inputs (prices are ten-thousandths):
- an MR run with 118 shares, close `361800n` dated `2026-11-25`, cash `2010510` → `stockCents 426924`, `valueCents 2437434`, `closeMark null`, `close 361800n`, `closeDate '2026-11-25'`.
- a VR run with 277 shares, close `714000n`, Pool `1212495` → `stockCents 1977780`, `valueCents 3190275`.
- rounding at half a cent: 3 shares at `333350n` → `stockCents 10001`.
- totals: the MR group above plus a second MR run of 95 shares at `714000n` with cash `1705299` → `totalCents` is the sum of the two `valueCents` (`2437434 + 2383599 = 4821033`).
- Review Focus 1: shares 10, `lastClose: null`, cash `50000` → `stockCents null`, `valueCents 50000`, `closeMark 'missing'`; the group `incomplete true`, the other group `incomplete false`.
- Review Focus 2: one run with a close dated `2026-11-25` and one dated `2026-11-24` → `closeDate '2026-11-25'`; the second row `closeMark 'older'` with its own `closeDate`; its group `olderClose true`; when the two rows are in different groups only the older row's group is marked.
- no shares: `shares 0` with a stored close dated `2026-11-27` and another run with shares at `2026-11-25` → the first row has `close null`, `closeDate null`, `stockCents 0`, `closeMark null`, and `Dashboard.closeDate` is `'2026-11-25'` (a row without shares plays no part).
- closed runs are absent and not summed; paused runs are present and summed; rows are ascending by id; with no run at all both groups are present with `runs []`, `totalCents 0`, and `closeDate null`.
- `waiting` is carried through.

`dashboard.test.ts`, on `loadDashboard` with the existing fakes:
- an MR run whose state has a held bucket of 100 shares, a force-sell bucket of 18 and an empty bucket → `shares 118`; `cashCents` from the state; two pending rows for it and one for another run → `waiting 2`.
- a VR run with fills and cash moves: its row's `shares` and `cashCents` equal `buildVrSummary`'s `shares` and `poolCents` for the same inputs, and `valueCents` equals the summary's `valueCents`.
- Review Focus 3: a VR run with opening cash only and no stored close → the summary's `valueCents` is `null`; the dashboard row's `valueCents` equals the Pool and `closeMark` is `null`.
- two runs on one ticker read the ticker's closes once (count the calls).

`http-dashboard.test.ts` (the pattern of `http-vr-runs.test.ts`): without a session the route answers like `GET /api/vr/runs` does; with one, `200` and a body whose `groups[0].strategy` is `'mean-reversion'`, `groups[1].strategy` is `'value-rebalancing'`, `close` is a string such as `"361800"`, the cent fields are numbers, and `today` is the injected date; `GET /api/runs` and `GET /api/vr/runs` answer the same bodies before and after the dashboard is read.

- [ ] **Step 3: Run to see them fail** — `bun test apps/server/test/dashboard.test.ts apps/server/test/http-dashboard.test.ts` → FAIL (module not found).
- [ ] **Step 4: Implement** `domain/dashboard.ts`, `http/routes/dashboard.ts`, and mount it in `http/app.ts`.
- [ ] **Step 5: Run** — `bun run typecheck && bun test` and `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_dash bun test` → clean, 0 fail.
- [ ] **Step 6: Commit**

```bash
git add -A apps/server
git commit -m "feat: GET /api/dashboard — value of active and paused runs per strategy at the last stored close"
```

---

### Task 2: The morning job keeps closes current

**Files:**
- Create: `apps/server/src/pipeline/close-catchup.ts`, `apps/server/test/day-close-catchup.test.ts`
- Modify: `apps/server/src/pipeline/day.ts` (the `DayDeps` field and one call), `apps/server/src/main.ts` (wire the reader)

**Interfaces:**
- Consumes: `fetchClose(deps, ticker, today)` from `pipeline/close.ts` (fetches, checks the close is the previous trading day's, stores it through `deps.persistClose`, returns null on any failure); `prevTradingDay` from `@st/calendar`; `runRepo.list()`, `vrRunRepo.list()`.
- Produces:
  - `DayDeps` gains the optional `latestStoredCloseDate?: (ticker: string) => Promise<ISODate | null>` (the trade date of the newest stored close of a ticker, or null).
  - `export async function catchUpCloses(deps: DayDeps, today: ISODate): Promise<void>` in `close-catchup.ts`.

Behaviour of `catchUpCloses`:
- When `deps.latestStoredCloseDate` is absent it does nothing (so every existing test and caller behaves as before).
- It takes the distinct tickers of the MR and VR runs whose status is `active` or `paused`. For each ticker whose newest stored close date is null or earlier than `prevTradingDay(today)`, it calls `fetchClose`. A ticker already stored for the previous trading day is not fetched.
- It sends no message, takes no run lock, changes no run or order, and never throws: any error, including one from reading the runs or the stored date, is logged with `console.error` and the next ticker is tried.

`morningPipeline` calls it once, after the MR runs and `processVrRuns` have been processed and before it returns, on that path only (not on the closed-day, conflict or any other early return). Its return value and messages do not depend on the catch-up.

`main.ts` wires `latestStoredCloseDate` from `repos.priceHistoryRepo` (the newest row of the ticker).

- [ ] **Step 1: Write the failing tests** in `day-close-catchup.test.ts` (the fixtures of the existing `day*.test.ts` and `vr-day-fixture.ts`; a trading day such as `2026-11-24`, whose previous trading day is `2026-11-23`):
- a paused MR run on `SOXL` with nothing stored → one `fetchLastClose('SOXL')` and one `persistClose('SOXL', '2026-11-23', …)`; the same for a paused VR run on another ticker.
- a ticker of an active run whose close was stored for `2026-11-23` by the run's own processing → not fetched a second time (count the `fetchLastClose` calls per ticker).
- an active run that is skipped because it is already planned today, with a stored close dated `2026-11-20` → its ticker is caught up.
- two paused runs on one ticker → fetched once.
- a closed run's ticker is never fetched.
- Review Focus 5: `fetchLastClose` throws for the paused ticker → the pipeline's return value and the list of sent messages equal those of the same morning without that paused run; an error is logged; the other paused ticker is still stored.
- `latestStoredCloseDate` throws → logged, nothing else changes.
- on a closed day and on a cross-check conflict nothing is fetched for a paused ticker.
- without `latestStoredCloseDate` in the deps nothing is fetched for a paused ticker.

- [ ] **Step 2: Run to see them fail** — `bun test apps/server/test/day-close-catchup.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `bun run typecheck && bun test` → clean, 0 fail; every existing `day*.test.ts`, `vr-day*.test.ts` and `main-boot-order.test.ts` passes with its assertions unedited.
- [ ] **Step 5: Commit**

```bash
git add -A apps/server
git commit -m "feat: the morning job stores the last close for every active or paused run's ticker that is behind"
```

---

### Task 3: Web — the Dashboard page, its route, and the landing page

**Files:**
- Create: `apps/web/src/api.dashboard.ts`, `apps/web/src/api.dashboard.test.ts`, `apps/web/src/pages/Dashboard.tsx`, `apps/web/src/pages/Dashboard.test.tsx`
- Modify: `apps/web/src/components/hooks.tsx` (`Route`, `parseHash`), `apps/web/src/components/hooks.test.tsx`, `apps/web/src/App.tsx`, `apps/web/src/App.test.tsx` or `AppVr.test.tsx` (routing cases), `apps/web/src/components/Layout.tsx`, `apps/web/src/pages/Login.tsx`, `apps/web/src/i18n/en.json`, `ko.json`

**Interfaces:**
- Consumes: Task 1's response. On the wire `close` is a string or null; everything else as declared there.
- Produces:
  - `api.dashboard.ts`: `DashboardDto`, `DashboardGroupDto`, `DashboardRowDto` (Task 1's shapes with `close: string | null`) and `dashboardApi.get(): Promise<DashboardDto>` (`GET /api/dashboard`, the same client rules as `api.vr.ts`).
  - `Route` gains `{ page: 'dashboard' }`; `parseHash('')`, `parseHash('#')`, `parseHash('#/')` and `parseHash('#/dashboard')` give it; `#/dashboard/x` is `notFound`. `#/runs` still gives `{ page: 'runs' }`.
  - `DashboardPage()` in `pages/Dashboard.tsx`; nav key `'dashboard'`.

The page (the spec's "The page"):
- Title, and at the top right "closes of <date>" from `closeDate` (nothing when it is null), and a reload control.
- One card per group, in the order received, each with the strategy name, its total, and a table: run (a link to `#/runs/<id>` for mean reversion, `#/vr/<id>` for VR), ticker, status badge, shares, close, stock value, cash (the header reads "Pool" in the VR table), value, waiting.
- Close cell: the price; blank when `close` is null and `closeMark` is null; a "close missing" mark when `closeMark` is `'missing'` (stock value blank); the price with its own date and an "older close" mark when `closeMark` is `'older'`.
- Total: the amount; plus a note when `incomplete` (some shares are not valued) and a note when `olderClose`.
- Waiting: blank when 0; otherwise the number as a link to `#/pending` (mean reversion) or `#/vr/<id>?tab=pending` (VR).
- A group with no runs shows an empty-state line and a total of `$0.00`.
- Loading, a failed load with a retry, and an expired sign-in behave as on `pages/VrRuns.tsx` (`useAsync`, `Spinner`, `ErrorNote`).
- Amounts with `centsUsd`, prices with `priceUsd`, dates with `isoDate`.

Navigation: "Dashboard" is the first menu item (`#/dashboard`), the app name in the header links to it, `Login.tsx` sends a signed-in user to it, and the not-found page's back link goes to it. The MR runs list stays at `#/runs` with its menu item.

Catalog keys (en and ko): `navDashboard`, and under `dash.`: `title`, `closesOf` (`{date}`), `reload`, `strategyMr`, `strategyVr`, `total`, `totalIncomplete`, `totalOlderClose`, `colRun`, `colTicker`, `colStatus`, `colShares`, `colClose`, `colStockValue`, `colCash`, `colPool`, `colValue`, `colWaiting`, `closeMissing`, `closeOlder` (`{date}`), `empty`.

- [ ] **Step 1: Write the failing tests**

`api.dashboard.test.ts`: `get()` sends `GET /api/dashboard` with the session header and returns the body.

`hooks.test.tsx`: change the one existing expectation `parseHash('')` → `{ page: 'dashboard' }`; add `#`, `#/`, `#/dashboard`, `#/dashboard/x` (not found); `#/runs` unchanged.

`Dashboard.test.tsx` (fetch stubbed as in `pages/VrRuns.test.tsx`), with a fixture of two MR runs and one VR run using Task 1's numbers:
- the header shows the closes date; each card shows its strategy name and total (`$48,210.33` for cents `4821033`, `$31,902.75` for `3190275`); the rows show `$4,269.24`, `$20,105.10`, `$24,374.34`; the VR table's cash header reads "Pool".
- run names link to `#/runs/<id>` and `#/vr/<id>`; a waiting count of 2 links to `#/pending` in the MR table and to `#/vr/<id>?tab=pending` in the VR table; a count of 0 renders nothing.
- Review Focus 1: a `'missing'` row shows the missing mark, a blank stock value and its cash as value; its card shows the incomplete note; the other card does not.
- Review Focus 2: an `'older'` row shows its own date and the mark; its card shows the older-close note.
- a row with no shares shows blank close and `$0.00` stock value, with no mark.
- a group with `runs: []` shows the empty line and `$0.00`.
- Review Focus 4: a 500 shows the worded error and a retry that loads the page; a 401 sends the user to the sign-in page (as the other pages do); while loading a spinner is shown.
- the reload control re-reads (`GET` count goes up by one).

Routing (`App.test.tsx` or `AppVr.test.tsx`, in that file's style): the empty hash and `#/dashboard` render the Dashboard page with "Dashboard" active in the menu and first in it; `#/runs` still renders the MR runs list; the header's app name links to `#/dashboard`; after a successful sign-in the hash is `#/dashboard`.

- [ ] **Step 2: Run to see them fail** — `bun test apps/web/src` → the new and changed cases FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `bun run typecheck && bun test` → clean, 0 fail; `catalog.test.ts` green; `pages/RunsList*.test.tsx` and `pages/VrRuns.test.tsx` pass unedited.
- [ ] **Step 5: Commit**

```bash
git add -A apps/web
git commit -m "feat: Dashboard page with per-strategy totals; the app opens on it"
```

---

### Task 4: End-to-end step, docs, whole-branch verification

**Files:**
- Create: `scripts/e2e-dashboard.ts`
- Modify: `scripts/e2e.ts` (one import and one call, after the last existing step), `scripts/e2e-vr.ts` only if its `storingCloses` helper must also supply `latestStoredCloseDate`, `AGENTS.md`

**Interfaces:**
- Consumes: the script's `ctx` (`scripts/e2e-ctx.ts`), the real HTTP app, `runMorningPipeline`.
- Produces: `checkDashboard(ctx, today, …)`.

The step, against the real HTTP app and the scratch database:
1. `GET /api/dashboard` → 200; two groups in the fixed order.
2. For every row, recompute from the script's own reads: MR — `GET /api/runs/<id>` gives the state (shares of non-empty buckets, `cashCents`); VR — `GET /api/vr/runs` gives `shares` and `poolCents`; the newest stored close of the ticker from the price-history repository. Assert `shares`, `cashCents`, `stockCents`, `valueCents` and `close` row by row, and each group's `totalCents` as the sum of its rows.
3. No closed run of the script appears in either group; every active or paused run does.
4. Create one VR run on a ticker of its own, type its opening buy, pause it, and make sure nothing is stored for the ticker: its dashboard row is marked `'missing'`, its value is its Pool, and the VR group is `incomplete`. Run the morning job with `latestStoredCloseDate` wired to the scratch database → the ticker now has a stored close for the previous trading day, the row's `stockCents` is its shares at that close, the mark is gone and the group is no longer `incomplete`. Close the run afterwards.

- [ ] **Step 1: Write `scripts/e2e-dashboard.ts` and wire it in.** `scripts/e2e.ts` stays at or under 300 lines.
- [ ] **Step 2: Run the smoke** — `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_dash bun scripts/e2e.ts` → exits 0, the new assertions counted.
- [ ] **Step 3: Update `AGENTS.md`** — repo map (every file this branch adds, enumerated with `git diff --name-status main -- . ':!docs'`); project overview (the Dashboard page: value per strategy at the last stored close; the app opens on it); Conventions: add "The dashboard (`domain/dashboard.ts`, `GET /api/dashboard`) values active and paused runs at the newest stored close of their ticker; the morning job (`pipeline/close-catchup.ts`) stores the last close for every active or paused run's ticker that is behind."
- [ ] **Step 4: Commit**

```bash
git add -A scripts AGENTS.md
git commit -m "test: dashboard end-to-end step; docs: repo map and conventions for the dashboard"
```

- [ ] **Step 5: Whole-branch checks** (after the commit)

```bash
bun run typecheck
bun test
TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_dash bun test
(cd apps/server && bun run db:generate < /dev/null)
git status --short
git diff --stat main -- apps/server/db/migrations
git diff --name-only main -- apps packages scripts | grep -E "\.(ts|tsx)$" | grep -v "\.test\." | xargs wc -l | sort -n | tail -6
docker exec st-mariadb-test mariadb -uroot -ptest -e "SHOW DATABASES LIKE 'st\_e2e%'; SHOW DATABASES LIKE 'st\_janitor%'; SHOW DATABASES LIKE 'st\_simlist%'; SHOW DATABASES LIKE 'st\_mrsplit%'"
```

Expected: typecheck clean; 0 fail in both runs; "No schema changes"; a clean tree; the migrations diff prints nothing; no non-test source file this branch touched is over ~300 lines; no scratch database left. Report the results of Steps 2 and 5. Leave `st_test_dash` in place and do not push or deploy.

---

### Task 5: The evening close job, and a "behind" rule that knows the time

Added after the final review, on the owner's decision. The spec's "The evening close job" and the amended last bullet of "Missing and older closes" are the requirement; read them first.

**Files:**
- Create: `apps/server/src/pipeline/evening-closes.ts`, `apps/server/test/evening-closes.test.ts`
- Modify: `apps/server/src/pipeline/close.ts` (`fetchClose` takes the expected date), `apps/server/src/pipeline/close-catchup.ts` (share the ticker collection), `apps/server/src/pipeline/wire.ts` (the cron), `apps/server/src/pipeline/day.ts` only if `DayDeps` needs the optional clock, `apps/server/src/domain/dashboard.ts`, `apps/server/src/http/routes/dashboard.ts`, `apps/server/src/http/app.ts` only for an optional clock on `HttpDeps`, `apps/server/src/market/bars.ts` (comment only), `apps/server/test/dashboard.test.ts`, `apps/server/test/http-dashboard.test.ts`, the test that pins the cron jobs of `wire.ts` if there is one, `apps/web/src/i18n/en.json`, `ko.json`, `apps/web/src/pages/Dashboard.test.tsx` (the two strings), `scripts/e2e-dashboard.ts`, `AGENTS.md`

**Interfaces:**
- `fetchClose(deps, ticker, today, expected?: ISODate)` — `expected` defaults to `prevTradingDay(today)`; every existing caller is unchanged. A fetched close dated other than `expected` is not stored and returns null.
- `export async function runEveningCloses(deps: DayDeps): Promise<{ stored: number; behind: number } | 'closed' | 'too-early'>` in `evening-closes.ts`:
  - `'closed'` when `dayInfo(today).open` is false; `'too-early'` when the New York wall time is before `16:30` (the clock is `deps.now?.() ?? new Date()`; `now` is optional on `DayDeps`, added only if it is not there yet);
  - otherwise, for each distinct ticker of an active or paused run of either strategy whose newest stored close is older than today (read through `deps.latestStoredCloseDate`), `fetchClose(deps, ticker, today, today)`; `stored` counts the tickers stored, `behind` those that could not be;
  - does nothing (returns `{ stored: 0, behind: 0 }`) when `latestStoredCloseDate` or `persistClose` is not wired; sends no message, takes no lock, never throws; a ticker that could not be stored is logged once, naming the ticker.
- `startJobs` adds one cron: `'0 17 * * 1-5'` in `America/New_York`, logging its result through the same `log` callback as the other jobs.
- `buildDashboard` takes `expectedClose: ISODate` next to `today`; `closesBehind = closeDate !== null && closeDate < expectedClose`. A new exported `expectedCloseDate(today: ISODate, etTime: string): ISODate` (`etTime` is `'HH:MM'` in New York) returns `today` when `dayInfo(today).open` and `etTime >= '17:30'`, else `prevTradingDay(today)`. The route computes `etTime` from `deps.now?.() ?? new Date()` (`now` optional on `HttpDeps`); a small helper for the New York `'HH:MM'` lives next to `todayEt` in `wire/deps.ts`.
- Web: no DTO change. The texts of `dash.closesBehind` and `dash.closesHint` change: en "These closes are behind: the last session's close has not been stored yet." and "Closes are stored at 17:00 New York time on trading days, and again by the next morning's job."; ko with the same meaning, natural, no Hanzi.

- [ ] **Step 1: Write the failing tests**

`evening-closes.test.ts` (the fixtures of `day-close-catchup.test.ts`; today `2026-11-24`, a Tuesday; the fake source answers `{ date: '2026-11-24', close }` unless said otherwise; clock `2026-11-24T22:00:00Z` = 17:00 New York):
- an active MR run, a paused MR run, an active VR run and a paused VR run on four tickers → four stores dated `2026-11-24`; result `{ stored: 4, behind: 0 }`; no message sent; no order, state or cycle written.
- two runs on one ticker → fetched once; a closed run's ticker never.
- a ticker already stored for `2026-11-24` → not fetched.
- the source answers `2026-11-23` for one ticker (not updated yet) → nothing stored for it, one error line naming it, `behind: 1`, the others stored.
- the source throws for one ticker → logged, the others stored, nothing thrown.
- a closed day (`2026-11-26`) → `'closed'`, no fetch; a Saturday → `'closed'`.
- the half day `2026-11-27` at 17:00 New York → stores closes dated `2026-11-27`.
- clock `2026-11-24T20:00:00Z` (15:00 New York) → `'too-early'`, no fetch, nothing stored; `2026-11-24T21:29:00Z` → `'too-early'`; `2026-11-24T21:30:00Z` → runs.
- without `latestStoredCloseDate`, or without `persistClose` → `{ stored: 0, behind: 0 }`, no fetch.
- the next morning (`2026-11-25`, the morning pipeline with the same store): the catch-up fetches nothing for the paused tickers (already stored for the previous trading day), and the pipeline's result and messages equal those of the same morning without the evening job having run.
- `fetchClose` with an explicit `expected`: a close dated `expected` is stored and returned; one dated otherwise is not stored and returns null; without the argument it behaves as before (one existing-behaviour case).

`dashboard.test.ts`: `expectedCloseDate('2026-11-24', '17:29')` → `'2026-11-23'`; `('2026-11-24', '17:30')` → `'2026-11-24'`; `('2026-11-24', '00:10')` → `'2026-11-23'`; a Saturday `('2026-11-28', '18:00')` → `'2026-11-27'`; the holiday `('2026-11-26', '18:00')` → `'2026-11-25'`; the half day `('2026-11-27', '17:30')` → `'2026-11-27'`. `buildDashboard` with `expectedClose`: a close dated the expected date → `closesBehind false`; one day earlier → `true`; `closeDate` null → `false`. Replace the date-only `closesBehind` cases of the previous rule with these.

`http-dashboard.test.ts`: with an injected clock at 17:00 New York on `2026-11-24` and a stored close dated `2026-11-23` → `closesBehind false`; at 17:30 → `true`; with a stored close dated `2026-11-24` at 17:30 → `false`.

The cron: a test that `startJobs` registers a job with pattern `0 17 * * 1-5` in `America/New_York` next to the existing ones (in the style of the existing test of `wire.ts`, if any; otherwise a new small test).

`Dashboard.test.tsx`: the two changed strings.

- [ ] **Step 2: Run to see them fail** — `bun test apps/server/test/evening-closes.test.ts apps/server/test/dashboard.test.ts apps/server/test/http-dashboard.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Update the comment at the top of `makeCachedBarReader` in `market/bars.ts` to say that a row dated today can exist, written only by the evening job after the session, and that the reader still never stores or marks as covered anything after the last finished trading day.
- [ ] **Step 4: Smoke.** In `scripts/e2e-dashboard.ts`, after the existing checks: call `runEveningCloses` with deps whose source answers today's date and whose clock is 17:00 New York on the script's day → a close dated today is stored for every ticker of a live run; the dashboard's `closeDate` is today and `closesBehind` is `false` with the clock at 17:30; with the clock at 17:30 and before the evening job, `closesBehind` is `true`. `scripts/e2e.ts` stays at or under 300 lines.
- [ ] **Step 5: Docs.** `AGENTS.md`: the new files in the repo map; Conventions: "An evening job (`pipeline/evening-closes.ts`, 17:00 New York on trading days) stores the day's close for every active or paused run's ticker; `price_history` may hold a row dated today only from that job; the bar cache never stores past the last finished trading day."
- [ ] **Step 6: Run** — `bun run typecheck`; `bun test`; `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_dash bun test`; `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_dash bun scripts/e2e.ts`; `(cd apps/server && bun run db:generate < /dev/null)` → clean, 0 fail, "No schema changes". Every existing `day*.test.ts`, `vr-day*.test.ts`, `bars*.test.ts` and `main-boot-order.test.ts` passes with its assertions unedited.
- [ ] **Step 7: Commit**

```bash
git add -A apps packages scripts AGENTS.md
git commit -m "feat: an evening job stores the day's close; the dashboard knows which close it should have by now"
```

---

### Task 6: Adding funds to a mean-reversion run moves its cash

Added after the final review, on the owner's decision. The spec's "Adding funds to a mean-reversion run" is the requirement.

**Files:**
- Create: `apps/server/src/domain/pool-edit.ts`, `apps/server/test/pool-edit.test.ts`
- Modify: `apps/server/src/http/routes/runs.ts` (`POST /runs/:id/pool` calls the new function), `apps/server/src/domain/recompute.ts` (the comment that names pool-edited runs as drifting), `docs/superpowers/specs/2026-11-14-partial-sell-history-design.md` ("Recalc and drift": pool edits no longer drift), the existing HTTP test of the pool route (add cases; existing assertions unedited)

**Interfaces:**
- `export function setRunPool(runId: number, poolCents: number, deps: BookingDeps & { repos: … poolEditRepo }): Promise<{ deltaCents: number } | null>` in `domain/pool-edit.ts`, run under `withRunLock(runId)`:
  1. read the run (null when it does not exist) and its stored state;
  2. `deltaCents = poolCents - run.poolCents`;
  3. `runRepo.updatePool`, then `poolEditRepo.insert` (both as today, also when the delta is 0);
  4. when `deltaCents !== 0`: save the state with `cashCents + deltaCents`, and insert one ledger row `{ kind: 'adjust', amountCents: deltaCents, ref: JSON.stringify({ bookedOn: deps.today, reason: 'pool-edit', poolCents }) }`.
- The route keeps its validation and answers (`400 invalid amountCents`, `404 not found`, `200 { ok: true }`).

- [ ] **Step 1: Write the failing tests** in `pool-edit.test.ts` (the booking fakes):
- a run with pool `1000000` and a held bucket (cash `850000` after a buy of `150000`): pool set to `1500000` → stored cash `1350000`, the buckets unchanged, one `adjust` ledger row of `500000` with `reason 'pool-edit'`, one pool-edit row, the run's pool `1500000`; result `{ deltaCents: 500000 }`.
- then `recalcRunState` on that run → `deltaCents 0` and no further ledger row (the stored cash already equals the pool minus history).
- pool lowered to `900000` → cash `750000`, an `adjust` row of `-100000`.
- the same pool again → `{ deltaCents: 0 }`, the state not saved, no ledger row, the pool-edit row still recorded (as today).
- a seeded run whose stored cash differs from the derived cash by `X`: after a pool increase of `500000`, the stored cash rose by exactly `500000` and a recalc still reports the same `X` as before the edit.
- an unknown run → null, nothing written.
- two calls started together (`Promise.all`) with pools `1500000` and `1200000` from `1000000` → the final stored cash equals `850000 + (final pool - 1000000)` whichever finishes last (the run lock makes them sequential), and the two ledger rows sum to that difference.
- order sizing: the next morning's buy size for the run uses the new pool exactly as it did before this change (compare `computeOrders` or the day test helper for a pool of `1500000` with and without the stored cash moved).

HTTP test of the pool route (add): after `POST /api/runs/:id/pool`, `GET /api/runs/:id` reports `progressView.cashCents` raised by the difference; `GET /api/dashboard` reports that run's `cashCents` and `valueCents` raised by the same difference.

- [ ] **Step 2: Run to see them fail** — `bun test apps/server/test/pool-edit.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `bun run typecheck`; `bun test`; `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_dash bun test`; `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_dash bun scripts/e2e.ts` → clean, 0 fail. If an existing test pins that a pool edit leaves the stored cash unchanged, STOP and report it (that expectation is the behaviour being changed; the controller rules on the edit).
- [ ] **Step 5: Commit**

```bash
git add -A apps packages scripts docs/superpowers/specs/2026-11-14-partial-sell-history-design.md
git commit -m "feat: setting a mean-reversion run's pool moves its stored cash by the difference"
```
