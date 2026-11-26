# VR Screenshot Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A broker screenshot sent to the Telegram bot or uploaded in the web app can become pending fills on a Value Rebalancing (VR) run, which the owner confirms on the VR run page into `vr_fills`.

**Architecture:** A VR intake that runs beside mean-reversion's (MR) and reuses the strategy-neutral parts: the vision read, the `captures` row, image storage, the claim check and the duplicate matcher (both take their readers as arguments). Routing learns that two strategies exist; when exactly one MR run and one VR run trade a ticker, Telegram parks the screenshot in `capture_choices` and asks. VR pending rows live in `vr_pending_fills`; confirming writes the fill and marks the row in one transaction.

**Tech Stack:** Bun, TypeScript, Hono, drizzle-orm 0.44 (mysql2), drizzle-kit 0.30, MariaDB 11, grammY, React + Vite + Tailwind, happy-dom tests.

**Spec:** `docs/superpowers/specs/2026-11-26-vr-capture-design.md`

## Global Constraints

- Work only in the worktree `/Users/nazgul33/.local/share/opencode/worktree/c34a7d/vr-capture`, branch `feat/vr-capture`. Run commands from the worktree root unless a step says otherwise.
- **Database for this branch:** every DB-gated command uses `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_vrcap` (Task 1 creates it). Never run anything against `st_test`.
- **Never touch these containers:** `mariadb_st_prod`, `stratagy_tracker_prod`, `mariadb_st_staging`, `strategy_tracker_staging`.
- **MR intake does not change** for any ticker VR does not trade: same events, same Telegram texts and buttons, same bookings. Existing MR capture tests may be edited only where a task names them. Every existing Yes/No button press still reaches `onConfirm` with the same arguments.
- The one intended change to existing behaviour: a ticker with exactly one active MR run and one active VR run no longer routes to the MR run by itself.
- **No VR code reads or writes an `mr_*` table**, and VR never calls MR booking functions. The two places MR and VR meet are the question's answer (which calls MR's existing `ingestCapture` unchanged) and the shared screenshot sweep.
- Money is integer only: cents are `number`, prices `bigint` ten-thousandths of a dollar. No floats.
- New tables come from `drizzle-kit generate` (no hand-written SQL); the journal `when` values stay strictly increasing. Task 9 adds one more generated migration (`0018`) that adds a nullable column to `vr_pending_fills` and to `vr_fills`; `0017` is not regenerated.
- `DayDeps` and `HttpDeps` gain no new required top-level field. New repositories go on the existing type surfaces and their fakes.
- No source file over ~300 lines. `wire/capture.ts` (251), `scripts/e2e.ts` (300) and `FillDialog.tsx` are at or near the limit: put new code in new modules.
- All user-facing copy goes through the catalogs: `packages/telegram/src/i18n.ts` (en and ko, same placeholders) and `apps/web/src/i18n/{en,ko}.json` (same keys, `localeCompare`-sorted, same placeholders, no Hanzi in ko; VR strings write "Pool").
- Do not add `plan.notices.push` calls or notice codes to `pipeline/day.ts` or `mean-reversion.ts`.
- No scratch files outside the worktree.
- English only in code, comments and commit messages; no Hanzi or Cyrillic characters. Korean only in the ko catalogs.
- Commit style: `feat|fix|docs|test|refactor|chore:`.

## Review Focus

