# Server hardening follow-ups (wave B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the server-side follow-ups from #42 and #49: observable and year-chunked bar caching, a locked `bar_coverage` merge, sim route/repo tidiness, a janitor plus transactional delete for screenshots, an honest "not kept" signal on the keep prompt, and two parked vision-review rulings (the Telegram date substitution notice, and `fee_overridden` semantics).

**Architecture:** These are small, independent changes, each owned by the module that already holds the behaviour. The bar cache (`market/bars.ts`) splits gaps by calendar year and warns when it records an empty gap as covered. `barCoverageRepo.add` locks the ticker's rows and retries on deadlock. Screenshot cleanup gets two repo primitives (`discard`, `sweepOrphans`); `sweepOrphans` runs from a new boot-sweeps module next to the sim draft sweep. The confirm and reject paths report `archived` up to the HTTP response, and the web keep prompt reads it.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle 0.44 (MariaDB/InnoDB), React (web), `bun:test`.

**Spec:** There is no design spec. The sources are GitHub #44, #47 and #48 (the "Validation" bullet and the "Server tidiness" bullets) and `docs/superpowers/followups/2026-11-17-pending-vision-review-followups.md` (cited per task as "followups §<heading>").

**Models (operator ruling 2026-11-18):** implementer subagents run on `anthropic/claude-sonnet-5-5`; per-task reviewers, the whole-branch reviewer and any plan amendments run on `anthropic/claude-opus-5-5`. Pass these as the subagent `model` parameter.

Branch: `fix/server-hardening` in a dedicated worktree, cut from `main` **after wave A (`docs/superpowers/plans/2026-11-18-sell-attribution.md`) has merged**. Line numbers below are from pre-wave-A `main`, so locate code by symbol. Post-A paths that this plan uses:
- `apps/server/test/booking-fakes.ts` (`fakeRepos`, `silentNotifier`, `recordingNotifier`)
- `domain/booking-notify.ts` (`notifyBookingOutcome`)
- `wire/booking-notifier.ts`
- `domain/order-ops.ts`
- `FillBookingDeps` and `BookedOutcome` (re-exported from `domain/booking.ts`)

**Not in this wave:**
- #40 multi-instance locking (deferred).
- #50 Korean native read (needs a human reviewer).
- Mime relabelling of non-allow-listed uploads (documented behaviour, no change).
- Delete-from-review-tab taking no run lock (intended).
- Wave A owns `sell-match.ts`, the `BookingDeps` type and the notifier hooks.
- Wave C owns typing `http-fakes.ts`, the test gaps and code hygiene.
- Wave D owns web polish and accessibility.

## Global Constraints

- English only in code, comments and docs. User-facing copy goes in the en/ko catalogs (`packages/telegram/src/i18n.ts`, `apps/web/src/i18n/{en,ko}.json`). No Chinese (Hanzi) or Cyrillic characters anywhere.
- Web catalog keys stay in `localeCompare` order with en/ko parity (enforced by the existing catalog test).
- No source file over ~300 lines. Split by responsibility.
- `packages/*` never import `apps/*`.
- Money is bigint myriadths via `@st/core/money`, fees are integer cents, cost is integer ppm. Never use floats.
- Schedules use `America/New_York`.
- `fetch` stays injectable.
- Do not edit `apps/server/src/domain/sell-match.ts` or the `BookingDeps`/`FillBookingDeps` types (wave A).
- Commit style: `feat|fix|docs|test|refactor|chore:`. Commit once per task.
- DB tests self-skip without `TEST_DATABASE_URL` (`const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip`, same as `apps/server/test/bars-db.test.ts`). They must use unique tickers and ids (`Date.now()` stamps) because the `st_test` DB is shared.
- Run every command from the repo root (migrations resolve from `process.cwd()`).

## Review Focus

1. **Two concurrent coverage writes on a ticker with no rows yet.** InnoDB gap locks do not serialize an empty `FOR UPDATE` read, so one transaction deadlocks. A sim Apply must still succeed, which means a retry rather than a 500. Pinned in Task 2 ("concurrent adds on a fresh ticker…").
2. **A year chunk whose edges are holidays or weekends** (Jan 1 closed, Dec 31 on a weekend). Each chunk must trim to its own first and last trading days, and must not call upstream for a chunk with no open day. Pinned in Task 1 ("a multi-year gap goes upstream one calendar year at a time").
3. **The janitor meeting a capture that still has a live pending row.** Its bytes must survive. Pinned in Task 6 (`sweepOrphans` keeps an unkept image with a live pending row).
4. **Ids like `01`, `0x1`, `1e0` or ones above 2^53.** `parseId` returns null, and a route never resolves them to an existing row. Pinned in Task 4.
5. **A screenshot whose trade date the extractor dropped as more than 45 days from today.** Telegram must show the same substitution notice as for a missing date. Pinned in Task 10.

---

### Task 1: Bar cache — shared `addDays`, year-chunked gaps, empty-gap warning (#47, #48)

Sources: #47; #48 "duplicates a four-line `addDays`" and "a large uncovered gap goes upstream as one unchunked call".

**Files:**
- Modify: `packages/calendar/src/index.ts:44-51` (export `addDays`)
- Modify: `apps/server/src/market/bars.ts:1`, `:18-22` (drop the local `addDays`), `:87-106` (chunk loop), `:131` (warn)
- Test: `packages/calendar/test/calendar.test.ts`, `apps/server/test/bars.test.ts`

**Interfaces:**
- Produces: `export function addDays(d: ISODate, n: number): ISODate` from `@st/calendar` (the existing body, now exported).
- Produces (module-local in `bars.ts`): `function splitByYear(from: ISODate, to: ISODate): Range[]`. It splits `[from, to]` at calendar-year boundaries, ascending, each piece inclusive.

