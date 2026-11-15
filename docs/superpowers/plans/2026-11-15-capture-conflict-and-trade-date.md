# Capture Conflict Detection + Trade-Date Display — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-capturing a fill that matches an existing booked/pending fill on side+ticker+shares+trade date (but not price) reports a conflict instead of inserting a duplicate pending row, and the detected trade date becomes visible in the web Pending table and in both Telegram booking lines.

**Architecture:** Two-phase dedup inside `ingestCapture` (apps/server domain module): exact-signature matching stays first (multiset consumption), then a loose key (`side|ticker|shares|filledOn`, price ignored) turns remaining fills into `CaptureConflict` records instead of pending rows. The wire layer (`wire/capture.ts`) renders conflict lines through three new telegram i18n keys and appends `{date}` to the two existing booking lines. The web Pending table renders the already-delivered `filledOn` above its existing override input.

**Tech Stack:** Bun, TypeScript, `bun test`, React + happy-dom (apps/web), MariaDB integration tests via `TEST_DATABASE_URL`.

Spec: `docs/superpowers/specs/2026-11-15-capture-conflict-and-trade-date-design.md` (approved).

## Global Constraints

- Respond/comment in English only (repo AGENTS.md).
- Money is bigint myriadths via `@st/core/money`; prices crossing the extract boundary are strings; never float.
- All user-facing copy lives in `packages/telegram/src/i18n.ts` (en+ko) or `apps/web/src/i18n/{en,ko}.json`.
- No source file > ~300 lines.
- Run all commands from the repo root. Unit suite needs no DB; `apps/server/test/db.test.ts` self-skips without `TEST_DATABASE_URL`.
- Test DB (for DB integration + e2e steps): `docker run -d --name st-mariadb-test -e MARIADB_ROOT_PASSWORD=test -e MARIADB_DATABASE=st_test -p 127.0.0.1:3307:3306 mariadb:11`, then `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test`.
- NEVER touch the production database or production deployment.
- Commit style: `feat:` / `fix:` / `test:` / `docs:` / `chore:`.
- Work happens on a fresh worktree branch `fix/capture-conflict-trade-date` created via superpowers:using-git-worktrees from `main` (main = `dd57426`). The design doc (untracked) and this plan must be committed in Task 0.

---

### Task 0: Branch + docs

**Files:**
- Commit: `docs/superpowers/specs/2026-11-15-capture-conflict-and-trade-date-design.md` (already written, in the working tree of main — copy it into the worktree if it is untracked there)
- Commit: `docs/superpowers/plans/2026-11-15-capture-conflict-and-trade-date.md` (this file)

- [ ] Create the isolated worktree + branch `fix/capture-conflict-trade-date` (superpowers:using-git-worktrees).
- [ ] Ensure the spec and plan files exist in the worktree, then:

```bash
git add docs/superpowers/specs/2026-11-15-capture-conflict-and-trade-date-design.md docs/superpowers/plans/2026-11-15-capture-conflict-and-trade-date.md
git commit -m "docs: approved design + implementation plan for capture conflicts and trade-date display"
```

---

### Task 1: `CaptureConflict` + two-phase dedup in `booking.ts`, conflict reporting in `capture.ts`, new i18n keys

One commit because widening `CaptureOutcome` and the `sendOutcome` handling must land together or `bun run typecheck` fails.

**Files:**
- Modify: `apps/server/src/domain/booking.ts` (types near L34; helpers L126-132; dedup block inside `ingestCapture` L157-190)
- Modify: `apps/server/src/wire/capture.ts` (imports L7-8; `sendOutcome` L120-141)
- Modify: `packages/telegram/src/i18n.ts` (add 3 keys after `'duplicate-capture'`, ~L27)
- Test: `apps/server/test/booking.test.ts` (append to the existing `describe('capture dedup against booked fills and pending rows')` block, which ends ~L652; its helpers `setup`, `img`, `ext`, `seedFill`, `seedPending` are already in scope)
- Test: `apps/server/test/wire.test.ts` (append one test to `describe('capture onPhoto — happy path books via the real booking module')`)

