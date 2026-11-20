# Type safety, hygiene and test gaps (wave C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Check every in-memory repo fake against the real repo surface at compile time, type the two remaining `any` seams in the vision-review path, and pin the behaviour that is correct today but has no test.

**Architecture:** No product behaviour changes and no new production modules. `bun run typecheck` already covers `apps/server/test`. `apps/server/tsconfig.json` includes `["src", "test"]`, and the root `tsc -b` builds that project. This was verified on `main` on 2026-11-18: deleting a method from a fake after removing `as any` fails with TS2741. Only the casts stop the check from catching drift, so no new tsconfig is needed. The fakes are typed with slot annotations (`HttpRepoSurface['x']`) or with `satisfies RepoSurface`. Slot annotations reject a missing or extra method. `satisfies` on the assembled object (`booking-fakes.ts`, `day.test.ts`) rejects only a missing slot or method, because its slots are shorthand references rather than fresh literals; it keeps the literal's own type for test call sites. Test files that would pass ~300 lines are split by topic instead of grown.

**Tech Stack:** Bun, TypeScript (`tsc -b`), Hono, Drizzle (MariaDB), React + happy-dom, `bun:test`.

**Spec:** No design spec. Sources: GitHub #48 (`gh issue view 48`, sections "Type safety / drift" and "Test coverage gaps"), and `docs/superpowers/followups/2026-11-17-pending-vision-review-followups.md` (sections "Code hygiene" and "Test gaps"). Each task cites its bullets.

**Models (operator ruling 2026-11-20):** implementer subagents run on `anthropic/claude-sonnet-5-5`; per-task reviewers, the whole-branch reviewer and any plan amendments run on `anthropic/claude-fable-5-2`. Pass these as the subagent `model` parameter.

Branch: `test/type-safety-and-gaps` in a dedicated worktree, cut from `main` after waves A and B have merged. Wave A is `docs/superpowers/plans/2026-11-18-sell-attribution.md` and wave B is `2026-11-18-server-hardening.md`. This plan assumes their results:

- From wave A:
  - `apps/server/test/booking-fakes.ts` exports `fakeRepos`, `silentNotifier` and `recordingNotifier`, and every former `./booking.test` importer uses it.
  - `RepoSurface.orderRepo.listForRunFrom` exists.
  - `FillBookingDeps` carries `notify: BookingNotifier`.
  - `booking-notify.ts`, `order-ops.ts` and `wire/booking-notifier.ts` exist.
- From wave B (`docs/superpowers/plans/2026-11-18-server-hardening.md`):
  - `apps/server/src/wire/boot-sweeps.ts` exports `runBootSweeps(repos, now)`, which owns `SIM_DRAFT_MAX_AGE_DAYS = 7` (its Task 6). Wave B tests that the cutoff argument equals `now − 7 d`.
  - `RepoSurface.captureImageRepo` gains `discard`, and the real repo gains `sweepOrphans`.
  - `simRepo.listRuns` is ordered in SQL and the `http-fakes.ts` fake mirrors that.
  - `apps/server/test/http-pending-routes.test.ts` and `apps/server/test/db-sim-list.test.ts` exist.
  - `scripts/e2e-vision-review.ts` asserts `archived === true` on `confirmA`.
  - The stale `replaceDays` line in the cut-loss spec is already fixed (its Task 3).
- Wave D (`2026-11-18-web-polish-a11y.md`) has merged before this wave (the order is A, B, D, C). From wave D:
  - Its Task 8 replaced the review tab's failed-delete test and may have created `apps/web/src/pages/VisionReviewDelete.test.tsx`. Task 8 below therefore skips its own failed-delete test.
  - Confirming a pending row with a blank fee opens a `DefaultFeePrompt` popup first; edited and erased fields carry `data-edit`.
  - `PendingRow.test.tsx`, `PendingDefaultFee.test.tsx` and `fieldeditstate.test.ts` exist.

Before starting, re-read every line number below against the merged tree, because A and B move code.

## Global Constraints

- English only in code, comments and docs. Never use Chinese or Cyrillic characters. UI copy goes in `apps/web/src/i18n/{en,ko}.json`, and this wave adds none.
- No source file over ~300 lines. Split a file by responsibility rather than grow it past that.
- Money is bigint myriadths and cost is integer ppm. Never use floats.
- `packages/*` never import `apps/*`.
- Schedules use `America/New_York`.
- Commit style is `feat|fix|docs|test|refactor|chore:`.
- No product behaviour change. If a new test fails against current behaviour, stop and report. Do not "fix" the product in this wave.

## Review Focus

