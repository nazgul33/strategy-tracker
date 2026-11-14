# Recalc Follow-ups — Design

Date: 2026-11-14
Status: Approved (verified against real `main` @ `25164e2` — a phantom "SellPanel" narrative
from the previous session's summary was debunked; that UI was never specified or committed,
and the prior feature shipped complete. Sections below describe only files that exist.)
Supersedes nothing; extends `2026-11-14-partial-sell-history-design.md`.

Five follow-ups from the partial-sell-history final review, as one wave:

1. Split `apps/server/src/domain/booking.ts` (347 lines) — move the history-recompute
   cluster to `domain/recompute.ts`, update importers, no re-export shim.
2. Typed `ApiError.code` union in the web api client + localized recalc error codes.
3. Consolidate the 7 duplicated fetch-stub copies in web tests into one helper.
4. Surface recalc/edit consequences: typed `deltaCents` in responses, a result
   popup after Update, a consequence warning when editing fills of closed
   buckets, and drift documentation.
5. i18n nit: move `updateButton` to its alphabetical position in en/ko catalogs.

## 1. Server: `domain/recompute.ts` split

New file `apps/server/src/domain/recompute.ts` receives, moved verbatim:

- `signedCents` (line 36; exported helper used only by recompute tests)
- `byIdAsc` (private, not exported)
- `rebuildState`
- `RebookEdit`
- `rebookFill`
- `deleteFill`
- `recalcRunState`

`booking.ts` keeps `sha256`, `RepoSurface`, `BookingDeps`, `FillRow`,
`runBooking`, `ingestCapture`, `confirmPendingFill`, `manualFill`, `rollStale`,
`CANCEL_REASONS`/`cancelOrder`, `seedRun`. `recompute.ts` imports `FillRow`
/`BookingDeps` types from `./booking` (no cycle: booking.ts never imports
recompute). Result: booking.ts ≈ 230 lines, recompute.ts ≈ 135 lines.
No re-exports from booking.ts — importers update to `../domain/recompute`
(or `../../domain/recompute`): `http/routes/fills.ts` (rebookFill/deleteFill/
recalcRunState), `test/recalc.test.ts`, `test/rebooking.test.ts` (its
`manualFill`/`BookingDeps`/`FillRow` stay on booking). `test/booking.test.ts`
and `test/http.test.ts` import only staying symbols — unchanged; test bodies
all stay put.

## 2. Server: consequences in responses (`deltaCents`)

All three recompute ops already compute the cash delta internally; surface it.

- `rebookFill(...): Promise<{ fill: FillRow; deltaCents: number }>`
- `deleteFill(...): Promise<{ fill: FillRow; deltaCents: number }>`
- `recalcRunState(...): Promise<{ state: RunState; deltaCents: number; fillCount: number }>`

Route responses become:

- `PUT /runs/:id/fills/:fillId` → `{ ok: true, deltaCents }`
- `DELETE /runs/:id/fills/:fillId` → `{ ok: true, deletedFillId, deltaCents }`
- `POST /runs/:id/recalc` → `{ ok: true, deltaCents, fillCount }`

Error contracts unchanged (404 `no-run`, 422 `<DomainError.kind>`). Server
tests update for the new return shapes and assert `deltaCents` values
(reuse the existing drift-adjust cases).

## 3. Docs: recalc drift on seeded / pool-edited runs

- Add a "Recalc and drift" section to
  `docs/superpowers/specs/2026-11-14-partial-sell-history-design.md`: derived
  cash comes from `poolCents` minus applied fills; `seedRun` sets stored cash
  directly and pool top-ups move `poolCents`, so on seeded/pool-edited runs an
  Update can book a large one-time `adjust` row (`reason: 'recalc'`) — expected,
  self-explaining via the new popup.
- Doc comments: on `recalcRunState` in recompute.ts and on `seedRun` in
  booking.ts stating this explicitly.

## 4. Web: typed error union + localized recalc codes

`apps/web/src/api.ts`:

- `export type ApiErrorCode =` union of every code the server can emit:
  `unauthorized`, `not-found`, `no-run`, `not-pending`, `pending-not-pending`,
  `ticker-mismatch`, `order-not-found`, `order-not-open`, `invalid-reason`,
  `invalid-body`, `not-last` (routes) + `no-bucket-for-sell`, `no-fill`,
  `invalid-fill`, `immutable-field` (booking/recompute) + `bucket-not-empty`,
  `bucket-not-found`, `bucket-not-held`, `invalid-shares`, `too-many-shares`
  (core) + template fallback `` `http-${number}` ``.
- `ApiError.code: ApiErrorCode` (`String(body.error ?? ...)` cast through the
  constructor).

