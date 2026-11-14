# Recalc Follow-ups — Implementation Plan

Spec: `docs/superpowers/specs/2026-11-14-recalc-followups-design.md` (approved, verified against `main` @ `25164e2`).

Five follow-ups: server recompute split + `deltaCents` responses + drift docs; web typed
`ApiErrorCode` + localized recalc errors + consequence popups + i18n alpha fix; shared
web test fetch-stub.

**Execution**: subagent-driven development, dedicated worktree per wave. Wave A (server)
and wave B (web) run in parallel; wave C starts only after A and B are merged to `main`.
Worker/reviewer on opposite providers (A: worker `m5max`, reviewer `rtx4090`; B: worker
`rtx4090`, reviewer `m5max`). Binding lesson: after **every** merge into `main` run the
repo-wide gate `bun test && bun run typecheck` on `main` before dispatching the next wave.

Conventions that bind every task: en/ko catalogs updated together; no source file > ~300
lines; `bun test <path>` for the focused file; commit style `feat|fix|docs|test|chore:`.

---

## Wave A — server (`feat/recalc-server-followups`)

### Task A1 — `domain/recompute.ts` split (pure move)

Files: create `apps/server/src/domain/recompute.ts`; edit `apps/server/src/domain/booking.ts`,
`apps/server/src/http/routes/fills.ts`, `apps/server/test/recalc.test.ts`,
`apps/server/test/rebooking.test.ts`.

1. Move **verbatim** from `booking.ts` to `recompute.ts`: `signedCents` (line 36),
   `byIdAsc` (line 246, keep private), `rebuildState`, `RebookEdit`, `rebookFill`,
   `deleteFill`, `recalcRunState` — including all comments.
2. `recompute.ts` imports: `applyBuyFill, applySellFill, emptyState, DomainError, parseUsd,
   type ISODate, type RunState` from `@st/core`; `feeCents` from `@st/core/money`;
   `ageBuckets` from `@st/strategies`; `type BookingDeps, type FillRow` from `./booking`.
   `booking.ts` must NOT import recompute (no cycle). Trim now-unused imports from
   `booking.ts` (`applySellFill` etc. — whatever the compiler flags via `bun run typecheck`).
3. Update import lines only: `fills.ts` → `import { rebookFill, deleteFill, recalcRunState } from '../../domain/recompute'`;
   `recalc.test.ts` splits into `{ manualFill, type BookingDeps } from '../src/domain/booking'` +
   `{ recalcRunState } from '../src/domain/recompute'`; `rebooking.test.ts` likewise
   (`deleteFill, rebookFill, rebuildState, signedCents` from recompute; `manualFill`,
   `BookingDeps`, `FillRow` stay on booking). `booking.test.ts`/`http.test.ts` unchanged.
4. No behavior change — existing suites must pass untouched:
   `bun test apps/server && bun run typecheck`.
5. Commit: `refactor: split history recompute out of booking domain`.

### Task A2 — `deltaCents` in recompute results + routes (TDD)

Files: `apps/server/test/recalc.test.ts`, `apps/server/test/rebooking.test.ts`,
`apps/server/test/http.test.ts`, `apps/server/src/domain/recompute.ts`,
`apps/server/src/http/routes/fills.ts`.

1. Failing tests first:
   - `recalc.test.ts`: `const res = await recalcRunState(...)`; assert
     `res.fillCount` = history length, `res.deltaCents === 0` on a clean run, and in the
     existing drift case `res.deltaCents` equals the booked adjust amount (positive and
     negative variants — extend one existing drift test with a negative case).
     The old return value (`RunState`) moves to `res.state`.
   - `rebooking.test.ts`: `rebookFill` → `{ fill, deltaCents }`, `deleteFill` →
     `{ fill, deltaCents }`; assert the returned `fill` equals the old return and
     `deltaCents` matches the ledger adjust (0 when no adjust booked).
   - `http.test.ts`: PUT fill 200 body `ok:true` + `deltaCents` (number, drift fixture
     nonzero); DELETE 200 keeps `deletedFillId` and adds `deltaCents`; POST recalc 200
     body `{ ok: true, deltaCents, fillCount }`; error contracts (404 `no-run`,
     422 kinds) unchanged.
   - Confirm red: `bun test apps/server/test/recalc.test.ts apps/server/test/rebooking.test.ts apps/server/test/http.test.ts`.