1. **A fake grows a method the real repo lacks, or misses one it gained.** Expected: `bun run typecheck` fails. Task 1 Step 3 and Task 2 Step 2 each prove it by deleting a method and watching tsc fail.
2. **A draft created 7 New York calendar days ago, across the 2026-11-01 DST change.** The window is 168 elapsed hours, not wall-clock days. A draft created at 12:00 EDT on Oct 27 is 169 h old at 12:00 EST on Nov 3, so it is swept. Pinned in Task 5, `the window is 168 elapsed hours even across the fall-back change`.
3. **MariaDB session time zone versus the JS cutoff.** A draft 60 s inside the window must survive, and one 60 s outside must be swept, whatever the server's time zone. Pinned in Task 5 by the DB boundary test in `db-sim-list.test.ts`.
4. **A legacy pending row** (`detectedAt` null, every `detected*` null) flows through the newly typed `resolveReview`. It must still freeze `edited: false`. Pinned in Task 3 by the new test `a legacy row resolved with a capture freezes edited false`.
5. **A test split silently drops a test.** The `test(` / `it(` count across the new files must equal the count in the original. Checked in Task 4 Step 2 and Task 8 Step 2.

---

### Task 1: HTTP fakes typed against `HttpRepoSurface` (#48 "http-fakes `as any`"; followups "Test gaps" sim fake)

**Files:**
- Modify: `apps/server/test/http-fakes.ts` (~:19-251: each repo const, and the `as any` at :251)
- Modify: `apps/server/test/sim.test.ts` (`describe('routes')`, ~:421-468: drop the local `makeFakes`/`makeDeps`/`auth`)
- Modify: `apps/server/test/bars.test.ts:53,220` (drop `f.repos as any`)

**Interfaces:**
- Produces: `makeFakes().repos` is a fully checked `HttpRepoSurface`, with the same return shape as before.

- [ ] **Step 1: Type each fake by its slot.** Annotate every repo const in `makeFakes` as `const <name>: HttpRepoSurface['<name>'] = { … }`. That covers `bucketRepo`, `runRepo`, `orderRepo`, `fillRepo`, `pendingRepo`, `captureRepo`, `captureImageRepo`, `visionReviewRepo`, `ledgerRepo`, `notificationRepo`, `settingsRepo`, `poolEditRepo`, `simRepo`, `priceHistoryRepo` and `barCoverageRepo`.
  - Delete the `: any` / `: any[]` annotations on method parameters, so contextual typing supplies the real types (`insertIgnore(row)`, `insertRun(i)`, `decide(id, status, edited?)` and so on).
  - Keep the internal store arrays (`runs: any[]` …) as they are.
  - Remove `as any` from the `repos` literal.
- [ ] **Step 2: Run `bun run typecheck`.** Expected: exit 0. A trial on `main` compiled cleanly. If waves A or B left drift, tsc reports it here. Fix the **fake** to match the real repo, never the reverse.
- [ ] **Step 3: Prove the check bites.** Temporarily delete `existingIds` from the `captureImageRepo` fake and run `bun run typecheck`. Expected: TS2322 whose message says `Property 'existingIds' is missing` (the slot type is an intersection, so it is not TS2741). Restore it and re-run. Expected: exit 0.
- [ ] **Step 4: Put the sim route tests on the shared fakes.** In `sim.test.ts` `describe('routes')`:
  - Import `makeFakes as makeHttpFakes`, `makeDeps` and `loginAs` from `./http-fakes`.
  - Build deps as `{ ...makeDeps(fakes), fetchDailyBars: async () => bars }`.
  - Delete the local `makeFakes`, `PASSWORD`, `SECRET`, `makeDeps` and `auth`, plus the now-unused `HttpDeps`/`HttpRepoSurface` imports.
  - Tests `case 9`, `case 10` and `case 11` keep their assertions unchanged.
- [ ] **Step 5: Remove `as any` from `f.repos` at `bars.test.ts:53,220`.** `HttpRepoSurface` is assignable to `BarCacheRepos`.
- [ ] **Step 6: Run `bun test apps/server/test` and `bun run typecheck`.** Expected: all pass, exit 0.
- [ ] **Step 7: Commit** `test: type the HTTP fakes against HttpRepoSurface (no as-any)`.

### Task 2: Booking and pipeline fakes typed against `RepoSurface`; conflicts-only capture-image case (followups "Test gaps" bullets 1 and 3)

**Files:**
- Modify: `apps/server/test/booking-fakes.ts` (created by wave A; the `repos` literal returned by `fakeRepos`)
- Modify: `apps/server/test/day.test.ts` (~:10-52, `makeRepos`)
- Modify: `apps/server/test/capture-image.test.ts` (rename the test at ~:32, add one test)

**Interfaces:**
- Consumes: `fakeRepos` from `./booking-fakes` (wave A). Its `_stores` include `captures`, `pending`, `captureImages` and `fills`.
- Produces: `fakeRepos().repos` keeps its own literal type, and that type now `satisfies RepoSurface`.

