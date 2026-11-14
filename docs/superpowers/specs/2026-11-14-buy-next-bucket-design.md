# Buy allocation: next never-used bucket — design

Date: 2026-11-14. Approved by the owner in conversation.

Supersedes the master spec line "A buy order fills the **lowest free bucket
index**" (`2026-11-10-strategy-tracker-design.md`, §Bucket allocation edge
cases).

## Intent and the why

A closed bucket carries its full trade episode in `RunState.closed` (buy
price, sold price, dates, fees). Today the next buy reuses the lowest empty
index, so a just-closed bucket gets immediately re-opened and its slot
history interleaves multiple episodes. The owner wants buys to advance to the
next never-used bucket, keeping each bucket slot's closed record as one
episode as long as possible; previously closed buckets are reused only when
no fresh bucket remains.

## Goals

- Buy booking picks the lowest empty bucket index never present in
  `state.closed` (never-used). Only when every empty bucket has been closed
  at least once does it fall back to a previously closed bucket.
- The morning plan (`buy_loc` order bucket index) and the booking path apply
  the identical rule, so planned orders and booked fills agree.

## Non-goals / anti-goals

- No schema or persisted-state shape change ("previously closed" is derived
  from `state.closed`, already stored).
- No change to sell bucket matching, sim mechanics, or the UI.
- No round-robin fairness tracking; anti-goal: a plan and a booking of the
  same buy landing in different buckets.

## Constraints

- `packages/*` never import `apps/*`; the shared rule lives in `@st/core`.
- Existing error `no-empty-bucket` when all buckets are held stays.
- `rebuildState` replay uses stored `bucketIdx`, so history stays
  deterministic regardless of this change.

## Approaches

1. **Shared helper in `@st/core` (chosen)** — `nextBuyBucketIndex(state)` in
   `packages/core/src/fills.ts`, re-exported from `@st/core`: lowest
   never-closed empty index, else lowest empty index, else `null`. One rule
   for every caller; zero drift; no migration.
2. Inline the rule at each call site — rejected: plan/booking drift risk.
3. Persist an `everOpened` flag per bucket — rejected: state/schema churn for
   data `state.closed` already records.

## Decided in conversation / owner's calls

- Behavior: next never-used bucket preferred; closed buckets reused only as
  last resort (owner).
- Subagent-driven implementation, dedicated worktree per parallel subagent,
  both model providers used (owner).

## Builder's calls

- Fallback tie-break = lowest closed index. Under normal sequential use this
  is also the oldest-closed bucket, so the two readings coincide.
- Call sites updated: `computeOrders` (`packages/strategies/src/mean-reversion.ts`,
  `buy_loc` bucket index), `runBooking` buy branch
  (`apps/server/src/domain/booking.ts`). `seedRun` also switches to the
  helper — on a fresh state (no closes) it picks 0,1,2… exactly as today.
- `no-bucket-available` notice in `computeOrders` and the `no-empty-bucket`
  throw in `runBooking` keep firing when the helper returns `null`.
- Tests: new core unit tests for the helper; strategies test for
  closed-then-plan ordering (buy moves past closed indices; reuses a closed
  bucket only when all are closed); booking test for the same through
  `manualFill`; check `day.test.ts`/`sim.test.ts` expectations still hold.