1. **A button pressed twice, or two presses racing.** Expected: the answer is carried out once; the second press gets "already answered". Pinned in Task 4.
2. **The same screenshot sent again after everything from it was decided, and a new screenshot of the same fills.** Expected: the same image is refused as a duplicate; a different image with the same fills has every one dropped; nothing new waits and nothing is booked twice. Pinned in Task 2.
3. **Confirming a waiting row that cannot be booked** (date after today, would make shares negative, edited to nonsense). Expected: refused with the same code a typed fill gets, the row stays waiting, its screenshot stays. Pinned in Task 2.
4. **A server restart while VR fills wait.** Expected: their screenshot survives the start-up sweep; one whose rows are all decided is gone. Pinned in Task 1.
5. **An un-pinned web upload for a ticker both strategies trade.** Expected: "several active runs", nothing parked, no screenshot or fill data in the response. Pinned in Task 3.

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/server/src/db/schema-vr.ts`, `schema.ts` (modify) | `vr_pending_fills`; `capture_choices` |
| `apps/server/db/migrations/0017_vr_capture.sql` + meta (generated) | create the two tables |
| `apps/server/src/domain/vr/repo-types.ts` (modify), `apps/server/src/domain/capture-choice.ts` (create) | row types and repository interfaces |
| `apps/server/src/db/repos-vr.ts`, `repos.ts`, `repos-vision.ts` (modify), `repos-capture-choice.ts` (create) | repositories; the sweep honours waiting VR rows |
| `apps/server/test/vr-fakes.ts` (modify), `capture-choice-fakes.ts` (create) | fakes |
| `apps/server/src/domain/vr/capture.ts`, `pending.ts` (create); `capture-dedup.ts` (modify: one export) | VR take-in; pending list, edit, confirm, reject, confirm all |
| `apps/server/src/http/routes/vr-pending.ts` (create); `vr.ts`, `domain/vr/view.ts` (modify) | `/api/vr/runs/:id/pending…`; waiting counts |
| `apps/server/src/wire/capture-route.ts`, `http/routes/captures.ts` (modify) | two-strategy routing; choice event hidden from the web |
| `packages/telegram/src/bot.ts`, `i18n.ts` (modify); `apps/server/src/wire/capture-choice.ts`, `vr-capture-message.ts` (create); `wire/capture.ts`, `wire/boot-sweeps.ts` (modify) | the question, its answer, the VR waiting message, expiry |
| `apps/server/src/pipeline/vr-day.ts` (modify) | waiting fills hold the cycle |
| `apps/web/src/api.vr.ts`, `api.vr.types.ts`, `api.captures.types.ts`, `components/hooks.tsx`, `pages/VrRun.tsx`, `pages/VrRuns.tsx`, `uploadlines.ts` (modify); `components/vr/VrPendingPanel.tsx`, `VrPendingDialog.tsx` (create) | Pending tab, upload from the VR page, result lines, counts |
| `scripts/e2e-vr-capture.ts` (create); `scripts/e2e.ts`, `AGENTS.md` (modify) | smoke step, repo map |

---

### Task 1: Tables, repositories, and the sweep

**Files:**
- Modify: `apps/server/src/db/schema-vr.ts` (add `vrPendingFills`), `schema.ts` (add `captureChoices`), `repos-vr.ts`, `repos.ts`, `repos-vision.ts`, `apps/server/src/domain/vr/repo-types.ts`, `apps/server/src/wire/capture.ts` (`CaptureRepos` only), `apps/server/src/http/app.ts` (`HttpRepoSurface` only)
- Create: `apps/server/src/domain/capture-choice.ts`, `apps/server/src/db/repos-capture-choice.ts`, `apps/server/test/capture-choice-fakes.ts`, `apps/server/test/db-vr-pending.test.ts`
- Generated: `apps/server/db/migrations/0017_vr_capture.sql`, `meta/0017_snapshot.json`, `meta/_journal.json`
- Modify tests: `apps/server/test/vr-fakes.ts`, `http-fakes.ts`, `wire-capture-fakes.ts`, `day-fakes.ts`, `repo-surface-types.test.ts`, `migration-sql.test.ts`, `db-vision-janitor.test.ts`, and any hand-built repository object that stops compiling (as `vision-review-reject.test.ts` did for the VR core: wiring only, no assertion changes)

**Interfaces:**
- Consumes: `RawFill` from `@st/ingest`; existing `VrRepos`, `NewVrFill`, `VrFillRow`.
- Produces, in `apps/server/src/domain/vr/repo-types.ts`:

```ts
export type VrPendingStatus = 'pending' | 'confirmed' | 'rejected'
export interface VrPendingRow {
  id: number; runId: number; captureId: number; side: 'buy' | 'sell'; shares: number; price: bigint
  fee: number | null            // null = compute from the run's trade cost at confirm
  filledOn: ISODate; dateRead: boolean   // false = the screenshot had no date and the reading day was used
  dupPrice: bigint | null       // price of the booked or waiting entry this may duplicate
  status: VrPendingStatus; createdAt: string
}
export type NewVrPending = Omit<VrPendingRow, 'id' | 'status' | 'createdAt'>
export type VrPendingPatch = Pick<VrPendingRow, 'side' | 'shares' | 'price' | 'fee' | 'filledOn'>
export interface VrPendingRepo {
  listForRun(runId: number, status?: VrPendingStatus): Promise<VrPendingRow[]>   // ascending filledOn, then id; every status when omitted
  get(runId: number, id: number): Promise<VrPendingRow | null>
  insertMany(rows: NewVrPending[]): Promise<number[]>
  update(runId: number, id: number, patch: VrPendingPatch): Promise<boolean>     // only a row still pending; false otherwise
  confirm(runId: number, id: number, fill: NewVrFill): Promise<number | null>    // ONE transaction: mark the row confirmed if still pending, then insert the fill; the fill id, or null (nothing written) when the row was not pending
  reject(runId: number, id: number): Promise<boolean>                            // only a row still pending
  countPending(runId: number): Promise<number>
  hasPendingForCapture(captureId: number): Promise<boolean>
  hasConfirmedForCapture(captureId: number): Promise<boolean>
}
// VrRepos gains: vrPendingRepo: VrPendingRepo
```

  and in `apps/server/src/domain/capture-choice.ts`:

```ts
export type ChoiceAnswer = 'mr' | 'vr' | 'both'
export const CHOICE_TTL_MS = 24 * 60 * 60 * 1000
export interface CaptureChoiceRow {
  id: number; chatId: string; ticker: string; mrRunId: number; vrRunId: number
  fills: RawFill[]                       // every field as read
  image: { base64: string; mime: string } // the identical base64 text that was parked
  readOn: ISODate; createdAt: string; answer: ChoiceAnswer | null
}
export type NewCaptureChoice = Omit<CaptureChoiceRow, 'id' | 'createdAt' | 'answer'>
export interface CaptureChoiceRepo {
  park(c: NewCaptureChoice): Promise<number>
  get(id: number): Promise<CaptureChoiceRow | null>
  answer(id: number, answer: ChoiceAnswer): Promise<boolean>   // true only for the call that moved it from open to answered
  deleteOlderThan(cutoff: Date): Promise<number>                // rows created before cutoff, answered or not
}
```

  - `getRepos(db)` also returns `vrPendingRepo` (through `getVrRepos`) and `captureChoiceRepo`. `CaptureRepos` and `HttpRepoSurface` declare `captureChoiceRepo`; every surface that extends `VrRepos` gets `vrPendingRepo` with it.
  - `makeVrFakes()` gains the pending store (`pending: VrPendingRow[]`) and repository; its fake `vrPendingRepo.confirm` pushes into the same fill store the fake `vrFillRepo` uses, so fill ids keep rising across both. `apps/server/test/capture-choice-fakes.ts` exports `makeChoiceFakes(now?: () => Date): { captureChoiceRepo: CaptureChoiceRepo; choices: CaptureChoiceRow[] }`, wired into `http-fakes.ts` and `wire-capture-fakes.ts`.
  - `captureImageRepo.sweepOrphans()` keeps an unkept image when a `vr_pending_fills` row with that `capture_id` is `pending`, exactly as it does for a pending `mr_pending_fills` row.

Tables:

| Table | Columns |
| --- | --- |
| `vr_pending_fills` | `id`; `run_id`; `capture_id` not null; `side` varchar(8); `shares` int; `price` bigint; `fee` int null; `filled_on` date; `date_read` boolean; `dup_price` bigint null; `status` enum(`pending`,`confirmed`,`rejected`) default `pending`; `created_at`. Indexes `vr_pending_fills_run_status_idx (run_id, status)`, `vr_pending_fills_capture_idx (capture_id)` |
| `capture_choices` | `id`; `chat_id` varchar(64); `ticker` varchar(16); `mr_run_id` int; `vr_run_id` int; `fills_json` text; `image_base64` longtext; `image_mime` varchar(32); `read_on` date; `created_at`; `answer` enum(`mr`,`vr`,`both`) null; `answered_at` timestamp null |

- [ ] **Step 1: Create the branch database**

```bash
docker exec st-mariadb-test mariadb -uroot -ptest -e "CREATE DATABASE IF NOT EXISTS st_test_vrcap"
export TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_vrcap
```

- [ ] **Step 2: Write the failing tests**

`apps/server/test/db-vr-pending.test.ts` (DB-gated, like `db-vr.test.ts`):
- `pending rows round-trip and list by date then id`, with and without a status filter; `countPending` counts only `pending`.
- `update changes a pending row and refuses a decided one` (returns false, nothing changes); another run's id changes nothing.
- `confirm marks the row and inserts the fill together`: returns the fill id; the row is `confirmed`; the fill has `source 'capture'`. A second `confirm` returns `null` and inserts no second fill. `confirm` with a fill that violates a column (for example `shares` beyond INT) throws and leaves the row `pending`.
- `reject` only moves a pending row; `hasPendingForCapture` / `hasConfirmedForCapture` follow.
- `capture choices`: `park` then `get` returns the same `fills` (deep equal, including optional fields that were absent staying absent) and the **identical** base64 string for a 1 MiB random image; `answer` returns true once and false after; `deleteOlderThan` removes old rows whether answered or not and leaves newer ones.

`db-vision-janitor.test.ts` (add, on its own scratch database as the file already does) — Review Focus 4:
- `sweepOrphans keeps an unkept image while a VR pending row is waiting`, and `deletes it once that row is confirmed or rejected`.
- The existing MR cases stay unedited.

`migration-sql.test.ts`: `the VR capture migration creates two tables and touches no other table` (the `0017_*` file has `CREATE TABLE \`vr_pending_fills\`` and `\`capture_choices\``, no `ALTER TABLE`, `DROP` or `RENAME`).