- [ ] **Step 1: Make the omission a compile error.**
  - In `booking-fakes.ts`, write the returned `repos` literal as `{ … } satisfies RepoSurface`. Add the missing slot as `notificationRepo: { async insert(_n: unknown) {} }`, because `RepoSurface` requires it and the fake lacks it today.
  - In `day.test.ts`, change `const repos: any` to `const repos: RepoSurface` (import the type from `../src/domain/booking`). Fix the three drifts tsc reports on `main` (it reports the third only after the first two are fixed):
    - `orderRepo` lacks `get`. Add `async get(id: number) { return orders.find((x) => x.id === id) ?? null }`.
    - The inline `pendingRepo.decide` returns `void`. Make it `async () => false`.
    - `correctionRepo` is missing. Add `correctionRepo: fakeCorrectionRepo().repo`, imported from `./fake-corrections`.
  - tsc will also report the slots waves A and B added that these two fakes never received, for example wave B's `captureImageRepo.discard`. Give each one a minimal in-memory implementation in the fake.
- [ ] **Step 2: Run `bun run typecheck`, then prove it bites.** Expected: exit 0. Then temporarily remove `visionReviewRepo` from the `day.test.ts` literal. Expected: TS2741 naming `visionReviewRepo`. Restore it.
- [ ] **Step 3: Write the pinning test** in `capture-image.test.ts`. Also rename `ingestCapture stores no image when the extract produced no pending fills` to `an unparseable extract stores no image (it returns before the store gate)`, keeping its body. Add `type CaptureConflict` to the existing `../src/domain/booking` import.
  ```ts
  test('a conflicts-only capture stores no image', async () => {
    const { f, deps, runId } = await setup()
    await f.repos.fillRepo.insert({ runId, bucketIdx: 0, side: 'buy', ticker: 'AAPL', shares: 1, price: parseUsd('10.00'), fee: 0, filledOn: '2026-11-05', source: 'manual' })
    const ext: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker: 'AAPL', shares: 1, price: '10.50', date: '2026-11-05' }] }
    const out = await ingestCapture(runId, PNG, ext, deps) as { conflicts: CaptureConflict[] }
    expect(out.conflicts.length).toBe(1)
    expect('pending' in out).toBe(false)
    expect(f._stores.captures.length).toBe(1)   // the claim ran, so the extract did not return early
    expect(f._stores.pending.length).toBe(0)
    expect(f._stores.captureImages.length).toBe(0)
  })
  ```
- [ ] **Step 4: Prove the test pins the gate.** Temporarily change `if (pendingRows.length > 0) await storeCaptureImage(…)` in `apps/server/src/domain/booking.ts` to run unconditionally. Run `bun test apps/server/test/capture-image.test.ts`. Expected: the new test FAILS with `captureImages.length` 1. Revert, then re-run. Expected: PASS.
- [ ] **Step 5: Run `bun test apps/server/test` and `bun run typecheck`.** Expected: green.
- [ ] **Step 6: Commit** `test: check booking and pipeline fakes against RepoSurface; pin the capture-image store gate`.

### Task 3: Narrow types on the vision-review seam; `detected_at` comment (followups "Code hygiene" bullets 1, 2 and 6)

**Files:**
- Modify: `apps/server/src/domain/vision-review.ts:76` (`pendingRow: any`)
- Modify: `apps/server/src/domain/booking.ts`: `RepoSurface.pendingRepo.decide` (~:49) and `const edited: any` (~:160). Wave A edits `BookingDeps` only, so this does not collide.
- Modify: `apps/server/src/db/repos.ts:142-147` (real `decide`)
- Modify: `apps/server/src/db/schema.ts:75-82` (comment only, no migration)
- Test: `apps/server/test/vision-review.test.ts` (~:177, plus a type pin)

**Interfaces:**
- Produces, in `vision-review.ts`:
  ```ts
  export interface ReviewedPendingRow {
    id: number; runId: number; ticker: string
    detectedSide: string | null; detectedShares: number | null; detectedPrice: bigint | null
    detectedFilledOn: string | null; detectedFee: number | null; detectedAt: string | null
  }
  ```
  `resolveReview`'s `args.pendingRow: ReviewedPendingRow`.
- Produces, in `booking.ts`: `export interface PendingDecisionPatch { side: 'buy' | 'sell'; shares: number; price: bigint; fee: number; filledOn: ISODate; bucketIdx: number }`, and `RepoSurface.pendingRepo.decide(id: number, status: 'confirmed' | 'rejected', edited?: PendingDecisionPatch): Promise<boolean>`.

