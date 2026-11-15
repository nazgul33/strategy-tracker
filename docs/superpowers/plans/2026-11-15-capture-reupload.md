# Capture Re-upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-sending an image the run has already seen is re-read and re-matched (reusing its `captures` row) unless a fill from that earlier upload is still `pending`.

**Architecture:** A new `claimCapture` helper decides, under the existing per-run lock, whether an image hash gets a capture id (fresh insert or reuse of the old row with its status reset) or is a duplicate (old row still has a `pending` fill, or a lost insert race). `ingestCapture` calls it first inside `withRunLock`, then runs the unchanged fill matcher. `captureRepo.hasHash` is replaced by `findByHash` + `setStatus`.

**Tech Stack:** Bun + TypeScript, drizzle-orm (MariaDB), bun:test.

**Spec:** `docs/superpowers/specs/2026-11-15-capture-reupload-design.md`

## Global Constraints

- Money via `@st/core/money` bigint myriadths — never float.
- No source file > ~300 lines (`booking.ts` is 278 today — the new logic lives in its own file).
- `packages/*` never import `apps/*`; no changes under `packages/`, `apps/web`, i18n, or migrations.
- English-only comments; commit style `feat|fix|docs|test|refactor|chore:`.
- **Prod DB is never touched.** DB tests only against `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test`; e2e uses its own scratch DB.
- Fill-level dedup/conflict rules (`capture-dedup.ts`) are unchanged.

## Review Focus

1. Partially decided earlier upload (one row rejected, one still `pending`) → still `'duplicate'`, nothing written. → Task 1 test `reupload: one row still pending blocks`.
2. Same image sent to a *different* run while run A's upload is still pending → processed normally for run B (lookup is per run). → Task 1 test `reupload: hash is per run`.
3. Two simultaneous re-sends of a reusable image → exactly one new set of pending rows. → Task 1 test `reupload: concurrent re-sends book once`.
4. Old rejected rows are left untouched; new pending rows are added alongside them on the same `capture_id`. → asserted in Task 1 `reupload after reject` and Task 2 DB test.
5. Re-send of a reusable capture whose new extract fails (`ok: false`) → row status becomes `unparseable`, returns `'rejected'`, no pending rows. → Task 1 test `reupload: failed re-read`.

---

### Task 1: `claimCapture` + repo interface + `ingestCapture` rewire

**Files:**
- Create: `apps/server/src/domain/capture-claim.ts`
- Modify: `apps/server/src/domain/booking.ts:31-32` (`BookingDeps.repos.captureRepo` type), `:136-182` (`ingestCapture`)
- Modify: `apps/server/src/db/repos.ts:160-164` (`captureRepo`)
- Modify test fakes: `apps/server/test/booking.test.ts:99-108`, `apps/server/test/wire.test.ts:152-159`, `apps/server/test/http.test.ts:88`, `apps/server/test/sim.test.ts:249`, `apps/server/test/day.test.ts:47`
- Test: `apps/server/test/booking.test.ts` (new `describe('capture re-upload', …)`), `apps/server/test/wire.test.ts` (one test in `capture onPhoto — dedup and failures`)

**Interfaces:**
- Produces (repo, real + every fake):
  - `captureRepo.findByHash(runId: number, hash: string): Promise<{ id: number; status: string } | null>`
  - `captureRepo.setStatus(id: number, status: string): Promise<void>`
  - `captureRepo.insert(c)` unchanged; `hasHash` **removed** everywhere.
- Produces (`capture-claim.ts`):
  - `export async function claimCapture(repos: { captureRepo: …findByHash/setStatus/insert…; pendingRepo: { listPending(): Promise<any[]> } }, runId: number, hash: string, status: 'parsed' | 'unparseable'): Promise<number | null>` — returns the capture id to attach rows to, or `null` meaning duplicate.
- Consumes: `withRunLock` (`./run-lock`), `matchCapturedFills` (unchanged).

