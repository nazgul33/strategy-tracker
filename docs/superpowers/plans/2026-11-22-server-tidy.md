# Server tidiness (plan C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the server tidy-ups: drop the dead sim `name` (#62), strict path ids on the runs/fills/pending routes (#63), record "keep the screenshot" before a confirm or reject flips its row (#64), index `orders` and the sim sweep tables (#58, #72), read Yahoo's unknown-symbol 404 as `no-data` (#71), and the server and server-test items of #72.

**Architecture:** Small, independent changes in `apps/server` (routes, `domain/confirm-pending.ts`, `domain/vision-review.ts`, `wire/boot-sweeps.ts`, `db/schema.ts` plus one generated migration, `db/repos-bars.ts`, `db/repos-vision.ts`), one in `packages/market-data/src/yahoo.ts`, and the new-sim form in `apps/web`. #64 adds one boot-time repair (re-freeze review rows for kept images whose freeze was lost) next to the existing screenshot janitor.

**Tech Stack:** Bun + TypeScript, Hono, Drizzle ORM (MySQL/MariaDB) with drizzle-kit migrations, React + happy-dom tests, `bun test`.

**Spec:** GitHub issues #62, #63, #64, #72 (server and server-test items), #58 (the `orders` index item), #71 (the Yahoo 404 item); decisions document `docs/superpowers/decisions/2026-11-22-followup-issues.md` (rulings 8, 9, 10 are binding).
**Models:** implementer subagents run on anthropic/claude-sonnet-5-5; per-task reviewers, the whole-branch reviewer and any plan amendments run on anthropic/claude-opus-5-5.
**Branch:** fix/followup-issues, shared by plans A to E, executed in order A, B, C, D, E. Code may have moved by the time this plan runs: locate by symbol, not line.

## Global Constraints

- English only in code, comments, tests and docs (never Chinese or Cyrillic characters); Korean only in `apps/web/src/i18n/ko.json` and tests that pin catalog strings.
- No source file over ~300 lines; new tests go into new focused files rather than growing `vision-review.test.ts` (436), `http-runs.test.ts` (489), `http-fills.test.ts` (312) or `http-fakes.ts` (301).
- `packages/*` never import `apps/*`. `fetch` stays injectable (`fetchImpl` parameter in `yahoo.ts`).
- Money as bigint myriadths (`@st/core/money`), cost in integer ppm.
- All user-facing copy via the en/ko catalogs; catalogs stay key-identical and in `localeCompare` order (`apps/web/src/catalog.test.ts`).
- Migrations are generated, never hand-written: edit `apps/server/src/db/schema.ts`, then `bun run --cwd apps/server db:generate`.
- Commit style `feat|fix|docs|test|refactor|chore:`; one commit per task.
- Do not touch `apps/web` beyond the files Task 2 names (plan D owns the rest of the web).
- Full gate before each commit: `bun run typecheck` and `bun test` (DB suites self-skip without `TEST_DATABASE_URL`).

## Review Focus

1. **A confirm that asked to keep, then fails inside booking** (`no-empty-bucket`, `no-bucket-for-sell`): the image must stay kept, the row stay pending, and no frozen record exist. Pinned in Task 3 ("a keep request survives a booking that fails before the flip").
2. **A crash after the flip on one fill of a multi-fill screenshot while a sibling is still pending**: the boot repair must re-freeze the resolved fill even though the capture still has a live row. Pinned in Task 4 (domain and DB tests "re-freezes a resolved fill whose sibling is still pending").
3. **A non-canonical id on a mutating route that also carries a bad body**: the id answer must win only where the route already checks the row before the body; the order-cancel route answers `order-not-found` before `invalid-reason`. Pinned in Task 5 ("cancel answers order-not-found for a non-canonical id even with a bad reason").
4. **A Yahoo 404 that is not the unknown-symbol answer** (an HTML 404 from a moved endpoint): must stay `http`, never claim "no prices for this ticker". Pinned in Task 7.
5. **Running a server test file under a non-UTC `TZ`**: `TZ=Asia/Seoul bun test apps/server/test/boot-sweeps.test.ts` must pass. Pinned in Task 8, Step 3.

## Already done

- No item this plan owns is fixed on this branch. Checked: `validateCreate` in `apps/server/src/http/routes/sim.ts` still rejects a missing `name` (`invalid name`); `runs.ts`, `fills.ts`, `pending.ts` still use `Number(c.req.param(...))`; `resolveReview` in `domain/vision-review.ts` still sets the keep flag after `bookUnlocked` flipped the row; `orders` in `db/schema.ts` has no index; `packages/market-data/test/yahoo.test.ts` "any other non-OK response is still an http error" still pins a 404 as `http`.
- #72 "`archived: true` is also true for a row with no image" is already documented on `confirmPendingFill` and `rejectPendingFill` (comments in `domain/confirm-pending.ts`); Task 3 restates the meaning after the reorder, no behaviour change.
- #72 "`SimRepoSurface.listRuns` newest-first": the shared fake `makeFakes().repos.simRepo.listRuns` in `apps/server/test/http-fakes.ts` already sorts newest first; only the in-file fake in `apps/server/test/sim.test.ts` does not (Task 8).

## Not in this plan

- #72 "a year covered with no data changes sim results with only a `console.warn`": surfacing it in the sim result is a new operator-facing feature (result shape, web copy), not a tidy-up; the warning is what #47 asked for.
- #72 "retry exhaustion in the coverage merge surfaces as a 500 carrying the raw driver message": changing what unexpected errors answer is an app-wide error policy, and the raw message is the single operator's only diagnostic; Task 9's backoff makes exhaustion rarer.
- #72 "files over the ~300-line convention" (`http-fakes.ts`, `http-runs.test.ts`, `vision-review.test.ts`, `sim.test.ts`, `wire.test.ts`, `day.test.ts`, `scripts/e2e.ts`, and the older ones): a mechanical split of eight-plus test files is a large diff with no behaviour change; this plan adds no lines to them beyond the edits it needs, and new tests go into new files.
- #72 "docs still name `http-pending-settings.test.ts`": those are dated records, left as written.
- #72 web test items (`cutloss.test.ts`, `catalog.test.ts`, `VisionReviewDelete.test.tsx`): plan D.
- #71 web copy for `simErr.market-data:http` / `no-data`: plan D (see "Handoff to plan D" below).
- #58 typing items (`listForRunFrom` typed `Promise<any[]>`, etc.): plan E.
- #64 option 2 (one DB transaction around the confirm): overlaps #40 (deferred).
- #64 "when `archived: false` is answered the web offers no way to retry the keep": after Task 3 the keep is already written when `archived: false` comes back, so there is nothing to retry; the wording is plan D's (#61 notice).

## Handoff to plan D (web copy after Task 7)

After Task 7, `market-data:no-data` also arrives for a mistyped or delisted ticker, and `market-data:http` arrives only for a provider that answered with an error (5xx, 429, a non-"Not Found" 4xx) or could not be reached at all (the fetch threw; it used to be a raw-text 500). Plan D should:
- change `simErr.market-data:http` (en and ko) to drop "Check the ticker": en "The market data provider returned an error or could not be reached. Try again in a moment.";
- change `simErr.market-data:no-data` (en and ko) to name the ticker check: en "The market data provider has no prices for this ticker and date range. Check the ticker spelling.";
- update `apps/web/src/pages/Sim.test.tsx` "a market-data failure on run reads in words, not as the code" (it asserts the text "Check the ticker" for `market-data:http`) and any `simerrors.test.ts` pin of the old copy.

After Task 3, when a confirm or reject asked to keep the screenshot and answers `archived: false`, the screenshot IS kept; only its review record was not written, and the next server start rebuilds it (Task 4). Plan D's #61 notice must not say the screenshot could not be kept in that case; suggested en: "The fill was booked, but its review record could not be saved. The screenshot is kept and appears in the review tab after the next server restart."

## Decisions for human review

