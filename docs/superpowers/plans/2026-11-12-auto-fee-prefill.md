# Auto-Calculate Fill Fee from Configured Cost — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the Run detail → "Add fill" form, prefill the Fee input from `feeCents(price, shares, run.costPpm)` as price/shares are typed, stopping when the operator types a fee, resuming when they clear it.

**Architecture:** Frontend only. `ManualCaptureForm` gains an optional `costPpm` prop (wired from `RunDetail`) plus a `feeTouched` flag; a module-level `autoFeeUsd()` helper computes the fee with `feeCents`/`parseUsd` from `@st/core/money` — the identical half-up math `booking.ts` uses server-side, so client and server agree to the cent. Submission, API, and server are untouched: a prefilled fee is sent as a declared fee, an empty fee still means "server, compute it".

**Tech Stack:** React 19 + bun/happy-dom tests (`bun test`), `@st/core/money` bigint helpers, existing `api.ts` input guards.

**Spec:** `docs/superpowers/specs/2026-11-12-auto-fee-prefill-design.md`

## Global Constraints

- Money math only via `@st/core/money` bigint helpers (`parseUsd`, `feeCents`) and `format.ts` (`centsToUsdText`) — never multiply money in JS floats.
- No new user-visible copy, no new i18n keys.
- No changes under `apps/server/` or `packages/`.
- Validation guards must mirror submit-time guards: price valid ⇔ `usdOrNull(price) !== null`; shares valid ⇔ `Number.isInteger(Number(shares)) && Number(shares) > 0`.
- Run all commands from the repo root. Commit style: `feat:` / `test:`.

## Review Focus

Failure modes a person using this form would notice; each is pinned by a test in Task 1.

