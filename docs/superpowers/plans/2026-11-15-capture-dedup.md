# Capture dedup against booked fills and pending rows — Implementation Plan

Date: 2026-11-15. Spec: `docs/superpowers/specs/2026-11-15-capture-dedup-design.md` (approved).
Status: ready. Execute in an isolated worktree (repo default: subagent-driven development).

## Goal

`ingestCapture` (`apps/server/src/domain/booking.ts`) currently only dedups by
image hash. A 기간체결 (date-range) screenshot therefore re-inserts trades that
are already booked (or already sitting in the pending queue) as brand-new
pending rows. After this change, every extracted fill whose exact
`side|ticker|shares|price|date` signature is already present in the run's
booked fills or status-`pending` pending rows is suppressed; if nothing
survives, the outcome is `'duplicate'` so the Telegram wire replies with the
existing `duplicate-capture` message.

## Architecture notes for the implementer

- All dedup logic lives in `ingestCapture`; nothing else changes signature.
  `CaptureOutcome` is already `'duplicate' | 'rejected' | { pending }` and
  `apps/server/src/wire/capture.ts` already renders `'duplicate'` (line ~124)
  and skips the per-fill keyboards. No i18n or web changes.
- Price canonization: booked fills and pending rows store `price` as **bigint**
  myriadths (`parseUsd` output); the extracted `RawFill.price` is a **string**.
  `formatUsd(parseUsd('58.3200'))` === `'58.32'` === `formatUsd(583200n)`, so
  the canonical key part is `formatUsd(BigInt)` for both spellings. Both
  `parseUsd` (from `@st/core`) and `formatUsd` (from `@st/core/money`) are
  already imported in booking.ts.
- Ticker is already bare (`SOXL`, not `SOXL.N`) on both sides thanks to
  `normalizeFill` (fix 2a5094d). Do not re-strip here.
- `filledOn` for an extracted fill is `f.date ?? deps.today` — the exact value
  the pending insert stores (booking.ts line ~141). The dedup key must use the
  same fallback.
- Multiset, not set: build `Map<key, count>` from booked fills + pending rows;
  each extracted occurrence consumes one count (decrement) and is skipped only
  while count > 0, so a genuinely new identical trade still books.
- `fillRepo.listForRun` is **optional** on `RepoSurface` (line ~22 of
  booking.ts; some fakes lack it). Guard it: without it, booked-fill dedup
  degrades to off; `pendingRepo.listPending()` is required and always runs.
- Dedup runs **after** the capture row is inserted (status `parsed`) and after
  the hash-duplicate guards, so the capture is still recorded and hash dedup
  stays first (a byte-identical re-send keeps returning `'duplicate'` via
  `hasHash` as before).

## Task 1 — Failing tests in `apps/server/test/booking.test.ts`

Files:
- Modify: `apps/server/test/booking.test.ts` (append a new `describe` after the
  existing `describe('booking', …)` block; do not touch existing tests).

The fake factory `fakeRepos()` (top of the file) exposes `f.repos` and
`f._stores: { runs, orders, fills, pending, captures, ledger }`. Booked fills
and pending rows can be seeded **directly** — no bucket state needed, because
dedup only reads `fillRepo.listForRun` / `pendingRepo.listPending`:

```ts
await f.repos.fillRepo.insert({ runId, bucketIdx: 0, side: 'buy', ticker: 'SOXL',
  shares: 88, price: parseUsd('56.0600'), fee: 0, filledOn: '2026-11-10', source: 'capture' })
await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null,
  side: 'sell', ticker: 'SOXL', shares: 44, price: parseUsd('64.07'), fee: null,
  filledOn: '2026-11-11', status: 'pending' })
```

Write these seven tests (spec tests 1–6 plus the optional-repo guard). Shape:

```ts
describe('capture dedup against booked fills and pending rows', () => {
  const setup = async (name: string) => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-15' }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion',
      ticker: 'SOXL', name, poolCents: 1_000_000, costPpm: 100 })
    return { f, deps, runId }
  }
  const img = (b64: string) => ({ base64: b64, mime: 'image/png' })
  const ext = (...fills: RawFill[]): ExtractResult => ({ ok: true, fills })
  // RawFill and ExtractResult are already imported (line 5); parseUsd too (line 3).
```

1. **fully overlapping range -> 'duplicate'**: seed 2 booked fills
   (`buy 88 @56.0600 2026-11-10`, `sell 44 @64.0700 2026-11-11`); capture an
   image whose fills are exactly those 2 (prices spelled `56.06` / `64.07`).
   Expect `out === 'duplicate'`, `f._stores.pending.length === 0`, and
   `f._stores.captures` got a new row with `status === 'parsed'`.
2. **partial overlap**: same 1 booked fill; image has booked trade +
   `buy 78 @58.3200 2026-11-13`. Expect `out.pending.length === 1`, that row
   `shares === 78` and `filledOn === '2026-11-13'`.