- **Ruling 10 needs one addition to hold (Task 4).** The review listing hides a kept image with no frozen record, so "kept, reviewable, deletable" after a crash is not true with the reorder alone. Added a boot-time repair (`refreezeKept`) that rebuilds the record from the pending row. Why: smallest change that keeps the listing and its invariant; the alternative (the listing synthesizing entries from pending rows) changes the wire shape plan D reads. Cost if wrong: one more boot step and one repo query.
- **[REVIEW]** A rebuilt review record has `feeOverridden: false` and its `edited` ignores the fee (the confirm's fee override is not stored anywhere). Cost if wrong: the review tab may not highlight an operator-typed fee on a record that a crash interrupted.
- **[REVIEW]** A confirm or reject that asked to keep and whose keep write fails is refused as a whole (nothing booked). Why: ruling 10 orders the keep before the flip; booking without the keep would recreate #64. Cost if wrong: a DB hiccup on one small UPDATE blocks a confirm until retried.
- The keep is written after the ticker-mismatch check and before `bookUnlocked`, so a mismatched ticker keeps nothing, while a booking refusal inside `bookUnlocked` (`no-empty-bucket`, `no-bucket-for-sell`) leaves the image kept. Cost if wrong: a few extra kept screenshots, deletable from the review tab once resolved.
- `archived` keeps its wire meaning ("the bookkeeping did not throw"); what changes is that a requested keep is already written when it is `false`. Plan D words the notice accordingly. Cost if wrong: copy only.
- **[REVIEW]** `POST /runs/:id/pool` and `POST /runs/:id/fills` now answer 404 `not found` for an unknown run, not only for a non-canonical id (was 200 plus a stray `pool_edits` row, and 422 with a TypeError message). Cost if wrong: a client relying on the old answers sees a 404.
- The run list routes (`/orders`, `/fills`, `/notifications`) answer `[]` for a non-canonical id, the same as for an unknown id, rather than a 404. Why: that is the routes' existing "nothing here" answer (ruling 9 asks for the existing not-found response). Cost if wrong: a hand-written client cannot tell a malformed id from an empty run.
- **[REVIEW]** `DELETE /runs/:id/fills/:fillId` answers 422 `no-fill` for a non-canonical fill id (was `not-last` for `abc`, `1.5`, `-2`). Why: `no-fill` is the route's not-found answer, and `0`/`01` already split between the two. Cost if wrong: the web shows "This fill can no longer be edited" instead of "Only the last fill of a bucket can be deleted" for an id it never sends.
- The order-cancel route checks both ids before the body, so a non-canonical id answers `order-not-found` even with an invalid reason. Cost if wrong: none visible.
- Task 6 also indexes `orders (trade_date)` (the buy booking's `listForDate` runs inside the run lock too) and the two sim sweep tables, in one generated migration. Cost if wrong: slightly slower order inserts.
- **[REVIEW]** Yahoo's 404 becomes `no-data` only when its JSON says `chart.error.code === 'Not Found'`; an HTML 404 stays `http`. Applied to `fetchLastClose` too (the morning pipeline treats both kinds alike). Cost if wrong: a moved Yahoo endpoint that answers that exact JSON would read as "no prices for this ticker".
- **[REVIEW]** A fetch that rejects (provider unreachable) becomes `MarketDataError('http')`, so the sim answers 502 `market-data:http` instead of a 500 with the raw text. Cost if wrong: the raw cause is only in the error message, not on screen.
- Deadlock backoff: 5, 10, 20, 40 ms plus 0-4 ms jitter, still five attempts. Cost if wrong: up to ~95 ms added to a contended first fetch.
- The simulator's in-memory run is labelled by its ticker now that no name arrives; nothing reads it. Cost if wrong: none.

## Issue closing

- **#62:** closed by this plan (Tasks 1, 2).
- **#63:** closed by this plan (Task 5).
- **#64:** closed by this plan (Tasks 3, 4; option 1 plus a boot repair; option 2 stays with #40).
- **#58:** partly: this plan adds the `orders` indexes (Task 6); the attribution, copy, wiring and typing items belong to plans A, B and E.
- **#71:** partly: this plan maps the Yahoo 404 and an unreachable provider (Task 7); the `simErr.*` copy change and the other web items belong to plan D.
- **#72:** partly: fixed here are the coverage-merge backoff (Task 9), the sweep indexes (Task 6), `listRuns` newest-first in the `sim.test.ts` fake, the e2e `name` (Task 1), the boot-order pin, the `boot-sweeps.test.ts` zone check, the `db-sim-list.test.ts` scratch database, the shared bar fakes (Task 8), and the `archived` wording (Task 3). Left with reasons (see "Not in this plan"): surfacing covered-with-no-data in sim results, the raw 500 message on retry exhaustion, the oversized-file split, the dated docs. The web test items belong to plan D.

---
## File map

| File | Change | Task |
| --- | --- | --- |
| `apps/server/src/http/routes/sim.ts` | `validateCreate` stops reading `name` | 1 |
| `apps/server/src/sim/sim.ts` | `SimInput` loses `name`; `prepareSim` labels the in-memory run itself | 1 |
| `apps/server/test/http-sim-drafts.test.ts`, `apps/server/test/sim.test.ts` | name tests; drop `name:` from `runSim({...})` literals; newest-first fake | 1, 8 |
| `scripts/e2e-sim-drafts.ts` | `BODY` loses `name` | 1 |
| `apps/web/src/pages/Sim.tsx`, `api.ts`, `api.types.ts`, `api.sim.ts`, `simconfig.ts`, `i18n/{en,ko}.json` (+ `Sim.test.tsx`, `api.test.ts`) | no name field, no `name` sent, `simName` key removed | 2 |
| `apps/server/src/domain/confirm-pending.ts` | keep written before the flip (confirm and reject) | 3 |
| `apps/server/test/confirm-keep-order.test.ts` (new) | keep-ordering tests | 3 |
| `apps/server/src/domain/vision-review.ts` | `freezeReview` extracted; `refreezeKept` added | 4 |
| `apps/server/src/db/repos-vision.ts` | `visionReviewRepo.listUnfrozenKept()` | 4 |
| `apps/server/src/wire/boot-sweeps.ts` | runs `refreezeKept` | 4 |
| `apps/server/src/http/routes/vision-review.ts` | comment on the "kept image always has a frozen row" invariant | 4 |
| `apps/server/test/booking-fakes.ts` | fake `listUnfrozenKept` | 4 |
| `apps/server/test/refreeze-kept.test.ts` (new), `db-vision-janitor.test.ts`, `boot-sweeps.test.ts`, `db-sim-list.test.ts` | repair tests; boot-sweep repo stubs | 4 |
| `apps/server/src/http/routes/{runs,fills,pending}.ts` | `parseId` on every path id | 5 |
| `apps/server/test/http-strict-ids.test.ts` (new), `http-fills.test.ts` | strict-id tests; one renamed pin | 5 |
| `apps/server/src/db/schema.ts`, `apps/server/db/migrations/0009_*.sql` + `meta/` (generated) | four indexes | 6 |
| `apps/server/test/migration-sql.test.ts` | index SQL pin | 6 |
| `packages/market-data/src/yahoo.ts`, `packages/market-data/test/yahoo.test.ts` | 404 "Not Found" -> `no-data`; fetch rejection -> `http` | 7 |
| `apps/server/test/bars-fakes.ts` (new), `bars.test.ts`, `bars-chunking.test.ts` | shared fake upstream | 8 |
| `apps/server/test/boot-sweeps.test.ts` | zone check independent of `TZ` | 8 |
| `apps/server/test/db-sim-list.test.ts` | scratch database | 8 |
| `apps/server/test/main-boot-order.test.ts` (new) | pins `runBootSweeps` ahead of bot, jobs, server | 8 |
| `apps/server/src/db/repos-bars.ts`, `apps/server/test/db-bar-coverage-lock.test.ts` | jittered backoff on deadlock retry | 9 |

Task order matters in one place: Task 4 adds `visionReviewRepo` to the boot-sweep repo type, which Task 8 then builds on in `db-sim-list.test.ts` and `boot-sweeps.test.ts`.

---

### Task 1: `POST /api/sim` accepts and ignores `name` (#62, server; #72 e2e item)

**Files:**
- Modify: `apps/server/src/http/routes/sim.ts` (`validateCreate`, the comment above `validateConfig`)
- Modify: `apps/server/src/sim/sim.ts` (`SimInput`, `prepareSim`, `updateSimRun`, the comment above `updateSimRun`)
- Modify: `apps/server/test/http-sim-drafts.test.ts` (`base`, test "POST still requires a name", test "GET /api/sim marks drafts and saved runs, newest first")
- Modify: `apps/server/test/sim.test.ts` (every `runSim({ name: ..., ... })` literal)
- Modify: `scripts/e2e-sim-drafts.ts` (`BODY`)

**Interfaces:**
- Produces: `SimInput` (in `apps/server/src/sim/sim.ts`) without `name`: `{ ticker; from; to; poolCents; costPpm; buyGapPpm?; sellGapPpm?; cutLossPpm?; params? }`. `updateSimRun(id: number, input: Omit<SimInput, 'ticker'>, deps)`.
- `GET /api/sim` rows are unchanged; the web labels a run `Simulation #<id>` (`simDetailTitle`), never by name, so nothing reads blank.

- [ ] **Step 1: Write the failing test.** In `http-sim-drafts.test.ts`, drop `name: 's'` from `base`, and replace the test "POST still requires a name" with:

```ts
test('POST needs no name and ignores one that is sent', async () => {
  const { f, call } = await setup()
  for (const over of [{}, { name: ' ' }, { name: 42 }, { name: 'kept by an old web bundle' }]) {
    expect((await call('POST', '', { ...base, ...over })).status).toBe(200)
  }
  expect(f.simRuns).toHaveLength(4)
  expect(f.simRuns.every((r) => !('name' in r))).toBe(true)
})
```

In "GET /api/sim marks drafts and saved runs, newest first", replace `create({ name: 'a' })` / `'b'` / `'c'` with `create()`.

- [ ] **Step 2: Run it to verify it fails.** `bun test apps/server/test/http-sim-drafts.test.ts` — expected: the new test FAILS (status 400 `invalid name` for the first body).

- [ ] **Step 3: Implement.** In `validateCreate` delete the two `name` lines and return `{ ...v.input, ticker }`. Remove `name` from `SimInput`. In `prepareSim`, the in-memory `Run` gets `name: input.ticker` (the planner never reads it; one line comment saying so). `updateSimRun` takes `Omit<SimInput, 'ticker'>` and calls `prepareSim({ ...input, ticker: run.ticker }, ...)`; update its comment ("no name is stored, so the in-memory run is labelled by id" becomes "labelled by its ticker"). Update the comment above `validateConfig` ("except the ticker: POST adds it from the body, PUT takes it from the stored draft"). In `sim.test.ts`, delete `name: '<x>', ` from every object literal passed to `runSim` (about ten sites; leave the `Run` fixture `name: 'sim'` near the top alone, and leave the `app.request('/api/sim', ...)` bodies that still send `name` — they now pin "ignored"). In `scripts/e2e-sim-drafts.ts`, `BODY` becomes `{ from: '2026-11-02', to: '2026-11-06', poolCents: 1_000_000 }`.

- [ ] **Step 4: Run the tests.** `bun test apps/server/test/http-sim-drafts.test.ts apps/server/test/sim.test.ts apps/server/test/http-sim.test.ts` — expected: PASS. Then `bun run typecheck` — expected: no errors (an excess `name` property in a `runSim` literal is a compile error, so a missed site shows here).

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/http/routes/sim.ts apps/server/src/sim/sim.ts apps/server/test/http-sim-drafts.test.ts apps/server/test/sim.test.ts scripts/e2e-sim-drafts.ts
git commit -m "fix: POST /api/sim accepts and ignores a name, as PUT does (#62)"
```

---

### Task 2: the new-sim form stops asking for a name (#62, web)

Plan D later edits the web; this task touches only the files listed.

**Files:**
- Modify: `apps/web/src/pages/Sim.tsx` (`SimPage`: the `name` state and its `Field`; the `api.runSim` call)
- Modify: `apps/web/src/api.types.ts` (`SimInput`, `SimUpdateInput`)
- Modify: `apps/web/src/api.ts` (`runSim` in `createApi`)
- Modify: `apps/web/src/simconfig.ts` (`SimConfigInput` and its doc comment)
- Modify: `apps/web/src/api.sim.ts` (doc comment "every config field but the ticker and name")
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json` (remove `simName`)
- Test: `apps/web/src/pages/Sim.test.tsx`, `apps/web/src/api.test.ts`

**Interfaces:**
- Consumes: Task 1 (the server no longer needs `name`).
- Produces: web `SimInput` without `name`; `SimUpdateInput = Omit<SimInput, 'ticker'>`; `SimConfigInput = Omit<SimInput, 'ticker'>`. `SimConfigFields.tsx` is unchanged (it never had the name).

- [ ] **Step 1: Write the failing tests.** In `Sim.test.tsx` (describe "SimPage gap fields") add:

```ts
it('asks for no name and posts none', async () => {
  await act(async () => { root.render(d(SimPage)); });
  const labels = Array.from(document.querySelectorAll('label span')).map((s) => s.textContent ?? '');
  expect(labels.some((l) => l.trim() === 'Name')).toBe(false);
  await fillBaseFields();
  await submitForm();
  expect(calls.length).toBe(1);
  expect('name' in calls[0]!.body).toBe(false);
});
```

In `api.test.ts`: drop `name: 'S'` from the `base` of describe "runSim gaps"; change "runSim carries cutLossPpm when set" to call `api.runSim({ ...config, ticker: 'qqq' })` and assert:

```ts
const body = JSON.parse(String(calls[0]!.init?.body));
expect(body).toMatchObject({ ticker: 'QQQ', cutLossPpm: 35_000 });
expect('name' in body).toBe(false);
```

- [ ] **Step 2: Run them to verify they fail.** `bun test apps/web/src/pages/Sim.test.tsx apps/web/src/api.test.ts` — expected: the new Sim test FAILS (`name` is in the body); `bun run typecheck` FAILS on `api.test.ts` (missing `name`).

- [ ] **Step 3: Implement.** Remove `name` from web `SimInput`; `SimUpdateInput` and `SimConfigInput` become `Omit<SimInput, 'ticker'>` (doc comments: "no ticker"). `runSim` in `createApi` sends `{ ticker: ..., ...simConfigBody(input) }`. In `SimPage` delete `const [name, setName]`, the `Field label={t('simName')}` block, and call `api.runSim({ ticker: tid, ...result.input })`; leave the ticker `Field` in its existing grid wrapper. Delete the `"simName"` entry from both catalogs (no other code uses it).

- [ ] **Step 4: Run the tests.** `bun test apps/web` and `bun run typecheck` — expected: PASS, including `apps/web/src/catalog.test.ts` (key parity).

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/pages/Sim.tsx apps/web/src/pages/Sim.test.tsx apps/web/src/api.ts apps/web/src/api.test.ts apps/web/src/api.types.ts apps/web/src/api.sim.ts apps/web/src/simconfig.ts apps/web/src/i18n/en.json apps/web/src/i18n/ko.json
git commit -m "fix: the new-sim form no longer asks for a name the server never stored (#62)"
```

---
### Task 3: the keep flag is written before the pending row flips (#64, ruling 10)

Plan A edits `confirmPendingFill` first (override handling for `bucketIdx`); locate by symbol.

**Files:**
- Modify: `apps/server/src/domain/confirm-pending.ts` (`confirmPendingFill`, `rejectPendingFill`, their comments)
- Create: `apps/server/test/confirm-keep-order.test.ts`

**Interfaces:**
- Consumes: `RepoSurface['captureImageRepo'].setKeep(captureId: number): Promise<void>` (exists; sticky, idempotent).
- Produces: no signature change. `confirmPendingFill(pendingId, overrides, deps, opts?: { keepImage?: boolean }): Promise<{ archived: boolean }>` and `rejectPendingFill(pendingId, deps, opts?): Promise<{ archived: boolean } | null>` keep their shapes.

**Where the keep write goes.** In `confirmPendingFill`, inside the `withRunLock` callback, after the row is re-read (`pending-not-found-or-not-pending`) and after the `ticker-mismatch` check, and before `bookUnlocked`:
`if (opts?.keepImage === true && pending.captureId != null) await repos.captureImageRepo.setKeep(pending.captureId)`.
In `rejectPendingFill`, inside its lock, after the row is re-read and before `pendingRepo.decide(pendingId, 'rejected')`, the same line. `resolveReview` is still called with `keepImage` as today (its own `setKeep` is now a harmless second raise; direct callers of `resolveReview` in tests keep working).

**What follows from it (write these into the comments on the two functions):**
- `setKeep` throws: nothing is booked or decided; the confirm/reject fails as a whole (the route answers 422 / 500 as for any thrown error) and the operator retries.
- Booking throws after the keep (`no-empty-bucket`, `no-bucket-for-sell`, a lost decide race): the row stays pending, the image stays kept (ruling 10's accepted cost; a later confirm or reject, with or without keep, leaves it kept because the flag is sticky).
- A crash or a thrown write after `decide` flipped the row: the row is `confirmed`/`rejected`, the image is kept, so the boot janitor (`sweepOrphans`, unkept only) never deletes it; the missing frozen record is rebuilt at the next boot (Task 4).
- `archived` keeps its wire meaning: `true` = the review bookkeeping (freeze, then keep or sweep) did not throw; `false` = the fill is booked (or the reject took effect) but the bookkeeping threw. New: when the operator asked to keep, the screenshot is already kept even when `archived` is `false`. Still `true` for a row with no capture or image.

- [ ] **Step 1: Write the failing tests** in the new `apps/server/test/confirm-keep-order.test.ts`. Copy the small `setup(fills)` helper, `TODAY = '2026-11-06'` and `PNG` from `apps/server/test/vision-review.test.ts` (it uses `fakeRepos` / `silentNotifier` from `./booking-fakes` and `ingestCapture`). Tests:

```ts
test('the keep is written before the row flips', async () => {
  const { f, deps, ids, captureId } = await setup(1)
  const order: string[] = []
  const setKeep = f.repos.captureImageRepo.setKeep
  f.repos.captureImageRepo.setKeep = async (id) => { order.push('keep'); await setKeep(id) }
  const decide = f.repos.pendingRepo.decide
  f.repos.pendingRepo.decide = async (...a) => { order.push('decide'); return decide(...a) }
  await confirmPendingFill(ids[0]!, null, deps, { keepImage: true })
  expect(order[0]).toBe('keep')
  expect(order.indexOf('keep')).toBeLessThan(order.indexOf('decide'))
  expect(f._stores.captureImages[0]).toMatchObject({ captureId, keep: true })
})

test('a crash after the flip leaves the row confirmed and the image kept, never sweepable', async () => {
  const { f, deps, ids, captureId } = await setup(1)
  // fillRepo.insert runs after pendingRepo.decide inside bookUnlocked: a throw here is a crash after the flip
  f.repos.fillRepo.insert = async () => { throw new Error('crash') }
  await expect(confirmPendingFill(ids[0]!, null, deps, { keepImage: true })).rejects.toThrow('crash')
  expect(f._stores.pending.find((p: any) => p.id === ids[0])!.status).toBe('confirmed')
  expect(f._stores.captureImages[0]).toMatchObject({ captureId, keep: true })
  expect(f._stores.visionReviews).toHaveLength(0)
  expect(await f.repos.pendingRepo.hasLiveForCapture(captureId)).toBe(false)
})

test('a keep request survives a booking that fails before the flip', async () => {
  const { f, deps, ids, captureId } = await setup(1)
  await expect(confirmPendingFill(ids[0]!, { side: 'sell' }, deps, { keepImage: true })).rejects.toMatchObject({ kind: 'no-bucket-for-sell' })
  expect(f._stores.pending.find((p: any) => p.id === ids[0])!.status).toBe('pending')
  expect(f._stores.captureImages[0]).toMatchObject({ captureId, keep: true })
  expect(f._stores.visionReviews).toHaveLength(0)
  expect(await confirmPendingFill(ids[0]!, null, deps)).toEqual({ archived: true })
  expect(f._stores.captureImages[0]!.keep).toBe(true)
  expect(f._stores.visionReviews).toHaveLength(1)
})

test('a failed keep write aborts the confirm before anything is booked', async () => {
  const { f, deps, ids } = await setup(1)
  f.repos.captureImageRepo.setKeep = async () => { throw new Error('keep-down') }
  await expect(confirmPendingFill(ids[0]!, null, deps, { keepImage: true })).rejects.toThrow('keep-down')
  expect(f._stores.pending.find((p: any) => p.id === ids[0])!.status).toBe('pending')
  expect(f._stores.fills).toHaveLength(0)
})

test('archived: false after a failed freeze still leaves a requested keep in place', async () => {
  const { f, deps, ids, captureId } = await setup(1)
  f.repos.visionReviewRepo.insertIgnore = async () => { throw new Error('archive-down') }
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(await confirmPendingFill(ids[0]!, null, deps, { keepImage: true })).toEqual({ archived: false })
  } finally { err.mockRestore() }
  expect(f._stores.captureImages[0]).toMatchObject({ captureId, keep: true })
})

test('a ticker mismatch keeps nothing', async () => { /* setup(1); set f._stores.pending row's ticker to 'MSFT'; confirm with keepImage -> rejects 'ticker-mismatch'; captureImages[0].keep false */ })

test('reject writes the keep before the row flips, and a crash after the flip leaves it kept', async () => {
  // same order recorder as the first test, via rejectPendingFill(ids[0]!, deps, { keepImage: true }): 'keep' before 'decide'.
  // Then, on a fresh setup(1): f.repos.visionReviewRepo.insertIgnore throws -> { archived: false }, row 'rejected', image keep true.
})
```

Write the two sketched tests out in full with the assertions given in their comments.

- [ ] **Step 2: Run them to verify they fail.** `bun test apps/server/test/confirm-keep-order.test.ts` — expected: the order tests FAIL (`decide` precedes `keep`), the crash and pre-flip-failure tests FAIL on `keep: false`; "a failed keep write aborts" FAILS (the fill is booked).

- [ ] **Step 3: Implement** the two `setKeep` calls where described above, and rewrite the comments on both functions to the four consequences listed (keep them short; the archived paragraph replaces the existing one).

- [ ] **Step 4: Run the tests.** `bun test apps/server/test/confirm-keep-order.test.ts apps/server/test/vision-review.test.ts apps/server/test/http-pending-confirm.test.ts apps/server/test/http-pending-review.test.ts apps/server/test/wire.test.ts` — expected: PASS (the existing "keep is sticky", "a booking that fails late archives nothing" and Telegram tests are unchanged in outcome).

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/domain/confirm-pending.ts apps/server/test/confirm-keep-order.test.ts
git commit -m "fix: record the operator's keep before a confirm or reject flips the pending row (#64)"
```

---

**Controller amendment (cross-plan check) for Task 3:** plan A added the error `invalid-bucket` (a malformed or buy-side `bucketIdx`), thrown inside the booking. After this task's reorder it counts among the refusals that come after the keep write: list it with `no-empty-bucket`, `no-bucket-for-sell` and a lost decide race in the comment and in the test that pins "a booking refusal leaves the screenshot kept".

### Task 4: rebuild a lost review record for a kept screenshot at boot (#64)

Why this task exists: ruling 10 says a kept image left by a crash is "reviewable, deletable from the review tab". It is not as the code stands: `GET /api/vision-reviews` (`visionReviewRouter`) drops a kept image that has no frozen `vision_reviews` row ("without one there is no run or ticker to show"), and the janitor never sweeps a kept image, so after Task 3 a crash between the flip and the freeze would strand a kept, invisible screenshot. The smallest fix keeps the listing as it is and restores its invariant: at boot, re-freeze every resolved pending row of a kept capture that has no frozen row, from the values the pending row already carries (`decide` writes the booked side, shares, price, fee and date onto it; the detected snapshot columns are untouched).

**Files:**
- Modify: `apps/server/src/domain/vision-review.ts` (extract `freezeReview` from `resolveReview`; add `refreezeKept`)
- Modify: `apps/server/src/db/repos-vision.ts` (`visionReviewRepo.listUnfrozenKept`)
- Modify: `apps/server/src/wire/boot-sweeps.ts` (`BootSweepRepos`, `runBootSweeps`)
- Modify: `apps/server/src/http/routes/vision-review.ts` (the comment in `GET /vision-reviews`)
- Modify: `apps/server/test/booking-fakes.ts` (fake `visionReviewRepo.listUnfrozenKept`)
- Create: `apps/server/test/refreeze-kept.test.ts`
- Modify: `apps/server/test/db-vision-janitor.test.ts`, `apps/server/test/boot-sweeps.test.ts`, `apps/server/test/db-sim-list.test.ts` (boot-sweep repo stubs)

**Interfaces:**
- Produces, in `apps/server/src/domain/vision-review.ts`:
  - `export type UnfrozenPendingRow = ReviewedPendingRow & { captureId: number; status: 'confirmed' | 'rejected'; side: string; shares: number; price: bigint; fee: number | null; filledOn: string }`
  - `export async function freezeReview(repos: Pick<ReviewRepos, 'visionReviewRepo'>, args: { pendingRow: ReviewedPendingRow; captureId: number; outcome: 'confirmed' | 'rejected'; final: FinalValues | null; feeOverride?: number | null }): Promise<void>` — exactly today's `insertIgnore` call in `resolveReview` (detected values, `isEdited`, `feeOverridden: feeOverride !== undefined`); `resolveReview` calls it.
  - `export async function refreezeKept(repos: { visionReviewRepo: Pick<ReviewRepos['visionReviewRepo'], 'insertIgnore'> & { listUnfrozenKept(): Promise<UnfrozenPendingRow[]> } }): Promise<number[]>` — for each row: `freezeReview` with `outcome: row.status`, `final` = `{ side, shares, price, filledOn, fee: row.fee ?? 0 }` for `confirmed` and `null` for `rejected`, `feeOverride: undefined`. Returns the pending ids it froze, ascending.
- Produces, in `repos-vision.ts`: `visionReviewRepo.listUnfrozenKept(): Promise<UnfrozenPendingRow[]>` — `pending_fills` rows with `status IN ('confirmed','rejected')`, `capture_id` naming a `capture_images` row with `keep = true`, and no `vision_reviews` row with that `pending_fill_id`; ordered by `pending_fills.id`. It does not look at sibling rows: a capture with a still-pending sibling is repaired too.
- Produces, in `boot-sweeps.ts`: `BootSweepRepos` gains `visionReviewRepo: { listUnfrozenKept(): Promise<UnfrozenPendingRow[]>; insertIgnore(row: VisionReviewInsert): Promise<void> }`. `runBootSweeps` runs `refreezeKept` after the screenshot sweep in its own `try/catch`, logging `[main] rebuilt review records for pending fill ids: <ids>` when non-empty and `[main] review record rebuild failed (continuing):` on error. The real `getRepos(db)` already satisfies the type once `listUnfrozenKept` exists; `RepoSurface` is not widened (plan E owns repository typing).
- Known loss, by design: a rebuilt record has `feeOverridden: false` and its `edited` ignores the fee (the confirm's fee override is not stored on the pending row).

- [ ] **Step 1: Write the failing domain tests** in `apps/server/test/refreeze-kept.test.ts`, using `fakeRepos` from `./booking-fakes`, `ingestCapture` / `confirmPendingFill` / `rejectPendingFill` and the same `setup(fills)` helper as Task 3:

```ts
test('a crash after the flip is repaired: the kept image gets its frozen record from the pending row', async () => {
  const { f, deps, ids, captureId } = await setup(1)
  const insert = f.repos.fillRepo.insert
  f.repos.fillRepo.insert = async () => { throw new Error('crash') }
  await expect(confirmPendingFill(ids[0]!, { shares: 4 }, deps, { keepImage: true })).rejects.toThrow('crash')
  f.repos.fillRepo.insert = insert
  expect(await refreezeKept(f.repos)).toEqual([ids[0]])
  expect(f._stores.visionReviews).toHaveLength(1)
  expect(f._stores.visionReviews[0]).toMatchObject({
    pendingFillId: ids[0], captureId, outcome: 'confirmed', ticker: 'AAPL',
    detectedShares: 1, finalShares: 4, edited: true, feeOverridden: false,
  })
  expect(await refreezeKept(f.repos)).toEqual([])   // idempotent
})

test('re-freezes a resolved fill whose sibling is still pending', async () => {
  // setup(2); crash-confirm ids[0] with keepImage as above; ids[1] stays pending.
  // refreezeKept -> [ids[0]]; one frozen row, for ids[0].
})

test('a rejected fill is rebuilt with null finals', async () => {
  // setup(1); f.repos.visionReviewRepo.insertIgnore throws once; rejectPendingFill(ids[0], deps, { keepImage: true }) -> { archived: false }.
  // restore insertIgnore; refreezeKept -> [ids[0]]; row outcome 'rejected', finalShares null, edited false.
})

test('an unkept image and a row that already has its record are left alone', async () => {
  // setup(2); confirmPendingFill(ids[0], null, deps) (unkept, frozen normally); confirm ids[1] with keepImage (frozen normally).
  // refreezeKept -> []; visionReviews still two rows.
})
```

The fake `listUnfrozenKept` in `booking-fakes.ts` (add next to `insertIgnore` in its `visionReviewRepo`) filters `pending` by the same three conditions against `captureImages` and `visionReviews`, sorted by id. Write the sketched tests out in full.

Add to `boot-sweeps.test.ts` (extend `makeRepos` with an optional `listUnfrozenKept` override and a call counter; pass a `visionReviewRepo` stub everywhere `runBootSweeps` is called in that file and in `db-sim-list.test.ts`):

```ts
test('the review rebuild runs after both sweeps and logs the ids it rebuilt', async () => { /* listUnfrozenKept returns two rows for pending ids 5 and 8; log contains '5, 8'; insertIgnore called twice */ })
test('a failing review rebuild is logged, not thrown, and the sweeps still ran', async () => { /* listUnfrozenKept throws; resolves undefined; console.error once; orphanCalls() === 1 */ })
```

- [ ] **Step 2: Write the failing DB test** in `db-vision-janitor.test.ts` (scratch database; reuse `newCapture`, `image`, `pending`, `review`):

```ts
test('listUnfrozenKept lists resolved rows of kept images that lack a frozen row, and nothing else', async () => {
  const a = await newCapture()          // kept, one confirmed row without a record, one pending sibling
  await image(a.captureId); await repos.captureImageRepo.setKeep(a.captureId)
  const lost = await pending(a.runId, a.captureId, 'confirmed')
  await pending(a.runId, a.captureId, 'pending')
  const b = await newCapture()          // kept, confirmed row that has its record
  await image(b.captureId); await repos.captureImageRepo.setKeep(b.captureId)
  const ok = await pending(b.runId, b.captureId, 'confirmed')
  await repos.visionReviewRepo.insertIgnore(review(b.runId, b.captureId, ok))
  const c = await newCapture()          // unkept image, confirmed row without a record
  await image(c.captureId)
  await pending(c.runId, c.captureId, 'confirmed')
  const rows = await repos.visionReviewRepo.listUnfrozenKept()
  const mine = rows.filter((r: any) => [a.captureId, b.captureId, c.captureId].includes(r.captureId))
  expect(mine.map((r: any) => r.id)).toEqual([lost])
  expect(mine[0]).toMatchObject({ captureId: a.captureId, status: 'confirmed', shares: 1, price: 100n })
})
```

- [ ] **Step 3: Run to verify failure.** `bun test apps/server/test/refreeze-kept.test.ts apps/server/test/boot-sweeps.test.ts` — expected: FAIL (`refreezeKept` is not exported). With the scratch DB up: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db-vision-janitor.test.ts` — expected: FAIL (`listUnfrozenKept` is not a function).

- [ ] **Step 4: Implement** `freezeReview`, `refreezeKept`, `listUnfrozenKept` (Drizzle: `select` the `UnfrozenPendingRow` columns from `pendingFills`, `innerJoin(captureImages, and(eq(captureImages.captureId, pendingFills.captureId), eq(captureImages.keep, true)))`, `where(and(inArray(pendingFills.status, ['confirmed', 'rejected']), notExists(<select 1 from visionReviews where pendingFillId = pendingFills.id>)))`, `orderBy(pendingFills.id)`), the fake, and the boot wiring. Replace the comment in `GET /vision-reviews` with: "A kept image normally has a frozen row. The keep is written before the confirm or reject flips its row, so a crash before the freeze can leave one without; the boot repair (`refreezeKept`) rebuilds it, and until then there is no run or ticker to show." Update the comment on `runBootSweeps` to name the third step.

- [ ] **Step 5: Run the tests.** `bun test apps/server` — expected: PASS. `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db-vision-janitor.test.ts apps/server/test/db-sim-list.test.ts` — expected: PASS. `bun run typecheck` — expected: no errors.

- [ ] **Step 6: Commit.**

```bash
git add apps/server/src/domain/vision-review.ts apps/server/src/db/repos-vision.ts apps/server/src/wire/boot-sweeps.ts apps/server/src/http/routes/vision-review.ts apps/server/test/booking-fakes.ts apps/server/test/refreeze-kept.test.ts apps/server/test/db-vision-janitor.test.ts apps/server/test/boot-sweeps.test.ts apps/server/test/db-sim-list.test.ts
git commit -m "fix: rebuild the review record of a kept screenshot whose confirm crashed before the freeze (#64)"
```

---
### Task 5: strict path ids on the runs, fills and pending routes (#63, ruling 9)

Plan A adds `bucketIdx` body parsing to `fills.ts` / `pending.ts` (and possibly the manual-fill route in `runs.ts`) first; locate each route by its path string.

**Files:**
- Modify: `apps/server/src/http/routes/runs.ts`, `apps/server/src/http/routes/fills.ts`, `apps/server/src/http/routes/pending.ts`
- Create: `apps/server/test/http-strict-ids.test.ts`
- Modify: `apps/server/test/http-fills.test.ts` (test "DELETE non-integer fillId -> 422 not-last")

**Interfaces:**
- Consumes: `parseId(raw: string): number | null` from `apps/server/src/http/params.ts` (canonical decimal ids only).
- Produces: every `Number(c.req.param(...))` in the three files is replaced by `parseId(...)`; no `Number(` on a path param remains (`rg "Number\(c\.req\.param" apps/server/src/http` prints nothing). A `null` id answers that route's not-found response, in the position the route already checks the row (body validation that runs before the row lookup today still runs first):

| Route | `null` id answers |
| --- | --- |
| `GET /runs/:id`, `PATCH /runs/:id`, `POST /runs/:id/gaps`, `GET /runs/:id/price-history` | 404 `{ error: 'not found' }` (existing) |
| `POST /runs/:id/pool` | 404 `{ error: 'not found' }`; **new: an unknown canonical id answers the same** (today: 200, a stray `pool_edits` row) |
| `POST /runs/:id/fills` | 404 `{ error: 'not found' }`; **new: an unknown canonical id answers the same** (today: 422 with a TypeError message) |
| `GET /runs/:id/orders`, `/fills`, `/notifications` | 200 `[]`, what an unknown id answers today |
| `POST /runs/:id/orders/:orderId/cancel` (either id) | 404 `{ error: 'order-not-found' }`, checked before the body and the reason |
| `PUT /runs/:id/fills/:fillId` | run id: 404 `{ error: 'no-run' }`; fill id: 422 `{ error: 'no-fill' }` (after the run check) |
| `DELETE /runs/:id/fills/:fillId` | fill id: 422 `{ error: 'no-fill' }` (replaces the `/^\d+$/` check and its `not-last` answer, same position); run id: 404 `{ error: 'no-run' }` |
| `POST /runs/:id/recalc` | 404 `{ error: 'no-run' }` |
| `POST /pending/:id/confirm`, `POST /pending/:id/reject` | 409 `{ error: 'not-pending' }`, before the body is read |

- [ ] **Step 1: Write the failing tests** in `apps/server/test/http-strict-ids.test.ts` with `makeFakes`, `makeDeps`, `loginAs`, `createRun`, `postFill`, `json` from `./http-fakes`. `const RAW = ['0x1', '1e0', '+1', '01']` (each one `Number()`s to 1). Each describe seeds run 1 (`createRun(app, auth, { name: 'r', ticker: 'AAPL', costPpm: 0, poolCents: 100000 })`, `expect(id).toBe(1)`), and:
  - describe "runs routes": one buy fill via `postFill` (fill 1), one open order via `f.repos.orderRepo.insertMany([{ runId: 1, tradeDate: '2026-11-10', kind: 'sell_loc', bucketIdx: 0, limitPrice: 110000n, shares: 1, status: 'open' }])` (order 1), one notification via `f.repos.notificationRepo.insert({ runId: 1, chatId: '42', text: 'n' })`. Tests:
    - `'a non-canonical id never reads a run'`: for each RAW, `GET /runs/<raw>` and `GET /runs/<raw>/price-history` are 404 `{ error: 'not found' }`; `GET /runs/<raw>/orders`, `/fills`, `/notifications` are 200 `[]`; and `GET /runs/1/fills` still has length 1.
    - `'a non-canonical id never changes a run'`: for each RAW, `PATCH /runs/<raw>` `{ status: 'paused' }`, `POST /runs/<raw>/pool` `{ amountCents: 5 }`, `POST /runs/<raw>/gaps` `{ buyGapPpm: 1, sellGapPpm: 2 }` and `POST /runs/<raw>/fills` `{ side: 'buy', shares: 1, price: '10.00', filledOn: '2026-11-10' }` are 404 `{ error: 'not found' }`; afterwards `f.runs[0]` still has `status: 'active'`, `poolCents: 100000`, `buyGapPpm: 0`, `f.poolEdits` is empty and `f.fills` has length 1.
    - `'an unknown run id is 404 on pool and manual fill, and writes nothing'`: `POST /runs/999/pool` and `POST /runs/999/fills` are 404 `{ error: 'not found' }`; `f.poolEdits` empty, `f.fills` length 1.
    - `'cancel answers order-not-found for a non-canonical id even with a bad reason'`: `POST /runs/0x1/orders/1/cancel` and `POST /runs/1/orders/01/cancel` with `{ reason: 'other' }`, and `POST /runs/1/orders/1e0/cancel` with `{ reason: 'nope' }`, are 404 `{ error: 'order-not-found' }`; `f.orders[0].status` is `'open'`; `f.sent` is empty.
  - describe "fills routes": one buy fill (fill 1, shares 2). Tests:
    - `'a non-canonical run id never edits, deletes or recalcs'`: for each RAW, `PUT /runs/<raw>/fills/1` `{ qty: 1, priceCents: 100, feeCents: 0 }`, `DELETE /runs/<raw>/fills/1` and `POST /runs/<raw>/recalc` are 404 `{ error: 'no-run' }`.
    - `'a non-canonical fill id is no-fill and leaves the fill alone'`: for each RAW, `PUT /runs/1/fills/<raw>` (same body) and `DELETE /runs/1/fills/<raw>` are 422 `{ error: 'no-fill' }`; afterwards `f.fills` is `[fill 1 with shares 2]`, the ledger length is unchanged and `f.states.get(1)!.cashCents` is unchanged.
  - describe "pending routes": `f.repos.pendingRepo.insert({ runId: 1, captureId: null, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 3, price: 100000n, fee: null, filledOn: '2026-11-10', status: 'pending' })` (pending 1). Test `'a non-canonical id never confirms or rejects'`: for each RAW, `POST /pending/<raw>/confirm` `{}` and `POST /pending/<raw>/reject` `{}` are 409 `{ error: 'not-pending' }`; afterwards `f.pending[0].status` is `'pending'` and `f.fills` is empty.

In `http-fills.test.ts`, rename "DELETE non-integer fillId -> 422 not-last" to "DELETE non-canonical fillId -> 422 no-fill" and expect `{ error: 'no-fill' }` for `'abc', '1.5', '-2'`.

- [ ] **Step 2: Run them to verify they fail.** `bun test apps/server/test/http-strict-ids.test.ts apps/server/test/http-fills.test.ts` — expected: FAIL (non-canonical ids reach row 1: 200s, changed rows; the unknown-run pool answers 200).

- [ ] **Step 3: Implement** per the table. Pattern for a route that looks the row up: `const id = parseId(c.req.param('id'))` then `const run = id === null ? null : await deps.repos.runRepo.get(id)` (as `GET /sim/:id` does). For pool and manual fill, add that lookup (after the existing body validation in pool; before `manualFill` in the fills POST). For the list routes, `if (id === null) return c.json([])`. Downstream calls take the narrowed `number`.

- [ ] **Step 4: Run the tests.** `bun test apps/server` and `bun run typecheck` — expected: PASS (including `http-runs.test.ts`, `http-recalc.test.ts`, `http-pending-confirm.test.ts`, `http-sibling-notify.test.ts`).

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/http/routes/runs.ts apps/server/src/http/routes/fills.ts apps/server/src/http/routes/pending.ts apps/server/test/http-strict-ids.test.ts apps/server/test/http-fills.test.ts
git commit -m "fix: runs, fills and pending routes accept canonical ids only (#63)"
```

---

### Task 6: index `orders` and the sim sweep tables (#58 performance item; #72 sweep indexes)

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`orders`, `simRuns`, `simDays`)
- Create (generated): `apps/server/db/migrations/0009_<drizzle-name>.sql`, `apps/server/db/migrations/meta/0009_snapshot.json`, update `meta/_journal.json`
- Modify: `apps/server/test/migration-sql.test.ts`

**Interfaces:**
- Produces four indexes (names are pinned by the test):
  - `orders_run_trade_date_idx` on `orders (run_id, trade_date)` — serves `orderRepo.listForRunFrom` (the read inside the run lock), `listForRun`;
  - `orders_trade_date_idx` on `orders (trade_date)` — serves `listForDate` (also read inside the lock by a buy booking), `listOpenBefore`, `markStale`;
  - `sim_runs_draft_created_idx` on `sim_runs (draft, created_at)` — serves `sweepDrafts`;
  - `sim_days_sim_run_idx` on `sim_days (sim_run_id)` — serves `listDays`, `rewriteDraft`, `deleteRun`, `sweepDrafts`.

- [ ] **Step 1: Write the failing test** in `migration-sql.test.ts`, a second describe that reads every `*.sql` in the migrations directory (same `Bun.Glob` approach as the 0007 test) into one string and asserts each of:

```ts
const want = [
  /CREATE INDEX `orders_run_trade_date_idx` ON `orders` \(`run_id`,`trade_date`\)/,
  /CREATE INDEX `orders_trade_date_idx` ON `orders` \(`trade_date`\)/,
  /CREATE INDEX `sim_runs_draft_created_idx` ON `sim_runs` \(`draft`,`created_at`\)/,
  /CREATE INDEX `sim_days_sim_run_idx` ON `sim_days` \(`sim_run_id`\)/,
]
for (const re of want) expect(all).toMatch(re)
```

Title: `'the orders and sim sweep indexes exist'`.

- [ ] **Step 2: Run it to verify it fails.** `bun test apps/server/test/migration-sql.test.ts` — expected: FAIL (no such CREATE INDEX).

- [ ] **Step 3: Implement.** Add a third argument to `mysqlTable` for `orders`, `simRuns` and `simDays`, in the style of `visionReviews` (`(t) => ({ runTradeDateIdx: index('orders_run_trade_date_idx').on(t.runId, t.tradeDate), ... })`). Then run `bun run --cwd apps/server db:generate` (no database needed). Check the generated SQL holds exactly the four `CREATE INDEX` statements and nothing else; if plans A or B added a migration first, the number is the next free one. Do not hand-edit the generated files.

- [ ] **Step 4: Run the tests.** `bun test apps/server/test/migration-sql.test.ts` — expected: PASS. With the scratch DB up: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db.test.ts apps/server/test/db-vision-janitor.test.ts` — expected: PASS (both apply all migrations). `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts` — expected: the final summary reports no failed check (it migrates a fresh scratch DB).

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/db/schema.ts apps/server/db/migrations apps/server/test/migration-sql.test.ts
git commit -m "perf: index orders by run and trade date, and the sim tables the draft sweep scans (#58, #72)"
```

---

**Controller amendment (cross-plan check) for Task 6 (#58 item plan A left to this task):** in `apps/server/test/db.test.ts`, test `orderRepo.listForRunFrom bounds by trade date and run`, insert the later-dated row before the earlier one, so id order differs from trade-date order; keep the id-order assertion. With the new `(run_id, trade_date)` index the scan would then return rows out of id order if `.orderBy(s.orders.id)` were dropped, so the assertion can fail. Show it bites (temporarily drop the `.orderBy`, run the file alone with `TEST_DATABASE_URL`, record the failure, restore). Add the test file to this task's commit and name the item in the #58 line of "Issue closing".

### Task 7: Yahoo's unknown-symbol 404 is `no-data`; an unreachable provider is `http` (#71)

**Files:**
- Modify: `packages/market-data/src/yahoo.ts` (`fetchDailyBars`, `fetchLastClose`)
- Test: `packages/market-data/test/yahoo.test.ts`

**Interfaces:**
- Produces: `MarketDataError` kinds unchanged (`'no-data' | 'http'`). In both functions: a response with `status === 404` whose JSON body has `chart.error.code === 'Not Found'` throws `MarketDataError('no-data')`; any other non-OK answer stays `http` (the existing 400 "Data doesn't exist" rule in `fetchDailyBars` stays). A rejected `fetchImpl(url)` throws `MarketDataError('http', String(cause))`.
- Effect downstream (no code change there): `POST/PUT /api/sim` answer 502 `market-data:no-data` for a mistyped or delisted ticker and 502 `market-data:http` for an unreachable provider (was a raw-text 500). `makeCachedBarReader` (`apps/server/src/market/bars.ts`) writes no coverage when every gap is `no-data` (it throws first), so a typo never poisons `bar_coverage`. The morning pipeline treats both kinds alike. Plan D changes the copy (see "Handoff to plan D").

- [ ] **Step 1: Write the failing tests.** In "any other non-OK response is still an http error", remove the `notFound` 404 line and add an HTML 404: `respond('<html>Not Found</html>', 404)` → `kind: 'http'`. Add:

```ts
test("Yahoo's 404 for an unknown or delisted symbol is no-data, for bars and for the last close", async () => {
  const notFound = `{"chart":{"result":null,"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}`;
  const fetchImpl = () => Promise.resolve(new Response(notFound, { status: 404 }));
  await expect(fetchDailyBars('ZZZZQ', '2026-02-01', '2026-02-05', fetchImpl as any)).rejects.toMatchObject({ kind: 'no-data' });
  await expect(fetchLastClose('ZZZZQ', fetchImpl as any)).rejects.toMatchObject({ kind: 'no-data' });
});

test('a provider that cannot be reached is an http error carrying the cause', async () => {
  const fetchImpl = () => Promise.reject(new TypeError('Failed to fetch'));
  const err = await fetchDailyBars('X', '2026-02-01', '2026-02-05', fetchImpl as any).catch((e) => e);
  expect(err).toBeInstanceOf(MarketDataError);
  expect(err).toMatchObject({ kind: 'http' });
  expect(err.message).toContain('Failed to fetch');
  await expect(fetchLastClose('X', fetchImpl as any)).rejects.toMatchObject({ kind: 'http' });
});
```

- [ ] **Step 2: Run them to verify they fail.** `bun test packages/market-data` — expected: FAIL (404 is `http`; the rejected fetch is a bare `TypeError`).

- [ ] **Step 3: Implement** one private helper in `yahoo.ts`, `async function request(url: string, fetchImpl: typeof fetch): Promise<Response>`, that wraps the rejection, and one `async function notOkError(res: Response, allowNoDataRange: boolean): Promise<MarketDataError>` that reads the body once and applies the 400 rule (only when `allowNoDataRange`, i.e. from `fetchDailyBars`) and the 404 rule; both fetch functions use them.

- [ ] **Step 4: Run the tests.** `bun test packages/market-data apps/server/test/http-sim-drafts.test.ts apps/server/test/bars.test.ts` and `bun run typecheck` — expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/market-data/src/yahoo.ts packages/market-data/test/yahoo.test.ts
git commit -m "fix: read Yahoo's unknown-symbol 404 as no-data and an unreachable provider as http (#71)"
```

---
### Task 8: server test reach (#72)

Plan B edits `apps/server/src/main.ts` (`send` wiring) first; the new test reads it by symbol, not line. Task 4 already added a `visionReviewRepo` stub to the `runBootSweeps` calls in `boot-sweeps.test.ts` and `db-sim-list.test.ts`; keep it.

**Files:**
- Create: `apps/server/test/bars-fakes.ts`; Modify: `apps/server/test/bars.test.ts`, `apps/server/test/bars-chunking.test.ts`
- Modify: `apps/server/test/boot-sweeps.test.ts` (test "the DST test leaves the process in UTC")
- Modify: `apps/server/test/db-sim-list.test.ts` (whole suite onto a scratch database)
- Modify: `apps/server/test/sim.test.ts` (in-file fake `listRuns`)
- Create: `apps/server/test/main-boot-order.test.ts`

**Interfaces:**
- Produces, in `apps/server/test/bars-fakes.ts`: `export function day(date: string, n = 1): string`, `export function mkBar(date: string): OHLCBar`, `export function makeUpstream()` — moved verbatim from `bars.test.ts` (the superset: `ranges`, `tickers`, `missing`, `failFrom`, `shuffle`, `calls`, `reset()`); `bars-chunking.test.ts` uses the same three (its `reset()` now also clears `tickers`, which it never reads).

- [ ] **Step 1: Shared bar fakes.** Move the three helpers into `bars-fakes.ts`, import them in both test files, delete the copies. Run `bun test apps/server/test/bars.test.ts apps/server/test/bars-chunking.test.ts` — expected: PASS, same test count as before (record it from a run before the move).

- [ ] **Step 2: Write the zone test.** In `boot-sweeps.test.ts`, capture the process zone at module load, before any test runs: `const offsetAtLoad = new Date('2026-07-01T12:00:00Z').getTimezoneOffset()`, and replace the test "the DST test leaves the process in UTC" with:

```ts
test('the DST test restores the zone the process started in', () => {
  expect(new Date('2026-07-01T12:00:00Z').getTimezoneOffset()).toBe(offsetAtLoad)
})
```

Also update the comment in the DST test ("the test process runs in UTC" becomes "the default runner zone is UTC"), and keep its restore line as is.

- [ ] **Step 3: Verify it under a non-UTC zone.** `TZ=Asia/Seoul bun test apps/server/test/boot-sweeps.test.ts` — expected: PASS (before the change this command FAILS on the old zone check: offset -540, not 0). Then `bun test apps/server/test/boot-sweeps.test.ts` — expected: PASS.

- [ ] **Step 4: `db-sim-list.test.ts` on a scratch database.** Mirror `db-vision-janitor.test.ts`: `const SCRATCH = \`st_simlist_${Date.now().toString(36)}_${process.pid.toString(36)}\``, the same name-guard regex (`/^st_simlist_[a-z0-9]+_[a-z0-9]+$/`), `CREATE DATABASE` on the parent connection, `applyMigrations` on the scratch connection, and an `afterAll` that drops it and ends both connections. With the database private, tighten "sweepDrafts returns the number of runs it deleted" from `toBeGreaterThanOrEqual(2)` to `toBe(2)` and delete its "st_test is shared" comment. Run `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db-sim-list.test.ts` — expected: PASS; then check two processes no longer race: run the same command twice in parallel (`... bun test apps/server/test/db-sim-list.test.ts & ... bun test apps/server/test/db-sim-list.test.ts & wait`) — expected: both PASS.

- [ ] **Step 5: Newest-first fake in `sim.test.ts`.** The in-file sim repo fake's `listRuns` becomes `async listRuns() { return [...runs].sort((a, b) => b.id - a.id) }` (matching `http-fakes.ts` and the real `simRepo.listRuns`). Run `bun test apps/server/test/sim.test.ts` — expected: PASS.

- [ ] **Step 6: Pin the boot order.** Create `apps/server/test/main-boot-order.test.ts`:

```ts
import { test, expect } from 'bun:test'

// main() has no seam to inject a fake bot or server, so the order is pinned on the source: the
// screenshot janitor and the review rebuild are only safe while no confirm can be in flight.
test('main runs the boot sweeps before it starts the bot, the jobs and the HTTP server', async () => {
  const src = await Bun.file(new URL('../src/main.ts', import.meta.url)).text()
  const at = (needle: string) => { const i = src.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i }
  const sweeps = at('await runBootSweeps(')
  for (const later of ['createBot(', 'startJobs(', 'Bun.serve(']) expect(sweeps).toBeLessThan(at(later))
})
```

Run `bun test apps/server/test/main-boot-order.test.ts` — expected: PASS. Sanity check that it can fail: temporarily move the `runBootSweeps` line below `Bun.serve(` and rerun — expected: FAIL; restore it.

- [ ] **Step 7: Full gate and commit.** `bun run typecheck && bun test` — expected: PASS.

```bash
git add apps/server/test/bars-fakes.ts apps/server/test/bars.test.ts apps/server/test/bars-chunking.test.ts apps/server/test/boot-sweeps.test.ts apps/server/test/db-sim-list.test.ts apps/server/test/sim.test.ts apps/server/test/main-boot-order.test.ts
git commit -m "test: shared bar fakes, zone-independent boot sweep check, scratch db for the sim sweep, boot order pin (#72)"
```

---

**Controller amendment (cross-plan check) for Task 8:** update the `AGENTS.md` repo map for every file plans C's Tasks 1 to 8 added (the new test files, `bars-fakes.ts`, any new source module) and include `AGENTS.md` in the Task 8 commit.

### Task 9: jittered backoff on the coverage-merge deadlock retry (#72)

**Files:**
- Modify: `apps/server/src/db/repos-bars.ts` (`getBarRepos`, `barCoverageRepo.add`)
- Test: `apps/server/test/db-bar-coverage-lock.test.ts` (describe "barCoverageRepo.add retry policy", not DB-gated)

**Interfaces:**
- Produces: `export function deadlockBackoffMs(attempt: number, random: () => number = Math.random): number` = `5 * 2 ** (attempt - 1) + Math.floor(random() * 5)` (attempt 1..4 gives 5, 10, 20, 40 ms plus 0-4 ms jitter; at most 95 ms over a full retry run). `getBarRepos(db: any, opts: { sleep?: (ms: number) => Promise<void>; random?: () => number } = {})`, defaults `Bun.sleep` and `Math.random`; `getRepos` keeps calling `getBarRepos(db)`. `add` sleeps `deadlockBackoffMs(attempt)` after a deadlock on attempt 1-4 and never after the last attempt or a non-deadlock error. Still five attempts.

- [ ] **Step 1: Write the failing tests.** Extend `stubbed(failures)` to pass `{ sleep: async (ms) => { delays.push(ms) }, random: () => 0 }` and return `delays`. Assert: "add retries a deadlock and succeeds on the fifth attempt" also `expect(s.delays).toEqual([5, 10, 20, 40])`; "add gives up after five deadlocks" `expect(s.delays).toEqual([5, 10, 20, 40])`; "add does not retry any other error" `expect(s.delays).toEqual([])`. New:

```ts
test('the backoff doubles per attempt with up to 4 ms of jitter', () => {
  expect([1, 2, 3, 4].map((a) => deadlockBackoffMs(a, () => 0))).toEqual([5, 10, 20, 40])
  expect(deadlockBackoffMs(1, () => 0.999)).toBe(9)
})
```

- [ ] **Step 2: Run to verify failure.** `bun test apps/server/test/db-bar-coverage-lock.test.ts` — expected: FAIL (`deadlockBackoffMs` not exported; `delays` empty).

- [ ] **Step 3: Implement** as specified; one comment on the sleep: "jitter keeps two first writers from retrying in lockstep".

- [ ] **Step 4: Run the tests.** `bun test apps/server/test/db-bar-coverage-lock.test.ts` — expected: PASS. With the DB: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db-bar-coverage-lock.test.ts apps/server/test/bars-db.test.ts` — expected: PASS. `bun run typecheck` — expected: no errors.

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/db/repos-bars.ts apps/server/test/db-bar-coverage-lock.test.ts
git commit -m "fix: back off with jitter between coverage-merge deadlock retries (#72)"
```

---
