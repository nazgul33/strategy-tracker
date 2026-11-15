# Fill Corrections Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the fill-corrections review leftovers on `feat/fill-corrections` before merge.

**Architecture:** Small, independent fixes: a `fill-gone` correction marker with its own Telegram line; fake-repo fidelity plus test hardening on the server; three web fixes (readable 422s, Pending page sections, no double load); DB-test tightening and final gates.

**Tech Stack:** Bun + TypeScript, Hono, drizzle (MariaDB), React + happy-dom (bun:test), Telegram copy in `packages/telegram/src/i18n.ts`.

**Spec:** `docs/superpowers/specs/2026-11-15-fill-corrections-followups-design.md` (parent: `2026-11-15-fill-corrections-design.md`)

## Global Constraints

- Money: bigint myriadths prices, integer-cent fees — never float.
- No source file > ~300 lines; `packages/*` never import `apps/*`; all copy via en/ko catalogs; English-only comments; commit style `feat|fix|docs|test|refactor|chore:`.
- No migrations. Prod DB never touched; DB tests only on `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test`.
- Behaviour unchanged except items 1–3 of the spec.

## Review Focus

1. A conflict citing a fill that vanished must never claim "listed in Pending". → Task 1 tests.
2. Apply refused with an unknown 422 code still shows something (raw code fallback). → Task 3 test `unknown 422 code falls back to the raw code`.
3. Fake now returns copies — no existing test may have relied on live objects. → Task 2 Step 4 full run.
4. Pending page still renders both sections when Corrections is empty (only Unconfirmed fills visible, titled). → Task 3 test.
5. RunDetail still refreshes cash/fills after Apply after removing the double load. → Task 3 test or check.

---

### Task 1: `fill-gone` conflicts

**Files:**
- Modify: `apps/server/src/domain/capture-dedup.ts` (`CaptureConflict.correction` type), `apps/server/src/domain/capture-corrections.ts` (missing-fill branch), `apps/server/src/wire/capture.ts` (`conflictLine`), `packages/telegram/src/i18n.ts`
- Test: `apps/server/test/booking.test.ts` (`describe('capture corrections', …)`), `apps/server/test/wire.test.ts`

**Interfaces:**
- `CaptureConflict.correction` becomes `{ id: number; status: 'open' | 'dismissed' } | { id: null; status: 'fill-gone' } | null`.
- `recordCorrections`: a booked-fill conflict whose fill is absent from `fillRepo.listForRun(runId)` → `correction: { id: null, status: 'fill-gone' }`, no insert. Pending-row conflicts stay `null`.
- New copy key `capture-conflict-gone`, exact text:
  - en: `⚠️ {side} {shares} {ticker} on {date} — extracted ${extracted}, but booked fill #{id} no longer exists. Nothing to correct.`
  - ko: `⚠️ {date} {ticker} {side} {shares}주 — 추출 가격 ${extracted}, 예약된 체결 #{id}이(가) 더 이상 없습니다. 수정할 항목이 없습니다.`
- `conflictLine`: `correction?.status === 'fill-gone'` → `capture-conflict-gone` with `id: c.bookedId`.

- [ ] **Step 1: Failing tests.** booking.test `a conflict whose booked fill vanished reports fill-gone and records nothing`: seedFill sell 44 '66.03' 11-11; wrap `f.repos.fillRepo.listForRun` so the first call returns the real list and later calls return `[]`; ext sell 44 '64.07' 11-11 → `out.conflicts[0].correction` toEqual `{ id: null, status: 'fill-gone' }`, `_stores.corrections.length === 0`. wire.test `gone fill uses the gone line`: same trick on the wire fakes → sent text equals the en `capture-conflict-gone` string with values filled.
- [ ] **Step 2: Run** `bun test apps/server/test/booking.test.ts apps/server/test/wire.test.ts` → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `bun test && bun run typecheck` → 0 fail, clean.
- [ ] **Step 5: Commit** `fix: capture conflicts on a vanished fill say so instead of claiming a correction`.

---

### Task 2: Fake fidelity and server test hardening

**Files:**
- Modify: `apps/server/test/fake-corrections.ts`, `apps/server/test/rebooking.test.ts`, `apps/server/test/http.test.ts`, `apps/server/test/booking.test.ts`, `apps/server/test/corrections.test.ts`, `apps/server/src/http/routes/corrections.ts`, `apps/server/src/domain/capture-claim.ts` (comment wrap), `apps/server/src/domain/booking.ts` (`ingestCapture` destructuring)
- Create: `apps/server/test/http-corrections.test.ts`, `apps/server/test/fake-corrections.test.ts`

**Interfaces:**
- Fake: every read (`get`, `listOpen`, `listBlocking`) returns shallow copies; `insert` stores `captureId ?? null`, `proposedFee ?? null`.
- `http.test.ts` exports the helpers the new file needs (`makeFakes`, `makeDeps`, login/run/fill helpers — whatever the existing correction tests use) instead of duplicating them; the `describe('http corrections', …)` block moves verbatim into `http-corrections.test.ts`.