1. Client/server rounding drift — a prefilled fee that differs by a cent from what the server books (`booking.ts:49` uses `feeCents` with `roundDiv` half-up). → "prefills the fee from price and shares" uses `340.23 × 100 @ 30 ppm → 102¢`, the value pinned in `packages/core/test/money.test.ts:38-41`.
2. Stale auto-fee — inputs cleared/invalidated while the fee still shows an old auto value, then submitted. → "invalid price clears an auto fee".
3. Clobbered override — the operator types their actual commission and a later price edit overwrites it. → "typed fee survives later price and shares edits".
4. Zero fee — `costPpm: 0` or a tiny notional prefills `0.00`, which must still submit cleanly as a declared `0.00` fee (the server accepts 0). → "prefills 0.00 when cost is 0 ppm".
5. Existing no-cost path — anything rendering the form without `costPpm` (and today's single caller passes it, but the prop stays optional) must behave exactly as before: no prefill, `fee` omitted from the body. → the existing "submits without a ticker…" test, unchanged, plus "no costPpm means no auto-fee".

---

### Task 1: Auto-fee logic in `ManualCaptureForm`

**Files:**
- Modify: `apps/web/src/components/forms/ManualCaptureForm.tsx`
- Test: `apps/web/src/components/forms/ManualCaptureForm.test.tsx`

**Interfaces:**
- Consumes: `feeCents(price: bigint, shares: number, ppm: number): number` and `parseUsd(s: string): bigint` from `@st/core/money`; `centsToUsdText(cents: number): string` from `../../format`; `usdOrNull` from `../../api`. All already exist.
- Produces: `ManualCaptureForm({ runId, costPpm?, onAdded? })` — new optional prop `costPpm?: number`. Task 2 passes it.

- [ ] **Step 1: Write the failing tests**

Append these `it` blocks to the `describe('ManualCaptureForm', …)` in `ManualCaptureForm.test.tsx` (they use the existing `type`, `inputByTestId`, `clickSubmit` helpers). Each new test first re-renders with the cost prop; factor the existing render line into the same shape:

```tsx
async function renderWith(props: Record<string, unknown>) {
  await act(async () => {
    root.render(d(ManualCaptureForm, { runId: 7, ...props }));
  });
}

it('prefills the fee from price and shares', async () => {
  await renderWith({ costPpm: 30 });
  await type('manualSharesInput', '100');
  await type('manualPriceInput', '340.23');
  expect(inputByTestId('manualFeeInput').value).toBe('1.02'); // feeCents(3402300n, 100, 30) = 102
  await type('manualDateInput', '2026-11-06');
  await clickSubmit();
  expect(calls[0]!.body.fee).toBe('1.02');
});

it('recomputes the auto fee when price changes', async () => {
  await renderWith({ costPpm: 30 });
  await type('manualSharesInput', '100');
  await type('manualPriceInput', '340.23');
  await type('manualPriceInput', '680.46');
  expect(inputByTestId('manualFeeInput').value).toBe('2.04');
});

it('recomputes the auto fee when shares change', async () => {
  await renderWith({ costPpm: 30 });
  await type('manualSharesInput', '100');
  await type('manualPriceInput', '340.23');
  await type('manualSharesInput', '200');
  expect(inputByTestId('manualFeeInput').value).toBe('2.04');
});

it('typed fee survives later price and shares edits', async () => {
  await renderWith({ costPpm: 30 });
  await type('manualSharesInput', '100');
  await type('manualPriceInput', '340.23');
  await type('manualFeeInput', '5.00');
  await type('manualPriceInput', '680.46');
  await type('manualSharesInput', '200');
  expect(inputByTestId('manualFeeInput').value).toBe('5.00');
  await type('manualDateInput', '2026-11-06');
  await clickSubmit();
  expect(calls[0]!.body.fee).toBe('5.00');
});

it('clearing the fee input returns it to auto mode', async () => {
  await renderWith({ costPpm: 30 });
  await type('manualFeeInput', '5.00');
  await type('manualFeeInput', '');
  await type('manualSharesInput', '100');
  await type('manualPriceInput', '340.23');
  expect(inputByTestId('manualFeeInput').value).toBe('1.02');
});

it('invalid price clears an auto fee', async () => {
  await renderWith({ costPpm: 30 });
  await type('manualSharesInput', '100');
  await type('manualPriceInput', '340.23');
  expect(inputByTestId('manualFeeInput').value).toBe('1.02');
  await type('manualPriceInput', 'abc');
  expect(inputByTestId('manualFeeInput').value).toBe('');
});

it('invalid price does not clear a typed fee', async () => {
  await renderWith({ costPpm: 30 });
  await type('manualFeeInput', '5.00');
  await type('manualPriceInput', 'abc');
  expect(inputByTestId('manualFeeInput').value).toBe('5.00');
});

it('prefills 0.00 when cost is 0 ppm', async () => {
  await renderWith({ costPpm: 0 });
  await type('manualSharesInput', '100');
  await type('manualPriceInput', '340.23');
  expect(inputByTestId('manualFeeInput').value).toBe('0.00');
  await type('manualDateInput', '2026-11-06');
  await clickSubmit();
  expect(calls[0]!.body.fee).toBe('0.00');
});

it('a fee cleared without re-autofilling is omitted from the body', async () => {
  await renderWith({ costPpm: 30 });
  await type('manualSharesInput', '100');
  await type('manualPriceInput', '340.23');
  await type('manualFeeInput', '');
  await type('manualDateInput', '2026-11-06');
  await clickSubmit();
  expect(calls[0]!.body.fee).toBeUndefined(); // server computes from costPpm
});

it('no costPpm means no auto-fee', async () => {
  await renderWith({});
  await type('manualSharesInput', '100');
  await type('manualPriceInput', '340.23');
  expect(inputByTestId('manualFeeInput').value).toBe('');
});
```

Note: the `clickSubmit` flush (`await Promise.resolve()`) already drains the stubbed fetch; if `calls[0]` is missing after `clickSubmit` in an auto-fee test, reuse the existing test's flush pattern verbatim rather than adding awaits.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `bun test apps/web/src/components/forms/ManualCaptureForm.test.tsx`
Expected: the prefill/recompute tests FAIL (`expected '' to be '1.02'` etc.); the pre-existing "submits without a ticker…" test still PASSES.

- [ ] **Step 3: Implement in `ManualCaptureForm.tsx`**

Signature change: `{ runId, costPpm, onAdded }: { runId: number; costPpm?: number; onAdded?: () => void }`.

Module-level helper (outside the component, after the imports):

```ts
export function autoFeeUsd(shares: string, price: string, costPpm: number | undefined): string {
  if (costPpm === undefined) return '';
  const priceUsd = usdOrNull(price);
  if (priceUsd === null || !Number.isInteger(Number(shares)) || Number(shares) <= 0) return '';
  return centsToUsdText(feeCents(parseUsd(priceUsd), Number(shares), costPpm));
}
```

New imports: `feeCents, parseUsd` from `@st/core/money`; `centsToUsdText` from `../../format`.

Component changes:
- Add `const [feeTouched, setFeeTouched] = useState(false);`
- Shares `onChange`: `setShares(v)`, then `if (!feeTouched) setFee(autoFeeUsd(v, price, costPpm));`
- Price `onChange`: same pattern with `autoFeeUsd(shares, v, costPpm)`.
- Fee `onChange`: `setFee(v); setFeeTouched(v.trim() !== '');` (clearing the field returns it to auto mode).
- On successful submit (next to the existing `setFee('')`): add `setFeeTouched(false);`

- [ ] **Step 4: Run tests to verify all pass**

Run: `bun test apps/web/src/components/forms/ManualCaptureForm.test.tsx`
Expected: all tests PASS, including the pre-existing ticker test (fee stays `undefined` there because no `costPpm` prop is passed).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/forms/ManualCaptureForm.tsx apps/web/src/components/forms/ManualCaptureForm.test.tsx
git commit -m "feat: prefill manual fill fee from run cost ppm"
```

---

### Task 2: Wire `costPpm` from Run detail

**Files:**
- Modify: `apps/web/src/pages/RunDetail.tsx:177-183` (the `<ManualCaptureForm …>` under `tab === 'manual'`)

**Interfaces:**
- Consumes: Task 1's `ManualCaptureForm({ runId, costPpm?, onAdded? })`; `run.costPpm: number` (integer ppm) already on `RunDetailDto`, used at `RunDetail.tsx:97`.
- Produces: nothing further.

- [ ] **Step 1: Pass the run's cost into the form**

Add `costPpm={run.costPpm}` to the existing `<ManualCaptureForm …>` element.

- [ ] **Step 2: Typecheck and full test pass**

Run: `bun run typecheck && bun test`
Expected: typecheck clean; all suites pass (the DB-integration skips in `apps/server/test/db.test.ts` are normal without `TEST_DATABASE_URL`).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/RunDetail.tsx
git commit -m "feat: pass run cost ppm into the add-fill form"
```