- [ ] **Step 1: Write the failing tests**

`calendar.test.ts`:
```ts
test('addDays crosses month, leap-day and year boundaries', () => {
  expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
});
```

`bars.test.ts` (inside the existing `describe`, default `today = '2026-06-01'`):
```ts
test('a multi-year gap goes upstream one calendar year at a time', async () => {
  await read('AAPL', '2024-06-03', '2026-03-31')
  expect(up.state.ranges).toEqual([['2024-06-03', '2024-12-31'], ['2025-01-02', '2025-12-31'], ['2026-01-02', '2026-03-31']])
  expect(await f.repos.barCoverageRepo.list('AAPL')).toEqual([{ fromDate: '2024-06-03', toDate: '2026-03-31' }])
})

test('a failing year keeps the years before it, and the retry asks only for the rest', async () => {
  up.state.failFrom = '2025-01-01'
  await expect(read('AAPL', '2024-06-03', '2026-03-31')).rejects.toMatchObject({ kind: 'http' })
  expect(await f.repos.barCoverageRepo.list('AAPL')).toEqual([{ fromDate: '2024-06-03', toDate: '2024-12-31' }])
  up.state.failFrom = null
  up.state.reset()
  await read('AAPL', '2024-06-03', '2026-03-31')
  expect(up.state.ranges).toEqual([['2025-01-02', '2025-12-31'], ['2026-01-02', '2026-03-31']])
})

test('a gap covered as empty after no-data is logged with the ticker and the range', async () => {
  today = '2026-01-09'
  up.state.missing = new Set(['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'])
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await read('AAPL', '2026-01-05', '2026-01-09')
    expect(warn).toHaveBeenCalledTimes(1)
    const text = String(warn.mock.calls[0]!.join(' '))
    expect(text).toContain('AAPL')
    expect(text).toContain('2026-01-05..2026-01-08')
    expect(text).toContain('bar_coverage')
  } finally { warn.mockRestore() }
})
```

Also extend `a range with no data anywhere propagates…`: wrap it in a `console.warn` spy and assert `toHaveBeenCalledTimes(0)`, because nothing gets covered on that path. Import `spyOn` from `bun:test`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/calendar/test/calendar.test.ts apps/server/test/bars.test.ts`
Expected: FAIL. `addDays` is not exported, the ranges show one unchunked call, and `warn` is called 0 times.

- [ ] **Step 3: Implement**

- Export `addDays` from `packages/calendar/src/index.ts`. Import it in `bars.ts` and delete the local copy.
- In the gap loop, iterate `uncovered(from, horizon, covered).flatMap(([a, b]) => splitByYear(a, b))`. Each chunk goes through the existing first-open/last-open → upstream → upsert → `add`/no-data path unchanged. A no-data answer now covers at most one year.
- In the final `emptyGaps` loop, after each `add`, call `console.warn` with exactly: `` `[bars] ${ticker} ${gFrom}..${gTo}: provider returned no data; recorded as covered. If bars exist there, delete this ticker's bar_coverage rows to refetch.` ``
- Update the comment block at `:78-81` to mention the per-year chunk and the warning.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/calendar apps/server/test/bars.test.ts apps/server/test/http-sim-drafts.test.ts apps/server/test/http-price-history.test.ts`
Expected: all pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/calendar apps/server/src/market/bars.ts apps/server/test/bars.test.ts
git commit -m "fix: chunk uncovered bar gaps by year and warn when an empty gap is covered"
```

---

### Task 2: Lock the `bar_coverage` merge (#44)

Source: #44.

**Files:**
- Modify: `apps/server/src/db/repos-bars.ts:69-94`
- Create: `apps/server/test/db-bar-coverage-lock.test.ts` (DB-gated, same `beforeAll` as `bars-db.test.ts`)

**Interfaces:**
- Produces: the `barCoverageRepo.add(ticker, fromDate, toDate): Promise<void>` signature is unchanged.
- Produces: `export function isDeadlock(e: unknown): boolean` in `repos-bars.ts`. It returns true when `e` or `e.cause` has `errno === 1213` or `code === 'ER_LOCK_DEADLOCK'`. Drizzle 0.44 wraps driver errors in `DrizzleQueryError`, with the mysql2 error on `.cause`.

Decision: use `SELECT … FOR UPDATE` as #44 asks, plus a bounded retry. On a ticker with no rows, InnoDB takes only gap locks. Gap locks are compatible with each other, so two first writers both pass the read and one dies on insert with a deadlock (errno 1213). `add` retries the whole transaction up to 5 attempts in total, and only on deadlock. InnoDB commits at least one of the competing writers each round, so 5 attempts cover the tests' 4 concurrent writers with margin.

- [ ] **Step 1: Write the failing tests**

```ts
test('concurrent adds on a fresh ticker leave one merged row', async () => {
  const ticker = 'LK' + Date.now()
  const days = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08']
  const results = await Promise.allSettled(days.map((d) => repos.barCoverageRepo.add(ticker, '2026-01-05', d)))
  expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
  expect(await repos.barCoverageRepo.list(ticker)).toEqual([{ fromDate: '2026-01-05', toDate: '2026-01-08' }])
})

test('concurrent adds touching a stored range all merge into it', async () => {
  const ticker = 'LM' + Date.now()
  await repos.barCoverageRepo.add(ticker, '2026-02-01', '2026-02-10')
  const results = await Promise.allSettled(Array.from({ length: 4 }, (_, i) =>
    repos.barCoverageRepo.add(ticker, `2026-02-${String(11 + i).padStart(2, '0')}`, `2026-02-${String(11 + i).padStart(2, '0')}`)))
  expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
  expect(await repos.barCoverageRepo.list(ticker)).toEqual([{ fromDate: '2026-02-01', toDate: '2026-02-14' }])
})

test('isDeadlock recognises the driver error directly and wrapped in cause', () => {
  expect(isDeadlock({ errno: 1213 })).toBe(true)
  expect(isDeadlock({ cause: { code: 'ER_LOCK_DEADLOCK' } })).toBe(true)
  expect(isDeadlock(new Error('x'))).toBe(false)
})
```