`repo-surface-types.test.ts`: real-versus-surface checks and one `@ts-expect-error` pin for each of the two new repositories.

- [ ] **Step 3: Run to see them fail**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_vrcap bun test apps/server/test/db-vr-pending.test.ts apps/server/test/db-vision-janitor.test.ts apps/server/test/migration-sql.test.ts`
Expected: FAIL (missing modules, no `0017` file).

- [ ] **Step 4: Add the schema and generate the migration**

```bash
cd apps/server && bunx drizzle-kit generate --name=vr_capture < /dev/null; cd ../..
```

Expected: `0017_vr_capture.sql` with two `CREATE TABLE` statements plus one `CREATE INDEX` per plain index, snapshot `0017`, one journal entry. If it asks a question or emits anything about an existing table, stop and report.

- [ ] **Step 5: Implement** the interfaces, repositories, the sweep condition, the surface members and the fakes.

- [ ] **Step 6: Run everything**

```bash
bun run typecheck
bun test
TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_vrcap bun test
cd apps/server && bun run db:generate < /dev/null; cd ../..; git status --short apps/server/db
```

Expected: typecheck clean; both runs 0 fail; "No schema changes, nothing to migrate", nothing written.

- [ ] **Step 7: Commit**

```bash
git add -A apps/server
git commit -m "feat: vr_pending_fills and capture_choices tables with repositories; the screenshot sweep keeps waiting VR rows"
```

---

### Task 2: VR take-in, pending fills, and their HTTP API

**Files:**
- Create: `apps/server/src/domain/vr/capture.ts`, `apps/server/src/domain/vr/pending.ts`, `apps/server/src/http/routes/vr-pending.ts`; tests `apps/server/test/vr-capture.test.ts`, `vr-pending.test.ts`, `http-vr-pending.test.ts`
- Modify: `apps/server/src/domain/capture-dedup.ts` (add one export, `matchCapturedFills` untouched), `apps/server/src/domain/vr/view.ts` (waiting count in the detail and summary), `apps/server/src/domain/vr/runs.ts` (pass the count), `apps/server/src/http/routes/vr.ts` (mount), tests that assert the whole detail or summary object (add the new field)

**Interfaces:**
- Consumes: Task 1 repositories and fakes; `claimCapture`, `matchCapturedFills`, `storeCaptureImage`, `sha256`; `parseVrFillBody` and the share and books checks in `domain/vr/booking.ts` (export what is needed; do not duplicate them); `withRunLock`; `VrNotFoundError`.
- Produces:

```ts
// domain/capture-dedup.ts
export function dropExactMatches<T extends { side: 'buy' | 'sell'; ticker: string; shares: number; price: bigint; filledOn: ISODate }>(
  existing: readonly T[], extracted: readonly RawFill[], today: ISODate,
): { kept: RawFill[]; dropped: number }   // each existing entry cancels at most one extracted fill with the same side, ticker, shares, price and date (missing date = today)

// domain/vr/capture.ts
export type VrCaptureOutcome = 'duplicate' | { waiting: number; dropped: number; possibleDuplicates: number }
export interface VrCaptureDeps { repos: VrCaptureRepos; today: ISODate }   // VrCaptureRepos: the VR repositories plus captureRepo and captureImageRepo, declared in this file
export function ingestVrCapture(run: VrRunRow, image: { base64: string; mime: string }, fills: readonly RawFill[], deps: VrCaptureDeps): Promise<VrCaptureOutcome>

