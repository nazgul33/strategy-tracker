# Delete the last fill of each bucket — design

Date: 2026-11-14
Status: approved in conversation (short design)

## Intent and why

On the run detail page, an operator can already delete one fill: the single newest
fill of the whole run. When a bucket's last fill is wrong but some *other* bucket
was touched more recently, the wrong fill can only be edited, not removed — sells
can't be edited at all. The operator wants every bucket's last fill to be deletable.
The i18n strings (`fillErr.not-last`) and `FillDialog` docs already promise exactly
this per-bucket rule; only the server and `FillsPanel` enforce the narrower
global-newest rule today.

## Goals

- `DELETE /runs/:id/fills/:fillId` accepts the newest fill of *any* bucket.
- The fills table gains a per-row Delete button on each deletable row (the
  bucket's last fill), in addition to the existing Delete inside the edit dialog.
- Booking stays consistent: state is re-derived from the remaining history.

## Non-goals / anti-goals

- No arbitrary mid-history deletes: a later fill in the same bucket depends on
  the earlier one, so replay after delete would be unsound. The per-bucket-last
  set is exactly the safe frontier and nothing wider.
- No reopening of orders (unchanged rule), no bulk delete, no undo.

## Constraints

- Cash Model A: run state = pool + fill-history replay (`rebuildState` in
  `apps/server/src/domain/booking.ts`). Deleting a bucket's last fill can only
  shift cash for *other* buckets' later fills; cash going negative is already an
  accepted outcome, rebalanced by one compensating `adjust` ledger row
  (reason `fill-delete`).
- All user-facing copy via en/ko catalogs; the needed keys (`dialog.delete*`,
  `fillErr.not-last`) already exist and already read correctly.

## Approaches considered

1. **Keep global-newest-only** — status quo; does not satisfy the request.
2. **Allow deleting any fill** — unsound: a later same-bucket sell can exceed the
   replayed holding; rejected by the domain's own guards.
3. **Per-bucket last** (chosen) — matches the documented intent, keeps the
   rebuild invariant trivially safe, smallest diff.

## Decided design

**Server domain** (`booking.ts`): replace `deleteLastFill(runId, deps)` with
`deleteFill(runId, fillId, deps)`: look the fill up in the id-ascending history
(unknown id → `DomainError('no-fill')`), require it to be the highest-id fill of
its own bucket (else `DomainError('not-last')`), rebuild state from history minus
that fill, delete the row by id, book the cash delta as `adjust` as today.

**Repos** (`db/repos.ts` + `RepoSurface`): add `fillRepo.deleteById(runId, fillId)`;
drop `deleteLast` and `lastId` (their only consumer was the route guard, which
moves into the domain). Update the intersection type in `http/app.ts`.

**Route** (`http/routes/fills.ts`): keep the run-exists check and the non-integer
id → `not-last` guard; delegate the rest to `deleteFill` and map `DomainError`
kinds as today. Note the small behavior shift: an unknown-but-numeric fill id now
returns `no-fill` instead of `not-last` (mirrors `rebookFill`).

**Web** (`RunPanels.tsx` FillsPanel, `FillTable.tsx`): the panel computes
last-id-per-bucket from the id-ascending fills list into a `Set<number>`.
`FillTable` gains `deletableIds?: Set<number>` + `onDelete?: (fill) => void`;
a row renders a Delete button beside Edit only when its id is in the set
(same callback/panel-owns-modal pattern as `OrdersPanel` + `OrderTable` cancel).
`FillsPanel` owns a confirm modal (reusing `dialog.delete*` copy), calls
`api.deleteFill`, then reloads and notifies via `onMutated`. The edit dialog's
Delete step receives the widened `deletable` set — no other dialog changes.

## Left to the builder

- Exact button label/test-ids in `FillTable` (follow `fillEdit`/`fillEditBtn` style).
- Test updates: `rebooking.test.ts` (new signature + cross-bucket deletes +
  same-bucket older id rejected), `http.test.ts` and `booking.test.ts` fakes
  (`deleteById`), `db.test.ts` (deleteById replaces deleteLast coverage), web
  component tests for the row button; `scripts/e2e.ts` if it exercises deletes.