2. Implement: in all three ops the delta is already computed (`rebuilt.cashCents -
   state.cashCents`); return `{ state: rebuilt, deltaCents, fillCount: history.length }`
   (recalc) / `{ fill: ..., deltaCents }` (rebook, delete). Routes pass the numbers into
   `c.json` (no bigint involved — plain integers).
3. Gate: `bun test apps/server && bun run typecheck` green.
4. Commit: `feat: return cash delta from fill edit, delete and recalc`.

### Task A3 — drift documentation

Files: `docs/superpowers/specs/2026-11-14-partial-sell-history-design.md`,
`apps/server/src/domain/recompute.ts`, `apps/server/src/domain/booking.ts`.

1. Append a `## Recalc and drift` section to the partial-sell spec: derived cash =
   `poolCents` minus applied fills; `seedRun` writes stored cash directly and pool
   top-ups move `poolCents`, so an Update on seeded/pool-edited runs may book one large
   `adjust` row (`reason: 'recalc'`) — expected; surfaced by the web popup.
2. Extend the existing doc comments: on `recalcRunState` (mention `deltaCents` semantics)
   and on `seedRun` (stored cash is authoritative until first recalc).
3. Gate: `bun test apps/server && bun run typecheck` (comments only).
4. Commit: `docs: explain recalc drift on seeded and pool-edited runs`.

**Wave A PR**: single PR `feat: recompute split + cash-delta responses`; merge after
review; then repo-wide gate on `main`.

---

## Wave B — web (`feat/recalc-web-followups`, branched from current `main`)

### Task B1 — typed `ApiErrorCode`

Files: `apps/web/src/api.ts`, `apps/web/src/api.test.ts`.

1. Failing test in `api.test.ts`: error response `{ error: 'not-last' }` →
   `err.code === 'not-last'`; non-JSON 500 → `err.code === 'http-500'`; type-only
   assertions compile away (run `bun run typecheck`).
2. Implement: `export type ApiErrorCode =` union of
   `'unauthorized' | 'not-found' | 'no-run' | 'not-pending' | 'pending-not-pending' |
   'ticker-mismatch' | 'order-not-found' | 'order-not-open' | 'invalid-reason' |
   'invalid-body' | 'not-last' | 'no-bucket-for-sell' | 'no-fill' | 'invalid-fill' |
   'immutable-field' | 'bucket-not-empty' | 'bucket-not-found' | 'bucket-not-held' |
   'invalid-shares' | 'too-many-shares'` plus `` `http-${number}` ``.
   `ApiError.code: ApiErrorCode`; in `call()`:
   `new ApiError(res.status, (typeof body.error === 'string' ? body.error : \`http-${res.status}\`) as ApiErrorCode)`.
   Callers using `err.code` as a string keep compiling.
3. Gate: `bun test apps/web && bun run typecheck`. Commit: `feat: typed ApiError codes in web api client`.

### Task B2 — localized recalc failure banner

Files: `apps/web/src/pages/RunDetail.tsx`, `apps/web/src/i18n/en.json`, `ko.json`,
`apps/web/src/pages/RunDetail.test.tsx`.

1. Failing test: recalc responds 422 `bucket-not-held` → banner shows the localized
   `recalcErr.bucket-not-held` text (not the raw code); unknown code `zzz` → falls back
   to `err.code`/message (mirror the `fillErr.*` fallback pattern from FillDialog).
2. Implement: `recalc` catch → `ApiError` → `t(\`recalcErr.${err.code}\`)` fallback
   `err.code`. New keys en/ko (alphabetical slot):
   `recalcErr.bucket-not-empty` — "This bucket still has open shares." /
   "이 버킷에 아직 청산되지 않은 수량이 있습니다.";
   `recalcErr.bucket-not-found` — "Bucket not found." / "버킷을 찾을 수 없습니다.";
   `recalcErr.bucket-not-held` — "This bucket is not currently held." /
   "버킷을 보유 중이 아닙니다.";
   `recalcErr.invalid-shares` — "Invalid share count." / "유효하지 않은 수량입니다.";
   `recalcErr.no-run` — "Run not found." / "런을 찾을 수 없습니다.";
   `recalcErr.too-many-shares` — "More shares than the position holds." /
   "보유 수량을 초과합니다."
3. Gate + commit: `feat: localize recalc error messages` (tests included).

### Task B3 — `deltaCents` in api client

