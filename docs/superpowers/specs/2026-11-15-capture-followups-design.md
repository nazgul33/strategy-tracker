# Capture follow-ups + per-run booking lock — design

Date: 2026-11-15. Status: approved.
Follows: `2026-11-15-capture-dedup-design.md` (merged in `3865ea9`).

## Intent

Close out the four follow-ups parked by the capture-dedup review, and fix the
concurrent-booking race that review deferred. Verified separately: all six
screenshots in `resources/trade_images/mpop` extract correctly through the
live pipeline (no prompt work needed).

## Goals

1. **DB integration case for capture dedup** in `apps/server/test/db.test.ts`.
2. **`duplicate-capture` copy** mentions pending matches, not just booked.
3. **Strict `RepoSurface.fillRepo.listForRun`** — required, guards removed.
4. **Per-run in-process lock** closing the `runBooking` decide→insert race and
   the `ingestCapture` dedup→insert race.

## Non-goals / anti-goals

- No multi-instance protection (second app process on the same DB stays
  unprotected) — tracked as GitHub issue #1 instead.
- No DB transaction refactor, no schema change, no behavior change to dedup
  matching itself.

## Constraints

- Repo rules: no source file > ~300 lines; en/ko catalogs for user copy;
  `bun test` must pass with and without `TEST_DATABASE_URL`.
- Two exact-string assertions track the copy: `apps/server/test/wire.test.ts:269`
  and `scripts/e2e.ts:156`.

## Approaches considered (race fix)

1. **In-process per-run mutex (chosen).** Promise-chain lock keyed by `runId`.
   Cheap, no schema change, fully closes the window under the actual
   single-container deployment. Trades away multi-instance safety.
2. **DB transaction + row lock.** Multi-instance-safe, but re-plumbs the repo
   factory and every write in `runBooking`, and needs `SELECT … FOR UPDATE`
   to truly prevent lost bucket-state updates. Rejected: disproportionate for
   a single-user single-container app. Filed as GitHub issue #1.

## Design

### 1. Lock — `apps/server/src/domain/run-lock.ts` (new file)

- `withRunLock<T>(runId: number, fn: () => Promise<T>): Promise<T>` — a
  Map<runId, Promise-tail>; callers for the same runId run one at a time in
  arrival order; map entry deleted when the queue drains. Non-reentrant.
- `booking.ts` is already ~267 lines, so the lock lives in its own module.

Applied in `booking.ts`:

- `runBooking`: the whole persist sequence (decide → saveState → fill →
  ledger → order flip) — actually the whole function body, since the
  bucket/order matching it does is also read-then-write.
- `ingestCapture`: wrap from the dedup reads (`fillRepo.listForRun`,
  `listPending`) through the `pendingRepo.insert` loop, so two simultaneous
  captures of the same trade serialize and the second sees the first's
  pendings. The hash check/insert stays outside (already atomic via the
  `inserted` flag).

No nesting exists today (`ingestCapture` never calls `runBooking`), so
non-reentrancy is safe; a comment notes it.

Tests (in `booking.test.ts`, no DB): two concurrent `ingestCapture` calls with
identical fills against slow fakes → second returns `'duplicate'`; two
concurrent `confirmPendingFill` on different pendings serialize (interleaving
instrumented by the fakes).

### 2. Copy

- `packages/telegram/src/i18n.ts` `duplicate-capture`:
  en `Duplicate capture — all fills already booked or pending.`
  ko `중복 스냅샷 — 모든 체결이 이미 예약되거나 대기 중입니다.`
- Update the two exact-string assertions listed under Constraints.

### 3. Strict `listForRun`

- `booking.ts` `RepoSurface.fillRepo.listForRun` loses `?`; comment updated
  (`update`/`deleteById` stay optional — rebook/delete history surface).
- Remove guards: `booking.ts` dedup `if (repos.fillRepo.listForRun)`;
  `recompute.ts` lines guarding `listForRun` (keep `update`/`deleteById`
  guards); `http/app.ts` fillRepo intersection simplifies to
  `RepoSurface['fillRepo']`.
- Delete the `booking.test.ts` test "dedup tolerates a fillRepo without
  listForRun" (contract changed). Add `listForRun` to the `day.test.ts`
  fillRepo fake for fidelity.

### 4. DB integration case

New test in `db.test.ts` (self-skips without `TEST_DATABASE_URL`), real repos:

- create run; insert a booked fill via `fillRepo.insert`; insert a pending row
  via `pendingRepo.insert`; call `ingestCapture` with an `ExtractResult`
  covering both → expect `'duplicate'`, capture row status `parsed`, zero new
  pending rows.
- mixed case: same set plus one fresh fill → one pending inserted, fresh only.

Left to the builder: test naming, run-naming/timestamp conventions copied
from neighboring tests.

## Verification

`bun test` (with and without DB), `bun run typecheck`, and `bun scripts/e2e.ts`
(copy string is asserted there).