Put `isDeadlock` in its own top-level `describe` (not DB-gated) in the same file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db-bar-coverage-lock.test.ts`
Expected: FAIL. `isDeadlock` is not exported, and `list` returns more than one row. The first two tests reproduce a race. If one passes by chance, rerun it once. It must still fail before the fix in at least one run.

- [ ] **Step 3: Implement**

- Change the transaction's read to `tx.select().from(s.barCoverage).where(eq(s.barCoverage.ticker, t)).for('update')`.
- Wrap the transaction in `for (let attempt = 1; ; attempt++) { try { await db.transaction(…); return } catch (e) { if (!isDeadlock(e) || attempt >= 5) throw e } }`.
- The merge-predicate comment at `:79-84` gains one sentence: the `FOR UPDATE` read is what makes "pairwise non-overlapping and non-adjacent" hold under concurrent writers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db-bar-coverage-lock.test.ts apps/server/test/db.test.ts apps/server/test/bars-db.test.ts`
Expected: all pass. This includes the three existing `barCoverage` tests in `db.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/repos-bars.ts apps/server/test/db-bar-coverage-lock.test.ts
git commit -m "fix: lock a ticker's bar_coverage rows before merging, retry on deadlock"
```

---

### Task 3: Sim repo — set-based `sweepDrafts`, `listRuns` ordered in SQL (#48)

Sources: #48 "`sweepDrafts` deletes N+1", "`GET /api/sim` sorts newest-first in the route", and the "Validation" bullet (stale spec line).

**Files:**
- Modify: `apps/server/src/db/repos-sim.ts:67-82`
- Modify: `apps/server/src/http/routes/sim.ts:76-79` (drop the in-route sort)
- Modify: `apps/server/test/http-fakes.ts:176-187` (fake `listRuns` returns a newest-first copy), `apps/server/test/http-fakes.test.ts:18,21` (expect `[4, 3, 1]` and `[4, 1]`)
- Create: `apps/server/test/db-sim-list.test.ts` (DB-gated)
- Modify: `docs/superpowers/specs/2026-11-16-cut-loss-and-sim-drafts-design.md:539`

**Interfaces:**
- Produces: `simRepo.sweepDrafts(createdBefore: Date): Promise<number>`. It now returns the `affectedRows` of the `sim_runs` delete, which is the number of runs actually removed.
- Produces: `simRepo.listRuns()` sorted by `desc(s.simRuns.id)`.

Decision on "summed affected rows": the count returned is runs deleted, not runs plus days. `main.ts` logs it as "N stale sim draft(s)", so mixing in day rows would mislabel it.

- [ ] **Step 1: Write the failing tests** (`db-sim-list.test.ts`)

Use the same `beforeAll` as `db-sim-rewrite.test.ts`, but keep `db` as well. `input()` is `{ ticker: 'SL' + Date.now(), ...config() }` and `day()` is that file's helper. Import `sql` from `drizzle-orm`.

```ts
test('listRuns is newest first', async () => {
  const a = await repos.simRepo.insertRun(input())
  const b = await repos.simRepo.insertRun(input())
  const ids = (await repos.simRepo.listRuns()).map((r: any) => r.id)
  expect(ids.indexOf(b)).toBeLessThan(ids.indexOf(a))
  expect(ids).toEqual([...ids].sort((x, y) => y - x))
})

test('sweepDrafts returns the number of runs it deleted, with their days gone', async () => {
  const x = await repos.simRepo.insertRun(input())
  const y = await repos.simRepo.insertRun(input())
  await repos.simRepo.insertDays([day(x, '2026-03-02'), day(y, '2026-03-02'), day(y, '2026-03-03')])
  await db.execute(sql.raw(`UPDATE sim_runs SET created_at = '2001-01-01 00:00:00' WHERE id IN (${x}, ${y})`))
  expect(await repos.simRepo.sweepDrafts(new Date('2002-01-01T00:00:00Z'))).toBe(2)
  expect(await repos.simRepo.getRun(x)).toBeNull()
  expect(await repos.simRepo.listDays(y)).toEqual([])
})
```