**Interfaces:**
- Produces (booking.ts):
  - `export interface CaptureConflict { side: 'buy' | 'sell'; ticker: string; shares: number; extractedPrice: string; filledOn: ISODate; bookedId: number | null; bookedPrice: string | null; pendingId: number | null; pendingPrice: string | null }`
  - `export type CaptureOutcome = 'duplicate' | 'rejected' | { pending: PendingFillRow[] } | { pending: PendingFillRow[]; conflicts: CaptureConflict[] } | CaptureConflict[]`
  - `ingestCapture` now returns `{ conflicts }` (no fresh rows) or `{ pending, conflicts? }`; `'duplicate'` only when the extract matched existing rows exactly (no fresh AND no conflicts).
- Consumed by capture.ts: `CaptureOutcome`, `CaptureConflict` from `../domain/booking`.
- i18n keys: `capture-conflicts-head`, `capture-conflict`, `capture-conflict-pending` (placeholders below).

- [ ] **Step 1: Write the failing unit tests** in `apps/server/test/booking.test.ts`. Add `type CaptureConflict` to the import from `'../src/domain/booking'` at the top of the file, then append inside the existing dedup describe block (helpers `setup/img/ext/seedFill/seedPending` and store `f._stores.{fills,pending,captures}` are already used there):

```ts
  test('conflict: price-only diff vs a booked fill books nothing and cites the booked fill', async () => {
    const { f, deps, runId } = await setup('cap-c1')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    const out = await ingestCapture(runId, img('CONF-1'),
      ext({ side: 'sell', ticker: 'SOXL', shares: 44, price: '64.07', date: '2026-11-11' }), deps)
    const conflicts = (out as { conflicts: CaptureConflict[] }).conflicts
    expect(conflicts.length).toBe(1)
    expect(conflicts[0]).toEqual({
      side: 'sell', ticker: 'SOXL', shares: 44, extractedPrice: '64.07', filledOn: '2026-11-11',
      bookedId: f._stores.fills[0]!.id, bookedPrice: '66.03', pendingId: null, pendingPrice: null,
    })
    expect(f._stores.pending.length).toBe(0)
  })

  test('conflict: price-only diff vs a pending row cites the pending row', async () => {
    const { f, deps, runId } = await setup('cap-c2')
    await seedPending(f, runId, 'buy', 78, '58.32', '2026-11-13')
    const out = await ingestCapture(runId, img('CONF-2'),
      ext({ side: 'buy', ticker: 'SOXL', shares: 78, price: '58.99', date: '2026-11-13' }), deps)
    const conflicts = (out as { conflicts: CaptureConflict[] }).conflicts
    expect(conflicts[0]).toEqual({
      side: 'buy', ticker: 'SOXL', shares: 78, extractedPrice: '58.99', filledOn: '2026-11-13',
      bookedId: null, bookedPrice: null,
      pendingId: f._stores.pending[0]!.id, pendingPrice: '58.32',
    })
    expect(f._stores.pending.length).toBe(1)
  })

  test('all-conflict capture is NOT reported as duplicate and stores no pending rows', async () => {
    const { f, deps, runId } = await setup('cap-c3')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    const out = await ingestCapture(runId, img('CONF-3'),
      ext({ side: 'sell', ticker: 'SOXL', shares: 44, price: '64.07', date: '2026-11-11' }), deps)
    expect(typeof out).toBe('object')
    expect((out as { pending?: unknown }).pending).toBeUndefined()
    expect((out as { conflicts: unknown[] }).conflicts.length).toBe(1)
    expect(f._stores.pending.length).toBe(0)
    expect(f._stores.captures.some((c: { status: string }) => c.status === 'parsed')).toBe(true)
  })

  test('different trade date is a different trade: fresh pending row, no conflict', async () => {
    const { f, deps, runId } = await setup('cap-c4')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    const out = await ingestCapture(runId, img('CONF-4'),
      ext({ side: 'sell', ticker: 'SOXL', shares: 44, price: '66.03', date: '2026-11-12' }), deps)
    expect((out as { pending: unknown[] }).pending.length).toBe(1)
    expect((out as { conflicts?: unknown[] }).conflicts).toBeUndefined()
  })

  test('order independence: an exact pending match is consumed before a loose booked match steals it (silent duplicate)', async () => {
    const { f, deps, runId } = await setup('cap-c5')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11') // loose twin, wrong price
    await seedPending(f, runId, 'sell', 44, '64.07', '2026-11-11') // exact twin
    const out = await ingestCapture(runId, img('CONF-5'),
      ext({ side: 'sell', ticker: 'SOXL', shares: 44, price: '64.07', date: '2026-11-11' }), deps)
    expect(out).toBe('duplicate')
    expect(f._stores.pending.length).toBe(1)
  })

  test('mixed capture: exact-duplicate + conflict + fresh returns pending rows and conflicts together', async () => {
    const { f, deps, runId } = await setup('cap-c6')
    await seedPending(f, runId, 'buy', 10, '50.00', '2026-11-11') // exact dup below
    await seedFill(f, runId, 'sell', 20, '70.00', '2026-11-12') // loose twin below
    const out = await ingestCapture(runId, img('CONF-6'), ext(
      { side: 'buy', ticker: 'SOXL', shares: 10, price: '50.00', date: '2026-11-11' },
      { side: 'sell', ticker: 'SOXL', shares: 20, price: '69.10', date: '2026-11-12' },
      { side: 'buy', ticker: 'SOXL', shares: 30, price: '40.00', date: '2026-11-13' },
    ), deps)
    const o = out as { pending: { shares: number }[]; conflicts: CaptureConflict[] }
    expect(o.pending.length).toBe(1)
    expect(o.pending[0]!.shares).toBe(30)
    expect(o.conflicts.length).toBe(1)
    expect(o.conflicts[0]!.bookedPrice).toBe('70.00')
    expect(f._stores.pending.length).toBe(2) // original + the fresh row only
  })
```