- [ ] **Step 1: Update every `captureRepo` fake** to the new interface (`findByHash` returns `{ id, status }` of the matching `(runId, imageHash)` row or `null`; `setStatus` mutates the stored row's `status`; trivial fakes in http/sim/day return `null` / no-op). Keep `insert` behaviour.

- [ ] **Step 2: Write the failing unit tests** in `booking.test.ts`, new `describe('capture re-upload', …)` reusing the `setup/img/ext/trade/seedFill` helper style of `describe('capture dedup …')` (copy the helpers into the new describe or hoist them — implementer's call):

```ts
test('reupload after reject: re-reads onto the same capture row', async () => {
  const { f, deps, runId } = await setup('re1')
  const first: any = await ingestCapture(runId, img('RE1'), ext(trade('buy', 78, '58.32', '2026-11-13')), deps)
  await f.repos.pendingRepo.decide(first.pending[0].id, 'rejected')
  const again: any = await ingestCapture(runId, img('RE1'), ext(trade('buy', 78, '58.32', '2026-11-13')), deps)
  expect(again.pending.length).toBe(1)
  expect(f._stores.captures.length).toBe(1)
  expect(f._stores.captures[0].status).toBe('parsed')
  expect(f._stores.pending.map((p: any) => [p.captureId, p.status]))
    .toEqual([[f._stores.captures[0].id, 'rejected'], [f._stores.captures[0].id, 'pending']])
})
test('reupload: one row still pending blocks', async () => {
  // first upload yields 2 rows; reject one, leave one pending; same image again
  // → 'duplicate', pending store unchanged (length 2), captures length 1
})
test('reupload after confirm: booked fill dedups to duplicate', async () => {
  // first upload, confirmPendingFill(row, null, deps); same image → 'duplicate'; fills length 1
})
test('reupload: failed re-read', async () => {
  // first upload, reject its row; same image with { ok: false, reason: 'unparseable', detail: 'x' }
  // → 'rejected'; captures[0].status === 'unparseable'; no new pending row
})
test('reupload of an unparseable capture with a good extract', async () => {
  // first: image with { ok: false, reason: 'http', detail: 'http 500' } → 'rejected'
  //   (status 'unparseable'); second: same image, ok extract
  // → pending length 1, captures length 1, status 'parsed'
})
test('reupload: IMG_2109 after rejecting both rows', async () => {
  // seedFill buy 88 56.0600 11-10, sell 44 66.03 11-11, sell 44 65.5300 11-12
  // first upload of all four screenshot trades (buy88@56.06/11-10, sell44@64.07/11-11,
  //   sell44@65.53/11-12, buy78@58.32/11-13) → 1 conflict + 1 pending; reject that pending
  // same image again → out.conflicts.length 1 (bookedPrice '66.03'), out.pending.length 1
  //   with shares 78, filledOn '2026-11-13'; captures length 1
})
test('reupload: hash is per run', async () => {
  // run A uploads image X (row stays pending); run B (second runRepo.create) uploads X
  // → run B gets pending length 1; captures length 2
})
test('reupload: concurrent re-sends book once', async () => {
  // first upload, reject; slow pendingRepo.insert/listPending + fillRepo.listForRun as in
  // 'concurrent identical captures serialize'; Promise.all two re-sends of the same image
  // → exactly one result is an object with pending.length 1, the other 'duplicate';
  //   pending rows with status 'pending' === 1
})
```

The existing `(a) duplicate capture`, `race path duplicate`, `still-pending rows suppress a repeat capture`, and `concurrent identical captures serialize` tests must remain unchanged and green.

- [ ] **Step 3: Write the failing wire test** in `wire.test.ts` `capture onPhoto — dedup and failures`:

```ts
test('same image after rejecting its fill is read again', async () => {
  const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
  await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
  await h.handlers.onConfirm(`no:${h.pending[0]!.id}`, false);
  await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
  expect(h.captures.length).toBe(1);
  expect(h.pending.map((p) => p.status)).toEqual(['rejected', 'pending']);
  expect(h.sent.at(-1)!.text).not.toBe('Duplicate capture — all fills already booked or pending.');
});
```

- [ ] **Step 4: Run to verify failures**

Run: `bun test apps/server/test/booking.test.ts apps/server/test/wire.test.ts`
Expected: the new tests FAIL (re-sends return `'duplicate'`); typecheck-level failures from removed `hasHash` are acceptable at this point.

- [ ] **Step 5: Implement `findByHash`/`setStatus` in `repos.ts`** (drizzle `select({ id, status })…limit(1)` and `update(captures).set({ status })`), delete `hasHash`, and update the `BookingDeps.repos.captureRepo` type in `booking.ts`.

- [ ] **Step 6: Implement `claimCapture` in `capture-claim.ts`.** Algorithm:

```
existing = findByHash(runId, hash)
if existing:
  if (await listPending()).some(p => p.captureId === existing.id): return null
  await setStatus(existing.id, status); return existing.id
res = insert({ runId, chatId: null, imageHash: hash, status })
return res.inserted ? res.id! : null
```

- [ ] **Step 7: Rewire `ingestCapture`** so the whole body after hashing runs inside `withRunLock(runId, …)`: `captureId = await claimCapture(repos, runId, hash, extract.ok ? 'parsed' : 'unparseable')`; `null` → `'duplicate'`; `!extract.ok` → `'rejected'`; then the existing `matchCapturedFills` + pending-insert + outcome code unchanged. The old hash-guard block and its `'duplicate'` insert are deleted. Keep the lock comment accurate (it now also covers the capture claim). `booking.ts` must stay ≤ 300 lines.

- [ ] **Step 8: Run tests + typecheck**

Run: `bun test && bun run typecheck`
Expected: 0 fail (db.test skip count unchanged at 13), typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/domain/capture-claim.ts apps/server/src/domain/booking.ts apps/server/src/db/repos.ts apps/server/test/booking.test.ts apps/server/test/wire.test.ts apps/server/test/http.test.ts apps/server/test/sim.test.ts apps/server/test/day.test.ts
git commit -m "fix: re-read a seen capture image unless its fills still await a decision"
```

---

### Task 2: DB integration proof + full gates

**Files:**
- Modify: `apps/server/test/db.test.ts:42-50` (`capture dedup` repo test → `findByHash`/`setStatus`)
- Test: `apps/server/test/db.test.ts` (new test appended to the `describeIf('db integration', …)` block, after the conflict test, same fixture style: ticker `'RU' + Date.now()`, real `repos`, `BookingDeps = { repos, today: '2026-11-15' }`)

**Interfaces:**
- Consumes: `captureRepo.findByHash`, `captureRepo.setStatus`, `ingestCapture` (Task 1).

- [ ] **Step 1: Update `capture dedup`** repo test: `findByHash` is `null` before insert; after insert returns `{ id: <number>, status: 'pending' }`; `setStatus(id, 'parsed')` then `findByHash(...).status === 'parsed'`; second insert still `inserted: false`.

- [ ] **Step 2: Add `ingestCapture re-reads a seen image after its fill was rejected`:** upload image `'REUP-REAL-' + Date.now()` with one buy (11 sh @ '218.55', 2026-11-12) → reject the pending row via `repos.pendingRepo.decide(id, 'rejected')` → same image again → `out.pending.length === 1`; SQL `SELECT id, status FROM captures WHERE run_id = ${runId}` returns exactly 1 row with status `'parsed'`; SQL `SELECT capture_id, status FROM pending_fills WHERE run_id = ${runId} ORDER BY id` returns `[{capture_id: <that id>, status: 'rejected'}, {capture_id: <that id>, status: 'pending'}]`.

- [ ] **Step 3: Run DB suite**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test`
Expected: 0 fail, no skips.

- [ ] **Step 4: Run e2e**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`
Expected: `e2e OK`, including `same photo again -> duplicate-capture message` (its first row is still pending) and `duplicate created no second pending row`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/test/db.test.ts
git commit -m "test: capture re-upload against real repositories"
```

---

## Out of scope (per spec)

- Moving the vision call after the duplicate check.
- Fill-level dedup/conflict rules, manual fills, HTTP pending routes, web UI, migrations.
- Any production data change (operator re-sends IMG_2109 after deploy).
