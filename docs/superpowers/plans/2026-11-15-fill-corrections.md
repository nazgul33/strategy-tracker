# Fill Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Price-only capture conflicts against booked fills become correction proposals listed on the Pending page (Apply / Dismiss), and sell fills become editable everywhere.

**Architecture:** A new `fill_corrections` table holds proposals with a full snapshot of the target fill. `ingestCapture` records them (inside the existing run lock) via a new `capture-corrections.ts` module; dismissed proposals for the same fill + price are never re-proposed. Apply/dismiss live in a new `domain/corrections.ts` (run-locked, snapshot staleness check, `rebookFill` with reason `capture-correction`) behind new `/api/corrections` routes; the web gets a `CorrectionList` section above `PendingTable`. `rebookFill` stops rejecting sells.

**Tech Stack:** Bun + TypeScript, Hono, drizzle-orm (MariaDB), React (happy-dom + bun:test for web tests), Telegram copy in `packages/telegram/src/i18n.ts`.

**Spec:** `docs/superpowers/specs/2026-11-15-fill-corrections-design.md`

## Global Constraints

- Money: prices bigint myriadths, fees integer cents (`@st/core/money`) — never float.
- Schema change only via `apps/server/src/db/schema.ts` + `bun run --cwd apps/server db:generate`; additive (new table only), no change to existing tables.
- No source file > ~300 lines (`booking.ts` is 269 — new logic goes in new modules).
- `packages/*` never import `apps/*`.
- All user-facing copy via en/ko catalogs: `packages/telegram/src/i18n.ts`, `apps/web/src/i18n/{en,ko}.json`.
- English-only comments; commit style `feat|fix|docs|test|refactor|chore:`.
- Prod DB never touched. DB tests only against `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test`; e2e uses its own scratch DB.
- A correction never books a new fill; it only patches its target fill.
- Dismiss sticks: an `open` or `dismissed` correction for the same fill + proposed price blocks a new one; `applied` never blocks.

## Review Focus

1. Correction against a **buy** fill (buy price typo) applies like a sell one. → Task 4 test `apply: buy fill correction`.
2. Screenshot without a fee → Apply keeps the booked fee. → Task 4 test `apply: no proposed fee keeps booked fee`.
3. Two open corrections for the same fill at different prices → applying one makes the other stale (snapshot price differs). → Task 4 test `apply: sibling correction goes stale`.
4. Fee-only difference (same price) → exact match, no conflict, no correction. → Task 3 test `fee-only difference creates no correction`.
5. One screenshot conflicting with two different booked fills → two corrections. → Task 3 test `two conflicts create two corrections`.

---

### Task 1: Sell fills are editable

**Files:**
- Modify: `apps/server/src/domain/recompute.ts:33-79` (`rebookFill`)
- Test: `apps/server/test/rebooking.test.ts:240-254`, `apps/server/test/http.test.ts:912-925`
- Check: `apps/web/src/i18n/{en,ko}.json`, `apps/web/src/components/forms/FillDialog.tsx` comments

**Interfaces:**
- Produces: `rebookFill(runId: number, edit: RebookEdit, deps: BookingDeps, audit?: { reason: string; correctionId?: number }): Promise<{ fill: FillRow; deltaCents: number }>` — `audit` defaults to `{ reason: 'fill-edit' }`; the adjust row's `ref` JSON becomes `{ fillId, bookedOn, reason, correctionId? }` (key omitted when absent).