- [ ] **Step 1: Write the type pin and update the legacy case.**
  - In `vision-review.test.ts`, add `import type { pendingFills } from '../src/db/schema'` and the line below. The real repo's row types come back as `any` (its `db` is `any`), so the schema row is the strongest thing tsc can check against.
    ```ts
    // A pending_fills row must carry every column resolveReview reads; a rename fails tsc here.
    const asReviewed = (r: typeof pendingFills.$inferSelect): ReviewedPendingRow => r
    ```
  - The `a manual row (no capture) is a no-op` call at ~:177 passes `{ id: 1, runId: 1, ticker: 'AAPL' }`. Pass the full row instead: `{ id: 1, runId: 1, ticker: 'AAPL', detectedSide: null, detectedShares: null, detectedPrice: null, detectedFilledOn: null, detectedFee: null, detectedAt: null }`. Its assertions stay as they are.
  - Add the test `a legacy row resolved with a capture freezes edited false`:
    - Take `fakeRepos()` and insert an image for capture `7` with `captureImageRepo.insertIgnore`.
    - Call `resolveReview(f.repos, { pendingRow: <the full-null row above with id 2>, captureId: 7, outcome: 'confirmed', final: final({ shares: 99 }), keepImage: true, feeOverride: undefined })`.
    - Expect `f._stores.visionReviews` to have length `1`, with `edited` `false` and `detectedShares` `null`.
- [ ] **Step 2: Run `bun run typecheck`.** Expected: FAIL. `ReviewedPendingRow` and `PendingDecisionPatch` are not exported yet.
- [ ] **Step 3: Implement the interfaces above.**
  - Keep the `?? null` guards inside `resolveReview`: fake rows can omit the columns at runtime.
  - In `bookUnlocked`, type the patch as `const edited: PendingDecisionPatch`.
  - In the real `decide`, take the same parameter types and build the patch as `{ status, ...edited }` with no `any`. The `(res as any)?.affectedRows` read stays, because `db` is `any`.
- [ ] **Step 4: Replace the comment at `schema.ts:75-76` with:**
  ```ts
  // Vision snapshot frozen at insert. Nulls are honest "vision missed it".
  // detectedAt is date-granular: ingest writes the ET booking day (deps.today), stored as
  // midnight of that date. Only its presence is ever read (null = row predates the snapshot).
  ```
  Comment only, so no `db:generate` is needed. `git status` must not show `db/migrations` changes.
- [ ] **Step 5: Run `bun run typecheck` and `bun test apps/server/test`.** Expected: exit 0, all pass, including the legacy case's `edited: false`. Prove the pin bites: temporarily rename `detectedFee` in `ReviewedPendingRow` to `detectedFees`. Expected: tsc fails at `asReviewed`. Revert.
- [ ] **Step 6: Commit** `refactor: type the pending row and decide patch on the vision-review path`.

### Task 4: Split `http-pending-settings.test.ts` by route group (followups "Code hygiene" bullet 7)

**Files:**
- Delete: `apps/server/test/http-pending-settings.test.ts` (317 lines on `main`, 23 tests)
- Create: `apps/server/test/http-pending-confirm.test.ts`: the top-level `describe('http pending')` tests (list, confirm, reject, 409/422 paths). The name keeps it apart from wave B's `http-pending-routes.test.ts`, which stays as it is.
- Create: `apps/server/test/http-pending-review.test.ts`: the nested `describe('vision review surface')` with its `DETECTED` and `setup`, re-wrapped as `describe('http pending: vision review surface')`
- Create: `apps/server/test/http-settings.test.ts`: `describe('http settings')`

- [ ] **Step 1: Move the tests verbatim.** Each new file imports only what it uses from `./http-fakes` (and `feeCents` where needed). Any tests wave B added go with the route group they exercise.
- [ ] **Step 2: Check that nothing was dropped.** Run `grep -c "test(" apps/server/test/http-pending-settings.test.ts` before deleting, then the same count over the three new files. Expected: the sums are equal. Run `bun test apps/server/test/http-pending-confirm.test.ts apps/server/test/http-pending-review.test.ts apps/server/test/http-settings.test.ts`. Expected: that many passes. Every new file must be ≤ 300 lines.
- [ ] **Step 3: Run `bun run typecheck`, then commit** `test: split http-pending-settings tests by route group`.

`apps/web/src/viewmodels.ts` is 227 lines on `main` (it was 302), so it is not split. Re-check it with `wc -l`. If it exceeds 300 again after waves A and B, report that rather than split it here.

### Task 5: Server test gaps from #48: sweep window, `cutLossPpm: null`, no `stop-preempted` after a market sell

**Files:** tests only. Wave B's `runBootSweeps` already owns the 7-day constant and the cutoff arithmetic, so no extraction is needed.
- Modify: `apps/server/test/boot-sweeps.test.ts` (wave B)
- Modify: `apps/server/test/db-sim-list.test.ts` (wave B, DB-gated)
- Modify: `apps/server/test/http-runs.test.ts` (`describe('cut-loss')`, ~:331)
- Modify: `apps/server/test/sim.test.ts` (`describe('cut-loss stops')`, ~:145)

**Interfaces:**
- Consumes (wave B): `runBootSweeps(repos: { simRepo: { sweepDrafts(before: Date): Promise<number> }; captureImageRepo: { sweepOrphans(): Promise<number[]> } }, now: Date): Promise<void>`.
- The window is "`createdAt` strictly before `now − 7 × 86_400_000 ms`": `lt` in the real repo, and the fake keeps rows with `>=`.
- Every call below passes `captureImageRepo: { sweepOrphans: async () => [] }` and silences `console.log` with `spyOn(...).mockImplementation`.

