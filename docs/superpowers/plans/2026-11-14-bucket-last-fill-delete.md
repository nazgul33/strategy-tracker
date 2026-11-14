# Per-bucket last-fill deletion — implementation plan

Spec: `docs/superpowers/specs/2026-11-14-bucket-last-fill-delete-design.md`

## Goal

Let an operator delete the newest fill of *each* bucket (today only the run's
single globally-newest fill is deletable), and add a Delete button on the fills
table rows for every deletable fill.

## Architecture context (read before starting)

- Run state follows "Cash Model A": it is fully re-derived from the starting
  pool plus the whole fill history by `rebuildState` in
  `apps/server/src/domain/booking.ts`. The canonical history order is
  id-ascending (`byIdAsc` there). After any delete the domain saves the rebuilt
  state and books one compensating ledger row `{ kind: 'adjust', ref.reason:
  'fill-delete' }`.
- Safety rule: a fill is deletable iff it has the highest id among the fills of
  its own `bucketIdx`. A same-bucket older fill must be rejected
  (`DomainError('not-last')`) because a later same-bucket fill depends on it.
  Unknown id → `DomainError('no-fill')`.
- HTTP contract (`DELETE /api/runs/:id/fills/:fillId`, auth enforced by app
  middleware): 404 `no-run`; non-numeric fillId → 422 `not-last` (route-level
  guard); everything else delegated to the domain, `DomainError.kind` → 422
  `{ error: kind }`. Success body `{ ok: true, deletedFillId }`.
  Behavior shift vs today: an unknown-but-numeric fillId now returns `no-fill`
  (was `not-last`), mirroring `rebookFill`.
- Web: `FillsPanel` (`apps/web/src/components/RunPanels.tsx`) owns the fills
  fetch and the edit dialog; `FillTable` is a dumb table; `FillDialog` already
  has a Delete step guarded by its `deletable` prop and its docs already promise
  the per-bucket rule. Follow the `OrdersPanel` + `OrderTable` pattern where the
  panel owns the confirm modal.

## Global constraints

- Repo `AGENTS.md`: English-only source comments; commit style
  `feat|fix|docs|test|chore:`; no source file > ~300 lines; all user-facing copy
  via `apps/web/src/i18n/en.json` + `ko.json`.
- Money: bigint myriadths for prices, integer cents elsewhere — never float.
- Run tests from the repo root: `bun test`; types: `bun run typecheck`.
  `apps/server/test/db.test.ts` self-skips unless `TEST_DATABASE_URL` is set
  (see AGENTS.md Test matrix); run it when a DB is available.
- `deleteLastFill`, `fillRepo.deleteLast` and `fillRepo.lastId` are fully
  removed by the end of Task 2 — no back-compat shims.

---

### Task 1 — `deleteById` plumbing (repo + surface + fakes)

**Files**
- `apps/server/src/db/repos.ts`
- `apps/server/src/domain/booking.ts` (only the `RepoSurface.fillRepo` type)
- `apps/server/test/booking.test.ts` (the `fillRepo` fake)
- `apps/server/test/db.test.ts`

**Steps (TDD)**

1. In `db.test.ts`, inside the existing test `'fillRepo: update is run-scoped,
   listForRun is id-ascending, deleteLast peels newest id'` (rename it to end
   with `deleteById is run-scoped`), *replace the whole `deleteLast` tail*
   (the three `deleteLast` calls and their assertions after the shuffled-id
   block) with coverage for the new method. The state at that point: the
   run's fills are ids `[hi, hi + 10]` (shares `[20, 12]`) and `foreignId` is
   the other run's only fill id. Assert:
   - `await repos.fillRepo.deleteById(runId, foreignId)` leaves both runs'
     lists untouched — run-scoped guard, mirroring `update` (still 2 and 1).
   - `await repos.fillRepo.deleteById(runId, hi)` deletes exactly that row:
     remaining `runId` fill is the row with id `hi + 10` and shares `12`; the
     other run's fill still exists.
   - `await repos.fillRepo.deleteById(runId, 99999999)` on a not-present id is
     a harmless no-op (list unchanged).
   - `await repos.fillRepo.deleteById(runId, hi + 10)` empties the run, and a
     repeat call on the now-empty run is a harmless no-op.
   The `deleteLast` method itself stays in `repos.ts` for now (Task 2 deletes
   it together with `lastId`); the db test simply stops referencing it.
2. In `repos.ts` `fillRepo`, add next to `update`:

   ```ts
   // Run-scoped guard: a foreign fillId can never be touched. No-op when absent.
   async deleteById(runId: number, fillId: number): Promise<void> {
     await db.delete(s.fills).where(and(eq(s.fills.id, fillId), eq(s.fills.runId, runId)))
   },
   ```