- [ ] **Step 1: Replace the sell-rejection test** in `rebooking.test.ts` (`editing a sell is rejected as immutable, state untouched`) with two tests, same fixture (buy 8 @ 16.00 into bucket 1, manual sell 8 @ 17.00 fee 0.30):
  - `editing a sell price and fee rebuilds closed history and books one adjust`: `rebookFill(runId, { fillId: sell.id, shares: 8, priceStr: '15.00', feeCents: 25 }, deps(f))` → stored sell price `parseUsd('15.00')`, fee 25; the closed record for bucket 1 carries `soldPrice === parseUsd('15.00')`; exactly 1 adjust row whose `ref` parses to `reason: 'fill-edit'`; `res.deltaCents === sellEffect('15.00', 8, 25) - sellEffect('17.00', 8, 30)` (write `sellEffect` next to the file's `buyEffect` helper: gross `roundDiv(price*shares,100)` minus fee).
  - `a sell qty above what the bucket holds is rejected, nothing persisted`: shares 9 → `DomainError` (kind whatever `applySellFill` throws — assert `toBeInstanceOf(DomainError)`), state JSON unchanged, 0 adjust rows, sell row unchanged.
- [ ] **Step 2: Flip the HTTP test** `PUT on a sell fill -> 422 immutable-field` into `PUT on a sell fill -> 200, price edited`: same setup, body `{ qty: 2, priceCents: 1100, feeCents: 0 }` → 200, `f.fills[1].price === 110000n`, cash `100200` (100000 − 2000 + 2200).
- [ ] **Step 3: Run** `bun test apps/server/test/rebooking.test.ts apps/server/test/http.test.ts` → the new tests FAIL with `immutable-field`.
- [ ] **Step 4: Implement:** delete the `if (match.side === 'sell') throw …` line; add the `audit` parameter as specified. Grep `apps/web/src` and `packages/telegram` copy for any text claiming sells cannot be edited (e.g. "Sell fills cannot be edited") and remove/adjust it in en+ko; `fillErr.immutable-field` ("Side, ticker and trade date cannot be changed.") stays.
- [ ] **Step 5: Run** `bun test && bun run typecheck` → 0 fail, clean.
- [ ] **Step 6: Commit** `feat: sell fills are editable` (recompute.ts, both test files, any copy files touched).

---

### Task 2: `fill_corrections` table and repository

**Files:**
- Create: `apps/server/src/domain/correction-types.ts`
- Modify: `apps/server/src/db/schema.ts` (new table), `apps/server/src/db/repos.ts` (new `correctionRepo`, exported in the returned repos object), `apps/server/src/domain/booking.ts:21-36` (`RepoSurface.correctionRepo`)
- Generated: `apps/server/db/migrations/0006_*.sql` + `meta/` (via `bun run --cwd apps/server db:generate`)
- Test fakes: every repo fake typecheck requires (at least `apps/server/test/booking.test.ts` `fakeRepos`, `wire.test.ts` `makeCaptureFakes`, `http.test.ts` `makeFakes`)
- Test: `apps/server/test/db.test.ts` (new repo test in the gated describe)

**Interfaces:**
- Produces (`correction-types.ts`):
```ts
export type CorrectionStatus = 'open' | 'applied' | 'dismissed'
export interface CorrectionRow {
  id: number; runId: number; fillId: number; captureId: number | null
  side: 'buy' | 'sell'; ticker: string; bookedShares: number; bookedFilledOn: ISODate
  bookedPrice: bigint; bookedFee: number; proposedPrice: bigint; proposedFee: number | null
  status: CorrectionStatus; createdAt: string
}
export type NewCorrection = Omit<CorrectionRow, 'id' | 'status' | 'createdAt'>
export interface CorrectionRepo {
  insert(c: NewCorrection): Promise<number>
  get(id: number): Promise<CorrectionRow | null>
  listOpen(): Promise<CorrectionRow[]>
  decide(id: number, status: 'applied' | 'dismissed'): Promise<boolean> // false unless it was 'open'
  findBlocking(fillId: number, proposedPrice: bigint): Promise<CorrectionRow | null> // open or dismissed only
  hasOpenForCapture(captureId: number): Promise<boolean>
}
```
- Table `fill_corrections` columns per spec (snake_case: `run_id, fill_id, capture_id, side, ticker, booked_shares, booked_filled_on, booked_price, booked_fee, proposed_price, proposed_fee, status, created_at`; `status` mysqlEnum `['open','applied','dismissed']` default `'open'`; prices `bigint mode 'bigint'`; dates `date mode 'string'`; `created_at` timestamp string defaultNow). Index on `(fill_id)`.
- `RepoSurface` gains `correctionRepo: CorrectionRepo`.

- [ ] **Step 1: Write the failing DB test** `correction repo: insert, findBlocking, decide, hasOpenForCapture` (gated describe): insert one (fillId 1000+Date-unique, proposedPrice `parseUsd('64.07')`, captureId unique) → `get` round-trips every field (bigints as bigint); `listOpen()` contains it; `findBlocking(fillId, parseUsd('64.07'))` returns it, `findBlocking(fillId, parseUsd('64.70'))` null; `hasOpenForCapture(captureId)` true; `decide(id,'dismissed')` true then `findBlocking` still returns it (status `'dismissed'`) and `hasOpenForCapture` false; second `decide(id,'applied')` false. Insert another, `decide(id2,'applied')` → `findBlocking` for its price null.
- [ ] **Step 2: Run** `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test apps/server/test/db.test.ts` → FAIL (no `correctionRepo`).
- [ ] **Step 3: Implement** schema table, `db:generate` (commit the generated SQL + meta), real repo, types, `RepoSurface` field, and in-memory fakes (array-backed, same semantics as the real repo) wherever typecheck requires. Expose the in-memory store on the booking/wire/http fakes (e.g. `_stores.corrections` / `corrections`) for later tasks.
- [ ] **Step 4: Run** the DB file again → PASS; then `bun test && bun run typecheck` → 0 fail, clean.
- [ ] **Step 5: Commit** `feat: fill_corrections table and repository`.

---

### Task 3: Captures record corrections

**Files:**
- Create: `apps/server/src/domain/capture-corrections.ts`
- Modify: `apps/server/src/domain/capture-dedup.ts` (conflict fields), `apps/server/src/domain/capture-claim.ts` (live rule), `apps/server/src/domain/booking.ts` (`ingestCapture` calls the recorder), `apps/server/src/wire/capture.ts` (`conflictLine`), `packages/telegram/src/i18n.ts`
- Test: `apps/server/test/booking.test.ts`, `apps/server/test/wire.test.ts`

**Interfaces:**
- Consumes: `CorrectionRepo` (Task 2).
- Produces: `CaptureConflict` gains `extractedFee: string | null` (canonical `formatUsd(parseUsd(fee))`, `null` when the raw fill has no fee) and `correction: { id: number; status: 'open' | 'dismissed' } | null` (matcher sets `null`; the recorder fills it for booked-fill conflicts).
- Produces (`capture-corrections.ts`): `recordCorrections(repos: { fillRepo: { listForRun(runId: number): Promise<FillRow-like[]> }; correctionRepo: CorrectionRepo }, runId: number, captureId: number, conflicts: CaptureConflict[]): Promise<CaptureConflict[]>` — for each conflict with `bookedId !== null`: `findBlocking(bookedId, parseUsd(extractedPrice))` → open ⇒ `correction = {id, status:'open'}`; dismissed ⇒ `{id, status:'dismissed'}`; none ⇒ insert snapshot from the booked fill row (side, ticker, shares, filledOn, price, fee) with `proposedPrice = parseUsd(extractedPrice)`, `proposedFee = extractedFee ? centsFromUsd(parseUsd(extractedFee)) : null`, `captureId` ⇒ `{id: new, status:'open'}`. Pending-row conflicts pass through with `correction: null`. Declare a local structural repo interface (same pattern as `capture-dedup.ts` / `capture-claim.ts`) — no import of `booking.ts` values.
- `claimCapture` live rule: live if a pending row has this `captureId` **or** `correctionRepo.hasOpenForCapture(existing.id)`.
- Telegram copy (exact):
  - `capture-conflict` en: `⚠️ Conflict: {side} {shares} {ticker} on {date} — extracted ${extracted}, booked fill #{id} has ${dupPrice}. Correction listed in Pending.`; ko: `⚠️ 충돌: {date} {ticker} {side} {shares}주 — 추출 가격 ${extracted}, 예약된 체결 #{id} 가격 ${dupPrice}. 수정 제안이 대기 목록에 추가되었습니다.`
  - new `capture-conflict-dismissed` en: `ℹ️ {side} {shares} {ticker} on {date} — extracted ${extracted}, booked fill #{id} has ${dupPrice}. You dismissed this correction before; not listed again.`; ko: `ℹ️ {date} {ticker} {side} {shares}주 — 추출 가격 ${extracted}, 예약된 체결 #{id} 가격 ${dupPrice}. 이전에 무시한 수정 제안이므로 다시 표시하지 않습니다.`
  - `conflictLine`: pending-row conflict → `capture-conflict-pending` (unchanged); booked with `correction.status === 'dismissed'` → `capture-conflict-dismissed`; otherwise `capture-conflict`.

- [ ] **Step 1: Update existing expectations** that `toEqual` a whole conflict (`booking.test.ts` CONF-1/CONF-2 tests) to include `extractedFee: null` and `correction` (`{ id: <the created correction id>, status: 'open' }` for the booked case, `null` for the pending case), and the wire verbatim conflict line to the new `capture-conflict` text.
- [ ] **Step 2: Write failing tests** in a new `describe('capture corrections', …)` in `booking.test.ts` (reuse the dedup describe's `setup/img/ext/trade/seedFill/seedPending` helpers — hoist or copy):
  - `booked-fill conflict creates one open correction with a full snapshot`: seedFill sell 44 @ '66.03' 2026-11-11 (fee 0 per helper); ext sell 44 '64.07' fee '2.03' date 2026-11-11 → store has 1 correction: `{ fillId, side:'sell', ticker:'SOXL', bookedShares:44, bookedFilledOn:'2026-11-11', bookedPrice: parseUsd('66.03'), bookedFee: 0, proposedPrice: parseUsd('64.07'), proposedFee: 203, captureId: <capture id>, status:'open' }`; `out.conflicts[0].correction` = `{ id, status:'open' }`; `out.conflicts[0].extractedFee === '2.03'`.
  - `a second screenshot with the same conflict reuses the open correction`: different image, same ext → still 1 correction; returned `correction.id` equal.
  - `dismissed correction is never re-proposed for the same price`: create, `correctionRepo.decide(id,'dismissed')`, new image same ext → 1 correction total, `correction: { id, status:'dismissed' }`.
  - `a different price after dismiss creates a new correction`: as above then ext price '64.70' → 2 corrections, the new one open.
  - `an applied correction does not suppress a new one`: create, `decide(id,'applied')`, new image same ext → 2 corrections.
  - `pending-row conflict creates no correction`: seedPending buy 78 '58.32' 2026-11-13, ext '58.99' → 0 corrections, `correction: null`.
  - `fee-only difference creates no correction` (Review Focus 4): seedFill sell 44 '64.07' fee 0; ext same price with fee '2.03' → `'duplicate'`, 0 corrections.
  - `two conflicts create two corrections` (Review Focus 5): seedFill sell 44 '66.03' 11-11 and buy 88 '56.60' 11-10; ext sell 44 '64.07' 11-11 + buy 88 '56.06' 11-10 → 2 open corrections with the right fillIds.
  - `same image re-sent while its correction is open is a duplicate; after dismiss it is re-read`: image X → correction open; X again → `'duplicate'`; dismiss; X again → `{ conflicts }` with `correction.status === 'dismissed'`, still 1 correction.
- [ ] **Step 3: Write failing wire test** `dismissed correction conflict uses the dismissed line`: fakes with a booked fill + a dismissed correction for (fill, extracted price) → the sent text equals the `capture-conflict-dismissed` en string with values filled.
- [ ] **Step 4: Run** `bun test apps/server/test/booking.test.ts apps/server/test/wire.test.ts` → new/updated tests FAIL.
- [ ] **Step 5: Implement** per Interfaces; `ingestCapture` calls `recordCorrections` right after `matchCapturedFills` (same lock span) and returns the recorded conflicts. Keep `booking.ts` ≤ 300 lines.
- [ ] **Step 6: Run** `bun test && bun run typecheck` → 0 fail, clean.
- [ ] **Step 7: Commit** `feat: capture conflicts against booked fills record correction proposals`.

---

### Task 4: Apply / dismiss / list — domain and HTTP

**Files:**
- Create: `apps/server/src/domain/corrections.ts`, `apps/server/src/http/routes/corrections.ts`
- Modify: `apps/server/src/http/app.ts` (mount `correctionsRouter(deps)` under `/api`)
- Test: create `apps/server/test/corrections.test.ts` (domain, using `fakeRepos` from `booking.test.ts`), extend `apps/server/test/http.test.ts`

**Interfaces:**
- Consumes: `CorrectionRepo`, `CorrectionRow` (Task 2); `rebookFill(..., audit)` (Task 1); `withRunLock`.
- Produces (`corrections.ts`):
  - `export interface CorrectionView extends CorrectionRow { stale: boolean }`
  - `listOpenCorrections(deps: BookingDeps): Promise<CorrectionView[]>` — `stale` = target fill missing from `fillRepo.listForRun(runId)` or any of side/ticker/shares/filledOn/price/fee ≠ snapshot.
  - `applyCorrection(id: number, deps: BookingDeps): Promise<{ deltaCents: number }>` — algorithm per spec "Apply / Dismiss" (whole body in `withRunLock(row.runId, …)`): unknown id → `DomainError('correction-not-found')`; not open → `'correction-not-open'`; stale → `'correction-stale'`; then `rebookFill(runId, { fillId, shares: fill.shares, priceStr: formatUsd(proposedPrice), feeCents: proposedFee ?? fill.fee, filledOn: fill.filledOn }, deps, { reason: 'capture-correction', correctionId: id })`; then `decide(id,'applied')`.
  - `dismissCorrection(id: number, deps: BookingDeps): Promise<void>` — under the run lock; unknown → `'correction-not-found'`; `decide(id,'dismissed') === false` → `'correction-not-open'`.
- HTTP (`correctionsRouter(deps: HttpDeps): Hono`):
  - `GET /corrections` → 200 `jsonBig(await listOpenCorrections(...))` (bigints → decimal strings).
  - `POST /corrections/:id/apply` → 200 `{ ok: true, deltaCents }`; `correction-not-found` → 404 `{error}`; `correction-not-open` / `correction-stale` → 409 `{error}`; other `DomainError` → 422 `{error: kind}`.
  - `POST /corrections/:id/dismiss` → 200 `{ ok: true }`; 404 / 409 as above.

- [ ] **Step 1: Write failing domain tests** in `corrections.test.ts` (seed a run with a buy 44 @ '60.00' into bucket 0 then a manual sell 44 @ '66.03' fee '2.03' on 2026-11-11, then insert a correction via `f.repos.correctionRepo.insert` with the sell's snapshot and `proposedPrice: parseUsd('64.07'), proposedFee: 203`):
  - `apply: patches only the target sell` → fills count unchanged; sell price `parseUsd('64.07')`, fee 203; correction status `'applied'`; exactly one adjust row with `ref` `reason:'capture-correction'` and `correctionId`; `deltaCents` equals the cash change (−(66.03−64.07)×44 in cents = −8624).
  - `apply twice → correction-not-open` (second call throws, fill unchanged after first).
  - `concurrent applies rebook once`: `Promise.allSettled([apply(id), apply(id)])` → one fulfilled, one rejected `correction-not-open`; 1 adjust row.
  - `apply: stale after hand edit` → `rebookFill` the sell to shares 44 price '65.00' first → apply throws `correction-stale`, status stays `'open'`.
  - `apply: stale after delete` → `deleteFill` the sell → `correction-stale`; `listOpenCorrections` returns it with `stale: true`.
  - `apply: sibling correction goes stale` (Review Focus 3): second correction same fill proposed '64.70'; apply the first → `listOpenCorrections` shows the second `stale: true` and applying it throws `correction-stale`.
  - `apply: no proposed fee keeps booked fee` (Review Focus 2): `proposedFee: null` → fee stays 203.
  - `apply: buy fill correction` (Review Focus 1): correction targeting the buy, proposed '59.50' → buy price patched, state rebuilt.
  - `dismiss: leaves the fill untouched` → status `'dismissed'`, fill identical, no adjust; second dismiss → `correction-not-open`; unknown id → `correction-not-found`.
- [ ] **Step 2: Write failing HTTP tests** in `http.test.ts` (extend `makeFakes` only as needed): GET lists an open correction with prices as strings and `stale:false`; apply → 200 `{ok:true, deltaCents}`; apply again → 409 `{error:'correction-not-open'}`; unknown id → 404 `{error:'correction-not-found'}`; dismiss → 200, second → 409.
- [ ] **Step 3: Run** `bun test apps/server/test/corrections.test.ts apps/server/test/http.test.ts` → FAIL.
- [ ] **Step 4: Implement** per Interfaces.
- [ ] **Step 5: Run** `bun test && bun run typecheck` → 0 fail, clean.
- [ ] **Step 6: Commit** `feat: apply and dismiss fill corrections`.

---

### Task 5: Web — Corrections section

**Files:**
- Create: `apps/web/src/components/forms/CorrectionList.tsx`, `apps/web/src/components/forms/CorrectionList.test.tsx`
- Modify: `apps/web/src/api.ts` (methods + `ApiErrorCode` += `'correction-not-found' | 'correction-not-open' | 'correction-stale'`), `apps/web/src/api.types.ts` (`CorrectionDto`), `apps/web/src/pages/Pending.tsx`, `apps/web/src/pages/RunDetail.tsx` (pending tab), `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`

**Interfaces:**
- Consumes: HTTP routes from Task 4.
- Produces:
  - `CorrectionDto { id: number; runId: number; fillId: number; captureId: number | null; side: string; ticker: string; bookedShares: number; bookedFilledOn: string; bookedPrice: string /* myriadths */; bookedFee: number /* cents */; proposedPrice: string; proposedFee: number | null; status: string; stale: boolean; createdAt: string }`
  - `api.listCorrections(): Promise<CorrectionDto[]>`, `api.applyCorrection(id: number): Promise<void>`, `api.dismissCorrection(id: number): Promise<void>` (POSTs to `/api/corrections/:id/apply|dismiss`).
  - `CorrectionList({ runId?: number; onChanged?: () => void })` — renders nothing when the (run-filtered) list is empty; otherwise a titled table, one row per correction: `Fill #{fillId}`, ticker, side, `bookedShares`, `bookedFilledOn`, price `bookedPrice → proposedPrice` (via existing `priceUsd`), fee cell shows `→ new` only when `proposedFee !== null && proposedFee !== bookedFee`; Apply (hidden when `stale`) + Dismiss; stale rows show the stale note. After a successful apply/dismiss: reload the list and call `onChanged`. 409 `correction-stale` → show stale note and reload; 409 `correction-not-open` → show `pendingAlreadyHandled`-style note and reload.
- Copy keys (en / ko): `correctionsTitle` "Corrections (from screenshots)" / "수정 제안 (스크린샷)"; `correctionFill` "Fill #{id}" / "체결 #{id}"; `correctionApply` "Apply" / "적용"; `correctionDismiss` "Dismiss" / "무시"; `correctionStale` "This fill changed since the screenshot — dismiss this correction." / "스크린샷 이후 체결이 변경되었습니다 — 이 수정 제안을 무시하세요."; `correctionAlreadyHandled` "Already handled" / "이미 처리됨". Column headers reuse existing `pendingCol*` keys where they fit.
- Placement: `Pending.tsx` renders `<CorrectionList />` above the existing card's `PendingTable` (own `Card`, hidden when empty); RunDetail's `pending` tab renders `<CorrectionList runId={id} onChanged={() => { setPanelKey((k) => k + 1); void reload(); }} />` above `PendingTable`.

- [ ] **Step 1: Write failing tests** in `CorrectionList.test.tsx` (mirror `PendingTable.test.tsx`'s happy-dom + `installFetchStub` setup):
  - `renders nothing when there are no corrections`.
  - `shows booked → proposed price and fee change` (bookedPrice '660300', proposedPrice '640700', bookedFee 0, proposedFee 203 → row text contains `$66.03`, `$64.07`, and a fee arrow).
  - `apply posts and reloads, calling onChanged` (POST `/api/corrections/1/apply` 200 → GET count 2, onChanged called once).
  - `stale row hides Apply and shows the stale note`.
  - `409 correction-stale on apply shows the stale note`.
  - `runId filter hides other runs' corrections`.
- [ ] **Step 2: Run** `bun test apps/web/src/components/forms/CorrectionList.test.tsx` → FAIL.
- [ ] **Step 3: Implement** per Interfaces (follow `PendingTable.tsx` patterns: `useAsync`, `Button`, `TableWrap`, `Td`, `Th`, `useT`).
- [ ] **Step 4: Run** `bun test && bun run typecheck` → 0 fail, clean.
- [ ] **Step 5: Commit** `feat: corrections section on the Pending page and run pending tab`.

---

### Task 6: DB integration, docs, full gates

**Files:**
- Test: `apps/server/test/db.test.ts` (new test in the gated describe)
- Modify: `AGENTS.md` repo map (new files: `domain/correction-types.ts`, `domain/capture-corrections.ts`, `domain/corrections.ts`, `http/routes/corrections.ts` in the routes brace list, `test/corrections.test.ts`)

**Interfaces:**
- Consumes: everything above, real repos.

- [ ] **Step 1: Write the IMG_2109 integration test** `capture conflict becomes a correction that fixes the booked sell` (ticker `'FC' + Date.now()`): real run; `manualFill` buy 88 @ '56.06' 2026-11-10, sell 44 @ '66.03' fee '2.03' 2026-11-11, sell 44 @ '65.53' fee '2.07' 2026-11-12; `ingestCapture` image `'FC-REAL-' + Date.now()` with the four screenshot trades (buy 88 '56.06' fee '3.45' 11-10; sell 44 '64.07' fee '2.03' 11-11; sell 44 '65.53' fee '2.07' 11-12; buy 78 '58.32' fee '3.18' 11-13) → 1 pending (buy 78) + 1 conflict with `correction.status 'open'`; `listOpenCorrections` has it, `stale:false`; `applyCorrection` → the 11-11 sell row's price is `parseUsd('64.07')` (bigint from the real DB), fills count unchanged, correction status `'applied'`. Then reject the buy-78 pending row and send the same image again: the capture is no longer live (its correction is applied, its pending row rejected), so it is re-read; the three booked trades now match exactly, so assert `out.pending.length === 1` (buy 78 again) and `out.conflicts` is undefined.
- [ ] **Step 2: Run** `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` → 0 fail, no skips.
- [ ] **Step 3: Run** `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts` → `e2e OK` (migrations incl. the new table apply on the scratch DB).
- [ ] **Step 4: Run** `bun test && bun run typecheck` → 0 fail, clean.
- [ ] **Step 5: Update AGENTS.md** repo map lines as listed.
- [ ] **Step 6: Commit** `test: fill corrections against real repositories` (db.test.ts + AGENTS.md; use `docs:` wording only if AGENTS.md is committed separately).

---

## Out of scope (per spec)

- Telegram Apply/Dismiss buttons; corrections for pending-row conflicts; qty/date/side corrections.
- Moving the manual `PUT` fill-edit path under the run lock (issue #22).
- Changing the `PUT /runs/:id/fills/:fillId` body (`priceCents`).
- Any production data change (operator edits fill #2 or re-sends a screenshot after deploy).