- [ ] **Step 1: Write the tests.**
  - `boot-sweeps.test.ts`:
    - `the draft window keeps 6 d and 7 d − 1 s, and sweeps 7 d + 1 s and 8 d`:
      - Use `simRepo` from `makeFakes()` (`./http-fakes`) with `now = new Date('2026-11-18T17:00:00Z')`.
      - Insert four drafts with `insertRun`, passing a full `SimConfig` as `http-sim-drafts.test.ts` does (after Task 1 the fake's parameter is typed). Then overwrite their `simRuns[i].createdAt` with ISO strings for `now` minus 6 d, 7 d − 1 s, 7 d + 1 s and 8 d.
      - Call `runBootSweeps(…, now)`.
      - Expect the surviving `simRuns` ids to equal the first two ids.
    - `the window is 168 elapsed hours even across the fall-back change`:
      - Use `now = new Date('2026-11-03T17:00:00Z')`, which is 12:00 EST.
      - Insert a draft created at `'2026-10-27T16:00:00Z'` (12:00 EDT, seven New York calendar days earlier, 169 h old) and one at `'2026-10-27T17:30:00Z'` (167.5 h old).
      - After `runBootSweeps`, only the second survives.
  - `db-sim-list.test.ts`, test `the boot sweep honours the 7-day window to the minute, whatever the session time zone`:
    - Insert four drafts and one finalized run (`finalize`). Run `UPDATE sim_runs SET created_at = FROM_UNIXTIME(<sec>)` with `<sec>` = `Math.floor(Date.now() / 1000)` minus 6 d, 7 d − 60 s, 7 d + 60 s and 8 d. The finalized run gets 8 d.
    - Call `runBootSweeps({ simRepo: repos.simRepo, captureImageRepo: { sweepOrphans: async () => [] } }, new Date())`.
    - Expect `getRun` to be non-null for the 6 d draft, the 7 d − 60 s draft and the finalized run. Expect null for the 7 d + 60 s and 8 d drafts.
  - `http-runs.test.ts`, test `POST /runs with an explicit cutLossPpm null stores 0; costPpm null is rejected`:
    - POST `{ ...base, cutLossPpm: null }`. Expect `201` and `f.runs.find((x) => x.id === id)!.cutLossPpm` to be `0`.
    - POST `{ ...base, costPpm: null }`. Expect `400`, `error` `'invalid costPpm'`, and `f.runs.length` still `1`.
  - `sim.test.ts`, test `a market sell that empties the bucket leaves no stop-preempted, even with the stop and the target in range`:
    - `market = { kind: 'market_sell', bucketIndex: 0, limitPrice: 0n, shares: 3 }`.
    - Call `resolveDay(heldState(), planOf(market, targetOrder, stopOrder), barOf('99', '102', '96'), 30)`. Target 101 ≤ high 102, and low 96 ≤ trigger 97.
    - Expect `r.events` to equal `[{ type: 'fill', side: 'sell', kind: 'market_sell', bucketIndex: 0, shares: 3, price: parseUsd('99'), feeCents: feeCents(parseUsd('99'), 3, 30) }]` and `r.state.buckets[0]!.state` to be `'empty'`.
- [ ] **Step 2: Run `bun test apps/server/test/boot-sweeps.test.ts apps/server/test/http-runs.test.ts apps/server/test/sim.test.ts` and `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db-sim-list.test.ts`.** Expected: PASS. All four pin existing behaviour. If one fails, stop and report rather than change product code.
- [ ] **Step 3: Prove the window tests bite.** Temporarily change the `7` in wave B's `SIM_DRAFT_MAX_AGE_DAYS` to `8` and re-run `boot-sweeps.test.ts`. Expected: the 6/7/8-day test FAILS (the 7 d + 1 s draft survives). Revert.
- [ ] **Step 4: Run `bun run typecheck`.** Expected: exit 0. **Commit** `test: pin the 7-day draft sweep window, cutLossPpm null, and no stop-preempted after a market sell`.

### Task 6: Web test gaps from #48: cut-loss drift guard, notice codes through `computeOrders`

**Files:**
- Modify: `apps/web/src/cutloss.test.ts`, `apps/web/src/catalog.test.ts:36-50`

- [ ] **Step 1: Write the tests.** Both import `computeOrders` from `@st/strategies` and `emptyState`/`type Run` from `@st/core`. Use the run `{ id: 0, name: 'x', ticker: 'T', strategyKey: 'mean-reversion', costPpm: 0, buyGapPpm: 0, sellGapPpm: 0, cutLossPpm, poolCents, status: 'active' }`.
  - `cutloss.test.ts`, `describe('agrees with the stops the planner places')`, nested inside the existing `describe('underwaterStopCount')` so it can use that block's `held` helper:
    - Loop over `[['1000100', 30_000, 970000n], ['999999', 35_000, 964900n], ['1234567', 500_000, 617200n]]`.
    - Hold bucket 0 of `emptyState(2)` with 10 shares at `BigInt(buy)` and call `computeOrders(run, state, { lastClose: BigInt(buy) })`.
    - Take the `stop_sell` for bucket 0 and expect its `limitPrice` to be the third value.
    - Expect `underwaterStopCount([held(0, buy)], ppm, String(stop))` to be `1` and `underwaterStopCount([held(0, buy)], ppm, String(stop + 1n))` to be `0`.
  - `catalog.test.ts`, replace the regex test with `every notice code computeOrders emits resolves in both catalogs`:
    - Scenario A: `emptyState(1)` with bucket 0 held 10 @ `parseUsd('100')`, run `cutLossPpm: 30_000, poolCents: 1_000_000`, `lastClose: parseUsd('90')`. It emits `no-bucket-available` and `cut-loss-immediate`.
    - Scenario B: `emptyState(10)`, run `cutLossPpm: 0, poolCents: 100`, `lastClose: parseUsd('100')`. It emits `shares-zero`.
    - Collect the distinct codes. Expect, sorted, `['cut-loss-immediate', 'no-bucket-available', 'shares-zero']`.
    - Keep the en/ko `digest.<code>` missing-key assertion, which must be `[]`.
    - Coverage guard: read `mean-reversion.ts` as today and expect `source.match(/notices\.push\(/g)!.length` to equal the number of distinct codes, `3`. A new notice without a scenario then fails here.
- [ ] **Step 2: Run `bun test apps/web/src/cutloss.test.ts apps/web/src/catalog.test.ts` and `bun run typecheck`.** Expected: PASS, exit 0. These tests pin current behaviour. If one fails, stop and report.
- [ ] **Step 3: Commit** `test: guard web cut-loss math against the planner and check notice codes via computeOrders`.

### Task 7: Pending table and dialog gaps (followups "Test gaps" bullets 5 and 6, pending side)

**Files:**
- Create: `apps/web/src/testing/pendingRow.ts`. It exports `PENDING_ROW: PendingFillDto` (the `ROW` fixture from `PendingTable.test.tsx:24-40`) and `setInputValue(el: HTMLInputElement, value: string)` (`:70-76`). Both are DOM-free at import time.
- Modify: `apps/web/src/components/forms/PendingTable.test.tsx` (681 lines). Import those two instead of declaring them, and add nothing else.
- Create: `apps/web/src/components/forms/PendingTable.edge.test.tsx`. Use the same happy-dom and `act` preamble as `PendingTable.test.tsx:1-21` and copy its local `flush`, `renderTable`, `renderWithConfirmCalls`, `cells`, `control`, `pressButton`, `confirmButton`, `clickConfirm` and `promptOpen` helpers, as each web test file does today. The vanished-row test installs its own `installFetchStub(routes)` and calls `renderTable`, because `renderWithConfirmCalls` hard-codes a 200 POST.
- Modify: `apps/web/src/api.test.ts` (~:340), `apps/web/src/components/forms/KeepImagePrompt.test.tsx`, `apps/web/src/components/forms/PendingReviewDialog.test.tsx`

- [ ] **Step 1: Write the tests.** Cells are numbered 0 date, 3 qty, 4 price, 5 fee.
  - `PendingTable.edge.test.tsx`:
    - `an unparsable price blocks the confirm with the validation message`: set cell 4 to `'abc'` and click Confirm. Expect `calls.length` `0`, the text to contain `'Check the values'`, and `promptOpen()` `false`.
    - `a cleared trade date that vision read blocks the confirm`: set cell 0 to `''` and click Confirm. Expect `calls.length` `0`, the text to contain `'Check the values'`, and the text NOT to contain `'fill in the highlighted field'`.
    - `fee text that is not an amount blocks the confirm`: set cell 5 to `'abc'` and click Confirm. Expect `calls.length` `0` and the text to contain `'Check the values'`.
    - `dismissing the keep prompt and confirming again re-asks, then posts once`: set qty to `'11'`, click Confirm, press `'✕'`, click Confirm again. Expect `promptOpen()` `true` and `calls.length` `0`. Press `'Keep for review'`. Expect `calls.length` `1` and the body `{ overrides: { shares: 11 }, keepImage: true }`.
    - `a row handled elsewhere while the prompt is open answers Already handled and drops out`:
      - Routes: `[{ method: 'POST', url: '/api/pending', status: 409, json: { error: 'not-pending' } }, { url: '/api/pending', json: [PENDING_ROW] }]`.
      - Edit qty and click Confirm. Then set `routes[1].json = []` and press `'Keep for review'`.
      - Expect `calls[0]` to match `{ method: 'POST', url: '/api/pending/9/confirm' }`, the text to contain `'Already handled'`, `promptOpen()` `false`, and the text to contain `'Nothing waiting for confirmation.'`.
  - `api.test.ts`, `confirmPending with overrides and keepImage false sends only the overrides`: call `api.confirmPending(3, { shares: 11 }, false)`. Expect the body to equal `{ overrides: { shares: 11 } }`.
  - `KeepImagePrompt.test.tsx`, `renders in the default narrow modal`: after `show('confirm')`, the panel `container.querySelector('[role=dialog] > div')!.className` contains `'max-w-md'` and not `'max-w-4xl'`.
  - `PendingReviewDialog.test.tsx`:
    - `the compare dialog uses the wide modal`: the same panel's className contains `'max-w-4xl'` and not `'max-w-md'`.
    - `a side vision missed offers an empty option until one is picked`:
      - Call `show({ ...ROW, side: '', detected: { ...ROW.detected!, side: null } }, { ...VALUES, side: '' })`.
      - The Side select's option values are `['', 'buy', 'sell']` and its value is `''`.
      - Pick `'sell'`. The options are now `['buy', 'sell']`.
      - Press Done. `done[0].side` is `'sell'`.
- [ ] **Step 2: Run `bun test apps/web/src/components/forms apps/web/src/api.test.ts` and `bun run typecheck`.** Expected: PASS, exit 0. These pin current behaviour. If one fails, stop and report. Each new or changed test file must be ≤ 300 lines, except `PendingTable.test.tsx` (it shrinks) and `api.test.ts` (already 376 lines on `main`; add the one test and do not split it here).
- [ ] **Step 3: Commit** `test: pin pending-row invalid inputs, keep-prompt re-entry, vanished rows and modal widths`.

### Task 8: Vision review tab gaps (followups "Test gaps" bullet 6, review side)

**Files:**
- Create: `apps/web/src/testing/visionReview.ts`. Move the DOM-free fixtures `READ`, `EDITED`, `UNEDITED`, `REJECTED`, `FEELESS`, `TYPED_FEE` and `entry()` here from `pages/VisionReview.test.tsx:23-58`.
- Modify: `apps/web/src/pages/VisionReview.test.tsx`, which keeps the display tests. Only the delete tests move out; the one new display test stays here.
- Create: `apps/web/src/pages/VisionReviewDelete.test.tsx`, the name wave D's Task 8 uses for the same split. Move the delete tests (`:217-282` on `main`, or wave D's replacements) here verbatim with the `render`/`button`/`cards` helpers, and add the new delete tests. If wave D already created the file, add to it.