Note: `seedFill`/`seedPending` store prices via `parseUsd(...)` (bigint), so `canon()` must handle bigint (it already does in `dedupKey`).

- [ ] **Step 2: Run to verify they fail** with the current single-phase dedup:

```bash
bun test apps/server/test/booking.test.ts
```

Expected: the 6 new tests FAIL (e.g. first returns `{ pending: [...] }` instead of conflicts); all pre-existing tests in the file PASS.

- [ ] **Step 3: Implement `booking.ts`.** Replace the `CaptureOutcome` line (L34) with:

```ts
export type CaptureOutcome =
  | 'duplicate'
  | 'rejected'
  | { pending: PendingFillRow[] }
  | { pending: PendingFillRow[]; conflicts: CaptureConflict[] }
  | CaptureConflict[]

/** A re-extracted fill that matches an existing booked/pending fill on everything
 * but price: the same trade with a price discrepancy — never a new row. */
export interface CaptureConflict {
  side: 'buy' | 'sell'
  ticker: string
  shares: number
  extractedPrice: string
  filledOn: ISODate
  bookedId: number | null
  bookedPrice: string | null
  pendingId: number | null
  pendingPrice: string | null
}
```

Replace the dedup helper block (L126-132) with:

```ts
// Prices arrive as bigint myriadths from the DB and as strings from extraction;
// formatUsd(parseUsd(x)) canonicalizes both spellings ("58.32" === "58.3200").
function canon(price: bigint | string): string {
  return formatUsd(typeof price === 'string' ? parseUsd(price) : price)
}

// Exact-signature dedup key.
function dedupKey(side: string, ticker: string, shares: number, price: bigint | string, filledOn: string): string {
  return `${side}|${ticker}|${shares}|${canon(price)}|${filledOn}`
}

// Same trade ignoring price: a price typo in a manual fill must not fork a
// second row — the discrepancy is reported as a conflict instead.
function looseKey(side: string, ticker: string, shares: number, filledOn: string): string {
  return `${side}|${ticker}|${shares}|${filledOn}`
}
```

Replace the dedup block inside `ingestCapture` (the code between `return withRunLock(runId, async () => {` and `const pendingRows: PendingFillRow[] = []`) with:

```ts
    const remaining = new Map<string, number>()
    const bump = (k: string) => remaining.set(k, (remaining.get(k) ?? 0) + 1)
    const bookedMatch = new Map<string, { id: number; price: bigint | string }>()
    const pendingMatch = new Map<string, { id: number; price: bigint | string }>()
    for (const b of await repos.fillRepo.listForRun(runId)) {
      bump(dedupKey(b.side, b.ticker, b.shares, b.price, b.filledOn))
      const lk = looseKey(b.side, b.ticker, b.shares, b.filledOn)
      if (!bookedMatch.has(lk)) bookedMatch.set(lk, { id: b.id, price: b.price })
    }
    for (const p of await repos.pendingRepo.listPending()) {
      if (p.runId !== runId) continue
      bump(dedupKey(p.side, p.ticker, p.shares, p.price, p.filledOn))
      const lk = looseKey(p.side, p.ticker, p.shares, p.filledOn)
      if (!pendingMatch.has(lk)) pendingMatch.set(lk, { id: p.id, price: p.price })
    }
    // Phase 1 consumes exact signatures first so a loose (price-ignoring) match
    // can never steal a true duplicate — result is independent of row order.
    const fresh: RawFill[] = []
    const conflicts: CaptureConflict[] = []
    for (const f of extract.fills) {
      const filledOn = f.date ?? deps.today
      const k = dedupKey(f.side, f.ticker, f.shares, f.price, filledOn)
      const n = remaining.get(k) ?? 0
      if (n > 0) { remaining.set(k, n - 1); continue }
      const lk = looseKey(f.side, f.ticker, f.shares, filledOn)
      const base = { side: f.side, ticker: f.ticker, shares: f.shares, extractedPrice: canon(f.price), filledOn }
      const b = bookedMatch.get(lk)
      if (b) {
        conflicts.push({ ...base, bookedId: b.id, bookedPrice: canon(b.price), pendingId: null, pendingPrice: null })
        continue
      }
      const p = pendingMatch.get(lk)
      if (p) {
        conflicts.push({ ...base, bookedId: null, bookedPrice: null, pendingId: p.id, pendingPrice: canon(p.price) })
        continue
      }
      fresh.push(f)
    }
    if (fresh.length === 0 && conflicts.length === 0) return 'duplicate'
```

And adjust the tail of the locked block: after the `for (const f of fresh)` insert loop (which keeps building `pendingRows`), end with:

```ts
    if (fresh.length === 0) return { conflicts }
    if (conflicts.length > 0) return { pending: pendingRows, conflicts }
    return { pending: pendingRows }
```

(The `captureRepo.insert`/`setStatus` logic around the loop is unchanged; an all-conflict capture still records status `parsed`.)

- [ ] **Step 4: Add the three i18n keys** in `packages/telegram/src/i18n.ts`, directly after the `'duplicate-capture'` entry (L27):

```ts
  'capture-conflicts-head': { en: 'Conflicts — these were not booked:', ko: '충돌 — 아래 체결은 예약되지 않았습니다:' },
  'capture-conflict': { en: '⚠️ Conflict: {side} {shares} {ticker} on {date} — extracted ${extracted}, but booked fill #{id} has ${dupPrice}. Fix the booked fill or reject the row.', ko: '⚠️ 충돌: {date} {ticker} {side} {shares}주 — 추출 가격 ${extracted}, 예약된 체결 #{id} 가격 ${dupPrice}. 예약된 체결을 수정하거나 이 행을 거부하세요.' },
  'capture-conflict-pending': { en: '⚠️ Conflict: {side} {shares} {ticker} on {date} — extracted ${extracted}, but pending row #{id} has ${dupPrice}. Resolve that row first.', ko: '⚠️ 충돌: {date} {ticker} {side} {shares}주 — 추출 가격 ${extracted}, 대기 중 행 #{id} 가격 ${dupPrice}. 먼저 해당 행을 처리하세요.' },
```

- [ ] **Step 5: Handle conflicts in `capture.ts` `sendOutcome`.** Extend the booking import (L7):

```ts
import { confirmPendingFill, ingestCapture } from '../domain/booking';
import type { CaptureConflict, CaptureOutcome, RepoSurface } from '../domain/booking';
```

(change the existing `import type { RepoSurface }` line accordingly) and replace `sendOutcome` (L120-141) with:

```ts
  async function sendOutcome(chatId: string, outcome: CaptureOutcome): Promise<void> {
    if (outcome === 'duplicate') {
      await deps.send(chatId, t('duplicate-capture', lang));
      return;
    }
    if (outcome === 'rejected') {
      await deps.send(chatId, t('capture-bad-extract', lang, { detail: 'no fills recognized' }));
      return;
    }
    const pending = 'pending' in outcome ? outcome.pending : [];
    const conflicts = 'conflicts' in outcome ? outcome.conflicts : outcome === 'duplicate' || outcome === 'rejected' ? [] : outcome;
    if (pending.length > 0 && conflicts.length > 0) {
      await deps.send(chatId, t('capture-conflicts-head', lang));
    }
    for (const c of conflicts) await deps.send(chatId, conflictLine(c));
    for (const row of pending) {
      const text = t('capture-booked', lang, {
        ticker: row.ticker,
        side: row.side,
        shares: row.shares,
        price: row.price,
      });
      await deps.send(chatId, text, { reply_markup: buildPendingKeyboard(String(row.id)) });
    }
  }

  function conflictLine(c: CaptureConflict): string {
    const base = { ticker: c.ticker, side: c.side, shares: c.shares, date: c.filledOn, extracted: c.extractedPrice };
    if (c.pendingId != null) {
      return t('capture-conflict-pending', lang, { ...base, id: c.pendingId, dupPrice: c.pendingPrice ?? '' });
    }
    return t('capture-conflict', lang, { ...base, id: c.bookedId ?? 0, dupPrice: c.bookedPrice ?? '' });
  }
```

Note the `'conflicts' in outcome` branch resolves to the bare `CaptureConflict[]` variant (`{ pending, conflicts }` is checked first by key order in the ternary — if that reads confusingly when implementing, write a plain if/else chain on `in` checks instead; behavior is what the tests pin).

- [ ] **Step 6: Write the failing wire test** appended to the `describe('capture onPhoto — happy path books via the real booking module')` block in `apps/server/test/wire.test.ts` (`makeCapture` defaults `today` to `'2026-11-10'`, `visionFetch` extracts `buy NVDA 10 @ 180.50` with no date, `h.repos.fillRepo` and `h.sent` are exposed):

```ts
  test('re-detected fill matching a booked fill except price sends a conflict line and books nothing', async () => {
    const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
    await h.repos.fillRepo.insert({
      runId: 1, bucketIdx: 0, side: 'buy', ticker: 'NVDA', shares: 10,
      price: parseUsd('999.99'), fee: 0, filledOn: '2026-11-10', source: 'manual',
    } as never);
    await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
    expect(h.pending.length).toBe(0);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.text).toBe(
      '⚠️ Conflict: buy 10 NVDA on 2026-11-10 — extracted $180.50, but booked fill #1 has $999.99. Fix the booked fill or reject the row.',
    );
  });
```

- [ ] **Step 7: Run the server suites:**

```bash
bun test apps/server/test/booking.test.ts apps/server/test/wire.test.ts
```

Expected: ALL pass (new conflict tests + every pre-existing dedup/booking/wire test — exact duplicates must still yield `'duplicate'` and the exact `Duplicate capture — all fills already booked or pending.` message).

- [ ] **Step 8: Typecheck:** `bun run typecheck` → clean.

- [ ] **Step 9: Commit:**

```bash
git add apps/server/src/domain/booking.ts apps/server/src/wire/capture.ts packages/telegram/src/i18n.ts apps/server/test/booking.test.ts apps/server/test/wire.test.ts
git commit -m "fix: re-detected fills matching existing trades report conflicts instead of duplicating"
```

---

### Task 2: Trade date in the Telegram booking lines

**Files:**
- Modify: `packages/telegram/src/i18n.ts` (`'capture-booked'` L25, `'booked'` L26)
- Modify: `apps/server/src/wire/capture.ts` (local `PendingRow` type L10; `sendOutcome` capture-booked call site; post-confirm `booked` call site ~L160)
- Test: `apps/server/test/wire.test.ts` (update exact-line expectations at ~L233, 247, 317, 331, 364, 383-384, 395, 410, 432)
- Test: `scripts/e2e.ts` (verbatim assertion ~L151)

**Interfaces:**
- Consumes: `PendingFillRow.filledOn` (already on `booking.ts` rows); `pendingRepo.get()` rows already carry `filledOn` in both real and fake repos.
- Produces: `capture-booked` / `booked` lines with a `{date}` placeholder.

- [ ] **Step 1: Update the two i18n entries** to:

```ts
  'capture-booked': { en: 'Booked {ticker} {side} {shares} sh @ ${price} on {date} — confirm?', ko: '{ticker} {side} {shares}주 @ ${price} ({date}) 예약 — 확인하시겠습니까?' },
  'booked': { en: 'Booked {ticker} {side} {shares} sh @ ${price} on {date} into bucket {bucket}', ko: '{ticker} {side} {shares}주 @ ${price} ({date})을(를) 버킷 {bucket}에 예약했습니다' },
```