In `http-fakes.test.ts`, the two `listRuns` expectations become `[4, 3, 1]` and `[4, 1]`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db-sim-list.test.ts apps/server/test/http-fakes.test.ts`
Expected: FAIL. `listRuns` comes back ascending.

- [ ] **Step 3: Implement**

`sweepDrafts`, in one transaction:
1. Select the stale draft ids with `.for('update')`.
2. Return 0 when there are none.
3. Run `tx.delete(s.simDays).where(inArray(s.simDays.simRunId, ids))`.
4. Run `tx.delete(s.simRuns).where(and(inArray(s.simRuns.id, ids), eq(s.simRuns.draft, true)))`.
5. Keep the id log line.
6. Return `affected(res)` of the runs delete.

`listRuns`: add `.orderBy(desc(s.simRuns.id))`. The route returns `jsonBig(rows)` as is.

Spec line 539: replace "`replaceDays` swaps the day set atomically" with "`rewriteDraft` swaps config and day set atomically and refuses a non-draft".

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db-sim-list.test.ts apps/server/test/db.test.ts apps/server/test/http-fakes.test.ts apps/server/test/http-sim-drafts.test.ts`
Expected: all pass. This includes `GET /api/sim marks drafts and saved runs, newest first`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/repos-sim.ts apps/server/src/http/routes/sim.ts apps/server/test/http-fakes.ts apps/server/test/http-fakes.test.ts apps/server/test/db-sim-list.test.ts docs/superpowers/specs/2026-11-16-cut-loss-and-sim-drafts-design.md
git commit -m "refactor: set-based sim draft sweep, newest-first sim list in SQL"
```

---

### Task 4: Strict `parseId`; `PUT /api/sim/:id` without `name` (#48)

Sources: #48 "`parseId` uses `Number()`" and "`PUT /api/sim/:id` requires a `name` the server discards".

**Files:**
- Create: `apps/server/src/http/params.ts`
- Create: `apps/server/test/http-params.test.ts`
- Modify: `apps/server/src/http/routes/sim.ts:13-52` (validation split, import `parseId`), `:96-107` (PUT)
- Modify: `apps/server/src/sim/sim.ts:268-277` (`updateSimRun` input type)
- Modify: `apps/server/test/http-sim-drafts.test.ts:106-129` (drop the `name: ' '` row), plus new tests
- Modify: `apps/web/src/api.sim.ts:5-18`, `apps/web/src/api.ts:280-287`, `apps/web/src/api.test.ts:91-99`

**Interfaces:**
- Produces: `export function parseId(raw: string): number | null` in `http/params.ts`. It accepts only `/^[1-9]\d*$/` and `Number.isSafeInteger`, and returns null otherwise. Task 6 consumes it.
- Produces: `updateSimRun(id: number, input: Omit<SimInput, 'ticker' | 'name'>, deps)`. The in-memory run is labelled `` `Sim #${id}` `` inside `updateSimRun`.
- Produces (web): `simConfigBody(input: SimUpdateInput): Record<string, unknown>` with no `name`. `runSim` adds `name: input.name.trim()` itself. `updateSimRun` sends no `name`.

- [ ] **Step 1: Write the failing tests**

`http-params.test.ts`:
```ts
test.each([['1', 1], ['42', 42], ['9007199254740991', 9007199254740991]])('parseId(%p) = %p', (raw, id) => expect(parseId(raw)).toBe(id))
test.each(['0', '01', '0x1', '1e0', '1e2', '+1', '-1', '1.0', ' 1', '1 ', '', 'abc', '9007199254740993'])('parseId(%p) is null', (raw) => expect(parseId(raw)).toBeNull())
```

`http-sim-drafts.test.ts`:
```ts
test('non-canonical ids never reach a sim', async () => {
  const { call, create } = await setup()
  const { id } = await create()
  expect(id).toBe(1)
  for (const raw of ['0x1', '1e0', '+1', '01']) expect((await call('GET', `/${raw}`)).status).toBe(404)
})

test('PUT needs no name and ignores one that is sent', async () => {
  const { call, create, edit } = await setup()
  const { id } = await create()
  const { name: _n, ...noName } = edit
  expect((await call('PUT', `/${id}`, noName)).status).toBe(200)
  expect((await call('PUT', `/${id}`, { ...noName, name: 42 })).status).toBe(200)
})
```

`apps/web/src/api.test.ts`: in `updateSimRun PUTs the config…`, add `expect('name' in body).toBe(false)`. Add a `runSim` assertion that `name` is `'S'` (trimmed).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/server/test/http-params.test.ts apps/server/test/http-sim-drafts.test.ts apps/web/src/api.test.ts`
Expected: FAIL. `params.ts` is missing, `/0x1` resolves to 200, the nameless PUT returns 400 `invalid name`, and the web body has `name`.

- [ ] **Step 3: Implement**

- Create `params.ts`. Delete the local `parseId` from `sim.ts` and import the shared one.
- Split `validateConfig` so it no longer reads `name`. `validateCreate` checks `name` (`'invalid name'`, as now) and adds it to `input`.
- PUT passes the name-less config to `updateSimRun`.
- Web: change `simConfigBody` and its two callers as stated under Interfaces. Remove the "stable placeholder" comment at `api.ts:284-285`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/server/test/http-params.test.ts apps/server/test/http-sim-drafts.test.ts apps/server/test/http-sim.test.ts apps/server/test/sim.test.ts apps/web/src/api.test.ts apps/web/src/components/forms/SimConfigPanel.test.tsx && bun run typecheck`
Expected: all pass, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/http/params.ts apps/server/src/http/routes/sim.ts apps/server/src/sim/sim.ts apps/server/test/http-params.test.ts apps/server/test/http-sim-drafts.test.ts apps/web/src
git commit -m "fix: strict decimal ids on sim routes; PUT /api/sim/:id no longer needs a name"
```

---

### Task 5: Price-history route stops writing closes; sibling-cancel note in `recompute.ts` (#48)

Sources: #48 "the price-history route still issues a close-only `upsertMany`" and "`deleteFill`/`rebookFill` do not undo sibling cancels".

**Files:**
- Modify: `apps/server/src/http/routes/runs.ts:146-208`. Drop the `upsertMany` call at `:167` and the `b.tradeDate ??` shim at `:204`, and update the comments at `:146-149` and `:183-186`.
- Modify: `apps/server/test/http-price-history.test.ts:28-54`
- Modify: `apps/server/src/domain/recompute.ts` (comments on `rebookFill` and `deleteFill`)

**Interfaces:**
- Consumes: `makeCachedBarReader` (unchanged). `HttpDeps.fetchDailyBars` keeps its type.

- [ ] **Step 1: Rewrite the pinning test so it fails against the current route**

Rename `?start backfills once from Yahoo…` to `?start backfills once through the cached reader, which alone persists the bars`. Steps:
- Set `deps.fetchDailyBars = makeCachedBarReader({ upstream, repos: f.repos as any, today: deps.today })` over a date-keyed OHLC upstream, as in the fourth test.
- Count calls with `const upsertMany = f.repos.priceHistoryRepo.upsertMany; let closeWrites = 0; f.repos.priceHistoryRepo.upsertMany = async (rows: any) => { closeWrites += 1; return upsertMany(rows) }`.
- Keep the existing assertions (one upstream call `['2026-11-02','2026-11-09']`, 6 bars, `f.priceHistory.length === 6`, no refetch).
- Add `expect(closeWrites).toBe(0)` and `expect(f.priceHistory.every((r) => r.open !== undefined)).toBe(true)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/server/test/http-price-history.test.ts`
Expected: FAIL on `closeWrites`, which is 1.

- [ ] **Step 3: Implement**

- Remove the `upsertMany` call. The merge into `rows` stays.
- Read `b.date` only.
- In `recompute.ts`, add one comment shared by `rebookFill` and `deleteFill`: "Rebuilding state does not reopen orders: a sell fill's sibling-cancelled leg stays cancelled after that sell is edited away or deleted, so a re-held bucket has no live protection until the next morning's re-plan places its legs again."

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/server/test/http-price-history.test.ts apps/server/test/rebooking.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/http/routes/runs.ts apps/server/src/domain/recompute.ts apps/server/test/http-price-history.test.ts
git commit -m "refactor: price-history relies on the cached reader's OHLC write; note sibling cancels survive fill edits"
```