3. In `booking.ts` `RepoSurface.fillRepo`, add
   `deleteById?(runId: number, fillId: number): Promise<void>` next to the
   optional `update`.
4. In the `fillRepo` fake in `booking.test.ts` (exported `fakeRepos`, also used
   by `rebooking.test.ts`), add:

   ```ts
   async deleteById(runId: number, fillId: number) {
     const gi = fills.findIndex((f) => f.runId === runId && f.id === fillId)
     if (gi >= 0) fills.splice(gi, 1)
   },
   ```

5. `bun test apps/server/test/rebooking.test.ts apps/server/test/booking.test.ts`
   and `bun run typecheck` pass; run the db test if a test DB is up.
6. Commit: `test: add run-scoped fillRepo.deleteById with repo coverage`
   (squash the impl + tests into one commit).

---

### Task 2 — domain `deleteFill`, route delegation, server test updates

**Files**
- `apps/server/test/rebooking.test.ts`
- `apps/server/src/domain/booking.ts`
- `apps/server/src/http/routes/fills.ts`
- `apps/server/src/http/app.ts`
- `apps/server/src/db/repos.ts` (drop `deleteLast` + `lastId`)
- `apps/server/test/http.test.ts` (fake + delete tests)
- `apps/server/test/db.test.ts` (drop `deleteLast` coverage)

**Steps (TDD)**

1. Rewrite the `describe('deleteLastFill', …)` block in `rebooking.test.ts` as
   `describe('deleteFill', …)` (import `deleteFill` instead of
   `deleteLastFill`). Existing cases keep their assertions, only gaining the
   explicit fill id: `deleteFill(runId, 2, deps(f))`, `deleteFill(runId, 3, …)`
   (scramble case), `deleteFill(runId, 1, …)` (only-fill and no-fill cases).
   Add three cases:
   - **cross-bucket delete**: 2-bucket run; `manualFill` buy 10 @ '10.00' fee
     '5.00' 2026-01-08 (id 1, bucket 0), then buy 5 @ '15.00' fee '2.50'
     2026-01-09 (id 2, bucket 1). `deleteFill(runId, 1, deps(f))` resolves:
     `deleted.id === 1`, fills are `[2]`, bucket 0 `empty`, bucket 1 still
     `held` 5 shares, `cashCents === 92_250` (100_000 − buyEffect('15.00', 5,
     250) = 100_000 − 7_750), one adjust row `{ amountCents: 10_500, ref: { fillId: 1, bookedOn:
     TODAY, reason: 'fill-delete' } }`.
   - **same-bucket older id rejected**: buy 8 @ '16.00' 2026-01-08 (id 1) then
     a full-close sell (insert the sell_loc order first, exactly like the
     existing `'deleting a full-close sell…'` test) (id 2);
     `deleteFill(runId, 1, …)` → `expectKind(...) .kind === 'not-last'`;
     serialized state unchanged (`asJson` compare), fills still length 2, no
     adjust rows.
   - **unknown id**: run with one fill; `deleteFill(runId, 99, …)` →
     `'no-fill'`, state unchanged.