Files: `apps/web/src/api.ts`, `apps/web/src/api.test.ts`.

1. Failing tests: `updateFill` resolves `{ deltaCents }`; `deleteFill` resolves
   `{ deletedFillId, deltaCents }`; `recalcRun` resolves `{ deltaCents, fillCount }`
   (stub JSON accordingly).
2. Implement: drop the `.then(() => undefined)` on `recalcRun`; widen the three
   `send<>` types to include the new fields; interface types updated.
3. Fix compile fallout in callers (RunDetail/FillsPanel/FillDialog pass-through only —
   behavior still unchanged until B5–B7).
4. Gate + commit: `feat: surface cash delta in fill/recalc api responses`.

### Task B4 — `RecalcSummary` + `RecalcResultModal` components

Files: create `apps/web/src/components/RecalcSummary.tsx` + colocated test; edit
`apps/web/src/i18n/en.json`, `ko.json`.

1. Failing component tests (happy-dom pattern like `RunPanels.test.tsx`):
   - summary with `deltaCents: 250, fillCount: 4` renders "Rebuilt run state from 4 fills."
     and contains `+$2.50` (via `signedCentsUsd`) plus the adjustment sentence;
   - `deltaCents: 0` renders the "No cash adjustment was needed." line and no amount;
   - `RecalcResultModal` wraps the summary in a `Modal` titled `recalcDone.title` with a
     single OK button firing `onClose`.
2. Implement both exports in one file (< 60 lines): `RecalcSummary({ result })` where
   `result: { deltaCents: number; fillCount: number }`, and
   `RecalcResultModal({ result, onClose })`.
   Keys (alphabetical): `recalcDone.adjusted` — en "Cash was off by {delta}; an adjustment
   was booked so the ledger matches the fill history. This is expected on seeded runs or
   after pool edits." / ko "현금 잔고가 {delta}만큼 어긋나 조정을 장부에 반영했습니다. 시드한
   런이나 풀 편집 후에 발생하는 정상 동작입니다."; `recalcDone.noAdjust` — "No cash
   adjustment was needed." / "현금 조정은 필요 없었습니다.";
   `recalcDone.rebuilt` — "Rebuilt run state from {n} fills." / "거래 {n}건으로 런 상태를
   다시 계산했습니다."; `recalcDone.title` — "Recalculation complete" / "재계산 완료";
   OK button reuses the existing common OK key if present, else `recalcDone.ok`
   ("OK"/"확인").
3. Gate + commit: `feat: recalc result summary components`.

### Task B5 — RunDetail: always-on recalc result popup

Files: `apps/web/src/pages/RunDetail.tsx` (+ extract `EditRunModal` — see step 0),
`apps/web/src/pages/RunDetail.test.tsx`.

0. File-size chore first: `RunDetail.tsx` is 343 lines (> ~300 convention). Move
   `EditRunModal` to `apps/web/src/components/forms/EditRunModal.tsx` verbatim, update
   imports, keep behavior; commit separately: `refactor: extract EditRunModal from RunDetail`.
1. Failing test: recalc resolves `{ deltaCents: 0, fillCount: 3 }` → after run,
   `[data-testid="recalcResult"]` modal visible with the no-adjust line; OK closes it.
   Nonzero delta variant shows the amount. Error path unchanged (B2).
2. Implement: `recalc()` stores `api.recalcRun` result in state, then `reload()`;
   render `<RecalcResultModal>` when result set. Same handler already serves the header
   button and every RunHistory line button — all surface the popup.
3. Gate + commit: `feat: show recalc result popup after Update`.

### Task B6 — closed-bucket warnings (two delete surfaces)

Files: `apps/web/src/components/RunPanels.tsx`, `apps/web/src/components/forms/FillDialog.tsx`,
`apps/web/src/pages/RunDetail.tsx`, catalogs, `RunPanels.test.tsx`,
`apps/web/src/components/forms/FillDialog.test.tsx`.

1. Failing tests:
   - `FillDialog` with `bucketClosed` + `fill` (edit): warning line
     `t('closedFillWarning')` visible in the form and in the delete step;
   - `FillsPanel` with `closedIndexes=[2]`: deleting a row with `bucketIdx: 2` shows the
     note in the confirm modal; a row with `bucketIdx: 1` does not.