---

### Task 6: Screenshot janitor and transactional review-tab delete (followups)

Sources: followups §"Behaviour an operator could notice": "A swallowed archive failure can strand bytes forever" and "`DELETE /api/vision-reviews/:captureId` is not transactional".

**Files:**
- Modify: `apps/server/src/db/repos-vision.ts` (add `discard`, `sweepOrphans` to `captureImageRepo`)
- Modify: `apps/server/src/domain/booking.ts:53-60` (`RepoSurface.captureImageRepo` gains `discard`; nothing else in that file)
- Modify: `apps/server/src/http/routes/vision-review.ts:46-67` (use `parseId` for both `:captureId` and `:id`, and `discard`)
- Create: `apps/server/src/wire/boot-sweeps.ts`; modify `apps/server/src/main.ts:22-30` to call it
- Modify: `apps/server/test/http-fakes.ts:92-125` (fake `discard`)
- Create: `apps/server/test/db-vision-janitor.test.ts` (DB-gated; copy `newCapture`/`review` helpers from `db.test.ts:691-702`)
- Create: `apps/server/test/boot-sweeps.test.ts`
- Modify: `apps/server/test/http-vision-review.test.ts`

**Interfaces:**
- Consumes: `parseId` (Task 4).
- Produces: `captureImageRepo.discard(captureId: number): Promise<void>`. One transaction deletes the capture's `vision_reviews` rows and its `capture_images` row.
- Produces: `captureImageRepo.sweepOrphans(): Promise<number[]>`. In one transaction it deletes two sets and returns the touched capture ids, ascending and distinct:
  - (a) Every `capture_images` row with `keep = false` and no `pending_fills` row of that `capture_id` with `status = 'pending'`, together with that capture's `vision_reviews` rows.
  - (b) Every `vision_reviews` row whose capture has neither a `capture_images` row nor a live pending row.
- Produces: `runBootSweeps(repos: { simRepo: { sweepDrafts(before: Date): Promise<number> }; captureImageRepo: { sweepOrphans(): Promise<number[]> } }, now: Date): Promise<void>`. It owns `SIM_DRAFT_MAX_AGE_DAYS = 7`. Each sweep sits in its own try/catch that logs via `console.error` and never throws. It logs `[main] swept N stale sim draft(s) older than 7 days` (as now) and, when non-empty, `` `[main] swept orphaned screenshots/review rows for capture ids: ${ids.join(', ')}` ``.

Decisions:
- (c) The DELETE becomes transactional through `discard`, not a reorder. Either order leaves an orphan the other side cannot see.
- (a) The janitor runs **at boot only**, inside `runBootSweeps` before the bot and HTTP server start, so no confirm can be mid-flight. A cron pass (for example 07:30 ET) could delete an image between a confirm's `decide` and its `setKeep`.
- `resolveReview`'s own sweep stays on the two `deleteFor` calls. A failure there is caught upstream, and the janitor collects what it leaves.

- [ ] **Step 1: Write the failing tests**

`db-vision-janitor.test.ts`. Each case seeds its own capture(s) and asserts by id: `toContain` / `not.toContain` on the returned ids, then reads back.
- `sweepOrphans deletes an unkept image with no live pending row, and its frozen rows`. Seed an image, a `confirmed` pending row and a review row. Expect the id returned, `getBytes` null, `listForCaptures([id])` empty.
- `sweepOrphans keeps an unkept image while a pending row is live`. Expect the id not returned and the bytes present.
- `sweepOrphans keeps a kept image with no live pending row, and its frozen rows`.
- `sweepOrphans deletes frozen rows left without an image and without a live pending row, but not those with a live sibling`.
- `discard removes one capture's image and frozen rows and leaves another capture alone`.

`boot-sweeps.test.ts`:
```ts
test('both sweeps run; the draft cutoff is exactly seven days before now', async () => { /* records sweepDrafts' arg: toEqual(new Date(now.getTime() - 7 * 86_400_000)); sweepOrphans called once */ })
test('a failing draft sweep still runs the screenshot sweep, and neither throws', async () => { /* sweepDrafts rejects; console.error spied (1 call); sweepOrphans called; resolves */ })
test('a failing screenshot sweep is logged, not thrown', async () => { /* sweepOrphans rejects; console.error called once; resolves */ })
test('swept capture ids are logged', async () => { /* sweepOrphans -> [3, 9]; console.log text contains '3, 9' */ })
```