2. Run `bun test apps/server/test/rebooking.test.ts` — new tests fail (compile
   error on `deleteFill`). Implement in `booking.ts`: delete `deleteLastFill`,
   drop `deleteLast?` from `RepoSurface.fillRepo`, add in its place:

   ```ts
   // Remove a fill that is the newest of its own bucket and rebuild state from
   // the remaining history. Orders are never reopened. Returns the deleted row;
   // books a compensating 'adjust'.
   export async function deleteFill(runId: number, fillId: number, deps: BookingDeps): Promise<FillRow> {
     const repos = deps.repos
     if (!repos.fillRepo.listForRun || !repos.fillRepo.deleteById) throw new Error('fill-history-unavailable')
     const history = byIdAsc(await repos.fillRepo.listForRun(runId))
     const target = history.find((f) => f.id === fillId)
     if (!target) throw new DomainError('no-fill')
     const bucketNewest = history.filter((f) => f.bucketIdx === target.bucketIdx).pop()!
     if (bucketNewest!.id !== target.id) throw new DomainError('not-last')

     const run = await repos.runRepo.get(runId)
     const state = await repos.bucketRepo.loadState(runId)
     const rebuilt = rebuildState(history.filter((f) => f.id !== fillId), run.poolCents, deps.today, state.buckets.length)

     const delta = rebuilt.cashCents - state.cashCents
     await repos.bucketRepo.saveState(runId, rebuilt)
     await repos.fillRepo.deleteById(runId, fillId)
     if (delta !== 0) {
       await repos.ledgerRepo.insert({ runId, kind: 'adjust', amountCents: delta, ref: JSON.stringify({ fillId, bookedOn: deps.today, reason: 'fill-delete' }) })
     }
     return target
   }
   ```

   Also update the stale comment above `byIdAsc` (it mentions "the MAX(id)
   delete in fillRepo") — id-ascending is still the canonical order, now for
   the newest-per-bucket check.
3. Rewrite the DELETE route in `fills.ts` (import `deleteFill`): keep the
   run-exists 404 and `/^\d+$/` → 422 `not-last` guards, then

   ```ts
   try {
     const deleted = await deleteFill(runId, Number(raw), bookingDeps())
     return c.json({ ok: true, deletedFillId: deleted.id })
   } catch (e) {
     if (e instanceof DomainError) return c.json({ error: e.kind }, 422)
     throw e
   }
   ```

4. In `app.ts` line ~15 the `fillRepo` intersection keeps only
   `listForRun(runId: number): Promise<any[]>` (drop `lastId`).
5. In `repos.ts` delete the `deleteLast` and `lastId` methods and their
   comments. (`db.test.ts` no longer references `deleteLast` — Task 1 already
   replaced that coverage.)
6. In `http.test.ts`:
   - Fake: replace `deleteLast` and `lastId` with `deleteById` (same splice-by-
     run-and-id body as Task 1's `booking.test.ts` fake).
   - `'DELETE older fill id -> 422 not-last'` must change meaning: two plain
     buys land in *different* buckets and are now both deletable. Rewrite it as
     same-bucket: create run, `postFill` buy 2 '10.0000' (id 1), `postFill`
     sell 2 '11.0000' (id 2 — the only held bucket is 0), then
     `DELETE /fills/1` → 422 `{ error: 'not-last' }` and `f.fills.length`
     stays 2. Rename to `'DELETE non-newest fill of the same bucket -> 422 not-last'`.
   - Add `'DELETE a bucket-last fill that is not globally newest -> 200'`:
     run pool 100000 costPpm 0; buy 1 '10.0000' (id 1 → bucket 0), buy 1
     '11.0000' (id 2 → bucket 1); `DELETE /fills/1` → 200
     `{ ok: true, deletedFillId: 1 }`; `f.fills.map(id)` equals `[2]`;
     `f.states.get(id)!.cashCents === 98_900`; last ledger row
     `{ kind: 'adjust', amountCents: 1_000 }` with ref
     `{ fillId: 1, bookedOn: '2026-11-10', reason: 'fill-delete' }`; the
     `GET /fills` list now has 1 row.
   - Add `'DELETE unknown numeric fillId -> 422 no-fill'`: run with one fill,
     `DELETE /fills/99` → 422 `{ error: 'no-fill' }`, fill survives.
   - Keep `'DELETE non-integer fillId -> 422 not-last'`, `'DELETE last fill…'`,
     `'DELETE on run without fills -> 422 no-fill'`, `'DELETE unknown run…'`
     as-is.
7. `bun test` + `bun run typecheck` green (db tests when DB available).
   Grep once more for `deleteLastFill|deleteLast|lastId` — zero hits in
   `apps/` and `packages/`.
8. Commit: `feat: allow deleting the last fill of each bucket`

---

### Task 3 — Delete button on `FillTable` rows

**Files**
- `apps/web/src/components/FillTable.tsx`
- `apps/web/src/components/FillTable.test.tsx`

**Steps (TDD)**

1. Add failing tests to `FillTable.test.tsx`:
   - With `onEdit` + `deletableIds = new Set([6])` + `onDelete`: rows render
     `button[id="fillDelete-6"]` (label `Delete`) only for id 6; id 5 has no
     delete button; clicking `#fillDelete-6` calls `onDelete` with that fill.
   - With `onEdit` but no `deletableIds` prop: no `button[id^="fillDelete-"]`,
     Edit buttons unchanged (regression guard for existing callers).
2. Implement: extend `FillTableProps` with
   `deletableIds?: Set<number>` and `onDelete?: (fill: FillDto) => void`
   (doc-comments mirroring `onEdit`'s). The actions column renders when
   `onEdit || onDelete`. In the actions cell, after the Edit button, render:

   ```tsx
   {onDelete && deletableIds?.has(f.id) && (
     <Button variant="ghost" id={`fillDelete-${f.id}`} onClick={() => onDelete(f)}>
       {t('dialog.delete')}
     </Button>
   )}
   ```

   (Check `./ui` for the exact secondary styling prop used on danger-ish row
   actions; `Button` supports `variant` — use `secondary` if `ghost` doesn't
   exist.) Wrap both buttons in a `flex justify-end gap-2` div so they sit
   side by side.
3. `bun test apps/web` green.
4. Commit: `feat(web): row-level delete button on deletable fills`

---

### Task 4 — `FillsPanel` per-bucket deletable set + confirm modal

**Files**
- `apps/web/src/components/RunPanels.tsx`
- `apps/web/src/components/RunPanels.test.tsx`
- `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`

**Steps (TDD)**

1. Update `RunPanels.test.tsx` first:
   - Extend `FILLS` with a bucket-1 buy `{ id: 1, bucketIdx: 1, side: 'buy',
     shares: 4, price: '3000000', fee: 90, source: 'manual',
     filledOn: '2026-11-10', createdAt: '2026-11-10T15:30:00Z' }` as the first
     array entry (server order is id-ascending). Update the block comment: the
     deletable set is now `{1, 3}` — one per bucket — not "last row".
   - Rewrite `'shows Delete only when editing the last fill'` as
     `'shows Delete in the dialog for each bucket's last fill'`: opening
     `#fillEdit-3` *and* `#fillEdit-1` show `[data-testid="fillDeleteBtn"]`.
   - New test `'deletes from the row: confirm modal, DELETE recorded, onMutated fired'`:
     click `#fillDelete-1` → a dialog opens (`role="dialog"`) showing the
     warning with `4` (shares); click `button('Delete for real')`; exactly one
     `DELETE` call to `/api/runs/7/fills/1`; `mutated === 1`; dialog closed.
     The existing dialog-driven delete test (fill 3) stays.
   - New test `'row delete cancel: no DELETE call, dialog closed'`: open the
     row-confirm on `#fillDelete-1`, click `button('Cancel')`, no DELETE calls.
2. Add i18n keys after `'dialog.deleteConfirm'` in both catalogs:
   `"deleteFailed": "Delete failed."` (en) / `"deleteFailed": "삭제하지 못했습니다."` (ko).
3. Implement in `FillsPanel` (`RunPanels.tsx`):
   - `const t = useT()` at the top of the component (import already exists).
   - Replace the `lastFillId` computation (and its stale "the last row is the
     deletable one" comment) with:

     ```ts
     // One deletable fill per bucket: the newest (max id) row of that bucket —
     // the server only accepts deleting a bucket's last fill. The list from
     // GET /fills is id-ascending, so the last row seen per bucket wins.
     const newestPerBucket = new Map<number, number>();
     for (const f of fills) newestPerBucket.set(f.bucketIdx, f.id);
     const deletableIds = new Set(newestPerBucket.values());
     ```
   - Pass `deletableIds` + `onDelete={(f) => setConfirmDel(f)}` to `FillTable`;
     pass `deletable={deletableIds.has(edit.id)}` to `FillDialog`.
   - Add `const [confirmDel, setConfirmDel] = useState<FillDto | null>(null)`,
     `busy`, `delError` state and a `submitDelete` mirroring `submitCancel`
     in `OrdersPanel`: `api.deleteFill(runId, confirmDel.id)` → close,
     `await reload()`, `onMutated?.()`; on failure `setDelError(true)`.
   - Render the confirm modal after `<FillTable … />` using the existing keys:

     ```tsx
     {confirmDel && (
       <Modal title={t('dialog.delete')} onClose={() => setConfirmDel(null)}>
         <p className="text-sm">{t('dialog.deleteWarning', { n: confirmDel.shares })}</p>
         {delError && <div className="mt-3"><ErrorNote message={t('deleteFailed')} /></div>}
         <div className="mt-4 flex justify-end gap-2">
           <Button onClick={() => setConfirmDel(null)}>{t('cancel')}</Button>
           <Button variant="danger" busy={busy} onClick={() => void submitDelete()}>
             {t('dialog.deleteConfirm')}
           </Button>
         </div>
       </Modal>
     )}
     ```

   - Update the panel's stale comment on line 109-110 ("the last row is the
     deletable one").
4. `bun test apps/web` + `bun run typecheck` green. Note `RunDetail.tsx` needs
   no change — `onMutated` already remounts panels and refreshes the run view.
5. Commit: `feat(web): per-bucket deletable fills with row delete confirmation`

---

### Task 5 — full verification

1. `bun test` from repo root (all suites; note db.test skips without
   `TEST_DATABASE_URL`) and `bun run typecheck`.
2. If the MariaDB test container is up
   (`docker start st-mariadb-test`), run
   `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test`
   to exercise `db.test.ts` against a real DB.
3. `scripts/e2e.ts` has no fill-delete coverage (verified by grep) — no
   change needed.
4. Fix-and-commit any fallout as `fix:` commits.