- [ ] **Step 1: Move the fixtures and delete tests, then add:**
  - In `VisionReview.test.tsx`, `shows an em dash for a side, qty, price and date vision missed, and marks them changed`:
    - The fill is `{ id: 16, outcome: 'confirmed', edited: true, feeOverridden: false, detected: { side: null, shares: null, price: null, filledOn: null, fee: 100 }, final: READ }`.
    - The detected cells for `side`, `shares`, `price` and `filledOn` read `'—'`, and the detected `fee` reads `'$1.00'`.
    - The final cells read `'Buy'`, `'10'`, `'$123.45'` and `'2026-11-10'`.
    - Those four fields carry `data-changed="true"` on both rows, and `fee` carries none.
  - In `VisionReviewDelete.test.tsx`:
    - `arming and deleting one card leaves its sibling untouched`:
      - Render `[entry(3, [EDITED], 'AAPL'), entry(5, [REJECTED], 'SOXL')]` and press Delete on card 0.
      - Card 1's buttons are `['Delete']` and its text does not contain `'This cannot be undone'`.
      - Press `'Delete for real'`. The calls are `['DELETE /api/vision-reviews/3']`.
      - The remaining card is `data-capture="5"`, still holds `[data-fill="13"]`, and its buttons are `['Delete']`.
    - `a failed delete shows the server error text and leaves the entry armed`: with the 500 `{ error: 'boom' }` stub of the existing failure test, `[role=alert]` text contains `'boom'`, the card's text contains `'This cannot be undone'`, and `button('Delete for real', cards()[0]!)` exists. **Skip this test: wave D's Task 8 has merged.** Its `shows a failed delete inside the armed entry, not at page level` already pins the same text and armed state. The expected count in Step 2 is therefore plus 2. Write this test only if that wave D test is absent from the tree.