// domain/vr/pending.ts
export interface VrConfirmAllResult { confirmed: number; refused: { id: number; error: string }[]; skippedDuplicates: number; skippedUndated: number }
export function listVrPending(run: VrRunRow, deps): Promise<VrPendingView[]>           // waiting rows only
export function editVrPending(run: VrRunRow, id: number, body: unknown, deps): Promise<void>
export function confirmVrPending(run: VrRunRow, id: number, deps): Promise<number>      // the new fill id
export function rejectVrPending(run: VrRunRow, id: number, deps): Promise<void>
export function confirmAllVrPending(run: VrRunRow, deps): Promise<VrConfirmAllResult>
```

  - Wire shape of a waiting row: `VrPendingDto { id; captureId; side; shares; price: string; fee: number | null; filledOn; dateRead: boolean; dateAfterToday: boolean; dupPrice: string | null; hasImage: boolean; createdAt }`.
  - `VrRunDetailDto` and `VrRunSummaryDto` gain `pendingCount: number`.

Rules for `ingestVrCapture`, all inside `withRunLock(run.id)`:

1. Hash the base64 text as MR does. `claimCapture` with VR readers: `hasLiveForCapture` → `vrPendingRepo.hasAnyForCapture` (true when the capture has a row in any status, so a screenshot that already produced rows for this run is never taken in again), `hasConfirmedForCapture` → always false, corrections always false. A refused claim returns `'duplicate'`. `VrPendingRepo` gains `hasAnyForCapture(captureId: number): Promise<boolean>` (real and fake).
2. Give every VR entry the run's ticker. `dropExactMatches` against the run's **rejected** pending rows; count what it drops.
3. `matchCapturedFills` with readers returning the run's booked fills and its **pending** rows (ticker and `runId` added): fills that vanish are added to the dropped count; each `conflict` becomes a pending row with `dupPrice` = the cited entry's price; each `fresh` fill becomes a pending row with `dupPrice` null.
4. Row fields: `fee` in cents when the screenshot showed one, else null; `filledOn = date ?? today`; `dateRead = date !== undefined`.
5. Store the image (`storeCaptureImage`) only when at least one row was created.
6. Return `{ waiting: rows created, dropped, possibleDuplicates }`.

Rules for pending operations (each write inside `withRunLock(run.id)`; unknown id → `VrNotFoundError`; a row that is not pending → `DomainError('vr-not-pending')`):

- `editVrPending`: the body is `{ side, shares, price, fee?, filledOn }` with price and fee as USD strings, checked like a typed fill's format (codes `invalid-side`, `invalid-shares`, `invalid-price`, `invalid-fee`, `invalid-date`), except that an absent or empty fee is stored as null. A date after today is accepted here. `dupPrice` and `dateRead` are kept.
- `confirmVrPending`: build the fill from the row (`fee ?? feeCents(price, shares, run.costPpm)`, `source: 'capture'`); refuse with exactly the codes a typed fill gets, format checks included (`invalid-side`, `invalid-shares`, `invalid-price`, `invalid-fee`, `invalid-date`, then `fill-date-in-future`, `vr-negative-shares`, `vr-too-large`), leaving the row pending; then `vrPendingRepo.confirm`; a `null` result is `vr-not-pending`. Afterwards, if the capture has no pending row left, delete its image (`captureImageRepo.deleteFor`).
- `rejectVrPending`: mark rejected, then the same image rule.
- `confirmAllVrPending`: take the waiting rows, set aside those with a `dupPrice` (counted in `skippedDuplicates`) and, of the rest, those with `dateRead` false (counted in `skippedUndated`), order what is left buys before sells, then by `filledOn`, then id; confirm each through `confirmVrPending`; a refusal is recorded as `{ id, error: <code> }` and the loop continues.

Routes (under `/api/vr`, unknown or MR run → `404 { error: 'not found' }`, as the other VR routes):

| Route | Result |
| --- | --- |
| `GET /runs/:id/pending` | `VrPendingDto[]`, ascending date then id |
| `PUT /runs/:id/pending/:pid` | `204`; `404`; `409 { error: 'vr-not-pending' }`; `422 { error: <code> }` |
| `POST /runs/:id/pending/:pid/confirm` | `201 { fillId }`; `404`; `409 vr-not-pending`; `422 <code>` |
| `POST /runs/:id/pending/:pid/reject` | `204`; `404`; `409 vr-not-pending` |
| `POST /runs/:id/pending/confirm-all` | `200 VrConfirmAllResult` |

- [ ] **Step 1: Write the failing tests**

`vr-capture.test.ts` (with the fakes):
- first take-in of three fills → three waiting rows with the right fee (cents or null), date and `dateRead`; image stored; outcome `{ waiting: 3, dropped: 0, possibleDuplicates: 0 }`.
- a fill with no date gets `today` and `dateRead false`; a fill dated after today is kept as read.
- same screenshot again while a row waits → `'duplicate'`, nothing added.
- Review Focus 2: after confirming two rows and rejecting the third, the same screenshot again → `'duplicate'`, no new row; a **different** image with the same three fills → `{ waiting: 0, dropped: 3, possibleDuplicates: 0 }`, no new row, no image stored. A screenshot whose first take-in produced no row is read again.
- two identical fills in one screenshot with one already booked → one dropped, one waiting.
- same side, shares and date but another price than a booked fill → one waiting row with `dupPrice` = the booked price; the same against a waiting row cites that row's price; against a rejected row with another price → a plain waiting row (`dupPrice` null).
- a screenshot whose every fill is dropped stores no image.
- `dropExactMatches`: each existing entry cancels one fill; a missing date uses `today`.

`vr-pending.test.ts`:
- confirm books a fill with `source 'capture'`, the computed fee when none was read, and returns its id; the row is confirmed; the image is deleted only when the capture's last waiting row is decided (two-row case: after the first, still there).
- Review Focus 3: a row dated after today → `fill-date-in-future`, row still pending, image still there; a sell beyond the holding → `vr-negative-shares`; an entry that would overflow the books → `vr-too-large`; after editing the date to today the same row confirms.
- edit: each format code; an empty fee stored as null; `dupPrice` kept; a decided row → `vr-not-pending`.
- reject, and the image rule.
- confirm all: buys are confirmed before sells so a same-day buy-then-sell pair both book even when listed sell first; a refused row is reported and the rest continue; rows with `dupPrice` are skipped and counted; rows with `dateRead` false are skipped and counted separately; an empty list gives zeros.
- a waiting row with price 0 (extraction can produce it) is refused at confirm with `invalid-price` and stays waiting.

`http-vr-pending.test.ts`: every route's success shape and status codes above, `dateAfterToday` and `hasImage` in the DTO, an MR run id → `404`, another run's pending id → `404`, no token → `401`; `GET /api/vr/runs/:id` and `GET /api/vr/runs` carry `pendingCount`.

- [ ] **Step 2: Run to see them fail** — `bun test apps/server/test/vr-capture.test.ts apps/server/test/vr-pending.test.ts apps/server/test/http-vr-pending.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `bun run typecheck && bun test` and `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_vrcap bun test` → clean, 0 fail.
- [ ] **Step 5: Commit**

```bash
git add -A apps/server
git commit -m "feat: VR screenshot take-in and pending fills (edit, confirm, reject, confirm all) with their API"
```

---

### Task 3: Routing across two strategies

**Files:**
- Modify: `apps/server/src/wire/capture-route.ts`, `apps/server/src/http/routes/captures.ts`, `apps/server/test/capture-route.test.ts`, `apps/server/test/http-captures.test.ts`
- Create: `apps/server/test/capture-route-vr.test.ts`

**Interfaces:**
- Consumes: `ingestVrCapture`, `VrCaptureOutcome` (Task 2); `vrRunRepo`.
- Produces — `CaptureEvent` gains two members, and `CaptureRouteDeps.repos` is typed to include the VR repositories it needs:

```ts
| { type: 'choose'; ticker: string; mrRunId: number; vrRunId: number; fills: RawFill[] }
| { type: 'vr-outcome'; runId: number; ticker: string; outcome: VrCaptureOutcome }
```

Routing rules (replace the two MR-only lookups; everything else in the function stays):

- **Pinned:** look the id up as an MR run, then as a VR run; neither → `unknown-run` as today. An MR run behaves exactly as today. A VR run: keep the fills with its ticker (`pin-nomatch` when none, `pin-skipped` for the others, same events as MR), `ingestVrCapture`, emit `vr-outcome`.
- **Un-pinned,** per ticker group, with candidates = active MR runs with that ticker plus active VR runs with that ticker:
  - none → `no-run`;
  - exactly one → MR: `ingestCapture` and `outcome` as today; VR: `ingestVrCapture` and `vr-outcome`;
  - exactly one MR and exactly one VR → `choose` (nothing is taken in);
  - anything else → `ambiguous`.
- Routing parks nothing and knows no chat.
- `POST /api/captures` replaces every `choose` event with `{ type: 'ambiguous', ticker }` before answering, so the browser never receives the fills of a choice. `vr-outcome` is returned as it is.

- [ ] **Step 1: Write the failing tests**

`capture-route-vr.test.ts` (the pattern of `capture-route.test.ts`): every row of the spec's routing table; pinned VR run (active, paused and closed) including `pin-nomatch` and `pin-skipped`; a ticker only VR trades goes to the VR run; `choose` carries the ticker, both run ids and every fill of the group with all fields, and no take-in happened for either run; one MR + two VR and two MR + one VR → `ambiguous`; a screenshot with three tickers (MR-only, VR-only, shared) emits `outcome`, `vr-outcome` and `choose` in ticker order and one group's result does not stop the others.

`capture-route.test.ts`: the existing cases keep every assertion (their fixture may gain the VR fakes: wiring only); add `a ticker only MR trades behaves exactly as before when VR runs exist for other tickers`.

`http-captures.test.ts` — Review Focus 5: an un-pinned upload for a shared ticker answers 200 with an `ambiguous` event for that ticker, no `choose` event, no `fills` key and no base64 anywhere in the body; nothing was added to the choice store; a pinned VR upload answers 200 with `vr-outcome`; an unknown pinned id still answers `404 no-run`.