`http-vision-review.test.ts`:
```ts
test('DELETE /api/vision-reviews/:captureId goes through one discard call', async () => {
  const { f, app, auth, keep } = await setup()
  await keep(1, '2026-11-10 09:00:00')
  await f.repos.visionReviewRepo.insertIgnore(review(1, 10) as any)
  f.repos.captureImageRepo.deleteFor = async () => { throw new Error('two-step delete used') }
  f.repos.visionReviewRepo.deleteFor = async () => { throw new Error('two-step delete used') }
  const res = await app.request('/api/vision-reviews/1', { method: 'DELETE', headers: auth })
  expect(res.status).toBe(200)
  expect(f.captureImages).toHaveLength(0)
  expect(f.visionReviews).toHaveLength(0)
})
test('DELETE and image GET reject non-canonical capture ids', async () => { /* keep(1,…); DELETE /0x1 -> 404 and capture 1 still kept; GET /api/captures/1e0/image -> 404 */ })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db-vision-janitor.test.ts apps/server/test/boot-sweeps.test.ts apps/server/test/http-vision-review.test.ts`
Expected: FAIL. `sweepOrphans`, `discard` and `boot-sweeps.ts` are missing, and the two-step delete throws.

- [ ] **Step 3: Implement**

- Repo methods per Interfaces. Use drizzle `notExists`/`exists` subqueries on `s.pendingFills` (`captureId`, `status = 'pending'`) and on `s.captureImages`. Select candidate ids with `.for('update')`, then run `inArray` deletes.
- Add `discard` to the `http-fakes.ts` fake. It removes from both `captureImages` and `visionReviews`.
- Replace the inline sweep block in `main.ts` with `await runBootSweeps(repos, new Date())`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db-vision-janitor.test.ts apps/server/test/boot-sweeps.test.ts apps/server/test/http-vision-review.test.ts apps/server/test/db.test.ts && bun run typecheck`
Expected: all pass, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/repos-vision.ts apps/server/src/domain/booking.ts apps/server/src/http/routes/vision-review.ts apps/server/src/wire/boot-sweeps.ts apps/server/src/main.ts apps/server/test
git commit -m "fix: boot-time janitor for stranded screenshots; review-tab delete in one transaction"
```

---

### Task 7: Pending routes — `archived` flag, validation order, parallel run lookup (followups)

Sources: followups §"A swallowed archive failure…" (`{ ok: true, archived: false }`), §"`GET /api/pending` does a small N+1", and §"Code hygiene" "Validation order".

**Files:**
- Modify: `apps/server/src/domain/confirm-pending.ts`. Move the side/fee validation below the `known` peek, and change the return types.
- Modify: `apps/server/src/http/routes/pending.ts:16-52`
- Modify: `apps/server/test/vision-review.test.ts` (the four `rejectPendingFill` assertions at `:329-349`; add return-value assertions to `:310` and `:337`)
- Create: `apps/server/test/http-pending-routes.test.ts`. `http-pending-settings.test.ts` is already at 317 lines; copy its `setup()` from `:167-176`.
- Modify: `scripts/e2e-vision-review.ts:50-52` (assert `archived === true` on `confirmA`)

**Interfaces:**
- Consumes (wave A): `confirmPendingFill(pendingId, overrides, deps: FillBookingDeps, opts?)`. Its locked callback returns `BookedOutcome`, which then goes to `notifyBookingOutcome`.
- Produces: `confirmPendingFill(...): Promise<{ archived: boolean }>`. The locked callback returns `{ outcome: BookedOutcome; archived: boolean }`. `archived` is false iff `resolveReview` threw. `notifyBookingOutcome(known.runId, outcome, deps)` is still called after the lock, as wave A left it.
- Produces: `rejectPendingFill(...): Promise<{ archived: boolean } | null>`. `null` replaces the old `false` (missing or already handled). `wire/capture.ts`'s `if (!rejected)` keeps working unchanged.
- Produces (HTTP): confirm and reject answer `200 { ok: true, archived: boolean }`. Error responses are unchanged.

- [ ] **Step 1: Write the failing tests**

`vision-review.test.ts`:
- `await confirmPendingFill(...)` in the happy-path keep test returns `{ archived: true }`.
- The archive-failure confirm test returns `{ archived: false }`.
- `rejectPendingFill(999, deps)` is `toBeNull()`. The first reject is `toEqual({ archived: true })` and the repeat is `toBeNull()`.
- The archive-failure reject returns `{ archived: false }`.
- New test: `a malformed override on an already handled row answers not-pending first`. `confirmPendingFill(handledId, { side: 'hold' as any }, deps)` rejects with message `'pending-not-found-or-not-pending'`. The same holds for `{ feeCents: -1 }`.

`http-pending-routes.test.ts`:
```ts
test('confirm and reject answer archived true normally', /* POST confirm {keepImage:true} on a captured row -> 200 {ok:true, archived:true}; same for reject */)
test('confirm and reject answer archived false when the archive write failed', /* f.repos.visionReviewRepo.insertIgnore throws; console.error spied; -> 200 {ok:true, archived:false}; fill booked / row rejected */)
test('a malformed override on an already handled row is 409 not-pending, not 422', /* reject row; POST confirm {overrides:{side:'hold'}} -> 409 {error:'not-pending'}; {overrides:{feeCents:-1}} -> 409 */)
test('GET /api/pending looks each distinct run up once, concurrently', async () => {
  // two runs, three pending rows (2 + 1); wrap f.repos.runRepo.get:
  // inFlight++, maxInFlight = max(...), await Promise.resolve() twice, inFlight--, record id
  // expect(calls.sort()).toEqual([runA, runB].sort()); expect(maxInFlight).toBe(2); costPpm per row still correct
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/server/test/vision-review.test.ts apps/server/test/http-pending-routes.test.ts`
Expected: FAIL. The functions return `undefined`/`true`, the override answers 422 `invalid-side`, and `maxInFlight` is 1.