- [ ] **Step 2: Pass `date` at both call sites** in `apps/server/src/wire/capture.ts`:
  - In `sendOutcome`'s booked loop add `date: row.filledOn,` to the `t('capture-booked', ...)` params.
  - In `onConfirm`'s booked line add `date: row.filledOn` to the `t('booked', ...)` params.
  - Extend the local row type at L10 to `type PendingRow = { id: number; side: string; ticker: string; shares: number; price: bigint | string; bucketIdx: number | null; filledOn: string; status: string };`

- [ ] **Step 3: Update every exact-line expectation.** The wire capture fakes run with `today = '2026-11-10'` and the vision fixture fills have no date, so `filledOn` is always `2026-11-10` there:
  - `apps/server/test/wire.test.ts`: replace `Booked NVDA buy 10 sh @ $180.50 — confirm?` → `Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 — confirm?` (8 occurrences), `Booked AAPL buy 5 sh @ $210.25 — confirm?` → `Booked AAPL buy 5 sh @ $210.25 on 2026-11-10 — confirm?`, and `Booked NVDA buy 10 sh @ $180.50 into bucket 0` → `Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 into bucket 0`.
  - `scripts/e2e.ts`: `Booked NVDA buy 30 sh @ $179.50 — confirm?` → `Booked NVDA buy 30 sh @ $179.50 on 2026-11-09 — confirm?` (`TODAY` there is `2026-11-09`).
  - Sanity grep for stragglers: `grep -rn "sh @ \$" apps/server/test scripts packages/telegram/test` — every `Booked` line expectation must now carry ` on <date>`.

- [ ] **Step 4: Run:**

```bash
bun test apps/server/test/wire.test.ts && bun run typecheck
```

Expected: all green, typecheck clean.

- [ ] **Step 5: Commit:**

```bash
git add packages/telegram/src/i18n.ts apps/server/src/wire/capture.ts apps/server/test/wire.test.ts scripts/e2e.ts
git commit -m "feat: show detected trade date in Telegram booking lines"
```

---

### Task 3: DB integration test for the conflict path

**Files:**
- Modify: `apps/server/test/db.test.ts` (append inside the existing describe block that contains `test('ingestCapture dedups against real booked fills and pending rows')` ~L241, following its exact fixture style; the file self-skips without `TEST_DATABASE_URL`)

**Interfaces:**
- Consumes: real `repos` + `ingestCapture` conflict return (Task 1).

- [ ] **Step 1: Append the test** (this reproduces the real IMG_2109 scenario — booked sell with a price typo, re-sent screenshot):

```ts
  test('ingestCapture reports a conflict when a re-detected fill matches a booked fill except for price', async () => {
    const ticker = 'CF' + Date.now()
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: 'conflict-' + Date.now(), poolCents: 1_000_000, costPpm: 10 })
    // booked sell carrying a price typo, stored as bigint myriadths like every real fill
    await repos.fillRepo.insert({ runId, bucketIdx: 0, side: 'sell', ticker, shares: 44, price: parseUsd('66.03'), fee: 0, filledOn: '2026-11-11', source: 'manual' })

    const deps: BookingDeps = { repos, today: '2026-11-15' }
    const out = await ingestCapture(runId, { base64: 'CONFLICT-REAL-' + Date.now(), mime: 'image/png' },
      { ok: true, fills: [{ side: 'sell', ticker, shares: 44, price: '64.07', date: '2026-11-11' }] }, deps)

    const conflicts = (out as { conflicts: Array<Record<string, unknown>> }).conflicts
    expect(conflicts.length).toBe(1)
    expect(conflicts[0]!.extractedPrice).toBe('64.07')
    expect(conflicts[0]!.bookedPrice).toBe('66.03')
    expect(typeof conflicts[0]!.bookedId).toBe('number')
    expect(conflicts[0]!.pendingId).toBeNull()
    const left = (await repos.pendingRepo.listPending()).filter((p) => p.runId === runId)
    expect(left.length).toBe(0)
  })
```

- [ ] **Step 2: Run against the test DB:**

```bash
docker start st-mariadb-test 2>/dev/null || docker run -d --name st-mariadb-test -e MARIADB_ROOT_PASSWORD=test -e MARIADB_DATABASE=st_test -p 127.0.0.1:3307:3306 mariadb:11
TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db.test.ts
```

Expected: all pass, including the new conflict test (it must also pass with bigint-stored prices — `canon()` handles bigint).