- [ ] **Step 2: Run to see them fail** — `bun test apps/server/test/capture-route-vr.test.ts apps/server/test/http-captures.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `bun run typecheck && bun test` → clean, 0 fail; `wire-capture-*.test.ts` unedited and green.
- [ ] **Step 5: Commit**

```bash
git add -A apps/server
git commit -m "feat: screenshot routing sees both strategies; pinned VR runs; a choice event for shared tickers"
```

---

### Task 4: The Telegram question and the VR message

**Files:**
- Modify: `packages/telegram/src/bot.ts`, `packages/telegram/src/i18n.ts`, `packages/telegram/test/bot.test.ts`, `apps/server/src/wire/capture.ts`, `apps/server/src/wire/boot-sweeps.ts`, `apps/server/src/main.ts` (pass the new handler to `createBot`), tests that build `BotDeps` or the handler object by hand
- Create: `apps/server/src/wire/capture-choice.ts`, `apps/server/src/wire/vr-capture-message.ts`; tests `apps/server/test/wire-capture-question.test.ts`, `wire-vr-capture-message.test.ts`

**Interfaces:**
- Consumes: Task 1 `captureChoiceRepo`, `CHOICE_TTL_MS`; Task 2 `ingestVrCapture`; Task 3 events; MR's `ingestCapture` and the existing `sendOutcome` in `wire/capture.ts` (reuse it; export or pass it in, do not copy it).
- Produces:
  - `packages/telegram/src/bot.ts`: `BotDeps` gains `onChoice(chatId: string, cbData: string): Promise<void> | void`; button data starting with `cs:` goes to `onChoice`, **everything else to `onConfirm` exactly as today**; `answerCallbackQuery` stays first for both. `buildChoiceKeyboard(id: string, labels: { mr: string; vr: string; both: string })` builds one row of three buttons with data `cs:<id>:m`, `cs:<id>:v`, `cs:<id>:b`.
  - `wire/vr-capture-message.ts`: `vrCaptureMessage(v: { runId: number; ticker: string; outcome: VrCaptureOutcome }, lang: Lang): string`.
  - `wire/capture-choice.ts`: `makeChoiceHandlers(deps)` returning `ask(chatId, image, event)` (parks and sends the question) and `onChoice(chatId, cbData)`.
  - `makeCaptureHandlers` returns `onChoice` next to the existing handlers; its `reply` handles `vr-outcome` (sends `vrCaptureMessage`) and `choose` (calls `ask` with the photo it is replying to).
  - `runBootSweeps` also deletes choices older than `CHOICE_TTL_MS`.

Behaviour:

- **Asking:** delete expired choices, park `{ chatId, ticker, mrRunId, vrRunId, fills, image, readOn: today }`, then send the question text with `buildChoiceKeyboard(String(id), labels from the catalog)`.
- **Answering** (`onChoice`): data must match `^cs:(\d+):([mvb])$`, otherwise do nothing (as `onConfirm` does for data it does not know). No such choice, or one older than `CHOICE_TTL_MS` → the "expired" reply. `captureChoiceRepo.answer` returning false → the "already answered" reply. Otherwise carry it out with `today = choice.readOn`:
  - `m` or `b`: `ingestCapture(choice.mrRunId, choice.image, { ok: true, fills: choice.fills }, { repos, today: choice.readOn })`, then the existing `sendOutcome` (same messages and Yes/No buttons as an un-asked MR screenshot);
  - `v` or `b`: load the VR run by id whatever its status, `ingestVrCapture`, then `vrCaptureMessage`;
  - for `b`, MR first, then VR; a throw in one is reported with the existing unknown-error wording and does not stop the other.
- **VR message:** one message, no buttons: the run and ticker with the number waiting and where to confirm them; a line for dropped fills when > 0; a line for possible duplicates when > 0; a different text when nothing is waiting; a different text for `'duplicate'` (this screenshot was already taken in for this run).
- Catalog keys (en and ko, identical placeholders): the question, the three button labels, expired, already answered, and the VR message lines. Existing keys and the Yes/No buttons are untouched.

- [ ] **Step 1: Write the failing tests**

`packages/telegram/test/bot.test.ts` (add; existing cases unedited): a `cs:5:v` press reaches `onChoice('111', 'cs:5:v')` and not `onConfirm`; `yes:9` and `no:9` still reach `onConfirm` with `['111','yes:9',true]` and `['111','no:9',false]`; `answerCallbackQuery` runs before `onChoice` and still runs when it throws; `buildChoiceKeyboard` data and labels; every `callback_data` is at most 64 bytes for an id of ten digits.

`wire-capture-question.test.ts` (with `makeCapture`-style fakes holding one active MR run and one active VR run on `TQQQ`):
- a photo with three TQQQ fills → one message with the question text naming the ticker and the count and a three-button keyboard; one parked choice holding the same image string, all three fills with every field, both run ids and `readOn`; nothing taken in.
- `m` → MR pending rows exist and the messages are exactly those an MR-only setup sends for that photo (compare with a second fixture that has no VR run); no VR row.
- `v` → VR waiting rows, the VR message, no MR row.
- `b` → both, MR messages first.
- Review Focus 1: the same button pressed twice → the second gets the "already answered" reply and books nothing; two presses started together (`Promise.all`) → exactly one is carried out.
- a choice parked 25 hours ago → "expired", nothing booked.
- an answer given the day after a photo whose fills have no date → the rows are dated the day the photo was read.
- an answer after the VR run was paused still reaches it.
- malformed data (`cs:x:v`, `cs:5:z`, `cs:5`) → no reply, nothing booked.
- asking deletes choices older than 24 hours; `runBootSweeps` does too.
- a photo for a ticker only MR trades → exactly today's messages (the existing `wire-capture-photo.test.ts` passes unedited).

`wire-vr-capture-message.test.ts`: each of the five message shapes in en and ko with its numbers.

- [ ] **Step 2: Run to see them fail** — `bun test packages/telegram apps/server/test/wire-capture-question.test.ts apps/server/test/wire-vr-capture-message.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Keep `wire/capture.ts` under ~300 lines: the new logic lives in the two new modules.
- [ ] **Step 4: Run** — `bun run typecheck && bun test` and the DB run → clean, 0 fail; `wire-capture-*.test.ts`, `capture-replies.test.ts`, `main-boot-order.test.ts` and `packages/telegram/test/i18n.test.ts` green, the first three unedited.
- [ ] **Step 5: Commit**

```bash
git add -A apps/server packages/telegram
git commit -m "feat: Telegram asks which strategy a shared ticker's screenshot is for; VR waiting message"
```

---

### Task 5: Waiting fills hold the cycle

**Files:**
- Modify: `apps/server/src/pipeline/vr-day.ts`, `packages/telegram/src/i18n.ts`, `packages/telegram/src/vr.ts` (if the text is rendered there), `apps/server/test/vr-day.test.ts`
- Create: `apps/server/test/vr-day-hold.test.ts`

**Interfaces:**
- Consumes: `vrPendingRepo.countPending` (on `DayRepoSurface` through `VrRepos`).
- Produces: no new exports. One catalog key, `vr-cycle-held` (en and ko, placeholders `{name}`, `{ticker}`, `{n}`).