3. **still-pending suppression**: no booked fills. Capture img A with fill
   `buy 88 @56.06 2026-11-10` (expect 1 pending). Capture img B (different
   base64) with the same trade -> `'duplicate'`, `f._stores.pending.length`
   still 1.
4. **price spelling**: booked `parseUsd('58.3200')`; extracted `'58.32'` ->
   excluded (covered inside test 1; keep as its own test with a single trade
   booked at `58.3200` and captured as `58.32`).
5. **multiset**: seed 1 booked `buy 88 @56.06 2026-11-10`; image has the same
   trade twice. Expect exactly 1 new pending row.
6. **near-misses not deduped**: seed 1 booked `buy 88 @56.06 2026-11-10`;
   image has 6 fills: the booked one (dropped) + five near-misses —
   `sell 88 @56.06 2026-11-10`, `buy 89 @56.06 2026-11-10`,
   `buy 88 @56.07 2026-11-10`, `buy 88 @56.06 2026-11-11`,
   `buy 88 @56.06` with **no date** (falls back to `deps.today` =
   `'2026-11-15'`, so it does NOT match the booked `2026-11-10`).
   Expect `out.pending.length === 5`.
7. **optional listForRun guard**: seed 1 booked fill, then
   `delete (f.repos.fillRepo as any).listForRun`; capture that trade -> it is
   NOT suppressed (outcome has 1 pending); then seed a matching *pending* row
   and capture again -> `'duplicate'` (pending dedup works without
   `listForRun`).

Run (from repo root): `bun test apps/server/test/booking.test.ts`
Expected: tests 1–7 FAIL (current code inserts pendings for everything).

Commit: `test: capture dedup expectations (booked + pending multiset suppression)`

## Task 2 — Implement dedup in `ingestCapture`

Files:
- Modify: `apps/server/src/domain/booking.ts` only.

Step 2.1 — add the key helper above `ingestCapture`:

```ts
// Exact-signature dedup key. Prices arrive as bigint myriadths from the DB and
// as strings from extraction; formatUsd(parseUsd(x)) canonicalizes both
// spellings ("58.32" === "58.3200").
function dedupKey(side: string, ticker: string, shares: number, price: bigint | string, filledOn: string): string {
  const canon = formatUsd(typeof price === 'string' ? parseUsd(price) : price)
  return `${side}|${ticker}|${shares}|${canon}|${filledOn}`
}
```

Step 2.2 — inside `ingestCapture`, after `const captureId = res.id!` and
before the pending-insert loop, build the multiset and filter:

```ts
  const remaining = new Map<string, number>()
  const bump = (k: string) => remaining.set(k, (remaining.get(k) ?? 0) + 1)
  if (repos.fillRepo.listForRun) {
    for (const b of await repos.fillRepo.listForRun(runId)) bump(dedupKey(b.side, b.ticker, b.shares, b.price, b.filledOn))
  }
  for (const p of await repos.pendingRepo.listPending()) {
    if (p.runId === runId) bump(dedupKey(p.side, p.ticker, p.shares, p.price, p.filledOn))
  }
  const fresh: RawFill[] = []
  for (const f of extract.fills) {
    const k = dedupKey(f.side, f.ticker, f.shares, f.price, f.date ?? deps.today)
    const n = remaining.get(k) ?? 0
    if (n > 0) { remaining.set(k, n - 1); continue }
    fresh.push(f)
  }
  if (fresh.length === 0) return 'duplicate'
```

and change the loop `for (const f of extract.fills)` (line ~139) to
`for (const f of fresh)`. Nothing else in the file changes — pending insert,
`PendingFillRow` shape, and outcome construction stay as-is.

Step 2.3 — minor fake-fidelity fix in `apps/server/test/wire.test.ts` line
~135: `listForRun: async () => fills` ignores `runId`; make it
`listForRun: async (runId: number) => fills.filter((x) => x.runId === runId)`
so the fake cannot cross-suppress between runs.

Step 2.4 — verify:
- `bun test apps/server/test/booking.test.ts` -> all green (incl. the 7 new).
- `bun test` -> all green (existing hash-duplicate, race-path, and wire tests
  must not move: they either re-send identical bytes — hash guard wins before
  dedup — or use distinct sides/dates).
- `bun run typecheck` -> clean.

Commit: `feat: dedup capture fills against booked fills and pending rows`

## Task 3 — Full verification and integration

1. Start the test DB if absent:
   `docker run -d --name st-mariadb-test -e MARIADB_ROOT_PASSWORD=test -e MARIADB_DATABASE=st_test -p 127.0.0.1:3307:3306 mariadb:11`
2. `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` -> 0 fail.
3. `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`
   (from repo root) -> passes. E2E re-sends the identical image, so the hash
   guard path is exercised; dedup must not change its messages.
4. Merge to `main` per the branch-finishing workflow, push.

## Out of scope (do not build)

- Order/fee/fuzzy matching, prompt changes, web UI, new Telegram copy,
  frontend display of "skipped" counts, dedup across runs.