`RunDetail.tsx` recalc failure banner: localize via `recalcErr.${err.code}`
with the FillDialog fallback pattern (`t(key) === key ? err.code : msg`).
New `recalcErr.*` en/ko keys cover the codes reachable from recalc
(the five core kinds + `invalid-fill`, `no-fill`, `no-run`). Existing
`fillErr.*` stays as-is for FillDialog.

## 5. Web: consequence UX

### 5a. Update (recalc) result popup

`api.recalcRun` returns `{ deltaCents, fillCount }`. After success,
`RunDetail` reloads and opens a summary `Modal` (success view, mirroring the
pool modal's `poolAdded` step):

- Always: "Rebuilt run state from {n} fills."
- `deltaCents !== 0`: "Cash was off by {±$X}; an adjustment was booked so the
  ledger matches the fill history. This is expected on seeded runs or after
  pool edits." (sign from delta; amount via existing cents formatter)
- `deltaCents === 0`: "No cash adjustment was needed."

Single OK button closes and stays on the page.

### 5b. Closed-bucket fill-edit warning + post-save delta

"Closed bucket" here means the fill's `bucketIdx` appears in
`run.state.closed` (any closed tranche, including partial sells).

- `FillsPanel` gains prop `closedIndexes: number[]`; `RunDetail` passes
  `run.state.closed.map((c) => c.index)`. `FillDialog` gains prop
  `bucketClosed?: boolean`. There are **two delete surfaces** on main and both
  are covered: the in-dialog delete step inside `FillDialog` (editing the
  bucket's newest fill) and `FillsPanel`'s own delete-confirm modal
  (FillTable row → `confirmDel` → `submitDelete`).
- Closed-bucket warning line: when `modify && bucketClosed`, `FillDialog`
  renders a persistent amber note in the edit form and in its delete step —
  "This fill belongs to a closed position. Saving re-derives all later history
  and may book a cash adjustment." `FillsPanel`'s delete modal renders the
  same note when the fill's `bucketIdx` is in `closedIndexes`.
- `api.updateFill` / `api.deleteFill` return `deltaCents`. On a successful
  edit/delete with `deltaCents !== 0` the user sees the 5a result popup before
  the panel closes/refreshes: inside `FillDialog` via a success step ("History
  re-derived") whose OK runs the existing `onSaved(); onClose()`; in
  `FillsPanel`'s delete flow by deferring `onMutated()` until the same popup
  (a shared `RecalcResultModal` component rendered by both) is dismissed.
  With `deltaCents === 0`, behavior is unchanged (silent save/close).

New en/ko catalog keys for all strings above. `updateButton` moves to its
alphabetical slot (after `loading`-range keys, i.e. the "u" section) in both
catalogs (item 5, mechanical).

## 6. Web tests: shared fetch-stub helper

New `apps/web/src/testing/fetchStub.ts` (test-only; never imported by
production modules):

- `installFetchStub(routes: Route[]): FetchCalls` where
  `Route = { method?: string; url: string; status?: number; json: unknown }`
  matched in order by `url.includes(route.url)` and method (default GET);
  no match → 200 `[]`. `FetchCalls` records
  `{ method, url, body }` for non-GET requests and exposes `reset()`.
- `restoreFetch()` restores the original `globalThis.fetch`.
- `json(data, status = 200)` low-level response builder for the two stubs
  with special response shapes (PriceChart's url-only stub, error shapes).

Migrate all 7 files: `pages/RunDetail.test.tsx` (both stubs),
`pages/Sim.test.tsx`, `components/RunPanels.test.tsx`,
`components/PriceChart.test.tsx`, `components/forms/CreateRunForm.test.tsx`,
`components/forms/FillDialog.test.tsx`, `components/forms/PendingTable.test.tsx`.
Assertions in each file stay unchanged — only the plumbing collapses.

## Execution waves (SDD)

- Wave 1 (parallel): **A** server = items 1+2+3-server (worktree, provider
  `m5max`); **B** web = items 2-web+4-web+5 (worktree, provider `rtx4090`).
  A and B touch disjoint files; `api.ts` response-type changes in B assume A's
  shapes per this spec, not A's branch.
- Wave 2 (after A and B merge to main): **C** = item 6 test refactor
  (touches RunDetail/FillDialog tests that B extends).
- Reviewers on the opposite provider per task; repo-wide `bun test` +
  typecheck gate on main after every merge (binding lesson).

## Non-goals

- No `fillErr.*` → `recalcErr.*` merge or shared error-text helper (YAGNI).
- No auto-recalc anywhere; Update button remains the only trigger.
- No changes to `runBooking` incremental booking, orders, or pending flows.
- No UI for `fillCount` beyond the popup sentence.