Rule, inside the run lock where the morning decision is made: when the run has waiting fills (`countPending > 0`) and the decision would be **anything that acts on the books** — the buy instruction, opening cycle 1, or rolling a cycle — do none of it. Send the held message (kind `vr-held`) instead; the run counts as completed. A missing or stale close does not matter for a held run (no close warning). When nothing was due anyway, waiting fills change nothing and nothing is sent. The schedule is untouched: a later run uses the existing anchoring.

(The spec names opening cycle 1 and rolling; including the buy instruction is the planner's extension: telling the owner to buy while his opening buy waits unconfirmed would be wrong.)

- [ ] **Step 1: Write the failing tests** in `vr-day-hold.test.ts` (the fixtures of `vr-day.test.ts`):
- a due cycle with two waiting fills → no new cycle, no deposit, one held message naming the run and the count; result `'sent'`.
- the next day with the list clear → the cycle opens with `scheduledStart` on the original anchor (previous scheduled start + 14 days) and `startDate` that day.
- shares held, no cycle, one waiting fill → cycle 1 is not opened; cleared → it opens.
- no shares, no cycle, one waiting fill (the opening buy awaiting confirmation) → the held message, not the buy instruction.
- mid-cycle with waiting fills → nothing sent, nothing changed.
- a due cycle with waiting fills and a stale close → the held message only, no close warning, run completed.
- every existing `vr-day*.test.ts` case passes unedited.

- [ ] **Step 2: Run to see them fail** — `bun test apps/server/test/vr-day-hold.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `bun run typecheck && bun test` → clean, 0 fail.
- [ ] **Step 5: Commit**

```bash
git add -A apps/server packages/telegram
git commit -m "feat: waiting screenshot fills hold a VR cycle until they are decided"
```

---

### Task 6: Web — the Pending tab

**Files:**
- Modify: `apps/web/src/api.vr.ts`, `api.vr.types.ts`, `api.vr.test.ts`, `api.call.ts` (new error code), `components/hooks.tsx`, `hooks.test.tsx`, `App.tsx`, `AppVr.test.tsx`, `pages/VrRun.tsx`, `pages/VrRun.test.tsx`, `testing/vr.ts`, `i18n/en.json`, `i18n/ko.json`
- Create: `apps/web/src/components/vr/VrPendingPanel.tsx`, `VrPendingDialog.tsx` and their tests (split by topic)

**Interfaces:**
- Consumes: the Task 2 wire shapes and codes.
- Produces:
  - `api.vr.types.ts`: `VrPendingDto`, `VrPendingInput { side; shares; price: string; fee?: string; filledOn }`, `VrConfirmAllResult`; `pendingCount` on `VrRunDetailDto` and `VrRunSummaryDto`.
  - `VrApi` gains `listPending(id)`, `updatePending(id, pendingId, input): Promise<void>`, `confirmPending(id, pendingId): Promise<{ fillId: number }>`, `rejectPending(id, pendingId): Promise<void>`, `confirmAllPending(id): Promise<VrConfirmAllResult>`.
  - `Route` `vrRun` gains `tab?: 'pending'`; `#/vr/<id>?tab=pending` parses to it; any other query is ignored. `VrRunPage` takes `initialTab?: 'pending'` and is keyed on id and tab.
  - `ApiErrorCode` gains `vr-not-pending`; catalog key `vrErr.vr-not-pending`.
  - `VrPendingPanel(props: VrPanelProps)` and `VrPendingDialog({ runId; costPpm; row: VrPendingDto; onClose; onSaved })`.

The page: the tab row becomes `Fills | Pending | Cash | Cycles | Alerts`; the Pending label shows the count when it is above 0 (`Pending 3`), from `detail.pendingCount`. The panel lists waiting rows (date, side, shares, price, fee or "auto" when empty, a screenshot link through the existing `ScreenshotLink` when `hasImage`, and marks: "date not in the screenshot" when `dateRead` is false, "dated after today" when `dateAfterToday`, "possible duplicate of <price>" when `dupPrice` is set), with Edit, Confirm and Reject per row and a **Confirm all** button above. After each action it reloads its list and calls `onChanged` (which reloads the run, so the count, books and ladder follow). Confirm all shows a summary: how many were booked, each refused row with its worded reason, how many possible duplicates and how many rows without a read date were left. Errors are worded with `errorText(err, t, 'vrErr')`; a refused confirm leaves the row in place with the message beside it. Confirm on a row dated after today is disabled with a hint to edit the date.

`VrPendingDialog` edits side, shares, price, fee (empty = auto) and date with the same client checks as `VrFillDialog`, sends `PUT`, and follows the dialog conventions (`closeOnEscape={false}`, first field focused).

- [ ] **Step 1: Write the failing tests** — api methods (verb, URL, body); `parseHash` for `#/vr/7?tab=pending` and for an unknown tab; the page opens on the Pending tab from that link and shows `Pending 3` / plain `Pending`; the panel's rows, marks and empty state; confirm, reject, edit round trips with reload and `onChanged`; a refused confirm (`fill-date-in-future`, `vr-negative-shares`) shows the worded error and keeps the row; `vr-not-pending` is worded; Confirm all shows the three numbers and the refused rows' reasons; the dialog's checks, body (no `fee` key when empty), focus and Escape.
- [ ] **Step 2: Run to see them fail** — `bun test apps/web/src` → the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `bun run typecheck && bun test` → clean, 0 fail; `catalog.test.ts` green.
- [ ] **Step 5: Commit**

```bash
git add -A apps/web
git commit -m "feat: Pending tab on the VR run page (edit, confirm, reject, confirm all)"
```

---

### Task 7: Web — upload from the VR page, result lines, counts

**Files:**
- Modify: `apps/web/src/api.captures.types.ts`, `uploadlines.ts`, `uploadlines.test.ts`, `pages/VrRun.tsx`, `pages/VrRun.test.tsx` (or a new `VrRunUpload.test.tsx`), `pages/VrRuns.tsx`, `pages/VrRuns.test.tsx`, `components/vr/VrFillsPanel.tsx` and its test, `i18n/en.json`, `i18n/ko.json`

**Interfaces:**
- Consumes: the existing `UploadDialog({ runId, onClose })` unchanged; Task 3's `vr-outcome` event; Task 6's Pending tab and `?tab=pending` link.
- Produces: `CaptureEventDto` gains `{ type: 'vr-outcome'; runId: number; ticker: string; outcome: 'duplicate' | { waiting: number; dropped: number; possibleDuplicates: number } }`.

Behaviour:
- `captureEventLines` words a `vr-outcome`: a head line with the ticker, run and number waiting, linking to `#/vr/<runId>?tab=pending`; a line for dropped fills when > 0; a line for possible duplicates when > 0; its own line when nothing is waiting; its own line for `'duplicate'`. `wantsPending` is also true for a `vr-outcome` with `waiting > 0`. Every existing line and key is unchanged.
- The VR run header gets an **Upload screenshot** button (shown for any status) opening `UploadDialog` with `runId`. When the dialog closes: reload the run; if the owner chose "go to pending", select the Pending tab.
- The VR runs list shows the number waiting per run (blank when 0).
- The Fills tab marks a fill whose `source` is `capture`.

- [ ] **Step 1: Write the failing tests** — `uploadlines` for each `vr-outcome` shape (text, tone, link) and `wantsPending`; every existing `uploadlines.test.ts` case unedited; the upload button opens the dialog with the run id, and closing with "go to pending" lands on the Pending tab and reloads; the list's count column; the source mark.
- [ ] **Step 2: Run to see them fail** — `bun test apps/web/src` → the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `bun run typecheck && bun test` → clean, 0 fail; `UploadDialog*.test.tsx`, `RunDetailUpload.test.tsx` and `PendingUpload.test.tsx` unedited and green.
- [ ] **Step 5: Commit**

```bash
git add -A apps/web
git commit -m "feat: upload screenshots from the VR run page; VR result lines and waiting counts"
```

---

### Task 8: End-to-end step, docs, whole-branch verification

**Files:**
- Create: `scripts/e2e-vr-capture.ts`
- Modify: `scripts/e2e.ts` (import and one call; it is at the line limit, so move an existing few lines into a step module if needed and say so), `AGENTS.md`

**Interfaces:**
- Consumes: everything above; the script's existing fake vision endpoint and upload helper (as `scripts/e2e-web-upload.ts` uses them).
- Produces: `checkVrCapture(ctx, today, …)` called after the existing VR step.

The step, against the real HTTP app and the scratch database:
1. Create a VR run of its own (as `scripts/e2e-vr.ts` does: opening buy, morning run, cycle 1 open). Upload a screenshot pinned to the run whose fake reading has three fills for its ticker (one buy at the first buy rung's price and lot, one unrelated extra buy, one with no date) → a `vr-outcome` with `waiting 3`; `GET /vr/runs/:id/pending` lists three rows, the undated one with `dateRead false`; the run detail's `pendingCount` is 3 and its books are unchanged.
2. The same screenshot again → `'duplicate'`.
3. Confirm the first row → a fill with `source` capture exists, shares and Pool moved by it, the first buy rung is used up, `pendingCount` 2.
4. Reject the second; edit the third's shares and confirm it → `pendingCount` 0; the screenshot is gone (`GET /api/captures/<id>/image` answers 404).
5. The same screenshot again → `'duplicate'`. A different image whose fake reading has the two unedited fills → `vr-outcome` with `waiting 0` and `dropped 2`.
6. On a second new VR run whose opening buy was typed in but which has no cycle yet, upload a screenshot that leaves one fill waiting, then run the morning job: the held message is sent and no cycle opens; reject the fill and run it again: cycle 1 opens. (The script's date is fixed, so the hold is exercised on cycle 1, not on a roll.)
7. Create an MR run and a VR run on one ticker that no other step uses; an un-pinned upload of a screenshot for that ticker → an `ambiguous` event and nothing waiting on either.

- [ ] **Step 1: Write `scripts/e2e-vr-capture.ts` and wire it in.**
- [ ] **Step 2: Run the smoke** — `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_vrcap bun scripts/e2e.ts` → exits 0, the new assertions counted.
- [ ] **Step 3: Update `AGENTS.md`** — repo map (every file this branch adds, enumerated with `git diff --name-status main -- . ':!docs'`; migrations end at `0017_vr_capture.sql`); project overview (VR fills also arrive by screenshot; they are confirmed on the VR run page); Conventions: add "`capture_choices` is a shared table (a parked Telegram question). A screenshot for a ticker with exactly one active MR run and one active VR run is asked about on Telegram and is 'several active runs' on an un-pinned web upload." and add `capture_choices` to the shared-tables list.
- [ ] **Step 4: Whole-branch checks**

```bash
bun run typecheck
bun test
TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_vrcap bun test
(cd apps/server && bun run db:generate < /dev/null)
git status --short
git diff --stat main -- apps/server/db/migrations | grep -E "00(0[0-9]|1[0-6])_"
git diff --name-only main -- apps packages scripts | grep -E "\.(ts|tsx)$" | grep -v "\.test\." | xargs wc -l | sort -n | tail -8
docker exec st-mariadb-test mariadb -uroot -ptest -e "SHOW DATABASES LIKE 'st_e2e%'; SHOW DATABASES LIKE 'st_janitor%'; SELECT COUNT(*) AS new_tables_in_st_test FROM information_schema.tables WHERE table_schema = 'st_test' AND table_name IN ('vr_pending_fills','capture_choices')"
```

Expected: typecheck clean; 0 fail in both runs; "No schema changes"; a clean tree after the commit below; the migrations diff prints nothing for 0000–0016; no non-test source file this branch touched is over ~300 lines; no scratch database left; `new_tables_in_st_test` is 0.

- [ ] **Step 5: Commit and report**

```bash
git add -A scripts AGENTS.md
git commit -m "test: VR screenshot end-to-end step; docs: repo map and conventions for VR screenshot intake"
```

Report the results of Steps 2 and 4. Leave `st_test_vrcap` in place and do not push or deploy.

---

### Task 9: Duplicate rules that know the order price

Added after the final review, on the owner's decision. The spec's "VR intake" rule 2 (amended) is the requirement; read it first.

**Files:**
- Create: `apps/server/src/domain/vr/capture-match.ts`, `apps/server/test/vr-capture-match.test.ts`, migration `apps/server/db/migrations/0018_vr_order_price.sql` (+ `meta/`)
- Modify: `apps/server/src/db/schema-vr.ts`, `apps/server/src/db/repos-vr.ts`, `apps/server/src/domain/vr/repo-types.ts`, `apps/server/src/domain/vr/capture.ts`, `apps/server/src/domain/vr/pending.ts`, `apps/server/src/domain/capture-dedup.ts` (remove `dropExactMatches`: the file goes back to its content on `main`), `apps/server/test/vr-fakes.ts`, `apps/server/test/vr-capture.test.ts`, `apps/server/test/vr-pending.test.ts`, `apps/server/test/db-vr-pending.test.ts`, `apps/server/test/migration-sql.test.ts`, `apps/server/test/http-vr-pending.test.ts`, `apps/web/src/api.vr.types.ts`, `apps/web/src/components/vr/VrPendingPanel.tsx` and its tests, `apps/web/src/testing/vr.ts`, `apps/web/src/i18n/en.json`, `ko.json`, `scripts/e2e-vr-capture.ts`, `AGENTS.md`

**Interfaces:**
- `vr_pending_fills.order_price` and `vr_fills.order_price`: `bigint` ten-thousandths, nullable. `VrPendingRow.orderPrice: bigint | null`, `NewVrPending.orderPrice: bigint | null`; `VrFillRow.orderPrice: bigint | null`, and `NewVrFill` takes it as optional (absent = null) so typed-fill call sites do not change.
- `capture-match.ts` (pure, no repositories):

```ts
export interface VrExisting { kind: 'booked' | 'waiting' | 'rejected'; side: 'buy' | 'sell'; shares: number; price: bigint; filledOn: ISODate; orderPrice: bigint | null }
export interface VrMatch { rows: { fill: RawFill; dupPrice: bigint | null }[]; dropped: number }
export function matchVrFills(existing: readonly VrExisting[], incoming: readonly RawFill[], today: ISODate): VrMatch
```

- `VrPendingDto` gains `orderPrice: string | null` (ten-thousandths string, as `price`).

Rules (`matchVrFills`), with `known(x)` = an order price that is present and not zero, and a missing date read as `today`:

(Corrected before coding by the notes' check of these rules; `task-9-impl-notes.md` section 1.2 is the precise algorithm and is binding.)

1. Only a drop consumes an entry. Entries are tried booked first, then waiting, then rejected (the matcher sorts them itself, stably).
2. **Drops first, for every incoming fill, walking the fills in a canonical order (not screenshot order), in three passes:** an unconsumed entry of any kind with the same side, shares, price and date and (D1) an equal known order price; then (D2a) the fill's order price known and the entry's unknown; then (D2b) the fill's order price unknown. The fill is dropped and the entry consumed. A drop never happens where both order prices are known and different.
3. **Marks, for the fills that are left; marks consume nothing.** A fill is marked, `dupPrice` = the cited entry's price, when an entry with the same side and date satisfies, in this order of preference:
   - (A) order prices both known and equal — entry used by a drop or not; booked, waiting or rejected;
   - (B) same shares and price, order prices both known and different — entry not used by a drop; booked, waiting or rejected;
   - (C) same shares, other price, either order price unknown — entry not used by a drop; booked or waiting only.
4. **Twins inside the screenshot** (added after the scoped final check): among the kept fills with a known order price, group by side, date and order price; in a group of two or more, the first in canonical order stays as it is and every other row that is still unmarked is marked, `dupPrice` = that first row's price.
5. Everything else is a plain row (`dupPrice` null). Rows come back in screenshot order.

`ingestVrCapture` builds the existing entries (booked from `vrFillRepo.listForRun`, waiting and rejected from `vrPendingRepo.listForRun`), calls `matchVrFills` on the run's own-ticker fills and writes one row per result with `dateRead: fill.date != null` and `orderPrice` = the fill's order price when known, else null. `matchCapturedFills`, `dropExactMatches` and the `unreadDates` helper are no longer used by VR; the outcome counts keep their meaning (`possibleDuplicates` = rows with a `dupPrice`). The same-screenshot refusal (`hasAnyForCapture`) is unchanged.

`confirmVrPending` passes the row's `orderPrice` to the fill it books. Editing a waiting row or a booked fill never changes the order price. Typed fills have none.

Web: the Pending table shows the order price in its own column (blank when none), formatted like the read price. Nothing else on the web changes.

- [ ] **Step 1: Schema and migration.** Add the two columns; `(cd apps/server && bunx drizzle-kit generate --name vr_order_price < /dev/null)`; the generated SQL must be exactly two `ALTER TABLE ... ADD` statements (one per table) and nothing else; any interactive question is a stop-and-report. `0017_vr_capture.sql` and its snapshot stay byte-identical. Add a `migration-sql.test.ts` case for `0018` (two ADD statements, no DROP / RENAME / MODIFY, journal `when` larger than 0017's). Migrate the branch database by running the DB suite.
- [ ] **Step 2: Write the failing tests.**
  - `vr-capture-match.test.ts`: every cell of the spec's table in both directions; the reviewer's two sequences with their numbers — (a) existing waiting buys of 3 at 44.39, 43.66 and 42.95 with those order prices, incoming 3 at 42.95 (order 42.95), 42.26 (order 42.26), 41.59 (order 41.59) → 1 dropped, 2 plain rows, no marks; the same incoming with NO order prices → 1 dropped, 2 marked (the old behaviour, pinned); (b) a gap open: existing waiting buys of 3 at 42.00 with order prices 44.39 and 43.66, incoming 3 at 42.00 with order price 42.95 → kept and marked, not dropped; incoming with order price 43.66 → dropped; (c) a booked 3 at 44.39 with order price 44.39, incoming 8 at 44.39 with order price 44.39 → marked; with order price unknown → plain; (d) a rejected entry drops an equal fill; with both order prices known it marks a fill that differs in order price, price or shares; with an unknown order price it never marks; (e) multiset: two equal existing entries cancel two equal incoming fills and a third is kept — plain without order prices, marked when all carry the same known order price; (e2) two leftover fills that both match one entry are both marked (an order-price misread next to a genuine other rung at the same fill price); (f) the result does not depend on the order of the incoming fills (permute); (g) an order price of `0.0000` counts as unknown; (h) a fill with no date uses `today`.
  - `vr-capture.test.ts`: rows carry `orderPrice`; the existing cases keep their expected outcomes (their fixtures have no order prices, so the old rules apply) — any existing expectation that changes is a finding to report, not to edit silently; add the two-screenshot ladder day end to end (second screenshot → `possibleDuplicates: 0`).
  - `vr-pending.test.ts`: confirm copies the order price to the fill; an edit keeps it; Confirm all confirms the second screenshot's unmarked rung fills.
  - `db-vr-pending.test.ts`: the column round-trips on both tables (a value, null); `confirm` writes it to `vr_fills`.
  - `http-vr-pending.test.ts`: `orderPrice` in the list as a string or null.
  - web: the Pending table's order-price column (a value with four decimals, blank for null).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Smoke.** In `scripts/e2e-vr-capture.ts` add, on the first run of the step: a second screenshot of the same day (different image) with one fill of the same lot at another rung's price and order price → `waiting 1`, `possibleDuplicates 0`, and Confirm all books it (`confirmed 1`); and one fill with the same order price as an already booked fill but another fill price → `possibleDuplicates 1`. Keep `scripts/e2e.ts` at or under 300 lines.
- [ ] **Step 5: Docs.** `AGENTS.md`: migrations end at `0018_vr_order_price.sql` (plain `drizzle-kit generate` output), the new files in the repo map, and in Conventions: "VR screenshot fills are matched against the run's booked, waiting and rejected fills by side, shares, price, date and the order price read from the screenshot (`domain/vr/capture-match.ts`); mean reversion's matcher (`domain/capture-dedup.ts`) is not used by VR."
- [ ] **Step 6: Run** — `bun run typecheck`; `bun test`; `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_vrcap bun test`; `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test_vrcap bun scripts/e2e.ts`; `(cd apps/server && bun run db:generate < /dev/null)` → "No schema changes, nothing to migrate"; `git diff main -- apps/server/src/domain/capture-dedup.ts` prints nothing; `git diff 968aa8f -- apps/server/db/migrations/0017_vr_capture.sql apps/server/db/migrations/meta/0017_snapshot.json` prints nothing.
- [ ] **Step 7: Commit**

```bash
git add -A apps packages scripts AGENTS.md
git commit -m "feat: VR screenshot matching knows the order price; rung fills are no longer marked as duplicates"
```