- [ ] **Step 1: Fake parity test** `fake-corrections.test.ts` (no DB): run the same scenario as `db.test.ts`'s correction-repo test against `fakeCorrectionRepo()` (insert/get round-trip, listOpen, listBlocking open/dismissed/applied filtering and id order, hasOpenForCapture, decide only-from-open), plus `a fetched row is not changed by a later decide` and `omitted captureId/proposedFee read back as null`. Run → the two new cases FAIL.
- [ ] **Step 2: Implement** the fake changes; run the file → PASS.
- [ ] **Step 3: Test hardening** (each must be green after; note any that fails and why):
  - rebooking.test over-qty sell test: add `expect(err.kind).not.toBe('immutable-field')`.
  - http.test `PUT on a sell fill -> 200, price edited`: also assert the response `deltaCents === 200` and exactly one ledger row with `kind 'adjust'` (via the fakes' ledger store).
  - http-corrections: `apply refused by replay -> 422` (arrange a correction whose apply makes `rebookFill` throw a non-correction `DomainError`, e.g. stub the fake fill store so replay rejects, or a proposed change that makes replay invalid — implementer's choice, must hit the 422 branch) → 422 `{ error: <kind> }`.
  - booking.test `capture corrections`: `a fresh open correction wins over a fresh dismissed one` — insert two corrections for the same fill + price with matching snapshots, first `dismissed`, second `open` (via fake insert + decide) → a new screenshot reuses the open one (`correction.status === 'open'`, its id), no insert.
  - corrections.test concurrent-apply test: unchanged code, but confirm it still passes with copy-returning fakes (it now genuinely needs the in-lock re-read); add a one-line comment saying so.
- [ ] **Step 4: Move** the corrections HTTP tests to `http-corrections.test.ts`; type `bookingDeps` in `routes/corrections.ts` as `BookingDeps` without `as any` if `HttpDeps.repos` is assignable (if not, keep the cast and note why in the report); rewrap the long comment in `capture-claim.ts`; in `ingestCapture` destructure `fresh` and `conflicts` the same way.
- [ ] **Step 5: Run** `bun test && bun run typecheck` → 0 fail, clean (test count unchanged except the added tests).
- [ ] **Step 6: Commit** `test: correction fake fidelity and server test hardening` (one commit; `refactor:` parts included).

---

### Task 3: Web fixes

**Files:**
- Modify: `apps/web/src/components/forms/CorrectionList.tsx`, `apps/web/src/components/forms/CorrectionList.test.tsx`, `apps/web/src/pages/Pending.tsx`, `apps/web/src/pages/RunDetail.tsx`, `apps/web/src/i18n/{en,ko}.json`
- Test: create `apps/web/src/pages/Pending.test.tsx` (mirror the happy-dom + fetchStub setup)

**Interfaces / copy:**
- `CorrectionList` action error for a non-409 `ApiError`: `t('fillErr.' + code)`, falling back to the raw code when the key is missing (same rule as `FillDialog.showFailure`).
- New key `pendingPageTitle`: en `Pending`, ko `확인 대기`. Pending page: `<h1>{t('pendingPageTitle')}</h1>`, then `<CorrectionList framed />`, then a `Card` whose first child is the section heading `t('pendingTitle')` rendered with the existing `ui.tsx` section-title component (the `<h2>` helper at `ui.tsx:14`), then `<PendingTable />`. `CorrectionList`'s own heading already uses `correctionsTitle`.
- RunDetail: exactly one corrections GET after a successful action, and cash/fills still refresh (drop the `key` remount on `CorrectionList` and keep `onChanged`, or skip the internal reload when `onChanged` is given — builder's call).

- [ ] **Step 1: Failing tests:**
  - CorrectionList `422 apply shows the localized fill error`: POST apply → 422 `{ error: 'invalid-fill' }` → text contains `Fill does not match this bucket — delete it and re-enter.`
  - CorrectionList `unknown 422 code falls back to the raw code` (Review Focus 2): `{ error: 'weird-kind' }` → text contains `weird-kind`.
  - Pending.test `page title is Pending and Unconfirmed fills is a section heading`: GET corrections `[]`, GET pending `[]` → `h1` text `Pending`; an `h2` with `Unconfirmed fills`; no corrections section (Review Focus 4).
  - Pending.test `with corrections, both section headings render`: one correction → headings `Corrections (from screenshots)` and `Unconfirmed fills` both present.
- [ ] **Step 2: Run** the two test files → FAIL.
- [ ] **Step 3: Implement.** For the RunDetail change, verify by reading/test that after `onChanged` the run reloads (Review Focus 5) and the corrections GET count per action is 1 (add a CorrectionList test with `onChanged` given asserting a single GET after apply if you change the reload behaviour inside the component).
- [ ] **Step 4: Run** `bun test && bun run typecheck` → 0 fail, clean.
- [ ] **Step 5: Commit** `fix: readable correction errors, Pending page sections, single reload`.

---

### Task 4: DB test tightening, docs, gates

**Files:**
- Modify: `apps/server/test/db.test.ts` (IMG_2109 corrections test), `docs/superpowers/specs/2026-11-15-fill-corrections-design.md` (rewrap the long "Dismiss sticks" line)

- [ ] **Step 1:** In `capture conflict becomes a correction that fixes the booked sell`: `expect(sell1111).toBeDefined()` before reading its price; after apply assert the 11-10 buy still has `parseUsd('56.06')` and the 11-12 sell `parseUsd('65.53')`; on the re-send assert the pending row's `side === 'buy'`.
- [ ] **Step 2: Run** `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` → 0 fail, no skips.
- [ ] **Step 3: Run** `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts` → `e2e OK`.
- [ ] **Step 4: Run** `bun test && bun run typecheck` → 0 fail, clean.
- [ ] **Step 5:** Rewrap the spec line; commit `test: tighten fill corrections DB test` (+ the spec rewrap in the same commit as `docs` content is trivial).