- [ ] **Step 3: Implement**

- Signatures as under Interfaces.
- The routes return `c.json({ ok: true, archived })`. The reject route maps `null` to the existing 409.
- In `GET /pending`, build `costPpm` with `await Promise.all([...new Set(runIds)].map(async (runId) => [runId, (await runRepo.get(runId))?.costPpm ?? default] as const))`.
- In `scripts/e2e-vision-review.ts`, after `confirmA`: `c.ok((await jsonOf(confirmA)).archived === true, 'confirm with keepImage reports archived')`. Read the body once; reuse it if the script already reads it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/server/test/vision-review.test.ts apps/server/test/http-pending-routes.test.ts apps/server/test/http-pending-settings.test.ts apps/server/test/wire.test.ts && bun run typecheck`
Expected: all pass, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/domain/confirm-pending.ts apps/server/src/http/routes/pending.ts apps/server/test scripts/e2e-vision-review.ts
git commit -m "fix: report archived on confirm/reject, answer not-pending before override validation, parallel run lookup"
```

---

### Task 8: Web keep prompt says when the screenshot was not kept (followups)

Source: followups §"A swallowed archive failure…" ("so the UI can say the keep did not stick").

**Files:**
- Modify: `apps/web/src/api.ts:162-164` (interface), `:256-262` (impl)
- Modify: `apps/web/src/components/forms/PendingTable.tsx:95-106`
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json` (new key `keepImageNotKept` between `keepImageKeep` and `keepImageRejectBody`)
- Test: `apps/web/src/api.test.ts`, `apps/web/src/components/forms/PendingTable.test.tsx` (the `keep or discard the screenshot` describe)

**Interfaces:**
- Consumes: `200 { ok: true, archived: boolean }` (Task 7).
- Produces: `confirmPending(id, overrides?, keepImage?): Promise<{ archived: boolean }>` and `rejectPending(id, keepImage?): Promise<{ archived: boolean }>`. Both map with `archived: r.archived !== false`, so a body without the field counts as archived.

Copy:
- en: `"keepImageNotKept": "Done, but the screenshot could not be kept for review."`
- ko: `"keepImageNotKept": "처리되었지만 스크린샷을 검토용으로 보관하지 못했습니다."`

- [ ] **Step 1: Write the failing tests**

- `api.test.ts`: `confirmPending resolves archived from the body, defaulting to true`. A recorder returning `{ ok: true, archived: false }` gives `{ archived: false }`, and `{ ok: true }` gives `{ archived: true }`. Add the same test for `rejectPending`.
- `PendingTable.test.tsx`. Use a variant of `renderWithConfirmCalls` whose POST JSON is a parameter.
  - `a keep that did not stick says so`: POST returns `{ ok: true, archived: false }`. Edit qty, Confirm, then `Keep for review`. `container.textContent` contains `'the screenshot could not be kept for review'`.
  - `a keep that stuck shows no note`: `archived: true`, and the text is absent.
  - `Discard never shows the note`: `archived: false` with Discard, and the text is absent.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/web/src/api.test.ts apps/web/src/components/forms/PendingTable.test.tsx`
Expected: FAIL. The API resolves `undefined` and no note is shown.

- [ ] **Step 3: Implement**

- In `submit`, keep the result. After `await reload()`, run `if (keepImage === true && !res.archived) setActionError(t('keepImageNotKept'))`.
- Add the en/ko keys.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/web && bun run typecheck`
Expected: all pass, including the catalog parity/order test, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat: tell the operator when a kept screenshot could not be archived"
```

---

### Task 9: Pin `fee_overridden` = "any fee override, a cleared fee included" (followups, parked ruling)

Source: followups §"`fee_overridden` means 'an override was present'…". Operator ruling 2026-11-20: highlight every fee override, including a cleared fee, so the current semantics stay. This task pins them and makes the comments say so on purpose. Wave D Task 10 adds the web side of the same ruling: hints on edited and erased fields, and a default-fee popup on confirm.

**Files:**
- Modify: `apps/server/src/domain/vision-review.ts:40-42` (field comment), `:78-79` (param doc). No logic change.
- Test: `apps/server/test/vision-review.test.ts:242-268`

**Interfaces:**
- Unchanged: `feeOverridden = feeOverride !== undefined`. A `feeCents: null` override (the operator cleared the fee, so the server books the default) sets it.

- [ ] **Step 1: Pin the semantics**
  - Keep `fee_overridden is true whenever the confirm carried a feeCents, null included` as it is.
  - Add `a confirm with no fee override records fee_overridden false`: overrides `{ shares: 11 }` give `toMatchObject({ edited: true, feeOverridden: false })`.
  - In `a fee-bearing capture confirmed with feeCents null is edited when the recomputed fee differs`, add `expect(row.feeOverridden).toBe(true)`.