- [ ] **Step 2: Check that nothing was dropped.** The `it(` count across both files must equal the count before this task plus 2 (plus 3 if the failed-delete test was written). Run `bun test apps/web/src/pages/VisionReview.test.tsx apps/web/src/pages/VisionReviewDelete.test.tsx` and `bun run typecheck`. Expected: PASS, exit 0, both files ≤ 300 lines.
- [ ] **Step 3: Commit** `test: pin review-tab null fields, sibling-card isolation and failed-delete state`.

### Task 9: E2E proves the unkept `vision_reviews` row is swept (followups "Test gaps" bullet 4)

**Files:**
- Modify: `scripts/e2e-vision-review.ts:34` (signature) and its B, C, A and D assertions. Wave B's `archived === true` check on `confirmA` stays as it is.
- Modify: `scripts/e2e.ts` (~:265, the `runVisionReview(ctx)` call in `main()`)

**Interfaces:**
- Produces: `runVisionReview(c: E2eCtx, db: { reviewRowCount(captureId: number): Promise<number> }): Promise<void>`. `main()` passes `{ reviewRowCount: async (id) => (await repos.visionReviewRepo.listForCaptures([id])).length }`. The real `listForCaptures` does not filter by kept, so it sees unkept rows.

- [ ] **Step 1: Add the row-count assertions and honest labels.**
  - A: after the keep confirm, `reviewRowCount(captureA) === 1` (`'the kept capture has its frozen vision_reviews row'`). After the DELETE, `=== 0` (`'discarding removed the vision_reviews row'`).
  - B: after the confirm, `reviewRowCount(captureB) === 0` (`'untouched confirm swept the frozen vision_reviews row'`). Relabel the HTTP check to `'untouched confirm lists no kept entry (the list shows kept captures only)'`.
  - C: the same pair for `captureC`, labelled `'a correction alone swept the frozen vision_reviews row'` and `'a correction alone lists no kept entry'`.
  - D: before the DELETE, `reviewRowCount(captureD) === 2`. After it, `=== 0`.