- [ ] **Step 3: Commit:**

```bash
git add apps/server/test/db.test.ts
git commit -m "test: conflict path of ingestCapture against real repositories"
```

---

### Task 4: Pending table shows the detected trade date (`apps/web`)

**Files:**
- Modify: `apps/web/src/components/forms/PendingTable.tsx` (Trade date cell ~L100-108)
- Test: `apps/web/src/components/forms/PendingTable.test.tsx` (fixture `ROW` has `filledOn: '2026-11-10'`; `render(R)`, `stubFetch(...)` helpers exist)

**Interfaces:**
- Consumes: `isoDate` (already imported in PendingTable.tsx), `PendingFillDto.filledOn` (already on the wire), `pendingIssue` returns `{ field: 'filledOn' }` when `filledOn` is empty.
- Produces: date column renders `isoDate(r.filledOn)` (— when empty) above the existing override input, mirroring the qty/price cells.

- [ ] **Step 1: Write the failing tests** appended to `PendingTable.test.tsx` (follow the file's existing `render`/`stubFetch` usage):

```tsx
test("trade date column shows the detected date above the override input", () => {
  stubFetch("conflict");
  render(R);
  const cell = document.querySelectorAll("tbody tr td")[0]!;
  expect(cell.textContent).toContain("2026-11-10");
  const input = cell.querySelector("input[type=date]") as HTMLInputElement | null;
  expect(input).toBeTruthy();
  expect(input!.value).toBe("");
});

test("empty detected trade date renders an em dash and keeps the flagged override input", () => {
  stubFetch("conflict");
  render(R, { ...ROW, filledOn: "" });
  const cell = document.querySelectorAll("tbody tr td")[0]!;
  expect(cell.textContent).toContain("—");
  const input = cell.querySelector("input[type=date]") as HTMLInputElement | null;
  expect(input).toBeTruthy();
  expect(input!.className).toContain("border-warning");
});
```

(`ROW` is the fixture object; the invalid-date issue path is `pendingIssue` → `field: 'filledOn'` → `border-warning`, already wired via `bad('filledOn')`.)

- [ ] **Step 2: Run to verify they fail:** `bun test apps/web/src/components/forms/PendingTable.test.tsx` — the new tests fail (cell currently holds only the input).

- [ ] **Step 3: Implement** — replace the Trade date `<Td>` body in `PendingTable.tsx` (currently just the `<Input type="date">`) with:

```tsx
                  <Td className="whitespace-nowrap tabular-nums">
                    <div>{isoDate(r.filledOn)}</div>
                    <Input
                      type="date"
                      className={`mt-1 w-36 ${bad('filledOn')}`}
                      value={o.filledOn}
                      aria-label={t('pendingColDate')}
                      onChange={(e) => setOverride(r.id, 'filledOn', e.target.value)}
                    />
                  </Td>
```

(Same value-above/override-below layout as the qty and price cells.)

- [ ] **Step 4: Run:** `bun test apps/web && bun run typecheck` → green (all pre-existing PendingTable tests still pass; the confirm-button selectors etc. are unaffected).

- [ ] **Step 5: Commit:**

```bash
git add apps/web/src/components/forms/PendingTable.tsx apps/web/src/components/forms/PendingTable.test.tsx
git commit -m "fix: pending table shows the detected trade date under the override input"
```

---

### Task 5: Full verification gates

- [ ] **Step 1: Unit suite (no DB):** `bun test` → 0 fail (db.test.ts skip set unchanged).
- [ ] **Step 2: DB suite:** `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` → 0 fail, no new skips.
- [ ] **Step 3: Typecheck:** `bun run typecheck` → clean.
- [ ] **Step 4: Operator E2E (scratch DB, never touches st_test tables):**

```bash
TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts
```

Expected: all checks pass, notably `capture-booked message verbatim` against the new dated line and `same photo again -> duplicate-capture message`.
- [ ] **Step 5: If anything fails, fix forward and re-run the failed gate. Never mark work complete on partial output.**
- [ ] **Step 6: If all green, no commit needed (no file changes) — proceed to review/merge per the plan handoff.**

---

## Out of scope (per spec)

- ManualFill / confirmPendingFill / rebook / recompute / HTTP pending routes.
- Vision prompt or extraction changes (verified working against IMG_2109).
- Any production data repair (operator-only; prod DB must not be touched).
