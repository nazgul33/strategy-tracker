# Manual-fill ticker: server-authoritative — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every stored fill carries `run.ticker`, by construction — no caller (web form, HTTP body, pending row) can choose a fill's ticker.

**Architecture:** `runBooking` in `apps/server/src/domain/booking.ts` is the single booking chokepoint and already loads the run; the fill insert stamps `run.ticker` and `BookInput` loses its `ticker` field. `confirmPendingFill` gains a `pending.ticker !== run.ticker` guard (`ticker-mismatch` → HTTP 409). The web drops the ticker input from the manual-fill form entirely.

**Tech Stack:** Bun + TypeScript monorepo, Hono routes, React (web), bun:test, happy-dom for web component tests.

**Spec:** `docs/superpowers/specs/2026-11-12-manual-fill-ticker-design.md`

## Global Constraints

- TDD: write the failing test first, see it fail, then implement.
- Commit style: `feat|fix|docs|chore:` prefix.
- All user-facing copy through `apps/web/src/i18n/en.json` + `ko.json`; deleting a key deletes it from **both** files in the same commit.
- Money values stay bigint myriadths; never introduce floats (unchanged here).
- All commands run from the repo root. Unit suites need no DB: plain `bun test`. The DB integration suite (`apps/server/test/db.test.ts`) self-skips without `TEST_DATABASE_URL`.
- Work happens on branch `feat/manual-fill-ticker` (already checked out, based on `main`).
- After each verified task step group, `git push -q backup feat/manual-fill-ticker` (this worktree has lost uncommitted work before).

## Review Focus

These are the failure modes the design exists for; each gets its pin in the owning task:

1. A stale web bundle (or any client) POSTs `/runs/:id/fills` still carrying a `ticker` — expect 200, booked with the **run's** ticker, the body's ticker silently ignored (Task 1).
2. A caller hands `manualFill` an object with a stray `ticker` property — expect no error, fill stamped with the run's ticker (Task 1).
3. A pending row whose `ticker` differs from its run's reaches confirm — expect 409 `ticker-mismatch` and **zero side effects**: no fill row, bucket state byte-identical, pending row still `status: 'pending'` (Task 2).
4. The web form's POST body must contain no `ticker` key at all (not `ticker: undefined` — absent) and must no longer render the ticker input (Task 3).
5. Seed-path fills already stamp `run.ticker` (verified in `seedRun`); this change must not regress that (covered by existing `(g)`/seed tests in Task 1's full-suite run).

---

### Task 1: Booking chokepoint — `runBooking` stamps `run.ticker`; `manualFill` loses ticker

**Files:**
- Modify: `apps/server/src/domain/booking.ts` (`BookInput` ~line 34-43, fill insert ~line 105, `confirmPendingFill` BookInput literal ~line 158, `manualFill` ~line 171)
- Modify: `apps/server/src/http/routes/runs.ts` (body cast ~line 159)
- Test: `apps/server/test/booking.test.ts`, `apps/server/test/http.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `manualFill(runId: number, fill: Omit<RawFill, 'ticker'> & { filledOn: ISODate }, deps: BookingDeps): Promise<void>`; `BookInput` with **no** `ticker` field; every `fillRepo.insert` from `runBooking` carries `ticker: run.ticker`.

- [ ] **Step 1: Update `(h) manualFill` and add the stray-ticker test in `apps/server/test/booking.test.ts`**

In `(h) manualFill` (~line 284), change the call to drop `ticker` and assert the stamp:

```ts
    await manualFill(runId, { side: 'buy', shares: 3, price: '5.00', filledOn: '2026-11-06' }, deps)
    expect(f._stores.fills[0].source).toBe('manual')
    expect(f._stores.fills[0].ticker).toBe('AAPL')
```

Add a new test next to it (a variable, not a literal, so TS allows the excess property):

```ts
  test('manualFill ignores a stray ticker and stamps the run ticker', async () => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r8b', poolCents: 1000, costPpm: 100, initialRunState: emptyState(2) })
    const legacy = { side: 'buy' as const, ticker: 'ZZZ', shares: 3, price: '5.00', filledOn: '2026-11-06' }
    await manualFill(runId, legacy, deps)
    expect(f._stores.fills[0].ticker).toBe('AAPL')
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/server/test/booking.test.ts 2>&1 | tail -20`
Expected: FAIL — the `(h)` call is a TS/arity mismatch or ticker assert mismatch, and the stray test shows `fills[0].ticker === 'ZZZ'`.

- [ ] **Step 3: Implement in `booking.ts`**

- `BookInput`: delete the `ticker: string` line.
- Fill insert in `runBooking` (~line 105): `ticker: input.ticker` → `ticker: run.ticker` (`run` is already loaded at the top).
- `confirmPendingFill`: delete only the `ticker: pending.ticker` line from its `runBooking({...})` literal (the guard comes in Task 2).
- `manualFill`: signature becomes `fill: Omit<RawFill, 'ticker'> & { filledOn: ISODate }`; delete the `ticker: fill.ticker` line from its `runBooking({...})` literal.

- [ ] **Step 4: Update the route cast in `apps/server/src/http/routes/runs.ts`**

~line 159: `const fill = body as Omit<RawFill, 'ticker'> & { filledOn: string }`. The `RawFill` import stays (still used by the `Omit`).

- [ ] **Step 5: Run booking tests to verify pass**

Run: `bun test apps/server/test/booking.test.ts`
Expected: all pass.

- [ ] **Step 6: Update HTTP tests in `apps/server/test/http.test.ts`**

In `test('manual fill books ...')` (~line 377): drop `ticker: 'AAPL'` from the POST body and add after the fills-length assert:

```ts
    expect(f.fills[0].ticker).toBe('AAPL')
```

Leave `test('manual fill domain error -> 422 ...')` untouched — its body still carries `ticker: 'AAPL'` and must keep passing, proving legacy bodies are still accepted. Add a new test after the first:

```ts
  test('manual fill with legacy ticker body -> 200, run ticker stamped', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r', ticker: 'AAPL', costPpm: 100, poolCents: 1000 }), headers: { 'content-type': 'application/json', ...auth } })
    const { id } = await cr.json()
    const fr = await app.request(`/api/runs/${id}/fills`, { method: 'POST', body: JSON.stringify({ side: 'buy', ticker: 'ZZZ', shares: 2, price: '10.0000', filledOn: '2026-11-10' }), headers: { 'content-type': 'application/json', ...auth } })
    expect(fr.status).toBe(200)
    expect(f.fills.length).toBe(1)
    expect(f.fills[0].ticker).toBe('AAPL')
  })
```

- [ ] **Step 7: Run the server unit suite + typecheck**

Run: `bun test apps/server/test/ 2>&1 | tail -5` (db.test self-skips) then `bun run typecheck`
Expected: 0 failures (6 db skips), typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/domain/booking.ts apps/server/src/http/routes/runs.ts apps/server/test/booking.test.ts apps/server/test/http.test.ts
git commit -m "feat: booking stamps run.ticker; manual fill contract drops ticker"
git push -q backup feat/manual-fill-ticker
```

---

### Task 2: Capture-path guard — `confirmPendingFill` rejects ticker mismatch

**Files:**
- Modify: `apps/server/src/domain/booking.ts` (`confirmPendingFill`, right after `const run = await repos.runRepo.get(pending.runId)`)
- Modify: `apps/server/src/http/routes/pending.ts` (confirm route catch)
- Test: `apps/server/test/booking.test.ts`, `apps/server/test/http.test.ts`

**Interfaces:**
- Consumes: Task 1's `runBooking`/`BookInput` shape.
- Produces: `confirmPendingFill` throws `new Error('ticker-mismatch')` when `pending.ticker !== run.ticker`; `POST /api/pending/:id/confirm` responds **409** `{ error: 'ticker-mismatch' }` for that error, everything else keeps 422.

- [ ] **Step 1: Write the failing domain test in `apps/server/test/booking.test.ts`**

Place it next to `declared fee pending used verbatim` (same fixture style):

```ts
  test('confirm with ticker mismatch throws and books nothing', async () => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'mism', poolCents: 1000000, costPpm: 100, initialRunState: { buckets: emptyState(2).buckets, cashCents: 1000000, closed: [], ages: {} } })
    const stateBefore = serializeState(await f.repos.bucketRepo.loadState(runId))
    const pid = await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'buy', ticker: 'ZZZ', shares: 5, price: parseUsd('10.00'), fee: null, filledOn: '2026-11-06', status: 'pending' })
    await expect(confirmPendingFill(pid, null, deps)).rejects.toThrow('ticker-mismatch')
    expect(f._stores.fills.length).toBe(0)
    expect(f._stores.pending[0].status).toBe('pending')
    expect(serializeState(await f.repos.bucketRepo.loadState(runId))).toBe(stateBefore)
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/server/test/booking.test.ts -t 'mismatch' 2>&1 | tail -10`
Expected: FAIL — confirm succeeds (books with AAPL since Task 1) instead of throwing.

- [ ] **Step 3: Implement the guard in `booking.ts` `confirmPendingFill`**

Immediately after `const run = await repos.runRepo.get(pending.runId)` add:

```ts
  if (pending.ticker !== run.ticker) throw new Error('ticker-mismatch')
```

Strict `!==` is deliberate: extraction uppercases and auto-route matches exact tickers, so any difference is real corruption. Throw a plain `Error` (like `pending-not-found-or-not-pending`), not `DomainError`.

- [ ] **Step 4: Run domain test to verify pass, then write the failing HTTP test in `apps/server/test/http.test.ts`**

In `describe('http pending', ...)` add (login/auth boilerplate identical to the sibling test; create a run with `ticker: 'AAPL'` first):

```ts
    const pid = await f.repos.pendingRepo.insert({ runId: id, captureId: null, bucketIdx: null, side: 'buy', ticker: 'ZZZ', shares: 3, price: 100000n, fee: null, filledOn: '2026-11-10', status: 'pending' })
    const conf = await app.request(`/api/pending/${pid}/confirm`, { method: 'POST', headers: auth })
    expect(conf.status).toBe(409)
    expect((await conf.json()).error).toBe('ticker-mismatch')
    expect(f.fills.length).toBe(0)
```

- [ ] **Step 5: Run to verify failure**

Run: `bun test apps/server/test/http.test.ts -t 'mismatch' 2>&1 | tail -10`
Expected: FAIL with `expect(422).toBe(409)` — the route currently maps every error to 422.

- [ ] **Step 6: Map the error in `apps/server/src/http/routes/pending.ts`**

In the confirm route's catch, before the generic 422 return:

```ts
      if (e?.message === 'ticker-mismatch') return c.json({ error: 'ticker-mismatch' }, 409)
```

- [ ] **Step 7: Run server suite + typecheck**

Run: `bun test apps/server/test/ 2>&1 | tail -5` then `bun run typecheck`
Expected: 0 failures (6 db skips), typecheck clean. Existing pending tests (matching tickers by construction) must be untouched and green.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/domain/booking.ts apps/server/src/http/routes/pending.ts apps/server/test/booking.test.ts apps/server/test/http.test.ts
git commit -m "feat: pending confirm rejects ticker mismatch with 409"
git push -q backup feat/manual-fill-ticker
```

---

### Task 3: Web — remove the ticker input and the client-side contract

**Files:**
- Create: `apps/web/src/components/forms/ManualCaptureForm.test.tsx`
- Modify: `apps/web/src/components/forms/ManualCaptureForm.tsx`
- Modify: `apps/web/src/api.ts` (`addManualFill` body builder ~line 164)
- Modify: `apps/web/src/api.types.ts` (`ManualFillInput` ~line 177)
- Modify: `apps/web/src/i18n/en.json:96`, `apps/web/src/i18n/ko.json:96`
- No change needed in `RunDetail.tsx` (passes only `runId` / `onAdded`).

**Interfaces:**
- Consumes: Task 1's server contract — `POST /runs/:id/fills` accepts a body without `ticker` (and ignores a stray one, so deploy order web↔server is free).
- Produces: `ManualFillInput { side: 'buy' | 'sell'; shares: number; price: string; fee?: string; filledOn: string }`.

- [ ] **Step 1: Write the failing test `apps/web/src/components/forms/ManualCaptureForm.test.tsx`**

Copy the harness wholesale from `GapEditForm.test.tsx` (GlobalRegistrator before dynamic imports, `d = React.createElement`, `fetch` stub recording `{url, body}` and returning 200 JSON, `setInputValue`, `inputByTestId`, `act`, `afterEach` cleanup). The i18n context defaults to `en` — render the form directly, no provider. Pin these specifics:

```tsx
import { ManualCaptureForm } from './ManualCaptureForm' // via await import after register()

// render: d(ManualCaptureForm, { runId: 7, onAdded: () => (added += 1) })

    // form no longer renders the ticker input
    expect(document.querySelector('input[placeholder="AAPL"]')).toBeNull();

    setInputValue(inputByTestId('manualSharesInput'), '3');
    setInputValue(inputByTestId('manualPriceInput'), '5.00');
    setInputValue(inputByTestId('manualDateInput'), '2026-11-06');
    // click the button whose textContent === 'Add fill' inside act()

    expect(calls.length).toBe(1);
    expect(calls[0].url.endsWith('/api/runs/7/fills')).toBe(true);
    const body = calls[0].body;
    expect('ticker' in body).toBe(false);
    expect(body.side).toBe('buy');
    expect(body.shares).toBe(3);
    expect(body.price).toBe('5.00');
    expect(body.filledOn).toBe('2026-11-06');
    expect(body.fee).toBeUndefined();
    expect(added).toBe(1);
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/web/src/components/forms/ManualCaptureForm.test.tsx 2>&1 | tail -10`
Expected: FAIL — `input [manualSharesInput] not found` (no data-testids yet) and the placeholder assertion.

- [ ] **Step 3: Update `ManualCaptureForm.tsx`**

Remove `useState` ticker, the ticker `<Field>` (lines ~80-82), and `ticker:` from the `ManualFillInput` literal in submit. Fix the stale header comment to say the route is `POST /runs/:id/fills` and that the ticker is the run's (server-stamped, not an input field). Add stable hooks: `data-testid="manualSideSelect"` on the side `<select>`, `data-testid="manualSharesInput" | "manualPriceInput" | "manualFeeInput" | "manualDateInput"` on the four `Input`s (`Input` spreads props — see `GapEditForm.tsx:50`).

- [ ] **Step 4: Update the API client + types + catalogs**

`apps/web/src/api.types.ts`: delete `ticker: string;` from `ManualFillInput` and correct its doc comment to `/** Body of POST /runs/:id/fills — USD strings; the ticker is the run's own, server-stamped. */`.
`apps/web/src/api.ts`: delete the `ticker: fill.ticker.trim().toUpperCase(),` line from `addManualFill`'s body builder.
`apps/web/src/i18n/en.json` and `ko.json`: delete the `"manualTicker"` line (line 96 in both) in this same commit.

- [ ] **Step 5: Run web suite + typecheck**

Run: `bun test apps/web 2>&1 | tail -5` then `bun run typecheck`
Expected: all web tests pass, typecheck clean (any leftover `ManualFillInput.ticker` reference surfaces here).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/forms/ManualCaptureForm.tsx apps/web/src/components/forms/ManualCaptureForm.test.tsx apps/web/src/api.ts apps/web/src/api.types.ts apps/web/src/i18n/en.json apps/web/src/i18n/ko.json
git commit -m "feat: manual fill form drops ticker input (run's ticker is server-stamped)"
git push -q backup feat/manual-fill-ticker
```

---

### Task 4: Full verification matrix

**Files:** none expected (fix-and-commit only if something falls out).

**Interfaces:**
- Consumes: Tasks 1-3 complete.
- Produces: verified green branch ready for PR.

- [ ] **Step 1: Reset the scratch DB and run the full unit+DB suite**

```bash
docker exec st-mariadb-test mariadb -uroot -ptest -e "DROP DATABASE st_test; CREATE DATABASE st_test;"
TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test
```

Expected: 0 failures, 0 skips attributable to this change (db suite runs ~6 tests).

- [ ] **Step 2: Typecheck + web build**

```bash
bun run typecheck
bun run --cwd apps/web build
```

Expected: both exit 0.

- [ ] **Step 3: E2E smoke from the repo root**

```bash
TEST_DATABASE_URL="mysql://root:test@127.0.0.1:3307/st_test" bun scripts/e2e.ts
```

Expected: all checks pass (48/48 at branch base). The e2e confirm path uses matching tickers (NVDA), so it must pass untouched.

- [ ] **Step 4: If anything was fixed, commit and push**

```bash
git status --short   # must be clean after fixes, or nothing to do
git push -q backup feat/manual-fill-ticker
```

---

## Self-Review notes

- Spec coverage: server chokepoint (T1), manualFill type (T1), confirm guard + 409 (T2), web removal incl. comment fix and i18n parity (T3), verification matrix incl. fresh st_test (T4). "Deliberately not doing" items have no tasks by design.
- Type consistency: `Omit<RawFill, 'ticker'> & { filledOn: ISODate }` used identically in T1 Step 3/4; web `ManualFillInput` shape in T3 Interfaces matches T3 Step 4; testids pinned once and reused in the T3 test.
- Review Focus lines 1-4 have explicit tests (T1 S6, T1 S1, T2 S1, T3 S1); line 5 is a no-regression check covered by T1 S7 / T4 S1.
