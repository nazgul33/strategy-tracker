# Bucket numbering (1-based everywhere the operator reads it) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every place the operator reads a bucket number shows the same 1-based number the bucket board, fill table, order table and run history already show. Today the bucket selector (Pending table, fill dialog) and every Telegram text (booked reply, `/status`, morning digest, booking notices, order-cancelled notice) print the raw 0-based storage index, so "Bucket 0" in a selector or a Telegram message is "1" on the board.

**Spec:** none. The confirmed root cause is the spec:

- A bucket's `index` (`Bucket.index`, `bucket_idx`, `PlannedOrder.bucketIndex`) is 0-based in storage and on the wire.
- Display surfaces that are already right (do not touch): `apps/web/src/components/BucketBoard.tsx:46` (`cell.index + 1`), `FillTable.tsx:53`, `OrderTable.tsx:28` (`bucketIdx + 1`), `RunHistory.tsx:55` (`c.index + 1`), `SimReplay.tsx:132,150,198` (`bucketIndex + 1`).
- Wrong, web: `apps/web/src/components/forms/BucketSelect.tsx:39` labels options `t('bucketLabel', { n: b.index })`, and line 42 labels the stale option `{ n: value }` (the raw 0-based string). `BucketSelect` is used by `PendingRow.tsx` (global Pending page and the run-detail Pending tab) and `FillDialog.tsx`.
- Wrong, Telegram (all print the raw index):
  - `apps/server/src/wire/capture.ts:160` `'booked'` reply: `bucket: row.bucketIdx ?? 0` (also invents bucket 0 when the column is null).
  - `apps/server/src/wire/capture.ts:195,197,199` `/status` lines `bucket-idle`, `bucket-force-sell`, `bucket-held`: `index: b.index`.
  - `apps/server/src/wire/booking-notifier.ts:28,30,49,56` (`sell-attributed-alt[-market]`, `sibling-cancelled[-market]`, `buy-removed-cancelled[-market]`): `bucket: leg.bucketIdx` / `order.bucketIdx`. These notices are also stored and shown in the web notice feed.
  - `apps/server/src/http/routes/runs.ts:270` `'order-cancelled'`: `bucket: order.bucketIdx`.
  - `packages/telegram/src/digest.ts:32,56,67,76,83,85` morning digest lines: `bucket ${o.bucketIndex}`.
- The null case of the booked reply: a successful confirm always goes through `bookUnlocked` (`apps/server/src/domain/booking.ts:128-131`), whose `pendingRepo.decide(id, 'confirmed', edited)` writes `PendingDecisionPatch.bucketIdx: number` (required, `domain/repo-types.ts:11`) onto the row before `onConfirm` re-reads it. So `row.bucketIdx` is never null after a confirm in practice; the column type is `number | null` only because a still-pending row has none. The fix must not print an invented number for that unreachable case: it sends the same sentence without the bucket clause.

**Branch:** `worktree-fix-bucket-numbering` (this worktree). Line numbers are from commit `5548820`; later tasks locate code by symbol.
**Execution:** subagent-driven: one fresh implementer per task, then a reviewer per task. Tasks are independent of each other except that Task 3 imports the helper Task 2 adds (run them in order 1, 2, 3).

## Global Constraints