- [ ] **Step 2: Run `bun test apps/server/test/vision-review.test.ts`.** Expected: PASS. These pin current behaviour; if one fails, stop and report.
- [ ] **Step 3: Rewrite both comments** to: "true whenever the confirm carried a fee override, `null` (cleared: the server books the default fee) included; the review tab highlights the fee for either (operator ruling 2026-11-20)."
- [ ] **Step 4: Run `bun test apps/server/test/vision-review.test.ts apps/web/src/pages/VisionReview.test.tsx`.** Expected: all pass.
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/domain/vision-review.ts apps/server/test/vision-review.test.ts
git commit -m "test: pin fee_overridden for every fee override, a cleared fee included"
```

---

### Task 10: Telegram prompt flags a substituted trade date (followups, parked ruling)

Source: followups §"The missed-date block is client-only" ("surface the substituted date in the Telegram confirm message rather than to block").

**Files:**
- Modify: `apps/server/src/domain/booking.ts:80` (`PendingFillRow` gains `detectedFilledOn: ISODate | null`), `:213-218` (set it to `f.date ?? null`)
- Modify: `apps/server/src/wire/capture.ts` `sendOutcome` (`:146-155`)
- Modify: `packages/telegram/src/i18n.ts` (new key after `capture-booked-earlier`)
- Test: `apps/server/test/wire.test.ts`

**Interfaces:**
- Produces: `PendingFillRow.detectedFilledOn: ISODate | null`. It is null exactly when vision gave no usable date. That covers a missing date and a date the extractor dropped as more than 45 days away.
- Produces: catalog key `capture-date-substituted` with param `{date}`:
  - en: `⚠️ The screenshot showed no trade date, so the capture date {date} was used. If the trade was on another day, fix the date in the web app's Pending view instead of confirming here.`
  - ko: `⚠️ 스크린샷에 거래일이 보이지 않아 캡처한 날짜 {date}을(를) 사용했습니다. 거래일이 다르면 여기서 확인하지 말고 웹 앱의 '확인 대기'에서 날짜를 수정하세요.`
- The prompt text becomes `t('capture-booked', …)`, plus `'\n' + t('capture-date-substituted', lang, { date: row.filledOn })` when `row.detectedFilledOn === null`. The keyboard is unchanged.

- [ ] **Step 1: Write the failing tests and fix the fixtures**

- Give the date-less vision fixtures that feed exact prompt assertions a date equal to their test's today. These are `visionFetch` (`:230`), `multiVisionFetch` and any other fixture behind a `'… — confirm?'` assertion (`:289, :404, :440, :461, :614, :628, :661, :680-681, :692`). Add `date: '2026-11-10'` so the existing exact-text assertions stay as written. If a test with a different `today` asserts prompt text, give it its own fixture dated to that `today` rather than changing the expected string.
- Add a `describe('capture prompt — trade date vision could not read')` with:
  - `a fill with no date carries the substitution notice`. The fixture has no date and today is `2026-11-10`. Expect `sent[0].text` toBe `'Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 — confirm?\n⚠️ The screenshot showed no trade date, so the capture date 2026-11-10 was used. If the trade was on another day, fix the date in the web app\'s Pending view instead of confirming here.'` and the keyboard unchanged.
  - `a date the extractor dropped as too far from today gets the same notice`. The fixture date is `'2026-01-02'` and today is `2026-11-10`. The text contains `'capture date 2026-11-10 was used'`.
  - `the notice is rendered in ko`. With `lang: 'ko'`, the text contains `'캡처한 날짜 2026-11-10'`.
  - `a readable date carries no notice`. The text has no `'\n'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/server/test/wire.test.ts`
Expected: the four new tests FAIL (no notice line). All the pre-existing tests pass with the dated fixtures.

- [ ] **Step 3: Implement** per Interfaces. Keep `capture.ts` at or under ~300 lines.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/server/test/wire.test.ts apps/server/test/booking.test.ts apps/server/test/vision-review.test.ts packages/telegram && bun run typecheck`
Expected: all pass, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/domain/booking.ts apps/server/src/wire/capture.ts packages/telegram/src/i18n.ts apps/server/test/wire.test.ts
git commit -m "feat: Telegram capture prompt says when the capture date stands in for an unread trade date"
```

---

### Task 11: Repo map, full verification, PR

**Files:**
- Modify: `AGENTS.md` repo map. Add `http/params.ts` and `wire/boot-sweeps.ts`. Add the new tests to the `test/` line: `db-bar-coverage-lock`, `db-sim-list`, `db-vision-janitor`, `boot-sweeps`, `http-params`, `http-pending-routes`.

- [ ] **Step 1: Update `AGENTS.md`** as above.
- [ ] **Step 2: Full unit suite.** Run `bun test`. Expected: 0 fail. DB suites skip.
- [ ] **Step 3: DB suite.** Run `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test`. Expected: 0 fail. (Start the DB per AGENTS.md "Test DB" if it is not running.)
- [ ] **Step 4: Typecheck.** Run `bun run typecheck`. Expected: exit 0, no output errors.
- [ ] **Step 5: E2E smoke.** Run `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`. Expected: every check `ok`, final success line, exit 0, scratch DB dropped.
- [ ] **Step 6: Commit** `git commit -m "docs: repo map for boot sweeps, params and new tests"`.
- [ ] **Step 7: Open the PR** from `fix/server-hardening`. Body:
  - `Closes #44, closes #47.`
  - "#48 (partial), handled here:"
    - the stale `replaceDays` spec line
    - `sweepDrafts` N+1 and snapshot count
    - `GET /api/sim` ORDER BY
    - `parseId`
    - the duplicate `addDays`
    - unchunked large gaps
    - the price-history `upsertMany`
    - `deleteFill`/`rebookFill` sibling-cancel note
    - `PUT /api/sim/:id` `name`
  - "Remaining #48 bullets belong to waves A/C/D."
  - A "Vision review follow-ups" section listing the janitor, `archived`, transactional delete, `Promise.all`, validation order, the Telegram date notice and `fee_overridden`. Cite `docs/superpowers/followups/2026-11-17-pending-vision-review-followups.md`.
