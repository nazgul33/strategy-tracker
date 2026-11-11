# Run lifecycle + bulk status — design

Date: 2026-11-11 · Status: approved · Delta on `2026-11-10-strategy-tracker-design.md` §runs

## Intent and the why

Runs pile up and ending/freezing them one by one (open detail → button → repeat) is
tedious. The owner wants to freeze ("stop"/pause) and close groups of runs in one
action from the Runs list, and to see his live set without scrolling past history.

## Decided by the owner

- `closed` **remains** and becomes **terminal**: a closed run can never be resumed
  or paused again — not in the UI and not through the API.
- `paused` remains, fully reversible.
- Bulk actions on the Runs list: **Pause**, **Resume**, **Close**.
- Runs tab shows **active runs only** by default.
- `done` is removed (owner approved by silence in review round 2; its only purpose
  was the closed→Stop→done chain, which disappears).

## Goals

- One click to pause/resume/close many selected runs.
- "Closed is final" is a server-enforced rule, not a hidden button.
- Runs list defaults to the live set; All/Active/Paused/Closed still selectable.

## Non-goals / anti-goals

- No bulk delete, no bulk pool edits, no Telegram bulk commands.
- No order cancellation: pausing/closing never touches open orders (they go stale
  next morning on their own). The program never trades. (Unchanged from base design.)

## Constraints

- All user-facing copy en+ko. Money untouched. `packages/*` stay app-free.
- Drizzle migrations regenerate from `db/schema.ts`; enum shrink must not error on
  existing rows → data UPDATE must precede the ALTER.

## Approaches considered

1. **UI-only rules, reuse per-run PATCH N times** — rejected: the "no resume for
   closed" rule would be cosmetic (direct API calls bypass it), and N sequential
   round-trips for a group is slow and non-atomic.
2. **Server-side transition rules + one bulk endpoint** — chosen: PATCH and the new
   bulk endpoint share one transition validator; bulk is a single
   `UPDATE … WHERE id IN (…)`.
3. **Keep `done` as a post-closed state** — rejected: a "done" badge invites
   reopening exactly when the owner decided closed must be final.

## The how

### States and transitions

Run status enum: `active | paused | closed` (already what `@st/core` `RunStatus`
declares). Valid transitions: `active⇄paused`, `active→closed`, `paused→closed`;
`closed→*` invalid everywhere.

### Migration

Generated from the shrunk `mysqlEnum`, hand-edited so
`UPDATE strategy_runs SET status='closed' WHERE status='done'` runs **before** the
enum ALTER. `closed` rows are untouched.

### API

- `PATCH /api/runs/:id {status}` — validates status ∈ enum **and** the transition
  from the run's current status; invalid transition → **409**, invalid value → 400.
- `POST /api/runs/bulk-status {ids: number[], status}` — same rules; ids must be a
  non-empty array of positive integers, else 400. Applies transitions row-by-row
  semantics via one filtered `UPDATE … WHERE id IN (…)` on rows whose current
  status admits the target; responds `{ updated: n }` (count from affectedRows).
- `runRepo` gains `updateStatusMany(ids, from: string[], to): Promise<number>`.

### Server details

- Transition table lives next to the runs router (or in `domain/booking.ts` if it
  reads better) as one exported helper used by both routes.
- `day.ts` and capture pinning are untouched: non-active skip and pinned
  paused/closed capture already behave correctly with terminal closed.

### Web

- `RUN_STATUSES` → `['active','paused','closed']`; tones unchanged for kept states.
- Runs list: filter defaults to `active`; checkbox column (header checkbox selects
  the visible page subset); selection bar with context-aware buttons —
  `Pause (n)` on selected active, `Resume (n)` on selected paused,
  `Close (n)` on selected not-closed. Buttons disabled when their subset is empty.
  Bulk **Close** confirms (modal naming the count, mirroring the single Close modal
  copy); bulk Pause/Resume act immediately, then reload.
- RunDetail: Active → `Pause` + `Close`; Paused → `Resume` + `Close`; Closed → no
  action buttons. closed→Stop chain deleted.

### i18n (en + ko)

Remove `statusDone`, `actionStop`; keep `statusClosed`, `actionClose`, `close`
(modal cancel). Add: `bulkSelected`, `bulkPause`, `bulkResume`, `bulkClose`,
`bulkCloseConfirm`, `bulkDone` (result line "n runs updated").

### Tests

- server: PATCH transition matrix (closed→active 409, paused→active 200, …),
  bulk-status happy path + skipped rows + 400s; day/http tests that used `done`
  updated.
- web: viewmodels status list, RunsList selection/filter-default, RunDetail button
  matrix incl. closed → none.
- e2e: touch if it asserts statuses (check during implementation).

## Left to the builder

Exact placement of the transition helper, checkbox column styling, and whether the
selection bar is a sticky footer or inline strip — match existing UI patterns.
