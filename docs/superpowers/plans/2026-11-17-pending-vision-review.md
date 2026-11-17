# Pending View Rework + Vision Review Archive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every field of a pending fill directly editable next to the screenshot it came from, and keep that screenshot plus a frozen detected-vs-corrected record whenever the operator corrects what vision read.

**Architecture:** Screenshot bytes land in a new `capture_images` table (1:1 with `captures`, LONGBLOB, insert-or-ignore) at ingest time; the vision snapshot is frozen onto `pending_fills` at insert and into a `vision_reviews` row at each resolution. A `keep` flag on the image decides whether the sweep that runs after every confirm/reject deletes the bytes and the frozen rows or archives them forever. The web row becomes one control per field (date, side, qty, price, fee) pre-filled from the snapshot, with a side-by-side dialog and a keep/discard prompt.

**Tech Stack:** Bun, TypeScript, Drizzle ORM + MariaDB, Hono, React 19 + Tailwind, `bun:test` with `@happy-dom/global-registrator`.

**Spec:** `docs/superpowers/specs/2026-11-16-pending-vision-review-design.md`

**Baseline:** `main` at `eed3571` (feat: per-bucket cut-loss stops, editable sim drafts, cost-as-percent, cached bars — #42). Every line reference below was re-verified against that commit. What #42 changed that this plan has to respect:

- **Migration `0007` is taken.** Ours is `0008_*`. `apps/server/test/migration-sql.test.ts` pins a hand-appended `UPDATE sim_runs SET draft = 0` inside `0007` — never regenerate `0007`, and leave that test alone. Our migration is pure drizzle-kit output with no hand edits.
- **Repos are split by area now**: `repos.ts` composes `getSimRepo` (`repos-sim.ts`) and `getBarRepos` (`repos-bars.ts`). Our two repos follow that convention in a new `repos-vision.ts`.
- **`confirmPendingFill` changed shape**: the `withRunLock` block now *returns* the sibling orders that were cancelled, and `notifySiblingsCancelled` runs after the lock (`booking.ts:206-229`). `BookingDeps` carries `notifySiblingCancelled`, and routes build deps via `fillBookingDeps()` in `apps/server/src/http/booking-deps.ts`.
- **`apps/web/src/catalog.test.ts` is new** and enforces three things on the i18n catalogs: en/ko key parity, keys sorted in `localeCompare` order, and no Chinese characters in ko values. New keys must be slotted in alphabetically in both files.
- **The e2e script is now modular**: `scripts/e2e.ts` drives step modules (`e2e-cutloss.ts`, `e2e-sim-drafts.ts`) through the shared `E2eCtx` in `scripts/e2e-ctx.ts`. Our smoke becomes another step module, not an inline block.
- `PendingTable.tsx`, `PendingTable.test.tsx` and `components/hooks.tsx`'s `Route` union were **not** touched by #42, so the references to them in Tasks 7–10 stand as written.

## Global Constraints

- No source file over ~300 lines; split by responsibility. `packages/*` never import `apps/*`.
- Money as `@st/core/money` bigint myriadths, never float; fees in integer cents; cost in integer ppm.
- All user-facing copy through `apps/web/src/i18n/en.json` + `ko.json`. English and Korean only — never Chinese or Cyrillic characters, including in comments.
- Commit style: `feat|fix|docs|test|refactor|chore:`.
- Drizzle has **no blob helper** for MySQL (`drizzle-orm/mysql-core` 0.44.7 ships `binary`/`varbinary` only). LONGBLOB needs `customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'longblob' })`.
- Migrations are **generated, never hand-written**: edit `apps/server/src/db/schema.ts`, then `bun run --cwd apps/server db:generate`. Next file is `0008_*` (`0007_even_slayback.sql` belongs to #42).
- DB-backed tests need `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test`; `bun test` alone self-skips `db.test.ts`.
- Byte cap for a stored screenshot: **8 MB**. Over the cap, store nothing and let the fill proceed — a missing screenshot must never block booking.
- `vision_reviews.pending_fill_id` is UNIQUE; the archive write happens **after** booking succeeds, inside the same run-lock span.
- Keep is sticky: once true, never flipped back to false.

## Review Focus

Five failure modes the spec implies that no feature-shaped test would naturally cover. Each has a test assigned to the task owning its code.

1. **A screenshot over the 8 MB cap** must still book its fills — no bytes stored, no keep prompt, no throw. (Task 2, Step 7)
2. **Re-ingesting a screenshot whose image was kept after a reject** must not collide on the image primary key and fail ingest inside the run lock. (Task 2, Step 9)
3. **Price equality across formatting** — `178.4` vs `178.40` parse to the same myriadths and must not count as an edit, or every confirm prompts. (Task 6, Step 3)
4. **A legacy pending row** (null `detected_at`, captured before this work) must confirm exactly as it does today, with no prompt and no archive row. (Task 6, Step 5)
5. **The image endpoint with a nonexistent capture id, and with no credentials** must 404 and 401 respectively, never leaking bytes. (Task 5, Step 7)

---

## File Structure

**Server — create**
- `apps/server/src/domain/capture-image.ts` — store (insert-or-ignore, cap), keep flag, sweep.
- `apps/server/src/domain/vision-review.ts` — edit detection, frozen-row writes, list/delete shaping.
- `apps/server/src/http/routes/vision-review.ts` — review endpoints + the image endpoint.

**Server — create**
- `apps/server/src/db/repos-vision.ts` — `getVisionRepos(db)`, following `repos-bars.ts` / `repos-sim.ts`.

**Server — modify**
- `apps/server/src/db/schema.ts` — `captureImages`, `visionReviews`, `pendingFills` snapshot columns.
- `apps/server/src/db/repos.ts` — compose `getVisionRepos` into the `getRepos` return.
- `apps/server/src/domain/booking.ts` — `RepoSurface` additions; snapshot + image store in `ingestCapture`; `side`/`feeCents` overrides and the archive hook in `confirmPendingFill`.
- `apps/server/src/http/routes/pending.ts` — new request-body fields.
- `apps/server/src/http/app.ts` — `HttpRepoSurface` additions, mount the new router.
- `apps/server/src/wire/capture.ts` — adapt to `confirmPendingFill`'s new signature; the Telegram reject path discards.

**Web — create**
- `apps/web/src/components/forms/PendingRow.tsx` — the five controls for one row.
- `apps/web/src/components/forms/PendingReviewDialog.tsx` — side-by-side image + fields, Cancel/Done.
- `apps/web/src/components/forms/KeepImagePrompt.tsx` — the two-button prompt.
- `apps/web/src/pages/VisionReview.tsx` — the tab.
- `apps/web/src/components/VisionReviewEntry.tsx` — one archived screenshot + its diff table.

**Web — modify**
- `apps/web/src/components/forms/PendingTable.tsx` — fetch/act/table shell only; row rendering moves to `PendingRow`.
- `apps/web/src/api.types.ts`, `api.ts`, `viewmodels.ts`, `components/hooks.tsx`, `App.tsx`, `components/Layout.tsx`, `i18n/en.json`, `i18n/ko.json`.

**Tests**
- Create: `apps/server/test/capture-image.test.ts`, `apps/server/test/vision-review.test.ts`, `apps/server/test/http-vision-review.test.ts`, `apps/web/src/components/forms/PendingReviewDialog.test.tsx`, `apps/web/src/components/forms/KeepImagePrompt.test.tsx`, `apps/web/src/pages/VisionReview.test.tsx`.
- Modify: `apps/server/test/booking.test.ts` (+ its exported `fakeRepos`), `apps/server/test/http-fakes.ts`, `apps/server/test/http-pending-settings.test.ts`, `apps/server/test/db.test.ts`, `apps/web/src/components/forms/PendingTable.test.tsx`, `apps/web/src/viewmodels.test.ts`, `scripts/e2e.ts`.

---

### Task 1: Schema, migration, repos

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/repos-vision.ts`
- Modify: `apps/server/src/db/repos.ts:1-6` (import) and `:227` (the `getRepos` return)
- Create: `apps/server/db/migrations/0008_*.sql` (generated)
- Test: `apps/server/test/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // schema.ts
  export const captureImages   // capture_images
  export const visionReviews   // vision_reviews
  // repos-vision.ts
  export function getVisionRepos(db: any): { captureImageRepo: …; visionReviewRepo: … }
  // getRepos(db) return value gains both, spread from getVisionRepos(db)
  captureImageRepo: {
    insertIgnore(row: { captureId: number; mime: string; bytes: Buffer; byteLen: number }): Promise<boolean>
    getBytes(captureId: number): Promise<{ mime: string; bytes: Buffer } | null>
    setKeep(captureId: number): Promise<void>
    deleteFor(captureId: number): Promise<void>
    listKept(limit: number): Promise<Array<{ captureId: number; mime: string; byteLen: number; createdAt: string }>>
  }
  visionReviewRepo: {
    insertIgnore(row: VisionReviewInsert): Promise<void>
    listForCaptures(captureIds: number[]): Promise<VisionReviewRow[]>
    deleteFor(captureId: number): Promise<void>
  }
  ```
  `VisionReviewInsert`/`VisionReviewRow` live in `apps/server/src/domain/vision-review.ts` (Task 4), mirroring how `CorrectionRepo` lives in `domain/correction-types.ts`; `repos-vision.ts` uses structural types until Task 4 lands.

- [ ] **Step 1: Add the three schema changes**

In `apps/server/src/db/schema.ts` (`boolean` is already imported at `:1`; `uniqueIndex` arrives via the import at `:179`):
- a `longblob` custom type as described in Global Constraints;
- `captureImages` = `mysqlTable('capture_images', …)` with `captureId` int primary key, `mime` varchar(32) notNull, `bytes` longblob notNull, `byteLen` int notNull, `keep` boolean notNull default false, `createdAt` timestamp notNull defaultNow;
- `visionReviews` = `mysqlTable('vision_reviews', …)` with the columns in the spec's table, `pendingFillId` carrying `uniqueIndex('vision_reviews_pending_fill_unique')` and `captureId` carrying `index('vision_reviews_capture_idx')`;
- on `pendingFills` (`schema.ts:60-74`): `detectedSide` varchar(8), `detectedShares` int, `detectedPrice` bigint mode bigint, `detectedFilledOn` date mode string, `detectedFee` int — all nullable — plus `detectedAt` timestamp mode string, nullable (its presence is what distinguishes "vision missed this field" from "row predates this work").

- [ ] **Step 2: Generate the migration**

Run: `bun run --cwd apps/server db:generate`
Expected: a new `apps/server/db/migrations/0008_*.sql` plus updated `meta/` snapshots. Read the SQL and confirm `bytes` is `longblob` and the unique index on `pending_fill_id` is present. `0007_even_slayback.sql` must be byte-identical afterwards — it carries a hand-appended backfill that `apps/server/test/migration-sql.test.ts` asserts. Run `bun test apps/server/test/migration-sql.test.ts` to prove it.

- [ ] **Step 3: Write the failing repo tests**

In `apps/server/test/db.test.ts`, following the file's existing pattern (self-skipping without `TEST_DATABASE_URL`):

```ts
test('captureImageRepo: insertIgnore stores once, second call reports false and keeps the original bytes', async () => {
  // insertIgnore({captureId: c, mime:'image/png', bytes: Buffer.from('one'), byteLen: 3}) -> true
  // insertIgnore({captureId: c, mime:'image/jpeg', bytes: Buffer.from('two'), byteLen: 3}) -> false
  // getBytes(c) -> { mime: 'image/png', bytes matching 'one' }
})
test('captureImageRepo: setKeep then deleteFor', async () => {
  // listKept(10) contains the capture after setKeep; deleteFor removes it; getBytes -> null
})
test('visionReviewRepo: insertIgnore is idempotent per pendingFillId and listForCaptures groups by capture', async () => {
  // two insertIgnore calls with the same pendingFillId leave exactly one row
  // listForCaptures([c1, c2]) returns rows for both, ordered by id
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db.test.ts`
Expected: FAIL — `captureImageRepo` is undefined.

- [ ] **Step 5: Implement both repos in `apps/server/src/db/repos-vision.ts`**

Signatures as in Interfaces, exported from `getVisionRepos(db)` the way `getBarRepos` works in `repos-bars.ts`. `insertIgnore` must use MySQL's duplicate-key tolerance rather than a read-then-write (`onDuplicateKeyUpdate` with a no-op `set`, as `settingsRepo.set` does at `repos.ts:217`), returning whether a row was created. `listKept` and `listForCaptures` must select **named columns only** — never `select()` — so no listing path can drag the blob; `getBytes` is the one method that reads `bytes`. Spread `getVisionRepos(db)` into the `getRepos` return at `repos.ts:227`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db.test.ts`
Expected: PASS. Also run `bun run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/repos.ts apps/server/src/db/repos-vision.ts apps/server/db/migrations apps/server/test/db.test.ts
git commit -m "feat: capture_images and vision_reviews tables with repos"
```

---

### Task 2: Store the image and the detected snapshot at ingest

**Files:**
- Create: `apps/server/src/domain/capture-image.ts`
- Modify: `apps/server/src/domain/booking.ts:26-48` (`RepoSurface`), `:156-196` (`ingestCapture`)
- Create: `apps/server/test/capture-image.test.ts`
- Modify: `apps/server/test/booking.test.ts:30-130` (`fakeRepos`)

**Interfaces:**
- Consumes: `captureImageRepo` (Task 1).
- Produces:
  ```ts
  // capture-image.ts
  export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
  export async function storeCaptureImage(
    repos: Pick<RepoSurface, 'captureImageRepo'>,
    captureId: number,
    image: { base64: string; mime: string },
  ): Promise<boolean>   // false when over the cap (nothing stored)
  ```
  `RepoSurface` in `booking.ts` gains `captureImageRepo` and `visionReviewRepo` with the Task 1 shapes.

- [ ] **Step 1: Extend the test fakes**

Add `captureImageRepo` and `visionReviewRepo` to `fakeRepos()` in `apps/server/test/booking.test.ts` (array-backed, mirroring the Task 1 semantics: `insertIgnore` no-ops on an existing key and reports `false`), expose them on `_stores` (`:127-130`) as `captureImages` and `visionReviews`, and add both to the returned `repos`. Do the same in `apps/server/test/http-fakes.ts` beside `captureRepo` (`:90`), the `repos` object (`:213`) and the `makeFakes` return (`:217`). `apps/server/test/http-fakes.test.ts` asserts the fakes' own behaviour — run it after the change and extend it if it enumerates the repo surface.

- [ ] **Step 2: Write the failing tests**

In `apps/server/test/capture-image.test.ts`, using `fakeRepos` imported from `./booking.test`:

```ts
test('ingestCapture stores the image bytes for a capture that produced pending fills', async () => {
  // after ingestCapture with one fresh fill: _stores.captureImages has one row,
  // captureId === the pending row's captureId, mime 'image/png', byteLen > 0
})
test('ingestCapture stores no image when the extract produced no pending fills', async () => {
  // ok:false extract -> 'rejected', captureImages empty
})
test('ingestCapture freezes the detected snapshot on each pending row', async () => {
  // fills [{shares:5, price:'10.00', date:'2026-11-04'}, {shares:2, price:'9.00'}]
  // row 0: detectedShares 5, detectedPrice parseUsd('10.00'), detectedFilledOn '2026-11-04', detectedAt set
  // row 1: detectedFilledOn === null even though filledOn === today (the substitute is not the snapshot)
})
test('ingestCapture snapshots a missing fee as null and a present fee as cents', async () => {
  // fill with fee '0.21' -> detectedFee 21; fill without fee -> detectedFee null
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test apps/server/test/capture-image.test.ts`
Expected: FAIL — no `captureImages` store entries, `detectedShares` undefined.

- [ ] **Step 4: Implement `storeCaptureImage`**

In `apps/server/src/domain/capture-image.ts`. Decode `image.base64` to a Buffer, compare its length against `MAX_IMAGE_BYTES`, and delegate to `captureImageRepo.insertIgnore`. Over the cap: return `false` without touching the repo.

- [ ] **Step 5: Wire it into `ingestCapture`**

In `apps/server/src/domain/booking.ts`, in the `for (const f of fresh)` loop around the `pendingRepo.insert` call at `:180`: pass the `detected_*` fields and `detectedAt: deps.today` — `detectedSide: f.side`, `detectedShares: f.shares`, `detectedPrice: parseUsd(f.price)`, `detectedFilledOn: f.date ?? null` (**not** the `filledOn` substitute), `detectedFee: feeCentsVal` — and call `storeCaptureImage` once after the loop, only when `pendingRows.length > 0`, inside the existing `withRunLock` span and before the `return` branches at `:191-194`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test apps/server/test/capture-image.test.ts apps/server/test/booking.test.ts`
Expected: PASS.

- [ ] **Step 7: Review Focus 1 — the byte cap**

```ts
test('an image over the cap books its fills and stores no bytes', async () => {
  // base64 for MAX_IMAGE_BYTES + 1 bytes
  // ingestCapture returns pending rows; _stores.captureImages is empty; no throw
})
```
Implement if needed, then run: `bun test apps/server/test/capture-image.test.ts` — PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/domain/capture-image.ts apps/server/src/domain/booking.ts apps/server/test
git commit -m "feat: persist capture screenshots and the vision snapshot at ingest"
```

- [ ] **Step 9: Review Focus 2 — re-ingest after a kept reject**

```ts
test('re-ingesting a screenshot whose image was kept after a reject does not throw and reuses the bytes', async () => {
  // ingest -> reject the pending row -> captureImageRepo.setKeep(captureId)
  // ingest the same image again: no throw, a new pending row exists,
  // captureImages still holds exactly one row with the original bytes
})
```
Run: `bun test apps/server/test/capture-image.test.ts`
Expected: PASS — `insertIgnore` already covers it. If it throws, fix the store, not the test.

- [ ] **Step 10: Commit**

```bash
git add apps/server/test/capture-image.test.ts
git commit -m "test: cover the byte cap and re-ingest after a kept reject"
```

---

### Task 3: `side` and `feeCents` overrides on confirm

**Files:**
- Modify: `apps/server/src/domain/booking.ts:198-229` (`confirmPendingFill`)
- Modify: `apps/server/src/wire/capture.ts` (the `confirmPendingFill` call in `onConfirm`)
- Test: `apps/server/test/booking.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces:
  ```ts
  export interface ConfirmOverrides {
    shares?: number
    price?: string          // USD string
    filledOn?: ISODate
    side?: 'buy' | 'sell'
    feeCents?: number | null  // null => recompute from the run's costPpm
  }
  export function confirmPendingFill(
    pendingId: number,
    overrides: ConfirmOverrides | null,
    deps: BookingDeps,
  ): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**

In `apps/server/test/booking.test.ts`, beside the existing confirm tests:

```ts
test('confirming with side: "sell" books a sell against a held bucket', async () => {
  // run seeded with one held bucket of 10 @ 10.00; pending row says side 'buy'
  // confirmPendingFill(id, { side: 'sell' }, deps)
  // the booked fill has side 'sell' and the bucket is emptied
})
test('a side override to sell with no held bucket throws no-bucket-for-sell and leaves the row pending', async () => {
  // expect DomainError kind 'no-bucket-for-sell'; _stores.pending[0].status === 'pending'
})
test('a sell override that empties a bucket still cancels and notifies the sibling order', async () => {
  // bucket with both a sell_loc target and a stop_sell leg open
  // after the override confirm: the untriggered leg is 'cancelled' with 'broker-filled'
  // and deps.notifySiblingCancelled saw it
})
test('side joins the edited patch written to the pending row on confirm', async () => {
  // after a sell override, _stores.pending[0].side === 'sell'
})
test('feeCents: null recomputes the fee from the run cost ppm', async () => {
  // pending.fee = 999; confirm with { price: '20.00', feeCents: null }
  // booked fill fee === feeCents(parseUsd('20.00'), shares, run.costPpm)
})
test('feeCents: 0 books a zero fee', async () => {
  // booked fill fee === 0 (not recomputed, not the pending fee)
})
test('an invalid side override throws invalid-side and books nothing', async () => {
  // confirmPendingFill(id, { side: 'SELL' as any }, deps) rejects; fills empty
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/server/test/booking.test.ts`
Expected: FAIL — the overrides are ignored, so the fill books as a buy with the pending fee.

- [ ] **Step 3: Implement the overrides**

In `confirmPendingFill`: export `ConfirmOverrides`, validate `side` against `['buy','sell']` (throw `new Error('invalid-side')` otherwise) and `feeCents` as `null` or an integer ≥ 0 (`invalid-fee`), then pass `side: overrides?.side ?? pending.side` and `feeCents: overrides?.feeCents !== undefined ? overrides.feeCents : pending.fee` into the `bookUnlocked` call at `booking.ts:217`. `bookUnlocked` already treats `feeCents: null` as "compute" (`booking.ts:92`) and already branches on `side`; `side` must also reach the `edited` patch at `booking.ts:133`.

Leave the sibling-cancel plumbing intact: the `withRunLock` block **returns** `bookUnlocked`'s cancelled-orders result and `notifySiblingsCancelled` runs after the lock (`:206-229`). A `side` override to `sell` now routes through the five-rung match chain in `apps/server/src/domain/sell-match.ts`, so a sell override can legitimately cancel a sibling stop order — the existing notify path must still fire.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test apps/server/test/booking.test.ts apps/server/test/wire.test.ts apps/server/test/http-sibling-notify.test.ts`
Expected: PASS. `wire/capture.ts` passes `null` overrides, so it needs no behavioural change — only a typecheck pass: `bun run typecheck`.

- [ ] **Step 5: Map the new codes in the HTTP + Telegram layers**

The fallback at `apps/server/src/http/routes/pending.ts:22` already returns `{error: e.message}` with 422, so both codes surface without a new branch — assert that in a route test rather than adding a case. Add them to `CONFIRM_ERROR_KEYS` in `apps/server/src/wire/capture.ts:12` with new `confirm-err-*` entries in `packages/telegram/src/i18n.ts` (en + ko). While there, `bucket-not-held` is a known gap in that map (noted in #42's follow-ups) — adding it is a one-line fix and in scope for this step.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/domain/booking.ts apps/server/src/wire/capture.ts apps/server/src/http/routes/pending.ts packages/telegram/src/i18n.ts apps/server/test/booking.test.ts
git commit -m "feat: side and fee overrides when confirming a pending fill"
```

---

### Task 4: Freeze, keep, sweep

**Files:**
- Create: `apps/server/src/domain/vision-review.ts`
- Modify: `apps/server/src/domain/booking.ts` (`confirmPendingFill`), `apps/server/src/http/routes/pending.ts` (reject path)
- Create: `apps/server/test/vision-review.test.ts`

**Interfaces:**
- Consumes: `captureImageRepo`, `visionReviewRepo` (Task 1); `ConfirmOverrides` (Task 3).
- Produces:
  ```ts
  export interface DetectedValues {
    side: string | null; shares: number | null; price: bigint | null
    filledOn: string | null; fee: number | null; detectedAt: string | null
  }
  export interface FinalValues {
    side: string; shares: number; price: bigint; filledOn: string; fee: number
  }
  /** null detected value + non-null final counts as edited; legacy rows (detectedAt null) never do. */
  export function isEdited(detected: DetectedValues, final: FinalValues | null): boolean
  export async function resolveReview(
    repos: ReviewRepos,
    args: {
      pendingRow: any; captureId: number | null
      outcome: 'confirmed' | 'rejected'
      final: FinalValues | null
      keepImage: boolean
    },
  ): Promise<void>   // freeze + keep flag + sweep, in that order
  ```

- [ ] **Step 1: Write the failing `isEdited` tests**

In `apps/server/test/vision-review.test.ts`:

```ts
test('identical values are not edited', …)
test('a changed share count, price, side, date or fee is edited', …)
test('a null detected value with a non-null final is edited', …)
test('a legacy row (detectedAt null) is never edited', …)
test('a rejected fill (final null) is not edited but is still archivable', …)
test('a derived fee (detected fee null, no feeCents override) is not edited', …)
```

*Plan correction, made during execution:* the fee is the one field the system
derives on its own, so "detected fee null, final fee computed from cost ppm" is
the normal path for a feeless screenshot, not a correction. Left as written,
every such capture would be marked edited and would prompt on every confirm.
The fee counts toward `edited` only when the confirm carried a `feeCents`
override; `final_fee` still records the booked fee either way. `isEdited`
therefore needs to know whether the fee came from the operator.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/server/test/vision-review.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `isEdited`**

In `apps/server/src/domain/vision-review.ts`. Compare prices as bigints, never as strings.

- [ ] **Step 4: Write the failing lifecycle tests**

```ts
test('confirming a fill freezes a vision_reviews row even when nothing is kept', async () => {
  // visionReviews has one row, outcome 'confirmed', edited false, finals populated
})
test('the sweep deletes the bytes and the frozen rows once the last fill resolves unkept', async () => {
  // two-fill capture: after the first confirm, captureImages still has the row;
  // after the second, captureImages and visionReviews for that capture are empty
})
test('keepImage on any fill keeps the bytes and all frozen rows of that capture', async () => {
  // three-fill capture, keep on the LAST confirm:
  // captureImages row survives with keep true, visionReviews has all three rows
})
test('keep is sticky: discarding on a sibling after a keep changes nothing', async () => {
  // keep on fill 1, keepImage false on fill 2 -> keep still true, bytes present
})
test('rejecting with keepImage archives the fill with null finals', async () => {
  // outcome 'rejected', final_* all null, bytes kept
})
test('a capture with a fill still pending keeps its bytes indefinitely', async () => {
  // one of two fills resolved, unkept -> bytes still present
})
```

- [ ] **Step 5: Run to verify they fail**

Run: `bun test apps/server/test/vision-review.test.ts`
Expected: FAIL — `resolveReview` not exported.

- [ ] **Step 6: Implement `resolveReview` and call it from both resolution paths**

`resolveReview` writes the frozen row via `visionReviewRepo.insertIgnore`, then `captureImageRepo.setKeep` when `keepImage`, then sweeps: if `pendingRepo.hasLiveForCapture(captureId)` is false and the image is not kept, `captureImageRepo.deleteFor` **and** `visionReviewRepo.deleteFor`. A null `captureId` (manual rows) makes the whole call a no-op.

Call it from `confirmPendingFill` **after `bookUnlocked` returns**, inside the existing `withRunLock` span (see the spec: a late `no-empty-bucket` must not leave a confirmed-looking record), with `confirmPendingFill` taking a fourth argument `opts?: { keepImage?: boolean }`. Mind the shape #42 left behind: that block now ends with `return bookUnlocked(…)` and its value feeds `notifySiblingsCancelled` outside the lock (`booking.ts:206-229`). Capture the result in a local, `await resolveReview(...)`, then return the local — the archive write must not displace the sibling-cancel notification.

Reject has **two** callers, and both must freeze and sweep: the HTTP route and the Telegram `onConfirm` "no" branch (`apps/server/src/wire/capture.ts`, which today calls `pendingRepo.decide(id, 'rejected')` bare). Put reject in one domain helper — `rejectPendingFill(pendingId, deps, opts?: { keepImage?: boolean })` in `confirm-pending.ts` — that takes `withRunLock(runId, …)`, calls `decide`, then `resolveReview`, containing archive failures the same way the confirm path does. Call it from both sites. A bare `decide` in either place leaves no frozen row and, if it was the capture's last pending fill, never sweeps the bytes.

*Plan correction, made during execution:* the original text wired only the HTTP route and described Telegram's reject as "discards", conflating "keeps no image" with "needs no lifecycle". Telegram rejects still pass `keepImage: false` — the spec's non-goal stands, there is no keep prompt over Telegram — but they must freeze and sweep like any other resolution.

- [ ] **Step 7: Run to verify they pass**

Run: `bun test apps/server/test/vision-review.test.ts apps/server/test/booking.test.ts apps/server/test/run-lock-writers.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/domain/vision-review.ts apps/server/src/domain/booking.ts apps/server/src/http/routes/pending.ts apps/server/test/vision-review.test.ts
git commit -m "feat: freeze detected-vs-final records and sweep unkept screenshots"
```

---

### Task 5: HTTP surface

**Files:**
- Create: `apps/server/src/http/routes/vision-review.ts`
- Modify: `apps/server/src/http/routes/pending.ts`, `apps/server/src/http/app.ts` (`HttpRepoSurface` and the `app.route('/api', …)` block)
- Create: `apps/server/test/http-vision-review.test.ts`
- Modify: `apps/server/test/http-pending-settings.test.ts`, `apps/server/test/http-fakes.ts`

**Interfaces:**
- Consumes: `resolveReview` (Task 4), `ConfirmOverrides` (Task 3), both repos (Task 1).
- Produces:
  ```ts
  export function visionReviewRouter(deps: HttpDeps): Hono
  // GET    /api/vision-reviews          -> { entries: VisionReviewEntryDto[] }
  // DELETE /api/vision-reviews/:captureId -> { ok: true } | 404 { error: 'not-found' }
  // GET    /api/captures/:id/image      -> bytes | 404 { error: 'not-found' }
  // GET    /api/pending rows gain: hasImage: boolean, detected: {...} | null, autoFeeCents: number
  // POST   /api/pending/:id/confirm body: { overrides?: {...}, keepImage?: boolean }
  // POST   /api/pending/:id/reject  body: { keepImage?: boolean }
  ```
  `VisionReviewEntryDto`: `{ captureId, runId, ticker, createdAt, mime, byteLen, fills: VisionReviewFillDto[] }`, fills ordered by `createdAt` then `id`.

- [ ] **Step 1: Write the failing pending-route tests**

In `apps/server/test/http-pending-settings.test.ts`:

```ts
test('GET /api/pending exposes hasImage and the detected snapshot', …)
test('GET /api/pending reports detected null for a legacy row without detectedAt', …)
test('GET /api/pending exposes autoFeeCents from the run cost ppm', …)   // feeCents(detected price, shares, run.costPpm)
test('POST confirm forwards side and feeCents overrides', …)   // assert the booking fake saw them
test('POST confirm with keepImage true keeps the image', …)
test('POST reject with keepImage true keeps the image', …)
```

- [ ] **Step 2: Write the failing review-route tests**

In `apps/server/test/http-vision-review.test.ts`, using `makeFakes`/`makeDeps`/`loginAs` from `./http-fakes`:

```ts
test('GET /api/vision-reviews groups frozen fills under their capture, newest first', …)
test('GET /api/vision-reviews is empty when nothing is kept', …)
test('DELETE /api/vision-reviews/:captureId removes the image and its frozen rows', …)
test('DELETE /api/vision-reviews/:captureId 404s for an unknown capture', …)
test('GET /api/captures/:id/image returns the bytes with the stored content type', …)
```

- [ ] **Step 3: Run both to verify they fail**

Run: `bun test apps/server/test/http-vision-review.test.ts apps/server/test/http-pending-settings.test.ts`
Expected: FAIL — 404 on the new routes.

- [ ] **Step 4: Implement the router**

In `apps/server/src/http/routes/vision-review.ts`. The image route returns a `Response` with the stored `mime` as `Content-Type` and `Cache-Control: private, max-age=300`. Prices go out through `jsonBig` like every other bigint. Mount with `app.route('/api', visionReviewRouter(deps))` alongside the existing routers and extend `HttpRepoSurface` with the two repos.

- [ ] **Step 5: Extend the pending routes**

Read `keepImage` and the two new override fields from the bodies, forward them to `confirmPendingFill(id, overrides, fillBookingDeps(deps), { keepImage })` — the deps come from `apps/server/src/http/booking-deps.ts`, do not hand-build a `BookingDeps` — and to the reject path's `resolveReview`. Add `hasImage`, `detected` and `autoFeeCents` to the `GET /api/pending` projection; today that route returns raw rows (`routes/pending.ts:9-11`), so it needs an explicit projection, and `detected` must be `null` whenever `detectedAt` is null.

- [ ] **Step 6: Run to verify they pass**

Run: `bun test apps/server/test`
Expected: PASS.

- [ ] **Step 7: Review Focus 5 — image endpoint hardening**

```ts
test('GET /api/captures/:id/image 404s for an unknown capture', …)
test('GET /api/captures/:id/image without credentials 401s', …)  // no Authorization, no cookie
```
Run: `bun test apps/server/test/http-vision-review.test.ts` — PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/http apps/server/test
git commit -m "feat: vision review and capture image endpoints"
```

---

### Task 6: Web client types and edit detection

**Files:**
- Modify: `apps/web/src/api.types.ts` (`PendingFillDto`), `apps/web/src/api.ts` (`Api` interface `:159-161`, implementations `:246-249`), `apps/web/src/viewmodels.ts:193-209` (`PendingIssue` / `pendingIssue`)
- Test: `apps/web/src/viewmodels.test.ts`, `apps/web/src/api.test.ts`

**Interfaces:**
- Consumes: the Task 5 wire shapes.
- Produces:
  ```ts
  // api.types.ts
  interface PendingFillDto { /* …existing… */ hasImage: boolean; detected: DetectedDto | null; autoFeeCents: number }
  interface DetectedDto { side: string | null; shares: number | null; price: string | null; filledOn: string | null; fee: number | null }
  interface VisionReviewEntryDto { captureId: number; runId: number; ticker: string; createdAt: string; mime: string; byteLen: number; fills: VisionReviewFillDto[] }
  interface VisionReviewFillDto { id: number; outcome: 'confirmed' | 'rejected'; edited: boolean; detected: DetectedDto; final: DetectedDto | null }
  // api.ts
  confirmPending(id: number, overrides?: PendingOverrides, keepImage?: boolean): Promise<void>
  rejectPending(id: number, keepImage?: boolean): Promise<void>
  listVisionReviews(): Promise<VisionReviewEntryDto[]>
  deleteVisionReview(captureId: number): Promise<void>
  captureImageUrl(captureId: number): string   // `/api/captures/${captureId}/image`
  // viewmodels.ts
  export interface RowValues { filledOn: string; side: string; shares: string; price: string; fee: string }
  export function pendingEdits(row: PendingFillDto, values: RowValues): Array<keyof RowValues>
  ```

- [ ] **Step 1: Write the failing `pendingEdits` tests**

In `apps/web/src/viewmodels.test.ts`:

```ts
describe('pendingEdits', () => {
  it('returns [] when every value matches the detected snapshot', …)
  it('names each field that differs', …)             // side, shares, price, filledOn, fee
  it('treats a null detected value with a filled-in field as edited', …)
  it('returns [] for a legacy row with detected null', …)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/web/src/viewmodels.test.ts`
Expected: FAIL — `pendingEdits` is not exported.

- [ ] **Step 3: Review Focus 3 — price formatting equality**

```ts
it('treats 178.4 and 178.40 as the same price', …)   // detected price myriadths for 178.40
it('treats a fee of "0.00" against detected fee 0 as unedited', …)
```

- [ ] **Step 4: Implement `pendingEdits`**

Compare prices and fees by parsing to myriadths/cents (`parseUsd` via `api.ts`'s re-export, `usdToCents` for the fee), never as display strings. Return `[]` when `row.detected` is null.

- [ ] **Step 5: Review Focus 4 — legacy confirm path**

Already asserted in Step 1's fourth case; verify the client sends no `keepImage` for such a row by checking it in Task 9's prompt test rather than duplicating here.

- [ ] **Step 6: Extend the API client and types**

Add the fields and methods in Interfaces. `captureImageUrl` is a plain string builder — the image is never fetched through `call()`, which always parses JSON. `apps/web/src/api.test.ts` asserts the client's request shapes; add cases there for the new `keepImage` bodies and the DELETE.

- [ ] **Step 7: Run to verify they pass**

Run: `bun test apps/web/src/viewmodels.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/api.types.ts apps/web/src/api.test.ts apps/web/src/viewmodels.ts apps/web/src/viewmodels.test.ts
git commit -m "feat: web types and edit detection for pending fills"
```

---

### Task 7: The pending row — one control per field

**Files:**
- Create: `apps/web/src/components/forms/PendingRow.tsx`
- Modify: `apps/web/src/components/forms/PendingTable.tsx` (full rewrite of the row markup), `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Modify: `apps/web/src/components/forms/PendingTable.test.tsx`

**Interfaces:**
- Consumes: `pendingEdits`, `RowValues`, `captureImageUrl` (Task 6); `Select`, `Input`, `Button` from `components/ui`.
- Produces:
  ```ts
  export function PendingRow(props: {
    row: PendingFillDto
    values: RowValues
    onChange: (patch: Partial<RowValues>) => void
    onOpenSideBySide: () => void
    onConfirm: () => void
    onReject: () => void
    busy: boolean
  }): JSX.Element
  export function initialRowValues(row: PendingFillDto): RowValues   // fee falls back to row.autoFeeCents
  ```

- [ ] **Step 1: Delete the obsolete layout assertions**

Three tests in `PendingTable.test.tsx` pin the *old* duplicated layout and must go, replaced by the Step 2 tests: `'trade date column shows the detected date above the override input'` (:172), `'quantity and price cells stack the detected value in a div above the override input, like the date cell'` (:186), and `'typing an override date keeps the detected date above it…'` (:200). Keep every error-handling test (:118-170) unchanged — they must still pass. Also update `ROW` (:24) with `hasImage: true`, `autoFeeCents`, and a `detected` snapshot. (#42 did not touch this file, so these line numbers are current.)

- [ ] **Step 2: Write the failing row tests**

```ts
it('renders exactly one control per editable field, pre-filled from the detected values', async () => {
  // date input value '2026-11-10'; select value 'buy'; qty input '10'; price input '12345.00'; fee input '1.00'
  // and no cell contains both a static value div and an input for the same field
})
it('the side control is a select offering buy and sell', …)
it('renders the screenshot thumbnail pointing at the capture image endpoint', async () => {
  // img src contains '/api/captures/3/image'
})
it('renders no thumbnail when hasImage is false', …)
it('confirm posts the edited values as overrides', async () => {
  // change qty to 11 -> body.overrides.shares === 11
})
it('confirm on an untouched row posts no overrides', async () => {
  // body === {} — same as today's behaviour
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `bun test apps/web/src/components/forms/PendingTable.test.tsx`
Expected: FAIL on the new assertions.

- [ ] **Step 4: Implement `PendingRow` and reshape `PendingTable`**

`PendingRow` renders the five controls plus the ticker as plain text and the three buttons. `PendingTable` keeps the fetch/confirm/reject/error logic it has today (including the `ticker-mismatch` no-reload guard at `PendingTable.tsx:58-64`) and holds `RowValues` per row id instead of `Overrides`. `initialRowValues` pre-fills from `row.detected` when present, else from the row itself; the fee falls back to `row.autoFeeCents` (the server-computed fee from the run's cost ppm) when `detected.fee` is null, per `docs/superpowers/specs/2026-11-12-auto-fee-prefill-design.md`. Build the confirm body from `pendingEdits`: only changed fields become overrides, so an untouched confirm still posts `{}`.

New i18n keys for the side options, the fee column and the side-by-side button go in **both** catalogs, inserted in `localeCompare` order — `apps/web/src/catalog.test.ts` enforces key parity, alphabetical order, and that no ko value contains Chinese characters. Run `bun test apps/web/src/catalog.test.ts` as part of Step 5.

- [ ] **Step 5: Run to verify they pass**

Run: `bun test apps/web/src && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/forms apps/web/src/i18n
git commit -m "feat: single editable control per pending field with screenshot thumbnail"
```

---

### Task 8: Side-by-side dialog

**Files:**
- Create: `apps/web/src/components/forms/PendingReviewDialog.tsx`, `apps/web/src/components/forms/PendingReviewDialog.test.tsx`
- Modify: `apps/web/src/components/forms/PendingTable.tsx`, `apps/web/src/components/ui.tsx` (`Modal` width), `apps/web/src/i18n/*.json`

**Interfaces:**
- Consumes: `RowValues`, `captureImageUrl` (Task 6); `Modal`, `Field`, `Input`, `Select`, `Button`.
- Produces:
  ```ts
  export function PendingReviewDialog(props: {
    row: PendingFillDto
    values: RowValues
    onCancel: () => void
    onDone: (values: RowValues) => void
  }): JSX.Element
  ```
  `Modal` gains an optional `wide?: boolean` that swaps `max-w-md` for `max-w-4xl`; existing callers are unaffected.

- [ ] **Step 1: Write the failing tests**

```ts
it('shows the screenshot and fields pre-filled with the row values', …)
it('Done reports the edited values and Cancel reports nothing', async () => {
  // edit price to '99.00', click Done -> onDone called with values.price === '99.00'
  // re-render, edit, click Cancel -> onDone not called
})
it('Done does not book anything', …)   // no POST recorded by the fetch stub
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/web/src/components/forms/PendingReviewDialog.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the dialog and wire the row button to it**

Local state seeded from `props.values`; `Done` lifts the whole `RowValues` to `PendingTable`, which merges it into that row's state. Add the `wide` prop to `Modal`.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test apps/web/src && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components apps/web/src/i18n
git commit -m "feat: side-by-side screenshot and values dialog"
```

---

### Task 9: Keep/discard prompt

**Files:**
- Create: `apps/web/src/components/forms/KeepImagePrompt.tsx`, `apps/web/src/components/forms/KeepImagePrompt.test.tsx`
- Modify: `apps/web/src/components/forms/PendingTable.tsx`, `apps/web/src/i18n/*.json`

**Interfaces:**
- Consumes: `pendingEdits` (Task 6), `confirmPending`/`rejectPending` with `keepImage` (Task 6).
- Produces:
  ```ts
  export function KeepImagePrompt(props: {
    action: 'confirm' | 'reject'
    onDecide: (keep: boolean) => void
    onDismiss: () => void
  }): JSX.Element
  ```

- [ ] **Step 1: Write the failing tests**

In `KeepImagePrompt.test.tsx`: the confirm variant shows the spec's copy; `[Keep for review]` calls `onDecide(true)`, `[Discard]` calls `onDecide(false)`; the reject variant shows the reject lead line.

In `PendingTable.test.tsx`:
```ts
it('confirming an edited row prompts before posting, then posts keepImage true', async () => {
  // edit qty -> Confirm -> no POST yet -> click Keep for review
  // -> body { overrides: { shares: 11 }, keepImage: true }
})
it('confirming an untouched row posts immediately with no prompt', …)
it('rejecting prompts and posts keepImage false on Discard', …)
it('no prompt when the row has no image, even when edited', async () => {
  // hasImage false + edited -> posts straight away, body has no keepImage
})
it('no prompt for a legacy row with detected null', …)   // Review Focus 4
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/web/src/components/forms`
Expected: FAIL — the confirm posts without prompting.

- [ ] **Step 3: Implement the prompt and gate the two actions**

Copy, verbatim from the spec, in both catalogs:
> **Values were edited** / You changed this fill before confirming, so vision may have misread the screenshot. Keep the screenshot for review? / `[Keep for review]` `[Discard]`

`PendingTable` holds a pending-decision state `{ row, action, overrides } | null`; it opens the prompt when `action === 'reject'` or `pendingEdits(...).length > 0`, **and** `row.hasImage` is true, **and** `row.detected !== null`. Dismissing the prompt cancels the action without posting.

*Plan correction, made during execution:* one helper cannot answer both of the
questions this plan asked of `pendingEdits`, because they diverge on legacy
rows. "Which fields changed" drives **which overrides to send**, and its
baseline must fall back to the row's own values when `detected` is null —
otherwise a legacy row reports no changes, the confirm body is empty, and the
operator cannot correct an old row at all, a regression against today's
override inputs. "Was this an operator correction" drives the **keep prompt**,
and a legacy row is never one. So `pendingEdits` falls back to the row's own
values as its baseline, and the prompt trigger adds the `row.detected !== null`
condition above. The server side already behaves correctly: `isEdited` returns
false whenever `detected_at` is null.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test apps/web/src && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components apps/web/src/i18n
git commit -m "feat: keep or discard the screenshot when a fill is corrected"
```

---

### Task 10: Vision review tab

**Files:**
- Create: `apps/web/src/pages/VisionReview.tsx`, `apps/web/src/components/VisionReviewEntry.tsx`, `apps/web/src/pages/VisionReview.test.tsx`, `apps/web/src/components/hooks.test.tsx`
- Modify: `apps/web/src/components/hooks.tsx` (`Route` union and `parseHash`), `apps/web/src/App.tsx:18-35`, `apps/web/src/components/Layout.tsx:7-12`, `apps/web/src/i18n/*.json`

**Interfaces:**
- Consumes: `listVisionReviews`, `deleteVisionReview`, `captureImageUrl` (Task 6), `useAsync` (`components/hooks`).
- Produces:
  ```ts
  export function VisionReviewPage(): JSX.Element
  export function VisionReviewEntry(props: { entry: VisionReviewEntryDto; onDelete: () => void }): JSX.Element
  // Route union gains { page: 'visionReview' }; hash '#/vision-review'
  ```

- [ ] **Step 1: Write the failing route test**

`parseHash` has no test file today — create `apps/web/src/components/hooks.test.tsx` (no DOM needed for `parseHash`, so no `GlobalRegistrator`):
```ts
it('parses #/vision-review', () => expect(parseHash('#/vision-review')).toEqual({ page: 'visionReview' }))
it('rejects #/vision-review/extra', …)   // notFound
```

- [ ] **Step 2: Write the failing page tests**

```ts
it('lists one entry per kept screenshot with its image and fills', …)
it('marks the fields that differ and shows both detected and corrected values', …)
it('shows an em dash for the finals of a rejected fill', …)
it('renders the empty note when nothing is archived', …)
it('Delete calls the endpoint and drops the entry', async () => {
  // DELETE /api/vision-reviews/3 recorded; list reloaded
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `bun test apps/web/src/pages/VisionReview.test.tsx apps/web/src/components`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the page, the entry component and the routing**

Follow `pages/Pending.tsx` for page shape (`Card` + `SectionTitle`) and `CorrectionList` for a framed list of records. Add the route to `parseHash`, `pageFor` and `NAV` with the key `navVisionReview` → "Vision review" / Korean equivalent.

- [ ] **Step 5: Run to verify they pass**

Run: `bun test apps/web/src && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat: vision review tab for archived screenshots"
```

---

### Task 11: End-to-end smoke and docs

**Files:**
- Create: `scripts/e2e-vision-review.ts`
- Modify: `scripts/e2e.ts` (drive the new step module), `AGENTS.md` (repo map + the e2e module list), `README.md` if it documents the nav
- Test: the e2e script itself

**Interfaces:**
- Consumes: every endpoint from Task 5; `E2eCtx` and `jsonOf` from `scripts/e2e-ctx.ts`.
- Produces: `export async function runVisionReview(ctx: E2eCtx): Promise<void>`, called from `scripts/e2e.ts` like `e2e-cutloss.ts` and `e2e-sim-drafts.ts` are.

- [ ] **Step 1: Add the e2e step module**

In `scripts/e2e-vision-review.ts`, following the structure of `scripts/e2e-cutloss.ts`: assert `GET /api/captures/:id/image` returns bytes with the right content type; confirm one fill with an edited price and `keepImage: true`; assert the entry appears in `GET /api/vision-reviews` with detected ≠ final; `DELETE` it and assert both the entry and the image are gone; then run a second capture, confirm it untouched, and assert no bytes and no entry remain. Wire it into `scripts/e2e.ts` in step order.

- [ ] **Step 2: Run the full matrix**

```bash
bun test
TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test
TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts
bun run typecheck
```
Expected: all green.

- [ ] **Step 3: Update the repo map**

Add the new source files to the `apps/server/src` and `apps/web/src` trees in `AGENTS.md`, including `db/repos-vision.ts` and the new `scripts/` module.

- [ ] **Step 4: Commit**

```bash
git add scripts AGENTS.md README.md
git commit -m "test: e2e coverage for screenshot retention and vision review"
```

---

## Self-Review Notes

- **Spec coverage:** goals 1–3 → Tasks 7, 8; goal 4 → Tasks 2, 4; goal 5 → Task 9; goals 6–7 → Tasks 4, 10. Schema and the six design calls → Tasks 1–5. Fee as the fifth field → Tasks 3, 7. Telegram untouched except the new error keys (Task 3, Step 5) and the unchanged `null`-overrides call site.
- **Deliberate test deletions:** three `PendingTable.test.tsx` cases assert the duplicated layout this work removes (Task 7, Step 1). They are listed by name and line so a reviewer can tell deletion from regression.
- **Known interface ripple:** `confirmPendingFill` gains a fourth parameter; its callers are `routes/pending.ts:17`, `wire/capture.ts` (`onConfirm`) and the server tests. Task 3 changes the overrides, Task 4 adds `opts`.
- **Rebase against `eed3571`:** migration renumbered to `0008`; repos moved into `repos-vision.ts` to match the new `repos-sim`/`repos-bars` split; `confirmPendingFill`'s lock block now returns the sibling-cancel result, so Task 4's archive write threads through it; `fillBookingDeps()` is the only way routes build `BookingDeps`; the fee prefill reads a new server-supplied `autoFeeCents` because the pending DTO carries no cost ppm; i18n work must satisfy the new `catalog.test.ts`; the e2e smoke becomes a step module. Line references outside these files were re-checked individually.