2. Implement: `FillsPanel` prop `closedIndexes: number[]` (default `[]`);
   `FillDialog` prop `bucketClosed?: boolean`; note rendered as a muted amber
   paragraph (match existing error-note styling). `RunDetail` passes
   `closedIndexes={run.state.closed.map((c) => c.index)}` and per-edit
   `bucketClosed={run.state.closed.some((c) => c.index === edit.bucketIdx)}`.
   Key `closedFillWarning` — en "This fill belongs to a closed position. Saving re-derives
   all later history and may book a cash adjustment." / ko "이 체결은 청산된 포지션에
   속합니다. 저장하면 이후 내역이 다시 계산되고 현금 조정이 발생할 수 있습니다."
3. Gate + commit: `feat: warn when editing or deleting closed-bucket fills`.

### Task B7 — post-mutation delta popups

Files: `FillDialog.tsx`, `RunPanels.tsx`, their tests, `RunDetail.test.tsx`.

1. Failing tests (fetch stubs now return `deltaCents`):
   - `FillDialog` edit save with `deltaCents: -120` → success step (form replaced) shows
     `RecalcSummary` content; OK click → `onSaved()` + close. `deltaCents: 0` → saves and
     closes silently (regression guard on existing tests);
   - `FillDialog` delete with nonzero delta → same success step;
   - `FillsPanel` row delete with `deltaCents: 80` → confirm modal closes,
     `RecalcResultModal` appears, `onMutated` NOT yet called; OK → popup closes and
     `onMutated` fires once; `deltaCents: 0` → `onMutated` fires immediately (unchanged).
2. Implement: capture `deltaCents` from `api.updateFill`/`api.deleteFill`;
   FillDialog local `doneResult` state + success-step branch (reuse the existing
   confirming-step pattern); FillsPanel holds `delResult` state, gates the `onMutated()`
   call behind `RecalcResultModal` dismiss.
3. Gate + commit: `feat: report booked cash adjustments after fill edits and deletes`.

### Task B8 — `updateButton` alphabetical slot

Files: `apps/web/src/i18n/en.json`, `ko.json`.

1. `bun test apps/web/src/catalog.test.ts` first — if catalog.test does not enforce key
   order, add an assertion that both catalogs are sorted (localeCompare) and confirm it
   fails on the misplaced `updateButton` (currently wedged between `historyColShares` and
   `historyEmpty`).
2. Move the key to its sorted position in both files; catalog tests green.
3. Gate + commit: `fix: sort updateButton key in i18n catalogs`.

**Wave B PR**: `feat: recalc consequence UX + typed api errors`; merge after review;
repo-wide gate on `main`.

---

## Wave C — web test plumbing (`refactor/web-fetch-stub`, after A+B merged)

### Task C1 — shared fetch-stub helper

Files: create `apps/web/src/testing/fetchStub.ts`; migrate `pages/RunDetail.test.tsx`
(both stubs), `pages/Sim.test.tsx`, `components/RunPanels.test.tsx`,
`components/PriceChart.test.tsx`, `components/forms/CreateRunForm.test.tsx`,
`components/forms/FillDialog.test.tsx`, `components/forms/PendingTable.test.tsx`.

1. Helper API (per spec §6): `installFetchStub(routes: Route[]): FetchCalls`,
   `Route = { method?: string; url: string; status?: number; json: unknown }`, matched in
   order by `url.includes(route.url)` + method (default GET), no match → 200 `[]`;
   `FetchCalls` records `{ method, url, body }` for non-GET requests and exposes
   `reset()`; `restoreFetch()` restores original `globalThis.fetch`;
   `json(data, status = 200)` low-level builder for special shapes (PriceChart url-only
   stub, error bodies). Colocated `fetchStub.test.ts` covering match order, method
   filter, fallback 200 `[]`, body recording, restore.
2. Migrate one file at a time; **assertions in each file stay unchanged** — only
   plumbing collapses; each migration ends with that file green.
3. Gate: `bun test apps/web && bun run typecheck`. Commit: `test: share one fetch stub across web tests`.

**Wave C PR**: `test: shared fetch-stub helper for web tests`; merge; repo-wide gate.

---

## Definition of done

- All three PRs merged to `main`; on final `main`: `bun test` (no new skips) and
  `bun run typecheck` clean.
- Design doc sections 1–6 each traceable to a merged commit.
- Ledger `.superpowers/sdd/2026-11-14-recalc-followups/progress.md` records per-task
  provider assignments, review rulings, and post-merge gate outputs.