- [ ] **Step 2: Run `bun run typecheck`, then `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`.** Expected: exit 0 and every step `ok`. Prove the probe bites: temporarily comment out `await repos.visionReviewRepo.deleteFor(captureId)` in `resolveReview`, re-run, and expect the B row-count assertion to fail. Revert.
- [ ] **Step 3: Commit** `test: e2e counts vision_reviews rows to prove the unkept sweep`.

### Task 10: Repo map, full verification, PR (followups "Code hygiene" bullet 8)

**Files:**
- Modify: `AGENTS.md` (Repo map and Commands)

- [ ] **Step 1: Diff the map against the tree.** Run `git ls-files | grep -v '^docs/'` and compare it with the map. On `main` the map is missing:
  - root `tsconfig.json`, `bun.lock` and `.dockerignore`
  - `prod_helpers/` (`build_and_push.sh`, `run_prod_container.sh`) and `resources/trade_images/` (sample broker screenshots)
  - `docs/superpowers/{specs,plans,followups}/`
  - `apps/server/{package.json,tsconfig.json}` and `apps/server/db/README.md`
  - `packages/*/{package.json,tsconfig.json}`, `apps/web/package.json` and `apps/web/.gitignore`
  - `apps/web/{index.html,vite.config.ts,tailwind.config.ts,postcss.config.js,tsconfig.json}`, `apps/web/src/style.css`, and `apps/web/src/testing/{fetchStub,pendingRow,visionReview}.ts` (plus `fetchStub.test.ts`)

  Also add `booking-fakes.ts` to the `test/` helper list, and every file waves A and B added that their own map edits missed. In Commands, change the typecheck note to `(packages + apps/server incl. test/ via tsc -b; apps/web + scripts directly)`.
- [ ] **Step 2: Full verification.** Run `bun test`, `bun run typecheck`, `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test`, and `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`. Expected: all green, exit 0.
- [ ] **Step 3: Commit** `docs: complete the AGENTS.md repo map`.
- [ ] **Step 4: Open the PR.** The body lists the #48 bullets this branch closes:
  - "http-fakes assembled with `as any`"
  - "draft sweep window untested"
  - "`POST /runs` with `cutLossPpm: null`"
  - "`stop-preempted` absent after a `market_sell`"
  - "`cutloss.ts` drift"
  - "catalog notice-code regex"

  It notes that wave A closed "`notifySiblingCancelled` optional" and the "`market_sell` tie-break", and that wave B closed the stale `replaceDays` spec line. It names the followups-doc bullets closed here: Code hygiene 1, 2, 6, 7 and 8 (and 4 by the ruling below), and Test gaps 1, 3, 4, 5 and 6 (wave A closed 2). Close #48 only if waves B and D have closed the rest; otherwise say what remains.

**Not in this wave:**
- The unreachable `invalid-side` / `invalid-fee` Telegram catalog entries stay as they are. Removing them saves nothing, and they become live the moment `onConfirm` forwards overrides.
- `samePrice` comma handling belongs to wave D.
- Other test files already over 300 lines (`booking.test.ts`, `wire.test.ts`, `db.test.ts`, `sim.test.ts`, `http-runs.test.ts`, `rebooking.test.ts`, `vision-review.test.ts`, `http-fills.test.ts`, `PendingTable.test.tsx`, `apps/web/src/api.test.ts`, `scripts/e2e.ts`) are not split here.
- `getRepos(db: any)` leaves the real repos untyped, so Task 3 pins against the schema row, not the query projection.
- The remaining call-site `f.repos as any` casts in `booking.test.ts` are harmless once the fake `satisfies RepoSurface`.
