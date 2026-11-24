# Sell Attribution by Order Type and Refusing Future-Dated Fills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A captured sell is attributed by the order type on the broker screenshot, never silently among several possible buckets, and no fill dated after today can be booked (#74, #96).

**Architecture:** The extractor passes three raw order columns through to new nullable `pending_fills` columns. A pure classifier maps the 주문구분 text to a type, and a pure matcher (`attributeSell`) replaces the old rung ladder; the booking is the only place that decides, and the same matcher runs as a dry run to tell Telegram and the web when the operator must choose. The future-date refusal is a `DomainError` at the three places that book or re-date a fill.

**Tech Stack:** Bun + TypeScript monorepo, Hono, Drizzle on MariaDB, React + Vite, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-23-order-type-attribution-and-future-dated-fills-design.md`. Read it before any task. Section numbers below ("spec §4") refer to it.

**Execution (operator's model assignment):** implementer subagents run on `anthropic/claude-sonnet-5-5`; per-task planning and review subagents on `anthropic/claude-opus-5-5`; the final whole-branch review on `anthropic/claude-fable-5-2`. Work happens in the worktree `/Users/nazgul33/.local/share/opencode/worktree/c34a7d/fix-issues-74-96` on branch `fix/issues-74-96`.

## Global Constraints

- Respond and write in English only. Korean is allowed only in UX string resources and in broker text used as test data. Never Chinese or Cyrillic characters.
- No source file over about 300 lines. Files already close: `apps/server/src/wire/capture.ts` (299), `apps/web/src/components/forms/FillDialog.tsx` (297), `apps/web/src/api.types.ts` (297), `apps/web/src/pages/RunDetail.tsx` (293), `apps/server/src/http/routes/runs.ts` (279), `apps/web/src/components/forms/PendingTable.tsx` (265).
- `packages/*` never import `apps/*`.
- Money is bigint myriadths via `@st/core/money`; never float.
- All user-facing copy goes in the en/ko catalogs (`packages/telegram/src/i18n.ts`, `apps/web/src/i18n/en.json` and `ko.json`). The plan fixes the English text; write the Korean in the register of the neighbouring keys.
- `fetch` stays injectable.
- `bun test` passes with and without `TEST_DATABASE_URL`. DB suite: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test`.
- Commit style: `feat|fix|docs|test|refactor|chore:`.
- Match the surrounding comment density. No new comment unless the behaviour is not obvious from the code.
- "Today" is always `deps.today` (the server's New York date). Dates are ISO `YYYY-MM-DD` strings compared as strings.
- A test that pinned the old ladder is rewritten to the new rule or deleted with the rule it tested. Never weaken an assertion to make it pass.

## Review Focus

1. **The operator edits side, quantity or price on a pending row before confirming.** The order columns read from the screenshot still apply to a sell, and are ignored when the row is confirmed as a buy. Test in Task 4.
2. **A pending row captured before this change** (all three order columns null, or `detectedAt` null). It must list, dry-run and confirm through the unknown-type rule without an error. Test in Task 6.
3. **Vision returns junk in the order columns** (a 40-character type, a non-numeric price, 0 shares, or `0.0000` as a target's order price). The fill still books; the junk is dropped or the step is skipped. Tests in Tasks 1 and 3.
4. **The dry run is out of date.** A row that showed Yes/No in Telegram needs a choice by the time Yes is pressed. The operator gets a worded reply pointing to the web view and the row stays pending with nothing written. Test in Task 6.
5. **The operator's browser date is a day ahead of New York.** A manual fill keeps the default date and must not be refused; a typed date after New York's today gets a worded error, not a generic failure. Tests in Task 8.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/ingest/src/extract.ts`, `prompt.ts` | carry `orderType`, `orderPrice`, `orderedShares` on `RawFill` |
| `apps/server/src/db/schema.ts`, `db/migrations/0012_*.sql` | three nullable `pending_fills` columns |
| `apps/server/src/domain/order-type.ts` (new) | `classifyOrderType`, `OrderEvidence`, `evidenceOf`, `kindOfType` |
| `apps/server/src/domain/sell-attribute.ts` (new) | `attributeSell`, `sellNeedsChoice` (spec §4) |
| `apps/server/src/domain/sell-match.ts` | keeps legs, `matchForcedLeg`, shared types; loses the old ladder |
| `apps/server/src/domain/pending-flags.ts` (new) | dry-run "needs bucket" for a set of pending rows of one run |
| `apps/server/src/domain/booking.ts`, `confirm-pending.ts`, `recompute.ts` | call the matcher with evidence; future-date refusal |
| `apps/server/src/wire/capture-pending-message.ts` (new) | the Telegram text and buttons for one new pending row |
| `apps/server/src/http/routes/pending.ts`, `runs.ts` | DTO fields, seed check, `today` |
| `apps/web/src/pendingchoice.ts` (new) | pure helpers for the pending row: date after today, bucket required, order line |
| `apps/web/src/components/forms/PendingRow.tsx`, `PendingTable.tsx`, `BucketSelect.tsx`, `FillDialog.tsx`, `CreateRunForm.tsx` | surface the above |
| `scripts/e2e-order-type.ts` (new) | operator smoke for both issues |

---

### Task 1: The extractor carries the order columns

**Files:**
- Modify: `packages/ingest/src/extract.ts`, `packages/ingest/src/prompt.ts`
- Test: `packages/ingest/test/extract-order.test.ts` (new; `extract.test.ts` is at 210 lines)

**Interfaces:**
- Produces: `RawFill` gains `orderType?: string; orderPrice?: string; orderedShares?: number`. A key is present only when its value passed the test in spec §1; otherwise the key is absent (existing `toEqual` assertions on fills must keep passing).

- [ ] **Step 1: Write the failing tests** in `extract-order.test.ts`, reusing the `fakeFetch` / `okJson` / `CFG` pattern of `extract.test.ts`. Each test feeds one vision response and asserts `r.fills` with `toEqual`:

| Test name | Vision `fills` entry | Expected `RawFill` |
| --- | --- | --- |
| `a filled stop-market row (IMG_2141)` | `{"side":"매도","ticker":"SOXL","shares":"1","price":"43.2500","date":"2026-11-23","orderType":"매도/STOP(시장가)","orderPrice":"0.0000","orderedShares":"1"}` | `{ side:'sell', ticker:'SOXL', shares:1, price:'43.2500', date:'2026-11-23', orderType:'매도/STOP(시장가)', orderPrice:'0.0000', orderedShares:1 }` |
| `a filled limit sell (IMG_2112)` | `…"shares":"44","price":"64.0700","orderType":"매도/보통(지정가)","orderPrice":"64.0700","orderedShares":"44"` | `orderType:'매도/보통(지정가)', orderPrice:'64.0700', orderedShares:44` |
| `an amended sell (IMG_2103)` | `…"shares":"270","price":"65.5300","orderType":"정정(매도)","orderPrice":"65.0000","orderedShares":"270"` | `orderType:'정정(매도)', orderPrice:'65.0000', orderedShares:270` |
| `a date-range row has no order keys` | no order keys | the object has none of the three keys |
| `thousands separators` | `"orderPrice":"1,234.5000","orderedShares":"1,268"` | `orderPrice:'1234.5000', orderedShares:1268` |
| `a numeric order price and count` | `"orderPrice":64.07,"orderedShares":44` | `orderPrice:'64.07', orderedShares:44` |
| `junk order values are dropped, the fill stays` | `"orderType":"<40 x's>","orderPrice":"abc","orderedShares":"0"` and a second fill with `"orderType":"  ","orderPrice":"-1","orderedShares":"1.5"` | both fills returned, neither has any of the three keys |
| `the order type is trimmed` | `"orderType":"  매도/LOC  "` | `orderType:'매도/LOC'` |
| `a date after today is kept` (with `today: '2026-11-12'` in the config) | `"date":"2026-11-20"` | `date:'2026-11-20'` (spec §6 relies on this existing behaviour; only the 45-day rule drops a date) |

Plus `the prompt asks for the order columns`: `MPOP_FILL_EXTRACTION_PROMPT` contains `orderType`, `orderPrice`, `orderedShares`, `매도/STOP(시장가)` and `정정(매도)`, and still contains `NEVER 주문단가`.

`maxTokens` stays 1024 (`apps/server/src/wire/capture.ts`): a screen shows about eight rows at most, roughly 70 tokens each with the new keys. (Superseded 2026-11-24: this estimate was wrong, because the model's reasoning counts against the limit; the limit is 4096 since #99. See the spec's Amendments.)

- [ ] **Step 2: Run** `bun test packages/ingest/test/extract-order.test.ts`. Expected: FAIL (keys missing, prompt strings missing).

- [ ] **Step 3: Implement.** In `normalizeFill`, after the date handling: `orderType` is a string, trimmed, kept when its length is 1 to 32; `orderPrice` goes through `stripCommas`, is stringified, and is kept when it matches `PRICE_RE`; `orderedShares` is `Number(stripCommas(x))`, kept when it is a positive integer. `validateFill` is unchanged. In the prompt: add the three outputs to the per-row rules and the example JSON; say 주문구분 is copied exactly as shown, including `정정(매도)` and both `STOP(...)` forms; say a value is omitted when its column is not in the table (the 기간체결 view); keep every existing rule.

- [ ] **Step 4: Run** `bun test packages/ingest`. Expected: PASS, including the untouched `extract.test.ts`.

- [ ] **Step 5: Commit** `feat: carry the order type, order price and ordered shares from the screenshot (#74)`.

---

### Task 2: Store the order columns on the pending row

**Files:**
- Modify: `apps/server/src/db/schema.ts` (the `pendingFills` table), `apps/server/src/domain/repo-types.ts` (`PendingRow`), `apps/server/src/domain/booking.ts` (`ingestCapture`), `apps/server/src/http/routes/pending.ts`
- Create: `apps/server/db/migrations/0012_*.sql` and its `meta/` snapshot, by `bun run --cwd apps/server db:generate`
- Test: `apps/server/test/booking-capture-order.test.ts` (new), `apps/server/test/http-pending-routes.test.ts`, `apps/server/test/db-capture.test.ts` (DB-gated)

**Interfaces:**
- Consumes: Task 1's `RawFill` fields.
- Produces: `PendingRow` gains `detectedOrderType?: string | null; detectedOrderPrice?: bigint | null; detectedOrderedShares?: number | null` (optional, so existing literals compile). `GET /api/pending` returns `detected.orderType`, `detected.orderPrice` (myriadths as a string, like `detected.price`) and `detected.orderedShares`; the three `detected*` columns never appear at the top level of a row.

- [ ] **Step 1: Write the failing tests.**
  - `booking-capture-order.test.ts`, `ingestCapture stores the order columns`: capture one sell with `orderType:'매도/STOP(시장가)', orderPrice:'0.0000', orderedShares:1` and one buy without them; assert `f._stores.pending[0]` has `detectedOrderType: '매도/STOP(시장가)'`, `detectedOrderPrice: 0n`, `detectedOrderedShares: 1`, and `f._stores.pending[1]` has all three `null`.
  - `http-pending-routes.test.ts`, `the detected object carries the order columns`: the row's `detected` has `orderType: '매도/보통(지정가)'`, `orderPrice: '640700'`, `orderedShares: 44`; `'detectedOrderType' in row` is false. A row with `detectedAt: null` still has `detected: null`.
  - `db-capture.test.ts` (inside the existing DB-gated describe), `the order columns round-trip`: insert through the real `pendingRepo`, read back with `listPending`, same three values (bigint for the price).

- [ ] **Step 2: Run** `bun test apps/server/test/booking-capture-order.test.ts apps/server/test/http-pending-routes.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Schema columns, after `detectedFee`: `detectedOrderType: varchar('detected_order_type', { length: 32 })`, `detectedOrderPrice: bigint('detected_order_price', { mode: 'bigint' })`, `detectedOrderedShares: int('detected_ordered_shares')`. Run `bun run --cwd apps/server db:generate` from the repo root and check the new SQL file holds exactly three `ADD` column statements on `pending_fills`. `ingestCapture` writes `f.orderType ?? null`, `f.orderPrice != null ? parseUsd(f.orderPrice) : null`, `f.orderedShares ?? null`. In `pending.ts`, `detectedDto` adds the three fields and the row destructuring drops the three columns.

- [ ] **Step 4: Run** `bun test apps/server` and `bun run typecheck`. Expected: PASS. If the test DB is up (`docker ps` shows `st-mariadb-test`), also run the DB suite; if it is not, say so in the task report.

- [ ] **Step 5: Commit** `feat: store the screenshot's order columns on the pending row (#74)`.

---

### Task 3: The classifier and the pure matcher

**Files:**
- Create: `apps/server/src/domain/order-type.ts`, `apps/server/src/domain/sell-attribute.ts`
- Modify: `apps/server/src/domain/sell-match.ts` (export the private helpers `poolOf`, `fits`, `legOf`, `isPrice`, `byBucket`, `nearestFirst` and the `Pair` type unchanged; widen `AttributionRule` to `'price' | 'market' | 'order-price' | 'ordered-shares' | 'shares' | 'older'`)
- Test: `apps/server/test/order-type.test.ts`, `apps/server/test/sell-attribute.test.ts`, `apps/server/test/sell-attribute-cases.test.ts` (split so neither passes 300 lines)

Nothing calls the new code yet; the old ladder keeps booking until Task 4.

**Interfaces:**
- Produces, `order-type.ts`:
  ```ts
  export type SellOrderType = 'target' | 'stop' | 'market' | 'unknown'
  export interface OrderEvidence { type: SellOrderType; orderPrice: bigint | null; orderedShares: number | null }
  export const NO_EVIDENCE: OrderEvidence   // { type: 'unknown', orderPrice: null, orderedShares: null }
  export function classifyOrderType(raw: string | null | undefined): SellOrderType
  export function kindOfType(type: SellOrderType): 'sell_loc' | 'stop_sell' | 'market_sell' | null   // null for 'unknown'
  export function evidenceOf(row: { detectedOrderType?: string | null; detectedOrderPrice?: bigint | null; detectedOrderedShares?: number | null }): OrderEvidence
  ```
- Produces, `sell-attribute.ts`:
  ```ts
  export interface SellInput extends SellFillKey { bucketIdx?: number | null; evidence?: OrderEvidence }
  // Spec §4, cases A, B, C, C-market, D. Throws DomainError('choose-bucket') or DomainError('no-bucket-for-sell').
  export function attributeSell(orders: OrderRow[], state: RunState, input: SellInput): SellPick
  // True only when attributeSell would throw 'choose-bucket'. Any other throw, or a given bucketIdx: false.
  export function sellNeedsChoice(orders: OrderRow[], state: RunState, input: SellInput): boolean
  ```
  `SellPick`, `SellFillKey`, `SellAttribution`, `SellLeg`, `OrderRow` are the existing types in `sell-match.ts`.

- [ ] **Step 1: Write the failing classifier tests** in `order-type.test.ts`, one `test.each` over:

| Text | Type |
| --- | --- |
| `매도/STOP(시장가)`, `매도/STOP(지정가)`, `매도/stop(시장가)` | `stop` |
| `매도/LOC`, `매도/보통(지정가)`, `매도 보통`, ` 매도 / loc ` | `target` |
| `매도/보통(시장가)`, `매도(시장가)`, `매도 시장가` | `market` |
| `정정(매도)`, `매도`, `매도 LOO`, `매수/LOC`, `매수/보통(시장가)`, `''`, `null`, `undefined` | `unknown` |

  Plus: `kindOfType` maps `target`, `stop`, `market`, `unknown` to `sell_loc`, `stop_sell`, `market_sell`, `null`; `evidenceOf({ detectedOrderType:'매도/LOC', detectedOrderPrice: 650000n, detectedOrderedShares: 44 })` equals `{ type:'target', orderPrice: 650000n, orderedShares: 44 }`; `evidenceOf({})` equals `NO_EVIDENCE`.

- [ ] **Step 2: Write the failing matcher tests.** Shared helpers at the top of each matcher test file:
  ```ts
  const D = '2026-11-12', Y = '2026-11-11'
  // 10 buckets; each B bought at 100.00 on boughtOn (default '2026-11-01'); forced sets bucket.state = 'force_sell'
  function stateOf(bs: Array<{ idx: number; shares: number; boughtOn?: string; forced?: boolean }>): RunState
  // runId 1, tradeDate D, status 'open', ids 1,2,3… in call order; price null for market_sell (limitPrice 0n)
  function ord(idx: number, kind: 'sell_loc' | 'stop_sell' | 'market_sell', price: string | null, shares: number, over?: Partial<OrderRow>): OrderRow
  const ev = (type: SellOrderType, orderPrice?: string, orderedShares?: number): OrderEvidence
  const sell = (shares: number, price: string, evidence?: OrderEvidence, bucketIdx?: number): SellInput   // runId 1, filledOn D
  ```
  "Notice" below means `pick.attribution` is non-null with the given `rule` and `alternatives` listing the other buckets' candidate legs; "quiet" means `pick.attribution === null`. `T` = `sell_loc`, `S` = `stop_sell`, `M` = `market_sell`; an order is written `kind@price x shares`.

  `sell-attribute.test.ts` (the spec's examples table, cases A, C, C-market, D):

| # | Buckets (idx: shares) | Orders | Fill and evidence | Expect |
| --- | --- | --- | --- | --- |
| 1 | 0: 4, 1: 4 | 0: `S@97.00 x10`; 1: `S@97.00 x4` | 4 @ 96.50, `stop`, ordered 10 | bucket 0, its stop; notice `ordered-shares`, alternatives = bucket 1's stop |
| 2 | as 1 | as 1 | 4 @ 96.50, no evidence | throws `choose-bucket` |
| 3 | 0: 12, 1: 10 | 0: `S@97.00`; 1: `S@99.00` | 10 @ 96.50, `stop` | bucket 1; notice `shares` |
| 4 | 0: 10, 1: 12 | 0: `T@60.00`; 1: `T@62.00` | 10 @ 63.00, `target`, order price 60.00 | bucket 0, quiet. Then 12 @ 63.00, order price 62.00: bucket 1, quiet |
| 5 | 0: 10, 9: 10 | 0: `T@103.00`, `S@97.00`; 9: `T@91.00`, `S@85.40` | 10 @ 96.50, `stop` | bucket 0, its stop, quiet |
| 6 | as 5 | as 5 | 10 @ 98.00, `stop` | throws `choose-bucket` |
| 7 | 1: 10 | 1: `T@103.00`, `S@97.00` | 10 @ 104.00, no evidence | bucket 1, its target, quiet |
| 8 | as 7 | as 7 | 10 @ 100.00, no evidence | bucket 1, `orderId` null, quiet |
| 9 | as 5 | as 5 | 10 @ 96.50, evidence type from `classifyOrderType('정정(매도)')` | throws `choose-bucket` |
| 10 | 0: 10, 1: 10, 2: 7 forced | 0 and 1: `T@103.00`, `S@97.00` each; 2: `M x7` | 7 @ 50.00, `market` | bucket 2, its market order, quiet |
| 11 | 2: 7 forced, 3: 5 forced | 2: `M x7`; 3: `M x5` | 5 @ 50.00, `market` | bucket 3; notice `shares`, alternatives = bucket 2's market order |
| 12 | 1: 10 | 1: `T@103.00`, `S@97.00` | 10 @ 50.00, `market` | throws `choose-bucket` |
| 13 | 1: 10 | as 12 | 99 @ 50.00, `market`; and 99 @ 50.00, `target`; and 99 @ 50.00, none | each throws `no-bucket-for-sell` |
| 14 | 1: 10 | 1: `T@103.00`, `S@97.00` | 10 @ 100.00, `target` (case C, one holder) | bucket 1, `orderId` = its target although the price does not fit, quiet |
| 15 | 0: 10, 1: 10 | 0 and 1: `T@103.00` each | 10 @ 100.00, `target` (case C, two holders) | throws `choose-bucket` |
| 16 | 1: 10 | 1: `T@103.00`, `S@97.00` | 10 @ 98.00, `stop`, `bucketIdx: 1` (case A) | bucket 1, `orderId` = its stop, quiet |
| 17 | 1: 10 | as 16 | 10 @ 98.00, no evidence, `bucketIdx: 1` | bucket 1, `orderId` null, quiet |
| 18 | 1: 10 | 1: `S@97.00 x10` and `S@97.00 x6` | 6 @ 98.00, `stop`, ordered 6, `bucketIdx: 1` | `orderId` = the stop sized 6 |

  Plus `sellNeedsChoice`: true for row 2's input; false for rows 1, 7 and 13 and for row 2's input with `bucketIdx: 0`.

  `sell-attribute-cases.test.ts` (each step of case B, the pool and the gates):

| # | Buckets | Orders | Fill and evidence | Expect |
| --- | --- | --- | --- | --- |
| 20 | 0: 10, 1: 10 | 0: `T@60.00`; 1: `T@62.00` | 10 @ 63.00, `target`, order price 61.80 | bucket 1; notice `order-price` (distance is not 0) |
| 21 | 0: 10, 1: 12 | 0: `T@60.00`; 1: `T@60.00` | 10 @ 63.00, `target`, order price 60.00 | bucket 0; notice `shares` (distance 0 on two buckets is not quiet) |
| 22 | as 20 | as 20 | 10 @ 63.00, `target`, order price `0.0000` | step 1 skipped: bucket 1; notice `price` |
| 23 | 0: 10, 1: 10 | 0: `S@97.00`; 1: `S@99.00` | 10 @ 96.50, `stop` | bucket 0; notice `price` |
| 24 | as 23 | as 23 | 10 @ 96.50, `stop`, ordered 7 | step 2 skipped: same as 23 |
| 25 | 0: 10 bought 11-03, 1: 10 bought 11-01 | 0 and 1: `S@97.00` each | 10 @ 96.50, `stop` | bucket 1; notice `older` |
| 26 | 0: 10, 1: 10, same buy date | as 25 | 10 @ 96.50, `stop` | bucket 0; notice `older` |
| 27 | 0: 10, 1: 10 | 0: `S@97.00` dated `Y`; 1: `S@99.00` | 10 @ 96.50, `stop` | bucket 1, quiet (an order of another day is not in the pool) |
| 28 | as 27 | 0: `S@97.00` status `cancelled`; then the same with `filled` | 10 @ 96.50, `stop` | bucket 1, quiet both times |
| 29 | as 27 | 0: `S@97.00` status `stale`; 1: `S@99.00` | 10 @ 96.50, `stop` | bucket 0; notice `price` (a stale order is a candidate) |
| 30 | 0: 6, 1: 10 | 0: `S@97.00`; 1: `S@99.00` | 10 @ 96.50, `stop` | bucket 1, quiet (bucket 0 does not cover) |
| 31 | 0: 10, 1: 10 | 0: `S@97.00`; 1: `S@95.00` | 10 @ 96.50, `stop` | bucket 0, quiet (bucket 1's stop does not fit) |
| 32 | 0: 10, 1: 10 | orders of `runId: 2` only | 10 @ 96.50, `stop` | throws `choose-bucket` (another run's orders are not in the pool; two holders) |

- [ ] **Step 3: Run** `bun test apps/server/test/order-type.test.ts apps/server/test/sell-attribute.test.ts apps/server/test/sell-attribute-cases.test.ts`. Expected: FAIL (modules missing).

- [ ] **Step 4: Implement `order-type.ts`.** `classifyOrderType` strips all whitespace, upper-cases, then applies the table of spec §3 in order.

- [ ] **Step 5: Implement `sell-attribute.ts`** following spec §4 exactly. Decisions the spec leaves to this plan:
  - Steps are narrowing filters over the candidate list: a filter that would leave nothing is skipped.
  - `rule` is the first step after which every remaining candidate is on one bucket. If the candidates were on one bucket before step 1, there are no alternatives and no attribution.
  - `alternatives` are the original candidates on buckets other than the chosen one: price legs sorted with the existing `nearestFirst`, market legs with `byBucket`.
  - Quiet exception: type `target`, step 1 ran, its smallest distance is `0n`, and the candidates it kept are on one bucket.
  - The order to flip in cases A, C, C-market and D: when the type is known and the decided bucket has pool orders of `kindOfType(type)`, the one whose `shares` equal `orderedShares`, else the one whose `shares` equal the fill's, else the lowest id; otherwise `matchForcedLeg(...)?.id ?? null`.

- [ ] **Step 6: Run** the three test files and `bun run typecheck`. Expected: PASS. Then `bun test apps/server`: PASS (nothing else changed).

- [ ] **Step 7: Commit** `feat: classify the broker order type and attribute a sell by it (#74)`.

---

### Task 4: The booking uses the matcher; the old ladder goes

**Files:**
- Modify: `apps/server/src/domain/booking.ts`, `confirm-pending.ts`, `sell-match.ts`, `packages/telegram/src/i18n.ts`
- Rewrite: `apps/server/test/sell-matching.test.ts`, `apps/server/test/sell-attribution.test.ts`
- Modify: `apps/server/test/sell-fixture.ts`, `packages/telegram/test/digest.test.ts`, and every other test the change breaks
- Test: `apps/server/test/booking-order-type.test.ts` (new), `apps/server/test/http-pending-confirm.test.ts`, `apps/server/test/http-runs-fills-gaps.test.ts`

**Interfaces:**
- Consumes: `attributeSell`, `OrderEvidence`, `evidenceOf` (Task 3); `PendingRow.detectedOrder*` (Task 2).
- Produces: `BookInput.order?: OrderEvidence` (sell only; absent = `NO_EVIDENCE`). `sell-match.ts` no longer exports `matchSellOrder` or `pickSellBucket`; `AttributionRule` is `'order-price' | 'ordered-shares' | 'shares' | 'price' | 'older'`. A sell that needs the operator's choice makes `runBooking`, `manualFill` and `confirmPendingFill` reject with `DomainError` kind `choose-bucket`, with nothing written. Test helper in `sell-fixture.ts`: `sellTyped(runId, shares, price, deps, order: OrderEvidence, filledOn = D)`, which calls `runBooking` with `bookInput` plus `order`.

- [ ] **Step 1: Write the failing tests** in `booking-order-type.test.ts`, on `sellSetup` / `heldRun`:
  - `a typed pending sell books by its type`: buckets and orders of Task 3 row 5; a pending sell row 10 @ 96.50 with `detectedOrderType: '매도/STOP(시장가)'`; `confirmPendingFill(id, null, deps)` books to bucket 0, flips its stop to `filled`, cancels bucket 0's target, sends no attribution notice.
  - `the same row without an order type needs a choice`: the confirm rejects with `{ kind: 'choose-bucket' }`; the row is still `pending`; `fills`, `ledger` and the bucket state are unchanged. Then `confirmPendingFill(id, { bucketIdx: 0 }, deps)` books it.
  - `an ordered-shares pick sends the notice` (Task 3 row 1 through a pending confirm): `rec` recorded one `sellAttributed` with `rule: 'ordered-shares'`.
  - `quantity and price edited before confirm still use the screenshot's order type` (Review Focus 1): row as in the first test, `confirmPendingFill(id, { shares: 5, price: '96.40' }, deps)` books 5 shares to bucket 0.
  - `a row confirmed as a buy ignores the order type` (Review Focus 1): a sell row with a stop type, `confirmPendingFill(id, { side: 'buy' }, deps)` books a buy into the next empty bucket.
  - `a manual sell among two possible buckets is refused`: `manualFill` of 10 @ 96.50 on Task 3 row 5's setup rejects with `choose-bucket`; with `bucketIdx: 9` it books.
  - HTTP: `POST /runs/:id/fills` and `POST /pending/:id/confirm` answer `422 { error: 'choose-bucket' }` in that situation.

- [ ] **Step 2: Run** `bun test apps/server/test/booking-order-type.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `bookUnlocked` calls `attributeSell(sellOrders, state, { runId, filledOn, shares, price, bucketIdx: input.bucketIdx, evidence: input.order })`. `confirmPendingFill` passes `order: side === 'sell' ? evidenceOf(pending) : undefined`. Delete `matchSellOrder`, `pickSellBucket` and the comment block that documents the old rungs from `sell-match.ts`; replace it with two lines pointing at `sell-attribute.ts`. Narrow `AttributionRule`.

- [ ] **Step 4: Telegram copy.** In `i18n.ts` remove `sell-attributed-why-market`, replace `sell-attributed-why-price`, and add the other four (English fixed here, `{shares}` is the only parameter):
  - `sell-attributed-why-order-price`: `More than one order of this type could have filled; the one whose limit is nearest the order price on the screenshot was chosen.`
  - `sell-attributed-why-ordered-shares`: `More than one order of this type could have filled; the one placed for the ordered quantity on the screenshot was chosen.`
  - `sell-attributed-why-shares`: `More than one order of this type could have filled; the bucket holding exactly {shares} shares was chosen.`
  - `sell-attributed-why-price`: `More than one order of this type could have filled; the one whose price is nearest the fill price was chosen.`
  - `sell-attributed-why-older`: `More than one order of this type could have filled and nothing else told them apart; the bucket bought earliest was chosen.`

- [ ] **Step 5: Rewrite the two old suites.**
  - `sell-matching.test.ts`: delete the `#52` share-count describe and every exact-price-rung test (their rules are gone; Task 3 covers the replacements). Keep the `#53` stale-leg and `#54` partial-fill describes, driving each sell through `sellTyped` with the type the scenario implies, and keep their assertions about which orders end `filled`, `cancelled` or untouched. `two partials of one stop` must assert what it now does: both partials book to the stop's bucket, and the number of attribution notices follows spec §4 (a stop fill with candidates on another bucket always notifies).
  - `sell-attribution.test.ts`: keep `delivery of the attribution notice` (failing notifier, after-the-lock ordering, pending confirm), with typed sells. Replace `sell attribution to the nearest order price` by three booking-level tests: the #43 case typed as a stop is quiet; two stops possible notifies with the alternatives nearest first; a market sell among two forced-sell buckets notifies.
  - Run `bun test` and fix every other failure by the same rule: a sell with no evidence among several possible buckets now needs `bucketIdx` or an `order`. List every test file you touched in the task report, one line each on why.

- [ ] **Step 6: Run** `bun test` and `bun run typecheck`. Expected: PASS, 0 fail.

- [ ] **Step 7: Commit** `fix: attribute a sell by the broker order type, or ask the operator (#74)`.

---

### Task 5: Refuse a fill dated after today

**Files:**
- Modify: `apps/server/src/domain/booking.ts` (`bookUnlocked`, `seedUnlocked`), `apps/server/src/domain/recompute.ts` (`rebookFillUnlocked`), `apps/server/src/http/routes/runs.ts` (`POST /runs`, `GET /runs/:id`), `apps/server/src/wire/capture.ts` (`CONFIRM_ERROR_KEYS`), `packages/telegram/src/i18n.ts`
- Test: `apps/server/test/booking-future-date.test.ts` (new), `apps/server/test/http-future-date.test.ts` (new), `apps/server/test/wire-capture-confirm.test.ts`

**Interfaces:**
- Produces: `DomainError` kind `fill-date-in-future`. `GET /api/runs/:id` gains `today: string` (the New York date). Telegram key `confirm-err-fill-date-in-future`: `The trade date is after today — fix the date in the web app's Pending view.`

- [ ] **Step 1: Write the failing tests.** `today` is `D = '2026-11-12'`, `T = '2026-11-13'`. "Nothing written" means `fills`, `ledger`, `orders` and the bucket state are deep-equal to before.
  - `booking-future-date.test.ts`:
    - `a manual buy dated after today is refused` and `a manual sell dated after today is refused`: reject with `{ kind: 'fill-date-in-future' }`, nothing written. `a fill dated today books`.
    - `a pending row with a future date cannot be confirmed`: rejects, row still `pending`, nothing written; `confirmPendingFill(id, { filledOn: D }, deps)` then books. (A requested `keepImage` is still applied before the refusal, as for every other booking refusal; do not change that.)
    - `an edit that moves a fill to a future date is refused`: `rebookFill` with `filledOn: T` rejects, nothing written.
    - `a fill already stored with a future date can be corrected and re-dated`: plant a fill dated `T` in the fake store; `rebookFill` with a new price and `filledOn: T` succeeds; with `filledOn: D` succeeds; `applyCorrection` on it succeeds.
    - `seeding refuses a future date`: `seedRun` with one bucket dated `T` rejects, no fill inserted.
  - `http-future-date.test.ts`:
    - `POST /runs with a seed dated after today`: `422 { error: 'fill-date-in-future' }` and `runRepo.list()` is unchanged.
    - `POST /runs/:id/fills` and `PUT /runs/:id/fills/:fillId` with a future date: `422` with the code.
    - `GET /runs/:id carries today`: body `today` equals the injected `deps.today()`.
  - `wire-capture-confirm.test.ts`, `Yes on a future-dated row is refused with its own text`: `onConfirm` sends the `confirm-err-fill-date-in-future` text and no `booked` line; the row is still `pending`.

- [ ] **Step 2: Run** the three files. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.**
  - `bookUnlocked`: right after the `bucketIdx` validation, `if (input.filledOn > deps.today) throw new DomainError('fill-date-in-future')`.
  - `rebookFillUnlocked`: right after `match` is found, refuse when `edit.filledOn !== undefined && edit.filledOn !== match.filledOn && edit.filledOn > deps.today`.
  - `seedUnlocked`: before the loop, refuse when any bucket's `filledOn > deps.today`.
  - `POST /runs`: after `validSeed` and before `runRepo.create`, answer `422 { error: 'fill-date-in-future' }` when any seed bucket is dated after `deps.today()`.
  - `GET /runs/:id`: add `today: deps.today()` to the body.
  - `CONFIRM_ERROR_KEYS`: add the code. `capture.ts` is at 299 lines; this adds one. Task 6 shrinks the file, so this is the only line to add here.

- [ ] **Step 4: Run** `bun test` and `bun run typecheck`. Expected: PASS. A test elsewhere that booked a fill dated after its own `deps.today` now fails: fix its fixture date or its `today`, never the check; list those files in the report.

- [ ] **Step 5: Commit** `fix: refuse a fill dated after today on booking, edit and seed (#96)`.

---

### Task 6: Tell Telegram and the pending list when the operator must act

**Files:**
- Create: `apps/server/src/domain/pending-flags.ts`, `apps/server/src/wire/capture-pending-message.ts`
- Modify: `apps/server/src/domain/booking.ts` (`ingestCapture`, `PendingFillRow`), `apps/server/src/http/routes/pending.ts`, `apps/server/src/wire/capture.ts`, `packages/telegram/src/i18n.ts`
- Test: `apps/server/test/pending-flags.test.ts` (new), `apps/server/test/wire-capture-choice.test.ts` (new), `apps/server/test/http-pending-routes.test.ts`, `apps/server/test/booking-capture-order.test.ts`

**Interfaces:**
- Consumes: `sellNeedsChoice`, `evidenceOf` (Task 3); `choose-bucket` (Task 4); `fill-date-in-future` (Task 5).
- Produces:
  ```ts
  // pending-flags.ts: one state load and one order read for the run; ids of the sell rows that need a choice right now.
  export async function rowsNeedingBucket(
    repos: Pick<RepoSurface, 'bucketRepo' | 'orderRepo'>, runId: number,
    rows: Array<{ id: number; side: 'buy' | 'sell'; shares: number; price: bigint; filledOn: ISODate; evidence: OrderEvidence }>,
  ): Promise<Set<number>>
  // capture-pending-message.ts
  export function pendingMessage(row: PendingFillRow, lang: Lang): { text: string; buttons: boolean }
  ```
  `PendingFillRow` gains `needsBucket: boolean; dateAfterToday: boolean`. `GET /api/pending` rows gain `needsBucket: boolean` (false for a buy) and `today: string`.
  Telegram keys: `capture-date-after-today`: `⚠️ The trade date read from the screenshot ({date}) is after today. Fix the date and confirm this fill in the web app's Pending view.`; `capture-needs-bucket`: `⚠️ More than one bucket could have sold this. Choose the bucket and confirm this fill in the web app's Pending view.`; `confirm-err-choose-bucket`: `More than one bucket could have sold this — choose the bucket in the web app's Pending view.`

- [ ] **Step 1: Write the failing tests.**
  - `pending-flags.test.ts`: on Task 3 row 5's setup, a sell row with no evidence is in the set; the same row with stop evidence is not; a buy row is never in it; a row no bucket can cover is not in it; an empty `rows` reads nothing (the fake's `loadState` is not called).
  - `booking-capture-order.test.ts`: `ingestCapture` returns `needsBucket: true` for an untyped sell among two possible buckets and `false` for the typed one; `dateAfterToday: true` for a fill dated after `deps.today`, and that row keeps `filledOn` and `detectedFilledOn` equal to the future date.
  - `wire-capture-choice.test.ts` (use `wire-capture-fakes.ts`):
    - `a sell that needs a choice is sent without buttons`: the message has no `reply_markup` and contains the `capture-needs-bucket` text.
    - `a future-dated fill is sent without buttons`: no `reply_markup`, contains the `capture-date-after-today` text with the date.
    - `an ordinary row keeps its buttons`; `a substituted date still has no buttons` (existing behaviour, through the new module).
    - `Yes on a row that now needs a choice` (Review Focus 4): the row was sent with buttons; a second bucket becomes possible; `onConfirm` Yes sends the `confirm-err-choose-bucket` text, the row is still `pending`, no fill exists.
  - `http-pending-routes.test.ts`: `needsBucket` true and false as above; every row has `today`; `a row captured before the order columns existed lists and confirms` (Review Focus 2): a row with `detectedAt: null` and no order columns returns `detected: null`, a boolean `needsBucket`, and its confirm with one held bucket answers 200.

- [ ] **Step 2: Run** the four files. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `rowsNeedingBucket`: return an empty set without reading when no row is a sell; otherwise load the state once, read `orderRepo.listForRunFrom(runId, <earliest filledOn of the sell rows>)` once, and test each sell row with `sellNeedsChoice`.
  - `ingestCapture`: after the inserts, inside the lock, compute the set for the fresh rows and set both flags on each returned row.
  - `pending.ts`: group the listed rows by run, call `rowsNeedingBucket` per run (evidence from `evidenceOf(row)`), add `needsBucket` and `today: deps.today()` to each row.
  - `pendingMessage`: the `capture-booked` line, then one line each, in this order, for a substituted date (`detectedFilledOn === null`), a date after today, and a needed bucket; `buttons` is false when any line was added. `sendOutcome` in `capture.ts` uses it. Add `choose-bucket` to `CONFIRM_ERROR_KEYS`. `capture.ts` must end at or below 300 lines.

- [ ] **Step 4: Run** `bun test` and `bun run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: withhold the Telegram buttons and flag the pending row when a bucket or a date needs the operator (#74, #96)`.

---

### Task 7: The web pending row

**Files:**
- Create: `apps/web/src/pendingchoice.ts`, `apps/web/src/pendingchoice.test.ts`
- Modify: `apps/web/src/api.types.ts`, `apps/web/src/components/forms/PendingRow.tsx`, `PendingTable.tsx`, `BucketSelect.tsx`, `apps/web/src/i18n/en.json`, `ko.json`, `apps/web/src/testing/pendingRow.ts`
- Test: `apps/web/src/components/forms/PendingRowChoice.test.tsx` (new), `PendingTableChoice.test.tsx` (new)

**Interfaces:**
- Consumes: the `GET /api/pending` fields of Tasks 2 and 6; error codes `choose-bucket`, `fill-date-in-future`.
- Produces:
  ```ts
  // api.types.ts
  DetectedDto += orderType?: string | null; orderPrice?: string | null; orderedShares?: number | null
  PendingFillDto += needsBucket?: boolean; today?: string
  // pendingchoice.ts
  export function dateAfterToday(row: PendingFillDto, values: RowValues): boolean        // row.today is set and values.filledOn > row.today
  export function bucketRequired(row: PendingFillDto, values: RowValues, bucket: string, refused: boolean): boolean
  //   values.side === 'sell' && bucket === '' && (refused || row.needsBucket === true)
  export function orderLine(detected: DetectedDto | null): { type: string | null; shares: number | null; price: string | null } | null
  //   null when none of the three was read; price is the myriadths string as received
  ```
  `PendingRow` gains the prop `bucketRefused: boolean`. `BucketSelect` gains `invalid?: boolean` (adds `border-warning`) and `'aria-describedby'?: string`.
  Catalog keys (English): `fillErr.choose-bucket`: `More than one bucket could have sold this — choose the bucket.`; `fillErr.fill-date-in-future`: `The trade date is after today (New York time).`; `pendingNeedsBucket`: `More than one bucket could have sold this. Choose the bucket.`; `pendingDateAfterToday`: `This date is after today (New York time). Change it before confirming.`; `pendingOrderLine`: `ordered {shares} @ {price}`.

  If `api.types.ts` would pass 300 lines, move `PendingFillDto`, `DetectedDto` and `HeldBucketDto` to a new `apps/web/src/api.pending.types.ts` and re-export them from `api.types.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `pendingchoice.test.ts`: `dateAfterToday` is false without `row.today`, false for the same day, true for a later day, and follows `values.filledOn`, not the row's stored date. `bucketRequired` truth table over side, bucket, `refused`, `needsBucket`. `orderLine` is null for `detected: null` and for a snapshot with none of the three; otherwise returns what was read with nulls for the rest.
  - `PendingRowChoice.test.tsx` (fixtures from `testing/pendingRow.ts`):
    - `the order line shows what the screen said`: with `detected.orderType '매도/STOP(시장가)'`, `orderedShares 1`, `orderPrice '0'`, the Side cell contains the raw text and `ordered 1 @ 0.00` in a `[data-order-line]` element. No such element for a row without order data.
    - `a row that needs a bucket marks the selector`: with `needsBucket: true`, side sell, bucket `''`: the select has `border-warning`, a `[data-needs-input]` row shows `pendingNeedsBucket`, and the select's `aria-describedby` points at it. Choosing a bucket clears all three. With `bucketRefused` and `needsBucket: false` it is marked the same way.
    - `a date after today is a standing issue`: with `today '2026-11-12'` and the date `2026-11-13`, the date input has `border-warning` and the needs-input row shows `pendingDateAfterToday`; changing the date to `2026-11-12` clears it.
    - `several issues show one line each`, in the order: ticker or missed fields, date after today, bucket.
  - `PendingTableChoice.test.tsx` (use `testing/fetchStub.ts`): a confirm answered `422 { error: 'choose-bucket' }` shows the worded alert (`fillErr.choose-bucket`) and marks that row's bucket selector as required; a confirm answered `422 { error: 'fill-date-in-future' }` shows its worded alert; neither reloads the list away.

- [ ] **Step 2: Run** `bun test apps/web/src/pendingchoice.test.ts apps/web/src/components/forms/PendingRowChoice.test.tsx apps/web/src/components/forms/PendingTableChoice.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement.** `PendingRow` renders the order line as muted `text-xs` under the Side control (the raw type, then `pendingOrderLine` with the price shown through the row's existing `priceField` formatting and `—` for a value that was not read). The needs-input row renders one line per standing message. `PendingTable` keeps `refused: Record<number, true>`, sets it for the row whose confirm answered `choose-bucket`, clears it when that row's bucket changes, and passes `bucketRefused`. No client-side blocking: the server decides. Add the five keys to both catalogs.

- [ ] **Step 4: Run** `bun test apps/web` and `bun run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: show the order read from the screenshot and ask for a bucket or a valid date on the pending row (#74, #96)`.

---

### Task 8: The manual-fill dialog and the create-run form

**Files:**
- Modify: `apps/web/src/api.types.ts` (`RunDetailDto`), `apps/web/src/components/forms/FillDialog.tsx`, `apps/web/src/pages/RunDetail.tsx`, `apps/web/src/components/forms/CreateRunForm.tsx`
- Test: `apps/web/src/components/forms/FillDialogDate.test.tsx` (new), `apps/web/src/components/forms/CreateRunForm.test.tsx`

**Interfaces:**
- Consumes: `GET /api/runs/:id` `today` (Task 5); catalog keys `fillErr.choose-bucket`, `fillErr.fill-date-in-future` (Task 7).
- Produces: `RunDetailDto.today?: string`. `FillDialog` gains `today?: string`: a new fill's date defaults to `today ?? todayIso()`; an edited fill keeps its stored date.

`FillDialog.tsx` is at 297 lines and `RunDetail.tsx` at 293: add the prop without adding lines beyond 300 (the default is a one-token change on the existing `useState` line; the `RunDetail` prop fits on an existing line).

- [ ] **Step 1: Write the failing tests.**
  - `FillDialogDate.test.tsx` (fixtures from `testing/fillDialog.ts`):
    - `a new fill defaults to the server's date` (Review Focus 5): rendered with `today="2026-11-22"`, the date input holds `2026-11-22` whatever the test machine's clock says.
    - `without a server date it falls back to the browser's`.
    - `an edited fill keeps its own date` even when `today` is given.
    - `a refused future date is worded` (Review Focus 5): the add request answers `422 { error: 'fill-date-in-future' }`; the dialog shows the `fillErr.fill-date-in-future` text, not the generic request error, and stays open.
    - `a sell that needs a bucket is worded`: `422 { error: 'choose-bucket' }` shows `fillErr.choose-bucket`.
  - `CreateRunForm.test.tsx`: `a seed dated after today is worded`: the create request answers `422 { error: 'fill-date-in-future' }`; the form shows the `fillErr.fill-date-in-future` text.

- [ ] **Step 2: Run** the two files. Expected: FAIL.

- [ ] **Step 3: Implement.** `RunDetail` passes `today={run.today}` to the add dialog. `CreateRunForm` calls `errorText(err, t, 'fillErr')`; every other code of that route has no `fillErr.` key and keeps its generic text.

- [ ] **Step 4: Run** `bun test apps/web` and `bun run typecheck`. Expected: PASS. Check the line counts of the three files.

- [ ] **Step 5: Commit** `fix: default a manual fill to New York's date and word the future-date refusal (#96)`.

---

### Task 9: Operator smoke, documents, full verification

**Files:**
- Create: `scripts/e2e-order-type.ts`
- Modify: `scripts/e2e.ts`, `scripts/e2e-ctx.ts` (`VisionFill` gains the three optional order fields), `docs/superpowers/specs/2026-11-16-cut-loss-and-sim-drafts-design.md`, `AGENTS.md`

- [ ] **Step 1: Write the e2e step module**, in the style of `scripts/e2e-cutloss.ts`, and call it from `scripts/e2e.ts` after the cut-loss step. It must check, against the real HTTP app and capture pipeline:
  - a manual fill dated the day after `today` answers `422 fill-date-in-future` and adds no fill;
  - a captured sell whose fake-vision row carries `orderType: '매도/STOP(시장가)'`, `orderPrice: '0.0000'` and `orderedShares` appears in `GET /api/pending` with those three values under `detected`, and with a boolean `needsBucket` and a `today`;
  - on a run with two held buckets whose legs both fit, an untyped captured sell is listed with `needsBucket: true`, its confirm answers `422 choose-bucket`, and the same confirm with `overrides.bucketIdx` answers 200.
  Read `scripts/e2e.ts` first and build the two-bucket state the way the existing steps do; do not disturb the state later steps rely on (use a run of its own if needed).

- [ ] **Step 2: Run the smoke.** `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts` from the repo root. Expected: every check `ok`, exit 0. If the test DB container is not running, start it with the command in `AGENTS.md` ("Test DB") and say so in the report.

- [ ] **Step 3: Documents.**
  - Cut-loss spec: at the description of the sell-matching rungs and at "Known limitations", add a dated note that the ladder is superseded by the new spec (link by file name). Leave "Sibling cancel" unchanged apart from one sentence stating that fills dated after today are refused, so an open leg older than the fill is always a finished day order (#96).
  - `AGENTS.md` repo map: `domain/order-type.ts`, `domain/sell-attribute.ts`, `domain/pending-flags.ts`, `wire/capture-pending-message.ts`, migration `0012`, the new server tests, `apps/web/src/pendingchoice.ts`, `scripts/e2e-order-type.ts`, and `resources/trade_images/mpop/stop/`.

- [ ] **Step 4: Full verification.** Run each and record the output tail in the report:
  - `bun run typecheck` : no errors.
  - `bun test` : 0 fail.
  - `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` : 0 fail.
  - `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts` : exit 0.
  - `find apps packages scripts -name '*.ts' -o -name '*.tsx' | grep -v node_modules | xargs wc -l | awk '$1 > 300 && $2 != "total"'` : no source file listed that this branch pushed past 300.

- [ ] **Step 5: Commit** `test: operator smoke for order-type attribution and future dates; docs: supersede the sell-matching ladder (#74, #96)`.

---

## After the last task

- Whole-branch review on `anthropic/claude-fable-5-2`.
- Ask the operator for the live read of all eleven samples in `resources/trade_images/mpop/` through the real vision model (needs their endpoint and key). Expected per file is in the spec, "What the broker screen shows".
- With the operator's go-ahead: open the PR, and post on #96 the reasoning from the spec's "Why the cancel rule stays".