- Work only in this worktree (`/Users/nazgul33/work/strategy-tracker/.claude/worktrees/fix-bucket-numbering`) and run every command from its root.
- English only in code, comments and tests. Korean appears only in catalog values and in tests that pin ko catalog output. Never Chinese or Cyrillic characters.
- **Stored and posted values stay 0-based.** No change to `Bucket.index`, `bucket_idx`, `bucketIdx` request fields, `<option value>`, `PlannedOrder.bucketIndex`, notice `params.bucket`, ages keyed by index, DTOs, schema or migrations. In particular the `<option value={String(b.index)}>` in `BucketSelect` and the `Number(bucket)` posts in `PendingTable.tsx:106` and `FillDialog.tsx:121` stay exactly as they are.
- **Displayed number = index + 1**, converted at the call site that builds the text. Catalog strings and their `{placeholders}` do not change (the caller passes the display number), except for the one new Telegram key in Task 3.
- The digest's skip-to-notice pairing (`digest.ts:25`, `String(n.params?.bucket) === String(o.bucketIndex)`) and `orderAge` (`ages?.[o.bucketIndex]`) compare and look up raw indexes: leave them alone. Same for `apps/web/src/simview.ts:34,64`.
- Tests that call the catalog directly with a literal (`t('sell-attributed-alt', 'en', { bucket: 9, ... })` in `packages/telegram/test/digest.test.ts:147-187`) pin the formatter, not the numbering: do not change them.
- No source file over ~300 lines (`apps/server/src/http/routes/runs.ts` is at 280 and `apps/server/test/wire-capture-confirm.test.ts` at 274: the edits here add 0 and about 12 lines).
- `packages/*` never import `apps/*`.
- Commit style `fix:`. End every commit message with the line `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Out of scope, deliberately:
  - Notification rows already stored in the database keep the text they were written with, so older entries in the web notice feed still show 0-based bucket numbers. No backfill: the text is free-form and a rewrite could not tell a bucket number from any other digit.
  - Comments, test names and `scripts/e2e*.ts` assertion labels that say "bucket 0" while talking about the stored index (for example `scripts/e2e.ts:185`, `e2e-cutloss.ts`, `e2e-order-type.ts`) are developer-facing and describe the index: unchanged. Only e2e assertions on rendered Telegram text change.
  - Web error texts (`fillErr.bucket-not-found` and friends) and Telegram `confirm-err-*` texts carry no bucket number: nothing to fix.
  - `/orders` (`onOrders`) and the pending prompt (`capture-pending-message.ts`) print no bucket number: nothing to fix.
  - No shared helper for the web (`index + 1` stays inline there, matching the four existing call sites).

Baseline (verified on `5548820`): `bun test packages/telegram apps/server/test/wire-capture-confirm.test.ts apps/server/test/wire-capture-status.test.ts apps/server/test/wire-capture-photo.test.ts apps/server/test/booking-notifier.test.ts apps/server/test/http-sibling-notify.test.ts apps/server/test/http-fill-edit-legs.test.ts apps/server/test/http-fill-delete-legs.test.ts apps/web/src/components/forms/BucketSelect.test.tsx apps/web/src/components/forms/PendingTableBucket.test.tsx apps/web/src/components/forms/FillDialogBucket.test.tsx apps/web/src/pages/RunDetailAddFill.test.tsx` gives 123 pass, 0 fail.

---

### Task 1: Web bucket selector shows 1-based labels

**Files**

- Modify: `apps/web/src/components/forms/BucketSelect.tsx`
- Modify (tests): `apps/web/src/components/forms/BucketSelect.test.tsx`, `apps/web/src/components/forms/PendingTableBucket.test.tsx`, `apps/web/src/components/forms/FillDialogBucket.test.tsx`, `apps/web/src/pages/RunDetailAddFill.test.tsx`

- [ ] **Step 1: write the failing tests.**

  `BucketSelect.test.tsx`: replace the first test (`'keeps a chosen bucket that is no longer held visible'`) with these two. Held fixture is `[{ index: 0, shares: 10 }]`, chosen value `'3'` is stale.

  ```tsx
  it('labels buckets 1-based, like the bucket board, and keeps a chosen bucket that is no longer held visible', async () => {
    const select = await render('3');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Automatic', 'Bucket 1 · 10 sh', 'Bucket 4']);
    expect(select.value).toBe('3');
  });

  it('keeps the option values on the stored 0-based index', async () => {
    const select = await render('3');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', '0', '3']);
  });
  ```

  Update the three existing label assertions (the fixtures stay as they are):

  - `PendingTableBucket.test.tsx:119` (held `{0: 10 sh, 3: 4 sh}`): `['Automatic', 'Bucket 1 · 10 sh', 'Bucket 4 · 4 sh']`
  - `PendingTableBucket.test.tsx:120`: `['Automatic', 'Bucket 2 · 5 sh']`
  - `FillDialogBucket.test.tsx:128`: `['Automatic', 'Bucket 1 · 10 sh', 'Bucket 3 · 7 sh']`
  - `RunDetailAddFill.test.tsx:120` (held bucket `index: 1`): `['Automatic', 'Bucket 2 · 20 sh']`

  Do not change any assertion in those files on `select.value`, on a posted `bucketIdx`, or on which option gets chosen by value: they pin the 0-based value and must keep passing untouched.

- [ ] **Step 2: see them fail.**

  ```
  bun test apps/web/src/components/forms/BucketSelect.test.tsx apps/web/src/components/forms/PendingTableBucket.test.tsx apps/web/src/components/forms/FillDialogBucket.test.tsx apps/web/src/pages/RunDetailAddFill.test.tsx
  ```

  Expected: the four label assertions fail showing `Bucket 0 …` style labels; the new value test passes already (it guards the constraint).

- [ ] **Step 3: fix `BucketSelect.tsx`.** Replace the leading comment and the two label expressions; nothing else in the file changes.

  ```tsx
  // Which bucket a sell is booked to. value '' = Automatic, otherwise the bucket's
  // stored 0-based index as text (what gets posted as bucketIdx). The label shows
  // index + 1, the number the bucket board and the fill/order tables show. A choice
  // that is no longer held stays listed (and is sent), so the server's
  // bucket-not-held answer explains it instead of the choice vanishing.
  ```

  ```tsx
        {held.map((b) => (
          <option key={b.index} value={String(b.index)}>
            {`${t('bucketLabel', { n: b.index + 1 })} · ${t('bucketShares', { shares: b.shares })}`}
          </option>
        ))}
        {stale && <option value={value}>{t('bucketLabel', { n: Number(value) + 1 })}</option>}
  ```

  (`value` is always `''` or a decimal index string: it only ever comes from these options. `stale` already excludes `''`.)

- [ ] **Step 4: verify.**

  ```
  bun test apps/web
  bun run typecheck
  ```

  Expected: all pass. If any other web test asserts a `Bucket N · …` option label, it is the same fix (+1 on the label only).

- [ ] **Step 5: commit.**

  ```
  fix: number buckets from 1 in the bucket selector, matching the bucket board
  ```

---

### Task 2: Telegram digest prints 1-based bucket numbers (+ shared `bucketNo` helper)

**Files**

- Modify: `packages/telegram/src/i18n.ts` (add `bucketNo`)
- Modify: `packages/telegram/src/digest.ts`
- Modify (tests): `packages/telegram/test/i18n.test.ts`, `packages/telegram/test/digest.test.ts`
- Modify (operator smoke, needs DB to run): `scripts/e2e.ts` lines 208-211

- [ ] **Step 1: write the failing tests.**

  `packages/telegram/test/i18n.test.ts`: change the import to `import { CATALOG, bucketNo } from '../src/i18n'` and add inside the `describe`:

  ```ts
  test('bucketNo turns the stored 0-based index into the number shown to the operator', () => {
    expect(bucketNo(0)).toBe(1)
    expect(bucketNo(9)).toBe(10)
  })
  ```

  `packages/telegram/test/digest.test.ts`: every expectation on a line **rendered by `renderDigest`** moves up by one; the plan fixtures (`bucketIndex: …`, `params.bucket`, the `ages` argument) do not change. Exact new expectations, by current line:

  | Line | New expected text |
  | --- | --- |
  | 18 | `'Buy  LOC  29 sh  @ 340.22  → bucket 1'` |
  | 27 | `'Market  SELL  120 sh  bucket 2  (age 21 — forced exit)'` |
  | 36 | `'Sell  LOC  10 sh  @ 350.00  → bucket 3'` |
  | 63 | `'SKIP  sell_loc  bucket 2  sell capped (price 164.5)'` |
  | 64 | `'SKIP  sell_loc  bucket 3  sell capped (price 150.7007)'` |
  | 100 | `'Buy  LOC  1000 sh  @ 300.00  → bucket 1'` |
  | 101 | `'Buy  LOC  1000 sh  @ 300.01  → bucket 1'` |
  | 102 | `'Buy  LOC  1000 sh  @ 300.0299  → bucket 10'` |
  | 123 | `'Sell  LOC  10 sh  @ 350.00  → bucket 3  (age 21)'` |
  | 132 | `'Market  SELL  120 sh  bucket 2  (age 21 — forced exit)'` |
  | 144 | `'→ bucket 1  (21일 경과)'` |
  | 145 | `'매도  MARKET  120 sh  bucket 2  (120일 경과 — 강제 청산)'` |
  | 216 | `lines.findIndex((l) => l.includes('bucket 1') && l.includes('LOC'))` |
  | 217 | `'Sell  LOC  10 sh  @ 350.00  → bucket 1'` |
  | 218 | `'Sell  STOP  10 sh  trigger 270.00  → bucket 1'` |
  | 219 | `lines.findIndex((l) => l.includes('bucket 3') && l.includes('LOC'))` |
  | 220 | `'Sell  STOP  5 sh  trigger 280.00  → bucket 3'` |
  | 224 | `'매도  STOP  10 sh  발동가 270.00  → bucket 1'` |
  | 229 | `['bucket 1:LOC', 'bucket 1:STOP', 'bucket 3:LOC', 'bucket 3:STOP']` |
  | 241 | `['Sell  STOP  4 sh  trigger 250.00  → bucket 4', 'Market  SELL  7 sh  bucket 2']` |

  Leave lines 147-187 (direct `t(...)` calls with literal `bucket:` params) unchanged. The legacy-pairing test around lines 47-66 keeps its fixtures (`bucketIndex: 1` with `params.bucket: '1'`): it now also proves the pairing still runs on raw indexes while the printed number is +1.

- [ ] **Step 2: see them fail.**

  ```
  bun test packages/telegram
  ```

  Expected: `bucketNo` import fails / the listed digest expectations fail with the old numbers.

- [ ] **Step 3: implement.**

  `packages/telegram/src/i18n.ts`, append after `t`:

  ```ts
  // Buckets are stored 0-based (Bucket.index, bucket_idx, bucketIndex). Every text shown to
  // the operator numbers them from 1, like the web bucket board: pass bucketNo(index) as the
  // {bucket} / {index} param, never the raw index.
  export function bucketNo(index: number): number {
    return index + 1
  }
  ```

  `packages/telegram/src/digest.ts`: change the import to `import { t, bucketNo } from './i18n'` and replace the six printed occurrences (and only those):

  ```ts
      lines.push(`${t('skip', lang)}  ${o.kind}  bucket ${bucketNo(o.bucketIndex)}  ${reason}`.trim())
  ```

  ```ts
  // buyLine
    return `${verb}  LOC  ${o.shares} sh  @ ${formatUsd(o.limitPrice)}  → bucket ${bucketNo(o.bucketIndex)}`
  // sellLocLine
    return `${verb}  LOC  ${o.shares} sh  @ ${formatUsd(o.limitPrice)}  → bucket ${bucketNo(o.bucketIndex)}${ageClause}`
  // stopSellLine
    return `${t('stop-verb', lang)}  STOP  ${o.shares} sh  ${t('stop-label', lang)} ${formatUsd(o.limitPrice)}  → bucket ${bucketNo(o.bucketIndex)}`
  // marketSellLine
      return `매도  MARKET  ${o.shares} sh  bucket ${bucketNo(o.bucketIndex)}${ageClause}`
    return `Market  SELL  ${o.shares} sh  bucket ${bucketNo(o.bucketIndex)}${ageClause}`
  ```

  Do not touch the sorts (`a.bucketIndex - b.bucketIndex`), the notice pairing on line 25, or `orderAge`.

  `scripts/e2e.ts` lines 208-211: the asserted digest substrings move up by one (labels keep naming the stored index):

  ```ts
      ok(digest.includes('Buy  LOC  5 sh  @ 179.99  → bucket 3'), 'digest buy_loc line: 5 sh @ 179.99 (close−tick) into lowest empty bucket (index 2, shown as 3)')
      ok(digest.includes('Sell  LOC  32 sh  @ 178.867  → bucket 1'), 'digest sell_loc line for seeded bucket (index 0, shown as 1)')
      ok(digest.includes('Sell  LOC  30 sh  @ 179.869  → bucket 2'), 'digest sell_loc line for captured bucket (index 1, shown as 2)')
      ok(digest.includes('Sell  STOP  32 sh  trigger 172.25  → bucket 1') && digest.includes('Sell  STOP  30 sh  trigger 173.21  → bucket 2'), 'digest stop lines: trigger 172.25 (shown bucket 1) and 173.21 (shown bucket 2)')
  ```

- [ ] **Step 4: verify.**

  ```
  bun test packages/telegram
  bun test
  bun run typecheck
  ```

  Expected: all pass (no server test asserts digest line text; `bun test` confirms). If the test DB is up, also run `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`; it will still fail at the cancel-message check on line 250 until Task 3, which is expected at this point.

- [ ] **Step 5: commit.**

  ```
  fix: number buckets from 1 in the morning digest
  ```

---

### Task 3: Server Telegram texts (booked reply, /status, booking notices, order-cancelled) print 1-based bucket numbers

**Files**

- Modify: `packages/telegram/src/i18n.ts` (one new key `booked-no-bucket`)
- Modify: `apps/server/src/wire/capture.ts`, `apps/server/src/wire/booking-notifier.ts`, `apps/server/src/http/routes/runs.ts`
- Modify (tests): `apps/server/test/wire-capture-confirm.test.ts`, `wire-capture-photo.test.ts`, `wire-capture-status.test.ts`, `booking-notifier.test.ts`, `http-sibling-notify.test.ts`, `http-fill-edit-legs.test.ts`, `http-fill-delete-legs.test.ts`, `http-orders.test.ts`
- Modify (operator smoke): `scripts/e2e.ts` line 250

- [ ] **Step 1: write the failing tests.** Fixtures (`bucketIdx: …` on orders, legs, pending rows, fills) never change; only expected message text does. Rule: every bucket number inside an expected Telegram/notice string is the fixture's `bucketIdx + 1`.

  `apps/server/test/wire-capture-confirm.test.ts`

  - line 14: `text: 'Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 into bucket 1'`
  - lines 234 and 247: `'⚠️ Run #1 NVDA: cancel bucket 1 target ($103.00) at your broker — the other leg already filled, so this order is no longer needed.'`
  - add to the `'capture onConfirm — reply target'` describe (the fake `pendingRepo.get` is a plain property on `h.repos.pendingRepo`, so it can be wrapped):

    ```ts
    test('a confirmed row that carries no bucket is reported without inventing a bucket number', async () => {
      const h = makeCapture({ runs: [activeRun(1, 'NVDA')] });
      await h.handlers.onPhoto('777', { base64: PNG_B64, mime: 'image/png' });
      const p = h.pending[0]!;
      const get = h.repos.pendingRepo.get;
      h.repos.pendingRepo.get = async (id: number) => {
        const row = await get(id);
        return row ? { ...row, bucketIdx: null } : row;
      };
      await h.handlers.onConfirm('777', `yes:${p.id}`, true);
      expect(h.sent.at(-1)!.text).toBe('Booked NVDA buy 10 sh @ $180.50 on 2026-11-10');
    });
    ```

  `apps/server/test/wire-capture-photo.test.ts` line 40: `'Booked NVDA buy 10 sh @ $180.50 on 2026-11-10 into bucket 1'` (the `p.bucketIdx` / `fills[0].bucketIdx` `toBe(0)` assertions just above stay: stored index).

  `apps/server/test/wire-capture-status.test.ts`, first test: replace `expect(h.sent[0]!.text).toContain('Bucket 0');` with

  ```ts
    const count = h.stateFor(1).buckets.length;
    expect(h.sent[0]!.text).toContain('Bucket 1: idle');
    expect(h.sent[0]!.text).toContain(`Bucket ${count}: idle`);
    expect(h.sent[0]!.text).not.toContain('Bucket 0:');
  ```

  `apps/server/test/booking-notifier.test.ts` (expected strings only):

  | Line | Change inside the expected string |
  | --- | --- |
  | 20 | `booked to bucket 1 stop (…)`, `Also possible: bucket 2 target (…); bucket 3 stop (…)` |
  | 49, 74, 81, 102, 199 | `cancel bucket 2 target ($103.00)` |
  | 55 | `cancel bucket 1 stop ($97.00)` |
  | 61, 108 | `cancel bucket 3 market sell` |
  | 67, 114, 221 | `버킷 2 목표가 매도 ($103.00)` |
  | 138 | `booked to bucket 6 target (…)`, `Also possible: bucket 1 target (…); bucket 4 market sell` |
  | 150 | `booked to bucket 3 market sell. Also possible: bucket 6 market sell.` |

  `apps/server/test/http-sibling-notify.test.ts`: lines 34, 60, 99: `cancel bucket 1 target ($103.00)`; line 46: `버킷 1 목표가 매도 ($103.00)`; line 98: `booked to bucket 1 stop ($97.00, $0.50 away). Also possible: bucket 2 stop ($99.00, $2.50 away).`; line 113: `toContain('bucket 1 target ($103.00)')`.

  `apps/server/test/http-fill-edit-legs.test.ts` line 28 and `http-fill-delete-legs.test.ts` lines 27-28: `cancel bucket 1 target ($103.00)` / `cancel bucket 1 stop ($97.00)`.

  `apps/server/test/http-orders.test.ts`, test `'cancel order: happy path stores reason, notifies each allowed chat'` (the order fixture has `bucketIdx: 2`, limit `3500000n`, reason `stale-price`): replace the loose `toContain('Cancelled')` line with the exact text.

  ```ts
    expect(f.notifications.find((n) => n.runId === runId)!.text).toBe('🚫 Cancelled: sell_loc bucket 3 — price no longer valid (350.00)')
  ```

- [ ] **Step 2: see them fail.**

  ```
  bun test apps/server/test/wire-capture-confirm.test.ts apps/server/test/wire-capture-photo.test.ts apps/server/test/wire-capture-status.test.ts apps/server/test/booking-notifier.test.ts apps/server/test/http-sibling-notify.test.ts apps/server/test/http-fill-edit-legs.test.ts apps/server/test/http-fill-delete-legs.test.ts apps/server/test/http-orders.test.ts
  ```

  Expected: each changed expectation fails with the old 0-based number; the new null test fails with `… into bucket 0`.

- [ ] **Step 3: implement.**

  `packages/telegram/src/i18n.ts`, directly under the `'booked'` entry:

  ```ts
    'booked-no-bucket': { en: 'Booked {ticker} {side} {shares} sh @ ${price} on {date}', ko: '{ticker} {side} {shares}주 @ ${price} ({date})을(를) 예약했습니다' },
  ```

  (`packages/telegram/test/i18n.test.ts` already checks en/ko placeholder parity for every key.)

  `apps/server/src/wire/capture.ts`

  - import: `import { bucketNo, t } from '@st/telegram/i18n';`
  - in `onConfirm`, replace the block from `const price = formatUsd(row.price);` through the `deps.send(... t('booked' ...))` call with:

    ```ts
      const booked = { ticker: row.ticker, side: row.side, shares: row.shares, price: formatUsd(row.price), date: row.filledOn };
      // A confirmed row carries the bucket the booking chose (decide writes it). Should it
      // ever be missing, say so by leaving the bucket out rather than printing a made-up one.
      await deps.send(
        chatId,
        row.bucketIdx == null ? t('booked-no-bucket', lang, booked) : t('booked', lang, { ...booked, bucket: bucketNo(row.bucketIdx) }),
      );
    ```

  - in `onStatus`, the three bucket lines pass `index: bucketNo(b.index)` instead of `index: b.index`:

    ```ts
          if (b.state === 'empty') {
            lines.push(t('bucket-idle', lang, { index: bucketNo(b.index) }));
          } else if (b.state === 'force_sell') {
            lines.push(t('bucket-force-sell', lang, { index: bucketNo(b.index), shares: b.shares, price: formatUsd(b.buyPrice) }));
          } else {
            lines.push(t('bucket-held', lang, { index: bucketNo(b.index), shares: b.shares, price: formatUsd(b.buyPrice) }));
          }
    ```

  `apps/server/src/wire/booking-notifier.ts`: import `import { bucketNo, t } from '@st/telegram/i18n'`, then

  - `legText`: `bucket: bucketNo(leg.bucketIdx)` in both branches (2 sites);
  - `siblingCancelled` and `buyRemoved`: `bucket: bucketNo(order.bucketIdx)` in each `params` (2 sites).

  `apps/server/src/http/routes/runs.ts`: change the import to `import { bucketNo, t as tgT } from '@st/telegram/i18n'` and, in the cancel route's `tgT('order-cancelled', …)` params, `bucket: bucketNo(order.bucketIdx),`.

  `scripts/e2e.ts` line 250: `bucket ${sellLoc.bucketIdx + 1}` in `expectedCancelMsg` (the script builds the expected text from the stored order row).

- [ ] **Step 4: verify.**

  ```
  bun test
  bun run typecheck
  wc -l apps/server/src/wire/capture.ts apps/server/src/http/routes/runs.ts apps/server/test/wire-capture-confirm.test.ts
  grep -rnE "bucket: [a-zA-Z.]*(bucketIdx|bucketIndex)|index: b\.index \}|index: b\.index," apps/server/src/wire apps/server/src/http packages/telegram/src
  ```

  Expected: all tests pass; typecheck clean; every file under 300 lines; the grep prints nothing (no remaining raw index handed to a message). Any other failing server test that pins one of these texts gets the same +1 on the expected string, never on a fixture. If the test DB is up: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` and `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`, both green.

- [ ] **Step 5: commit.**

  ```
  fix: number buckets from 1 in Telegram replies, /status, booking notices and the order-cancelled notice
  ```
