# Web polish and accessibility (wave D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the web-only polish and accessibility follow-ups from #48 and the pending/vision-review branch. That means cost display and loading, sim error copy, screen-reader names and markers, putting delete errors where the operator is looking, the derived-fee hint, comma-grouped prices, and a checked narrow-width pending row.

**Architecture:** Every change lives in `apps/web`. Two small new modules hold the logic that would otherwise be inlined in components: `defaultcost.ts` (memoized `/api/settings` default cost) and `simerrors.ts` (server code to en/ko copy). Everything else is a focused edit to the existing component, with tests next to it. New test files are used where the existing one is already at or above ~300 lines, or where wave C is likely to edit the same file.

**Tech Stack:** Bun, TypeScript, React 19 + Tailwind, `bun:test` with `@happy-dom/global-registrator`, the shared fetch stub in `apps/web/src/testing/fetchStub.ts`.

**Spec:** No design spec. Sources: GitHub issue #48, "Web polish" section plus the `useDefaultCostText` line under "Server tidiness" (`gh issue view 48`); `docs/superpowers/followups/2026-11-17-pending-vision-review-followups.md`, sections "Behaviour an operator could notice", "Accessibility and layout", and the `samePrice` line under "Code hygiene". Each task cites its source.
**Models (operator ruling 2026-11-20):** implementer subagents run on `anthropic/claude-sonnet-5-5`; per-task reviewers, the whole-branch reviewer and any plan amendments run on `anthropic/claude-fable-5-2`. Pass these as the subagent `model` parameter.

**Branch:** `feat/web-polish-a11y`, cut from `main` **after waves A and B have merged**. Wave B Task 8 changes `PendingTable.tsx`'s `submit`, and Task 10 here builds on it. Line references below were checked against `c76d971`, so locate code by symbol.

**Operator ruling 2026-11-20 (applies to Tasks 9 and 10):**
- Apply the sticky actions column without a manual browser check.
- Visually hint edited and erased values.
- Confirming a blank fee opens a popup that shows the default fee formula (rate × price × qty).

## Global Constraints

- English only in code, comments and docs. Never use Chinese or Cyrillic characters. Korean is allowed only in `apps/web/src/i18n/ko.json`.
- All user-facing copy goes through `apps/web/src/i18n/en.json` + `ko.json`. `apps/web/src/catalog.test.ts` checks four things: en/ko key parity, keys in `localeCompare` order in both files, no Chinese characters in ko values, and identical `{placeholders}` per key. Slot each new key in alphabetically and run that test after every catalog edit.
- No source file over ~300 lines. Split by responsibility.
- `fetch` stays injectable. Tests go through `installFetchStub` / `restoreFetch` from `apps/web/src/testing/fetchStub.ts`, or a file-local stub where a file already has one.
- Money is never float. Cost is integer ppm on the wire and percent text only in the UI.
- Commit style: `feat|fix|docs|test|refactor|chore:`.
- No server changes (`apps/server`, `packages/*` untouched).
- Do not touch `KeepImagePrompt`. Wave B adds the `archived: false` note to `PendingTable`'s `submit`; keep it intact. Do not add the test-only gaps wave C owns (Modal `wide`, the Compare dialog's empty side, keep-prompt dismiss/re-confirm, null review-tab fields, sibling-card delete, pending-row invalid price/date/fee branches).
- Component tests load `react-dom/client` with a dynamic import *after* `GlobalRegistrator.register()`, as every existing `*.test.tsx` does.

## Review Focus

1. **The display formatter leaking into an input.** If `costPercentText` (now `0.070%`) seeds a form field, every prefilled cost becomes invalid. Four existing tests pin the input value `'0.070'`: `CreateRunForm.test.tsx:182`, `Sim.test.tsx:171`, `SimConfigPanel.test.tsx:134` and `simconfig.test.ts:184`. Task 1 must leave them green unchanged (Task 1, Step 6).
2. **A memoized default overwriting what the operator typed, or tests leaking the memo into each other.** The existing "does not overwrite a cost typed before settings arrive" test only means something if the memo is reset before each test (Task 2, Step 1 + Step 7).
3. **A failed settings load memoized for the whole page load.** The "couldn't load" note would then stick until a full reload, even after the server recovers. The memo must forget failures (Task 2, Step 1, `a failed load is not memoized`).
4. **Unknown or free-text sim error codes.** A 500 carrying an arbitrary `e.message`, and the test-only `market-data:upstream`, must still show the raw code through `simActionFailed` and never a bare catalog key (Task 3, Step 1 fallback cases; existing `SimConfigPanel.test.tsx:227` and `SimDrafts.test.tsx:181` stay green).
5. **A comma-grouped price that is *not* equal to the detected one.** Once `"12,345.00"` reads as unedited, `"12,345.50"` must still be refused with the invalid-override message, and nothing may be posted with a comma in it (Task 5, Step 1, second test).

---

## File Structure

**Create**
- `apps/web/src/defaultcost.ts`: module-level memo of the default cost text from `/api/settings`.
- `apps/web/src/defaultcost.test.ts`
- `apps/web/src/simerrors.ts`: `simErrorText(err, t)`, which maps sim API errors to copy.
- `apps/web/src/simerrors.test.ts`
- `apps/web/src/components/forms/CreateRunFormCost.test.tsx`: the cost-field tests moved out of `CreateRunForm.test.tsx` (308 lines) plus the new failure-note test.
- `apps/web/src/components/forms/PendingRow.test.tsx`: thumbnail header name, blank-fee placeholder, comma-grouped price, sticky actions column, edit hints (new file, so it does not collide with wave C's additions to the 681-line `PendingTable.test.tsx`).
- `apps/web/src/fieldeditstate.test.ts`: the `fieldEditState` unit tests (`pendingvalues.test.ts` is 287 lines already).
- `apps/web/src/components/forms/DefaultFeePrompt.tsx`, `DefaultFeePrompt.test.tsx`, and `PendingDefaultFee.test.tsx` (the popup flow through `PendingTable`).
- `apps/web/src/components/VisionReviewEntry.test.tsx`: review-tab a11y (renders the entry directly).

**Modify**
- `apps/web/src/format.ts:93-97`: `costPercentText` gains `%`; new `costInputText`.
- `apps/web/src/simconfig.ts:7,137`, `apps/web/src/components/hooks.tsx:52-81`, `apps/web/src/pages/RunDetail.tsx:122`, `apps/web/src/pages/RunsList.tsx:228`, `apps/web/src/pages/Sim.tsx:47,79,107,118-123`
- `apps/web/src/components/forms/CreateRunForm.tsx:32,166-176`, `apps/web/src/components/forms/SimConfigFields.tsx:9-39`, `apps/web/src/components/forms/SimConfigPanel.tsx:39-48`
- `apps/web/src/components/PriceChart.tsx:45-48`
- `apps/web/src/api.ts:113-126` (`ungroupUsd`; the file is 311 lines already, so tighten `usdToCents` around the extraction instead of growing it), `apps/web/src/pendingvalues.ts:91-100` (`samePrice`), `apps/web/src/autofee.ts:10` (`autoFeeUsd` reads grouped prices)
- `apps/web/src/components/forms/PendingTable.tsx:145`, `apps/web/src/components/forms/PendingRow.tsx:100-113`
- `apps/web/src/components/VisionReviewEntry.tsx:70-91,105-153`, `apps/web/src/pages/VisionReview.tsx`
- `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Tests: `format.test.ts`, `api.test.ts`, `pendingvalues.test.ts`, `pages/Sim.test.tsx`, `pages/SimDrafts.test.tsx`, `components/forms/CreateRunForm.test.tsx`, `components/PriceChart.test.tsx`, `pages/VisionReview.test.tsx`, and two existing blank-fee tests in `components/forms/PendingTable.test.tsx` (Task 10)

---

### Task 1: Cost percent formatter owns its `%`

Source: #48 "Web polish", first bullet.

The formatter currently returns `0.070`. Three display sites append ` %` (with a space). Two *input* seeds also call it: `hooks.tsx:66` (`useDefaultCostText`) and `simconfig.ts:137` (`formFromRun`). Inputs must keep the bare number, so they move to a new `costInputText`.

**Files:**
- Modify: `apps/web/src/format.ts:93-97`
- Modify: `apps/web/src/simconfig.ts:7,137`, `apps/web/src/components/hooks.tsx:5,66`
- Modify: `apps/web/src/pages/RunDetail.tsx:122`, `apps/web/src/pages/RunsList.tsx:228`, `apps/web/src/pages/Sim.tsx:47`
- Test: `apps/web/src/format.test.ts:71-85`, `apps/web/src/pages/SimDrafts.test.tsx`

**Interfaces:**
- Produces: `costPercentText(ppm: number | null | undefined): string` returns `'0.070%'`, or `'—'` (no `%`) for null/undefined/non-finite. `costInputText(ppm: number): string` returns `'0.070'` (three decimals), or `''` for non-finite. Task 2 uses `costInputText`.

- [ ] **Step 1: Update and add the formatter tests in `format.test.ts`**

```ts
describe('costPercentText', () => {
  test('always shows three decimals and its own percent sign, no space', () => {
    expect(costPercentText(700)).toBe('0.070%');
    expect(costPercentText(0)).toBe('0.000%');
    expect(costPercentText(10)).toBe('0.001%');
    expect(costPercentText(1250)).toBe('0.125%');
    expect(costPercentText(1_000_000)).toBe('100.000%');
  });
  // existing "missing or non-finite values render as an em dash" test unchanged ('—', no '%')
});

describe('costInputText', () => {
  test('is the bare three-decimal number an input holds', () => {
    expect(costInputText(700)).toBe('0.070');
    expect(costInputText(0)).toBe('0.000');
  });
  test('non-finite is blank', () => {
    expect(costInputText(Number.NaN)).toBe('');
  });
});
```

- [ ] **Step 2: Add a rendered assertion in `SimDrafts.test.tsx`**

New test `it('shows the cost with its percent sign and no space', ...)`: `await renderList()`, then `expect(rowsIn('simDrafts')[0]).toContain('0.070%')` and `expect(rowsIn('simDrafts')[0]).not.toContain('0.070 %')`. `simRow` already uses `costPpm: 700`.

- [ ] **Step 3: Run to see them fail**

Run: `bun test apps/web/src/format.test.ts apps/web/src/pages/SimDrafts.test.tsx`
Expected: FAIL. `costInputText` is not exported, `'0.070'` is not `'0.070%'`, and the row contains `0.070 %`.

- [ ] **Step 4: Implement**

- `format.ts`: add `costInputText`. `costPercentText` returns `` `${costInputText(ppm)}%` `` after its existing `'—'` guard. Update both doc comments.
- `simconfig.ts:137` and `hooks.tsx:66`: switch to `costInputText` and fix the imports.
- `RunDetail.tsx:122`: `{costPercentText(run.costPpm)} %{' '}` becomes `{costPercentText(run.costPpm)}{' '}`. `RunsList.tsx:228` and `Sim.tsx:47`: drop the trailing ` %`.

- [ ] **Step 5: Run the task's tests**

Run: `bun test apps/web/src/format.test.ts apps/web/src/pages/SimDrafts.test.tsx apps/web/src/simconfig.test.ts`
Expected: PASS.

- [ ] **Step 6: Guard the input seeds (Review Focus 1) and grep for leftovers**

Run: `bun test apps/web/src/components/forms/CreateRunForm.test.tsx apps/web/src/pages/Sim.test.tsx apps/web/src/components/forms/SimConfigPanel.test.tsx`
Expected: PASS with no test edits (inputs still read `0.070`).
Run: `rg -n "costPercentText\([^)]*\)\}? ?%" apps/web/src`
Expected: no matches.

- [ ] **Step 7: Typecheck and commit**

Run: `bun run typecheck`. Expected: exit 0.

```bash
git add apps/web/src/format.ts apps/web/src/format.test.ts apps/web/src/simconfig.ts apps/web/src/components/hooks.tsx apps/web/src/pages/RunDetail.tsx apps/web/src/pages/RunsList.tsx apps/web/src/pages/Sim.tsx apps/web/src/pages/SimDrafts.test.tsx
git commit -m "fix: cost percent formatter emits its own % with no space"
```

---

### Task 2: Default cost loaded once per page, with a note when it fails

Sources: #48 "Web polish", second bullet (failed `/api/settings` note), and "Server tidiness", last bullet (`useDefaultCostText` module-level memo).

Decisions:
- The memo holds the in-flight promise, so concurrent mounts share one request. A failed load (rejected request, or a non-finite `defaultCostPpm`) clears the memo: that mount shows the note, and the next mount asks again.
- `defaultCostPpm` is env-only on the server (`DEFAULT_COST_PERCENT`). The Settings page cannot change it, so the memo never needs invalidating at runtime.
- The note shows only while the load failed **and** the operator has not typed in the field.

**Files:**
- Create: `apps/web/src/defaultcost.ts`, `apps/web/src/defaultcost.test.ts`
- Modify: `apps/web/src/components/hooks.tsx:52-81`
- Modify: `apps/web/src/components/forms/CreateRunForm.tsx:32,166-176`, `apps/web/src/components/forms/SimConfigFields.tsx:9-39`, `apps/web/src/pages/Sim.tsx:79,149-152`
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Create: `apps/web/src/components/forms/CreateRunFormCost.test.tsx`. Move the four cost tests out of `CreateRunForm.test.tsx` (lines 174-256: `prefills cost from the settings default and posts ppm`, `converts an edited percent cost to ppm`, `does not overwrite a cost typed before settings arrive`, `rejects a four-decimal cost`) together with the helpers they need. This keeps both files under ~300 lines.
- Modify tests: `apps/web/src/components/forms/CreateRunForm.test.tsx`, `apps/web/src/pages/Sim.test.tsx`, `apps/web/src/pages/SimDrafts.test.tsx` (add `resetDefaultCostMemo()` to each `beforeEach`)

**Interfaces:**
- Consumes: `costInputText(ppm: number): string` (Task 1); `api.getSettings(): Promise<SettingsDto>`.
- Produces (in `apps/web/src/defaultcost.ts`):
  - `loadDefaultCostText(): Promise<string>`: memoized; resolves to `costInputText(defaultCostPpm)`; rejects on request failure or non-finite ppm, and forgets the failure.
  - `peekDefaultCostText(): string | undefined`: the resolved text, if any, so a later mount can seed `useState` without a blank first frame.
  - `resetDefaultCostMemo(): void`: test hook.
- Produces (in `hooks.tsx`): `useDefaultCostText(): [text: string, setText: (v: string) => void, loadFailed: boolean]`. `loadFailed` is true after a failed load until the operator types. Existing two-element destructuring keeps working.
- Produces (in `SimConfigFields.tsx`): new optional prop `costNote?: string`, rendered under the cost input.

- [ ] **Step 1: Write `defaultcost.test.ts`**

Use `installFetchStub` with a `/api/settings` route whose `get json()` getter counts requests (the pattern at `PendingTable.test.tsx:47-58`). Call `resetDefaultCostMemo()` in `beforeEach` and `restoreFetch()` in `afterEach`.

```ts
test('two loads share one /api/settings request', async () => {
  const [a, b] = await Promise.all([loadDefaultCostText(), loadDefaultCostText()]);
  expect([a, b]).toEqual(['0.070', '0.070']);
  expect(await loadDefaultCostText()).toBe('0.070');
  expect(settingsGets).toBe(1);
});
test('a failed load is not memoized: the next load asks again', async () => {
  route.status = 500;
  await expect(loadDefaultCostText()).rejects.toBeDefined();
  route.status = 200;
  expect(await loadDefaultCostText()).toBe('0.070');
  expect(settingsGets).toBe(2);
});
test('a non-finite defaultCostPpm counts as a failure', async () => {
  settings.defaultCostPpm = null;
  await expect(loadDefaultCostText()).rejects.toBeDefined();
});
test('peek is undefined until the load resolves, then the text', async () => {
  expect(peekDefaultCostText()).toBeUndefined();
  await loadDefaultCostText();
  expect(peekDefaultCostText()).toBe('0.070');
});
test('resetDefaultCostMemo forces a fresh request', async () => {
  await loadDefaultCostText();
  resetDefaultCostMemo();
  await loadDefaultCostText();
  expect(settingsGets).toBe(2);
});
```

- [ ] **Step 2: Move the cost tests into `CreateRunFormCost.test.tsx` and add the note test**

Move the four tests verbatim (same names). The memo adds promise steps before the prefill lands: if a moved test then reads `''` after its single flush, add flushes in the test helper and leave the assertion alone. Add `resetDefaultCostMemo()` to `beforeEach` in this file, in `CreateRunForm.test.tsx`, in `Sim.test.tsx` and in `SimDrafts.test.tsx`. New tests:

```ts
it('a failed settings load says so by the cost field, until the operator types', async () => {
  settingsRoute.status = 500;          // the /api/settings route object from the stub
  await renderForm();                  // render + one flush, as the moved tests do
  const note = document.querySelector('[data-testid="costDefaultFailed"]')!;
  expect(note.textContent).toBe("Couldn't load the default cost. Enter one.");
  expect(inputByLabel('Cost (%)').value).toBe('');
  await act(async () => setInputValue(inputByLabel('Cost (%)'), '0.1'));
  expect(document.querySelector('[data-testid="costDefaultFailed"]')).toBeNull();
});
it('no note when the default loads', async () => {
  await renderForm();
  expect(document.querySelector('[data-testid="costDefaultFailed"]')).toBeNull();
});
it('ko copy for the note', () => {
  expect(lookup('ko', 'costDefaultFailed')).toBe('기본 비용을 불러오지 못했습니다. 직접 입력하세요.');
});
```

In `Sim.test.tsx`, add `it('a failed settings load says so by the cost field', ...)`: the settings route gets status 500, and the test checks the same `[data-testid="costDefaultFailed"]` text and that `inputByTestId('costInput').value` is `''`.

- [ ] **Step 3: Run to see them fail**

Run: `bun test apps/web/src/defaultcost.test.ts apps/web/src/components/forms/CreateRunFormCost.test.tsx apps/web/src/pages/Sim.test.tsx`
Expected: FAIL (module missing, no `costDefaultFailed` element).

- [ ] **Step 4: Implement**

- `defaultcost.ts` per the Interfaces block.
- `useDefaultCostText`: seed `useState(() => peekDefaultCostText() ?? '')`. In the effect, `loadDefaultCostText().then(set-if-live-and-untouched, () => live && !touched && setFailed(true))`. The setter sets `touched` and clears `failed`. Update the doc comment (no longer "submit asks for a cost").
- Catalog key `costDefaultFailed`: en `"Couldn't load the default cost. Enter one."`, ko `"기본 비용을 불러오지 못했습니다. 직접 입력하세요."`.
- `CreateRunForm.tsx`: `const [cost, setCost, costLoadFailed] = useDefaultCostText();`. Inside the cost `Field`, after the `Input`, render `<span data-testid="costDefaultFailed" role="status" className="mt-1 block text-[11px] text-warning">` when `costLoadFailed`. Use a `span`: `Field` renders a `<label>`, and a `<p>` is not valid inside one.
- `SimConfigFields.tsx`: render the same element under the cost input when `costNote` is set. `Sim.tsx` passes `costNote={costLoadFailed ? t('costDefaultFailed') : undefined}`. `SimConfigPanel` does not pass it.

- [ ] **Step 5: Run the task's tests**

Run: `bun test apps/web/src/defaultcost.test.ts apps/web/src/components/forms/CreateRunFormCost.test.tsx apps/web/src/components/forms/CreateRunForm.test.tsx apps/web/src/pages/Sim.test.tsx apps/web/src/pages/SimDrafts.test.tsx apps/web/src/catalog.test.ts`
Expected: PASS.

- [ ] **Step 6: Line counts**

Run: `wc -l apps/web/src/components/forms/CreateRunForm.test.tsx apps/web/src/components/forms/CreateRunFormCost.test.tsx apps/web/src/components/forms/CreateRunForm.tsx apps/web/src/components/hooks.tsx`
Expected: each ≤ ~300.

- [ ] **Step 7: Prove the memo reset matters (Review Focus 2)**

Temporarily comment out `resetDefaultCostMemo()` in `CreateRunFormCost.test.tsx`'s `beforeEach`, run the file, and confirm `does not overwrite a cost typed before settings arrive` fails. Restore the line and re-run: PASS. Record the result in the task report.

- [ ] **Step 8: Typecheck and commit**

Run: `bun run typecheck`. Expected: exit 0.

```bash
git add apps/web/src/defaultcost.ts apps/web/src/defaultcost.test.ts apps/web/src/components/hooks.tsx apps/web/src/components/forms/CreateRunForm.tsx apps/web/src/components/forms/SimConfigFields.tsx apps/web/src/pages/Sim.tsx apps/web/src/i18n/en.json apps/web/src/i18n/ko.json apps/web/src/components/forms/CreateRunForm.test.tsx apps/web/src/components/forms/CreateRunFormCost.test.tsx apps/web/src/pages/Sim.test.tsx apps/web/src/pages/SimDrafts.test.tsx
git commit -m "feat: load the default cost once per page and say when it could not be loaded"
```

---

### Task 3: Sim errors in words

Source: #48 "Web polish", third bullet (`simActionFailed`).

The codes the sim routes actually return (`apps/server/src/http/routes/sim.ts:56-63,68,83,95-114`) are:
- `not-found` (404)
- `sim-finalized` (409, already mapped)
- DomainError kinds as 422: `not-enough-bars` (`sim/sim.ts:177`) and `invalid-params`
- `market-data:` + `MarketDataError.kind`, which is only `market-data:http` or `market-data:no-data` (`packages/market-data/src/yahoo.ts:4`), as 502
- free-text 400 validation strings (`invalid from`, …)
- an arbitrary `e.message` as 500
- the client's `http-<status>` fallback when the body has no `{error}`

`market-data:upstream` is **not** a real code. It exists only as a fake in `SimConfigPanel.test.tsx:229`, and it stays as the fallback case there.

The mapping uses an explicit allow-list, so a free-text 500 message can never accidentally match a key. `invalid-params` and the 400 strings are not mapped: the client validates first, so they would point to a client bug, and the raw code is more useful there.

`Sim.tsx`'s run-submit catch (line 107) currently shows `err.message`, the bare code. It is the most likely path to hit `market-data:*` and `not-enough-bars`, so it uses the helper too.

**Files:**
- Create: `apps/web/src/simerrors.ts`, `apps/web/src/simerrors.test.ts`
- Modify: `apps/web/src/pages/Sim.tsx:104-108,118-123`, `apps/web/src/components/forms/SimConfigPanel.tsx:39-48`
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Test: `apps/web/src/pages/Sim.test.tsx`

**Interfaces:**
- Produces: `simErrorText(err: unknown, t: (key: string, params?: Record<string, string | number>) => string): string`. Its rules:
  - An `ApiError` whose code is in `['sim-finalized', 'not-found', 'not-enough-bars', 'market-data:http', 'market-data:no-data']` → `t('simErr.<code>')`.
  - An `ApiError` with code matching `/^http-5\d\d$/` → `t('simErr.server', { code })`.
  - Any other `ApiError` → `t('simActionFailed', { code })`.
  - Any other `Error` → `err.message`.
  - Anything else → `String(err)`.

- [ ] **Step 1: Write `simerrors.test.ts`**

Use `const en = (k, p) => lookup('en', k, p)`, the same for `ko`, and `new ApiError(status, code as ApiErrorCode)`.

```ts
test.each([
  ['market-data:http', "Couldn't reach the market data provider. Try again in a moment."],
  ['market-data:no-data', 'The market data provider has no prices for this ticker and date range.'],
  ['not-enough-bars', 'This date range has fewer than two trading days to simulate. Widen it.'],
  ['not-found', 'This simulation no longer exists.'],
  ['sim-finalized', 'This simulation is already saved and can no longer be changed.'],
])('maps %s to words', (code, text) => expect(simErrorText(new ApiError(502, code as ApiErrorCode), en)).toBe(text));
test('any http-5xx fallback reads as a server error with its code', () => {
  expect(simErrorText(new ApiError(500, 'http-500'), en)).toBe('The server hit an error (http-500). Try again.');
  expect(simErrorText(new ApiError(503, 'http-503'), en)).toBe('The server hit an error (http-503). Try again.');
});
test('unknown codes fall back to the raw code', () => {
  expect(simErrorText(new ApiError(502, 'market-data:upstream' as ApiErrorCode), en)).toBe('The request failed (market-data:upstream).');
  expect(simErrorText(new ApiError(500, 'internal' as ApiErrorCode), en)).toBe('The request failed (internal).');
  expect(simErrorText(new ApiError(400, 'invalid from' as ApiErrorCode), en)).toBe('The request failed (invalid from).');
  expect(simErrorText(new ApiError(404, 'http-404'), en)).toBe('The request failed (http-404).');
});
test('a non-API error shows its message', () => expect(simErrorText(new Error('offline'), en)).toBe('offline'));
test('ko copy', () => {
  expect(simErrorText(new ApiError(502, 'market-data:http' as ApiErrorCode), ko)).toBe('시세 데이터 제공처에 연결하지 못했습니다. 잠시 후 다시 시도하세요.');
  expect(simErrorText(new ApiError(502, 'market-data:no-data' as ApiErrorCode), ko)).toBe('시세 데이터 제공처에 이 티커와 기간의 가격이 없습니다.');
  expect(simErrorText(new ApiError(422, 'not-enough-bars' as ApiErrorCode), ko)).toBe('이 기간에는 시뮬레이션할 거래일이 두 개 미만입니다. 기간을 넓히세요.');
  expect(simErrorText(new ApiError(404, 'not-found'), ko)).toBe('이 시뮬레이션은 더 이상 존재하지 않습니다.');
  expect(simErrorText(new ApiError(500, 'http-500'), ko)).toBe('서버 오류가 발생했습니다 (http-500). 다시 시도하세요.');
});
```

In `Sim.test.tsx`, add `it('a market-data failure on run reads in words, not as the code', ...)`. Use a POST `/api/sim` route with status 502 and `{ error: 'market-data:http' }`, call `fillBaseFields()` then `submitForm()`, and check that the body text contains `"Couldn't reach the market data provider."` and does not contain `'market-data:http'`.

- [ ] **Step 2: Run to see them fail**

Run: `bun test apps/web/src/simerrors.test.ts apps/web/src/pages/Sim.test.tsx`
Expected: FAIL (module missing; page shows the raw code).

- [ ] **Step 3: Implement**

- `simerrors.ts` per the Interfaces block. The new keys go next to `simErr.sim-finalized` (en.json:333) in `localeCompare` order:

| key | en | ko |
| --- | --- | --- |
| `simErr.market-data:http` | Couldn't reach the market data provider. Try again in a moment. | 시세 데이터 제공처에 연결하지 못했습니다. 잠시 후 다시 시도하세요. |
| `simErr.market-data:no-data` | The market data provider has no prices for this ticker and date range. | 시세 데이터 제공처에 이 티커와 기간의 가격이 없습니다. |
| `simErr.not-enough-bars` | This date range has fewer than two trading days to simulate. Widen it. | 이 기간에는 시뮬레이션할 거래일이 두 개 미만입니다. 기간을 넓히세요. |
| `simErr.not-found` | This simulation no longer exists. | 이 시뮬레이션은 더 이상 존재하지 않습니다. |
| `simErr.server` | The server hit an error ({code}). Try again. | 서버 오류가 발생했습니다 ({code}). 다시 시도하세요. |

- `Sim.tsx`: both catches use `setSubmitError(simErrorText(err, t))`. `SimConfigPanel.fail`: keep the `sim-finalized` → `onApplied()` branch, and use `simErrorText(err, t)` for the text in every branch.

- [ ] **Step 4: Run the task's tests**

Run: `bun test apps/web/src/simerrors.test.ts apps/web/src/pages/Sim.test.tsx apps/web/src/pages/SimDrafts.test.tsx apps/web/src/components/forms/SimConfigPanel.test.tsx apps/web/src/catalog.test.ts`
Expected: PASS. The existing `SimDrafts` "(internal)" test and the `SimConfigPanel` "market-data:upstream" test pass unchanged (Review Focus 4).

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`. Expected: exit 0.

```bash
git add apps/web/src/simerrors.ts apps/web/src/simerrors.test.ts apps/web/src/pages/Sim.tsx apps/web/src/components/forms/SimConfigPanel.tsx apps/web/src/i18n/en.json apps/web/src/i18n/ko.json apps/web/src/pages/Sim.test.tsx
git commit -m "feat: map common sim server error codes to en/ko copy"
```

---

### Task 4: PriceChart effect deps without the eslint-disable

Source: #48 "Web polish", fourth bullet.

The repo has no ESLint config. The only consumer passes `setLatestClose` (`RunDetail.tsx:55,171`), which is a React state setter and therefore stable. Adding `onLatestClose` to the deps is safe and needs no caller change. The fetch stays in `PriceChart`; it is not lifted into `RunDetail`. The `eslint-disable` lines in `hooks.tsx:45` and `SimReplay.tsx:61` are out of scope.

**Files:**
- Modify: `apps/web/src/components/PriceChart.tsx:45-48`
- Test: `apps/web/src/components/PriceChart.test.tsx`

**Interfaces:** none new. `PriceChart` props unchanged.

- [ ] **Step 1: Add a characterisation test**

`it('reports the latest close once per value and not again on a re-render with the same callback', ...)`: create a spy `const seen: (string | null)[] = []; const report = (c: string | null) => seen.push(c);`. Then:
1. `stubFetch(BARS)`, render `d(PriceChart, { runId: 1, onLatestClose: report })`, `flush()`.
2. `expect(seen).toEqual([null, '465000'])`.
3. Render the same element again (same `report`), `flush()`.
4. `expect(seen).toEqual([null, '465000'])`.

- [ ] **Step 2: Run it (passes before the change; it guards the refactor)**

Run: `bun test apps/web/src/components/PriceChart.test.tsx`
Expected: PASS.

- [ ] **Step 3: Implement.** Deps become `[latestClose, onLatestClose]`; delete the `eslint-disable` comment line.

- [ ] **Step 4: Re-run and check**

Run: `bun test apps/web/src/components/PriceChart.test.tsx apps/web/src/pages/RunDetail.test.tsx`
Expected: PASS.
Run: `rg -n "eslint-disable" apps/web/src/components/PriceChart.tsx`
Expected: no output.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`. Expected: exit 0.

```bash
git add apps/web/src/components/PriceChart.tsx apps/web/src/components/PriceChart.test.tsx
git commit -m "refactor: list onLatestClose in PriceChart's effect deps"
```

---

### Task 5: `samePrice` accepts comma-grouped input like `usdToCents`

Source: followups "Code hygiene", `samePrice` line.

`usdToCents` (`api.ts:114-126`) strips grouping only when it is strictly well-formed (`/^\d+(,\d{3})+(\.\d+)?$/`). `samePrice` (`pendingvalues.ts:92-100`) calls `parseUsd` directly and rejects commas. Extract the stripping step into `ungroupUsd` and use it in both places. `samePrice` keeps comparing myriadths, not cents, so sub-cent prices stay exact. `buildOverrides` still validates an *edited* price with `usdOrNull`, which rejects commas, so an unequal grouped price is refused before anything is posted.

**Files:**
- Modify: `apps/web/src/api.ts:113-126`, `apps/web/src/pendingvalues.ts:1-2,91-100`, `apps/web/src/autofee.ts:10`
- Test: `apps/web/src/api.test.ts` (`usdToCents` describe), `apps/web/src/pendingvalues.test.ts` (`pendingEdits` describe), `apps/web/src/components/forms/PendingRow.test.tsx` (create; Task 6 extends it)

**Interfaces:**
- Produces: `ungroupUsd(value: string): string` in `api.ts`. It returns the trimmed text with commas removed when the grouping is well-formed; otherwise it returns the trimmed text unchanged. `usdToCents` calls it.

- [ ] **Step 1: Write the failing tests**

`api.test.ts`:
```ts
describe('ungroupUsd', () => {
  test('strips only well-formed grouping', () => {
    expect(ungroupUsd(' 12,345,678.90 ')).toBe('12345678.90');
    expect(ungroupUsd('1,000.00')).toBe('1000.00');
    expect(ungroupUsd('1,00')).toBe('1,00');
    expect(ungroupUsd('12,34.00')).toBe('12,34.00');
  });
});
```
`pendingvalues.test.ts`:
```ts
test('treats comma-grouped "12,345.00" as the same price as 12345.00', () => {
  const d = { ...detected, price: '123450000' };
  expect(pendingEdits(row(d), { ...same, price: '12,345.00' })).toEqual([]);
  expect(pendingEdits(row(d), { ...same, price: '12,34.00' })).toEqual(['price']);
});
```
`PendingRow.test.tsx` (new file). It uses the `ROW` fixture shape from `PendingTable.test.tsx:24-40` (10 sh @ 12,345.00, fee 100, costPpm 40), `installFetchStub` with POST `/api/pending` → `{ ok: true }` and GET `/api/pending` → `[ROW]`, and renders `PendingTable` with `runId: 7`.
```ts
describe('PendingTable comma-grouped price', () => {
  it('a grouped price equal to the detected one confirms with no overrides and no prompt', async () => {
    // type '12,345.00' into the Price input (aria-label "Price"), click Confirm
    expect(container.querySelector('[role=dialog]')).toBeNull();
    expect(calls[0]!.body).toEqual({});
  });
  it('a grouped price that differs is refused and nothing is posted', async () => {
    // type '12,345.50', click Confirm
    expect(container.textContent).toContain('Check the values: qty and price must be positive');
    expect(calls.length).toBe(0);
  });
});
```
(Review Focus 5 is the second test. `buildOverrides` throws on the edited price before any keep prompt is considered, so no prompt opens and nothing is posted.)

- [ ] **Step 2: Run to see them fail**

Run: `bun test apps/web/src/api.test.ts apps/web/src/pendingvalues.test.ts apps/web/src/components/forms/PendingRow.test.tsx`
Expected: FAIL (`ungroupUsd` missing; the grouped price `'12,345.00'` is refused as invalid, so the first PendingRow test sees nothing posted).

- [ ] **Step 3: Implement** `ungroupUsd`. Refactor `usdToCents` to use it, and make `samePrice` call `parseUsd(ungroupUsd(s))`. `autoFeeUsd` calls `usdOrNull(ungroupUsd(price))`: a grouped price that now reads as unedited must still derive its fee, or the placeholder (Task 6) and the default-fee popup (Task 10) silently disappear for it.

- [ ] **Step 4: Run the task's tests**

Run: `bun test apps/web/src/api.test.ts apps/web/src/pendingvalues.test.ts apps/web/src/components/forms/PendingRow.test.tsx apps/web/src/components/forms/PendingTable.test.tsx`
Expected: PASS. Then run `wc -l apps/web/src/pendingvalues.test.ts`: expected ≤ ~300.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`. Expected: exit 0.

```bash
git add apps/web/src/api.ts apps/web/src/api.test.ts apps/web/src/pendingvalues.ts apps/web/src/pendingvalues.test.ts apps/web/src/components/forms/PendingRow.test.tsx
git commit -m "fix: comma-grouped prices compare equal on pending rows, as usdToCents already reads them"
```

---

### Task 6: Pending table: thumbnail column name and the fee a blank field books

Sources: followups "Accessibility and layout", first bullet (thumbnail column `<Th />`); "Behaviour an operator could notice", fourth bullet (cleared fee shows nothing).

Decisions:
- The thumbnail header gets sr-only text.
- The placeholder shows whenever the fee field is blank and a fee is derivable, on a feeless row **and** on a row whose read fee was cleared. In both cases the server books `feeCents(price, shares, costPpm)`: a blank confirm posts `feeCents: null` (`confirm-pending.ts:41` → `booking.ts:110-111`). The source names only the feeless case; showing it in both is what the server does. Operator: confirm.
- The derived value comes from the existing `autoFeeUsd(values.shares, values.price, row.costPpm)` (`apps/web/src/autofee.ts`). When that returns `''`, there is no placeholder. The existing `data-auto-fee` "auto" marker (`feeIsDerived`) is unchanged.

**Files:**
- Modify: `apps/web/src/components/forms/PendingTable.tsx:145`, `apps/web/src/components/forms/PendingRow.tsx:100-107`
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Test: `apps/web/src/components/forms/PendingRow.test.tsx`

**Interfaces:** none new. `PendingRow` props unchanged.

- [ ] **Step 1: Write the failing tests in `PendingRow.test.tsx`**

Header test: render `PendingTable` as in Task 5. Row tests: render `PendingRow` directly inside `<table><tbody>`, with `values` built by hand (`shares: '10'`, `price: '12345.00'` unless a test says otherwise) and `onChange` a no-op. `feeInput = container.querySelector('input[aria-label="Fee"]')`.

```ts
describe('PendingTable header', () => {
  it('names the thumbnail column for screen readers', async () => {
    const th = Array.from(container.querySelectorAll('thead th'))[6]!;
    const label = th.querySelector('.sr-only')!;
    expect(label.textContent).toBe('Screenshot');
    expect(lookup('ko', 'pendingColScreenshot')).toBe('스크린샷');
  });
});
describe('PendingRow blank fee', () => {
  // 10 sh @ 12,345.00 at 40 ppm derives $4.94
  it('a cleared fee on a feeless row shows the fee the server will book', () => {
    // row: fee null, detected.fee null; values.fee ''
    expect(feeInput().placeholder).toBe('auto $4.94');
  });
  it('a cleared fee vision did read shows the recomputed fee too', () => {
    // row: ROW (fee 100); values.fee ''
    expect(feeInput().placeholder).toBe('auto $4.94');
  });
  it('a comma-grouped price still derives the placeholder', () => {
    // feeless row; values.price '12,345.00', values.fee ''
    expect(feeInput().placeholder).toBe('auto $4.94');
  });
  it('no placeholder while the field holds a fee', () => {
    // values.fee '4.94'
    expect(feeInput().getAttribute('placeholder')).toBeNull();
  });
  it('no placeholder when qty or price do not parse', () => {
    // values.fee '', shares 'x'
    expect(feeInput().getAttribute('placeholder')).toBeNull();
  });
  it('ko copy', () => {
    expect(lookup('ko', 'pendingFeeAutoPlaceholder', { fee: '4.94' })).toBe('자동 $4.94');
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test apps/web/src/components/forms/PendingRow.test.tsx`
Expected: FAIL (no `.sr-only`; placeholder empty).

- [ ] **Step 3: Implement**

- Catalog keys:
  - `pendingColScreenshot`: en `"Screenshot"`, ko `"스크린샷"`.
  - `pendingFeeAutoPlaceholder`: en `"auto ${fee}"`, ko `"자동 ${fee}"`. The `$` is literal catalog text before the `{fee}` placeholder; callers pass the bare amount (`{ fee: '4.94' }` → `auto $4.94`).
- `PendingTable.tsx:145`: `<Th><span className="sr-only">{t('pendingColScreenshot')}</span></Th>`.
- `PendingRow.tsx`: compute `blankFee = values.fee.trim() === '' ? autoFeeUsd(values.shares, values.price, row.costPpm) : ''`. Pass `placeholder={blankFee ? t('pendingFeeAutoPlaceholder', { fee: blankFee }) : undefined}` to the fee `Input`.

- [ ] **Step 4: Run the task's tests**

Run: `bun test apps/web/src/components/forms/PendingRow.test.tsx apps/web/src/components/forms/PendingTable.test.tsx apps/web/src/catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`. Expected: exit 0.

```bash
git add apps/web/src/components/forms/PendingTable.tsx apps/web/src/components/forms/PendingRow.tsx apps/web/src/components/forms/PendingRow.test.tsx apps/web/src/i18n/en.json apps/web/src/i18n/ko.json
git commit -m "feat: name the pending thumbnail column and show the fee a blank field books"
```

---

### Task 7: Review tab: row-label column name and a non-colour change marker

Source: followups "Accessibility and layout", first and second bullets.

Decisions:
- The row-label header (`VisionReviewEntry.tsx:153`) gets sr-only text "Source", because the column holds "Vision read" / "Final".
- Each changed cell gets a visible `✎` glyph as a **sibling after** the `[data-field]` span, with `role="img"` and `aria-label` = "changed". It sits outside the span so the existing `cell(...).textContent` assertions in `VisionReview.test.tsx` stay exact.

**Files:**
- Modify: `apps/web/src/components/VisionReviewEntry.tsx:70-91,153`
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Create: `apps/web/src/components/VisionReviewEntry.test.tsx`

**Interfaces:** none new.

- [ ] **Step 1: Write `VisionReviewEntry.test.tsx`**

Render `d(LangProvider, null, d(VisionReviewEntry, { entry, onDelete: () => {} }))`. For ko, `localStorage.setItem('st-lang', 'ko')` before rendering and remove it in `afterEach` (the pattern from `FillTable.test.tsx:12,57`). Use one EDITED fixture copied from `VisionReview.test.tsx:27-34` (price corrected 123.45 → 125.50, fee derived).

```ts
it('names the row-label column for screen readers', () => {
  const th = container.querySelectorAll('thead th')[1]!;
  expect(th.querySelector('.sr-only')!.textContent).toBe('Source');
});
it('marks a changed field with a labelled glyph as well as the tint', () => {
  for (const kind of ['detected', 'final']) {
    const tr = container.querySelector(`[data-fill="11"][data-row="${kind}"]`)!;
    const marks = tr.querySelectorAll('[role="img"][aria-label="changed"]');
    expect(marks.length).toBe(1);
    expect(marks[0]!.closest('td')!.querySelector('[data-field]')!.getAttribute('data-field')).toBe('price');
    expect(marks[0]!.textContent).toBe('✎');
  }
});
it('an unchanged fill carries no marker', () => { /* UNEDITED fixture */ expect(container.querySelector('[role="img"]')).toBeNull(); });
it('ko names', () => {
  // st-lang = ko
  expect(container.querySelectorAll('thead th')[1]!.querySelector('.sr-only')!.textContent).toBe('출처');
  expect(container.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('변경됨');
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test apps/web/src/components/VisionReviewEntry.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Keys: `visionReviewChangedMark` (en `"changed"`, ko `"변경됨"`) and `visionReviewColSource` (en `"Source"`, ko `"출처"`).
- Header: `<Th><span className="sr-only">{t('visionReviewColSource')}</span></Th>`.
- Cell: when `isChanged`, render `<span role="img" aria-label={t('visionReviewChangedMark')} className="ml-1 text-warning">✎</span>` after the `[data-field]` span. Keep tint + bold.

- [ ] **Step 4: Run the task's tests**

Run: `bun test apps/web/src/components/VisionReviewEntry.test.tsx apps/web/src/pages/VisionReview.test.tsx apps/web/src/catalog.test.ts`
Expected: PASS (existing page tests unchanged).

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`. Expected: exit 0.

```bash
git add apps/web/src/components/VisionReviewEntry.tsx apps/web/src/components/VisionReviewEntry.test.tsx apps/web/src/i18n/en.json apps/web/src/i18n/ko.json
git commit -m "feat: name the review tab's row-label column and mark changed fields without relying on colour"
```

---

### Task 8: Review tab delete/load errors next to the armed entry

Source: followups "Accessibility and layout", third bullet.

The bullet says "pending row", but the state it names (`deleteError`) and the armed-delete flow live on the review tab: `pages/VisionReview.tsx:13,33` and `VisionReviewEntry.tsx:115-144`. Pending rows have no delete. Operator: confirm this reading.

Rules:
- The page tracks `lastDeleteId: number | null` (set at the start of `remove`, cleared on cancel) and `deleteError: string | null` (cleared at the start of `remove` and on cancel).
- An entry's error is `entry.captureId === lastDeleteId ? (deleteError ?? (data ? error : null)) : null`. Every reload on this page is triggered by a delete, so a list error while entries are on screen belongs to that entry.
- The page-level `ErrorNote` for `error` renders only when it is not attributed this way, for example on the initial load.
- `VisionReviewEntry` renders the error as an `ErrorNote` inside the armed box, under the warning. The entry stays armed after a failure (unchanged local state), and Cancel calls `onCancel`.

Wave C planned a test of "the failed-delete error text and the entry staying armed". This task's tests cover that, so tell the wave C implementer to drop theirs if this lands first.

**Files:**
- Modify: `apps/web/src/pages/VisionReview.tsx`, `apps/web/src/components/VisionReviewEntry.tsx:105-144`
- Test: `apps/web/src/pages/VisionReview.test.tsx:264-282` (replace the existing failure test) plus two new tests

**Interfaces:**
- Produces: `VisionReviewEntry` gains the props `error?: string | null` and `onCancel?: () => void`.

- [ ] **Step 1: Write the failing tests in `VisionReview.test.tsx`**

Replace `shows the error and keeps the list when the delete fails` with:
```ts
it('shows a failed delete inside the armed entry, not at page level', async () => {
  // reinstall the stub: DELETE /3 → 500 { error: 'boom' }; the list returns
  // { entries: [entry(3, [EDITED]), entry(5, [REJECTED])] }; render those same two entries
  // Delete → Delete for real on card 0
  const alerts = container.querySelectorAll('[role=alert]');
  expect(alerts.length).toBe(1);
  expect(cards()[0]!.contains(alerts[0]!)).toBe(true);
  expect(alerts[0]!.textContent).toBe('boom');
  expect(button('Delete for real', cards()[0]!)).toBeTruthy();   // still armed
  expect(cards()[1]!.querySelector('[role=alert]')).toBeNull();
});
it('Cancel after a failed delete clears the error', async () => {
  // same failure, then Cancel on card 0
  expect(container.querySelector('[role=alert]')).toBeNull();
  expect(Array.from(cards()[0]!.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Delete']);
});
it('a reload that fails after a delete shows next to that entry', async () => {
  // DELETE /3 → 200; list GET now → 500 { error: 'list-down' }; Delete → Delete for real on card 0
  const alerts = container.querySelectorAll('[role=alert]');
  expect(alerts.length).toBe(1);
  expect(cards()[0]!.contains(alerts[0]!)).toBe(true);
  expect(alerts[0]!.textContent).toBe('list-down');
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test apps/web/src/pages/VisionReview.test.tsx`
Expected: FAIL (the alert sits outside the card; Cancel leaves it).

- [ ] **Step 3: Implement** the rules above in `VisionReview.tsx` and the two props in `VisionReviewEntry.tsx`.

- [ ] **Step 4: Run the task's tests**

Run: `bun test apps/web/src/pages/VisionReview.test.tsx apps/web/src/components/VisionReviewEntry.test.tsx`
Expected: PASS. Then run `wc -l apps/web/src/pages/VisionReview.test.tsx`: expected ≤ 300. If it is over (likely: 283 lines today), move the three delete-error tests into `apps/web/src/pages/VisionReviewDelete.test.tsx` with the shared `render` helper.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`. Expected: exit 0.

```bash
git add apps/web/src/pages/VisionReview.tsx apps/web/src/components/VisionReviewEntry.tsx apps/web/src/pages/VisionReview.test.tsx
git commit -m "fix: show review-tab delete and reload errors in the armed entry; cancel clears them"
```

---

### Task 9: Pending row actions stay visible on narrow screens (sticky column)

Source: followups "Accessibility and layout", fourth bullet. Operator ruling 2026-11-20: apply the sticky fix without a manual browser check.

**Files:**
- Modify: `apps/web/src/components/forms/PendingTable.tsx` (the actions `Th`, currently `:147`), `apps/web/src/components/forms/PendingRow.tsx` (the actions `Td`, currently `:128`)
- Test: `apps/web/src/components/forms/PendingRow.test.tsx`

- [ ] **Step 1: Write the failing test.** Add `it('keeps the actions column pinned while the table scrolls', ...)`. It renders `PendingTable` as in Task 5 and asserts that the last `thead th` and the last `td` of the row both have a `classList` containing `sticky`, `right-0` and `bg-card`.
- [ ] **Step 2: Run `bun test apps/web/src/components/forms/PendingRow.test.tsx`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add `sticky right-0 bg-card` to the actions `Th` and `Td` `className`s. `TableWrap` already scrolls sideways with `overflow-x-auto`, so nothing else changes.
- [ ] **Step 4: Run `bun test apps/web/src/components/forms`.** Expected: PASS.
- [ ] **Step 5: Commit** `fix: keep pending row actions visible while the table scrolls on narrow screens`.

---

### Task 10: Hint edited and erased values; confirm a blank fee with a default-fee popup

Source: operator ruling 2026-11-20 on the parked `fee_overridden` item:
- "highlight all overrides including cleared fees"
- "visually hint user for updated or erased values"
- "if fee is cleared and then submitted, show alert popup that default fee of fee rate * price * quantity will be used instead"

The server side of this ruling (keep `fee_overridden` = "any fee override, null included") is wave B Task 9.

Rules:
- **Edited hint.** A field in `pendingEdits(row, values)` with a non-blank value gets `data-edit="changed"`, the class `ring-1 ring-primary`, and `title={t('pendingFieldChanged')}`.
- **Erased hint.** A field whose value is blank while the detected value (or, for a legacy row, the row's own value) was non-null gets `data-edit="erased"` and the classes `border-dashed border-warning`. This covers a fee vision read and the operator cleared, and a feeless row whose prefilled derived fee was cleared. The `title` depends on the field: `t('pendingFeeErased')` for the fee, because the server books the default fee; `t('pendingFieldErased')` for date, qty and price, because confirm refuses a blank one (`buildOverrides` throws `pendingInvalidOverride`). The side select cannot be blanked once set.
- **The standing-issue border wins.** The `missing(...)` `border-warning` for a field vision missed takes precedence: such a field gets no edit hint until it is filled in.
- **Default-fee popup.** On Confirm, after `buildOverrides` succeeds, if `values.fee.trim() === ''` and `autoFeeUsd(values.shares, values.price, row.costPpm) !== ''`, a `DefaultFeePrompt` modal opens before anything else. "Use default fee" continues to the keep/discard prompt when `asksAboutImage` holds, otherwise it submits. "Go back" (or closing the modal) cancels and posts nothing. The popup never appears on Reject.

**Files:**
- Create: `apps/web/src/components/forms/DefaultFeePrompt.tsx`, `apps/web/src/components/forms/DefaultFeePrompt.test.tsx`
- Create: `apps/web/src/fieldeditstate.test.ts`, `apps/web/src/components/forms/PendingDefaultFee.test.tsx`
- Modify: `apps/web/src/pendingvalues.ts` (add `fieldEditState`)
- Modify: `apps/web/src/components/forms/PendingTable.test.tsx`: two existing tests confirm with a blank fee and now meet the popup. In `clearing the field posts nothing, since the server derives that fee anyway` (`:533`) and `clearing a fee vision read posts feeCents null (recompute)` (`:616`), press `'Use default fee'` after Confirm and before the keep step or the body check. Do the same for any other existing test that confirms with a blank fee, and name it in the report. Add nothing else to this file.
- Modify: `apps/web/src/components/forms/PendingRow.tsx` (hints), `apps/web/src/components/forms/PendingTable.tsx` (the popup stage in `act`)
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Test: `apps/web/src/components/forms/PendingRow.test.tsx`

**Interfaces:**
- Consumes: `costPercentText` (Task 1), `autoFeeUsd` (`apps/web/src/autofee.ts`), `Modal`/`Button` (`components/ui.tsx`).
- Produces: `fieldEditState(row: PendingFillDto, values: RowValues, field: RowField): 'changed' | 'erased' | null` in `pendingvalues.ts`.
- Produces: `DefaultFeePrompt({ rate, price, shares, fee, onUse, onBack }: { rate: string; price: string; shares: string; fee: string; onUse: () => void; onBack: () => void })`.
- `PendingTable`'s `Decision` gains `stage: 'fee' | 'keep'`. `act` sets `stage: 'fee'` when the popup applies and `stage: 'keep'` when it skips the popup and `asksAboutImage` holds. `onUse` either moves the same decision to `stage: 'keep'` (when `asksAboutImage`) or calls `submit`. `KeepImagePrompt` renders only when `decision?.stage === 'keep'`.

Copy (slot the keys in `localeCompare` order; `{rate}` is `costPercentText(row.costPpm)`, e.g. `0.004%` for 40 ppm: 12,345.00 × 10 × 0.004% = $4.94):

| key | en | ko |
| --- | --- | --- |
| `pendingDefaultFeeBack` | Go back | 돌아가기 |
| `pendingDefaultFeeBody` | The fee is empty, so the default fee will be booked: {rate} × ${price} × {shares} sh = ${fee}. | 수수료가 비어 있어 기본 수수료가 적용됩니다: {rate} × ${price} × {shares}주 = ${fee}. |
| `pendingDefaultFeeTitle` | Use the default fee? | 기본 수수료를 적용할까요? |
| `pendingDefaultFeeUse` | Use default fee | 기본 수수료 사용 |
| `pendingFeeErased` | Cleared — the default fee will be booked | 지워짐 — 기본 수수료가 적용됩니다 |
| `pendingFieldChanged` | Changed from what vision read | 비전 판독값에서 변경됨 |
| `pendingFieldErased` | Cleared — enter a value before confirming | 지워짐 — 확인 전에 값을 입력하세요 |

- [ ] **Step 1: Write the failing tests.**
  - `fieldeditstate.test.ts` (new file; build the row and values with the same fixtures as `pendingvalues.test.ts`), `describe('fieldEditState')`:
    - An untouched row gives `null` for every field.
    - A qty of `'11'` on a 10-share row gives `'changed'`.
    - A fee of `''` on a row whose detected fee is `100` gives `'erased'`.
    - A fee of `''` on a feeless row (detected fee `null`, prefilled with the derived fee) gives `'erased'`.
    - A price of `''` gives `'erased'`.
    - A `filledOn` of `''` on a row whose detected date exists gives `'erased'`.
    - A detected `filledOn` of `null` with value `''` gives `null`, because the standing issue owns that field.
  - `DefaultFeePrompt.test.tsx`:
    - Rendering with `{ rate: '0.004%', price: '12,345.00', shares: '10', fee: '4.94' }` shows the en body `'The fee is empty, so the default fee will be booked: 0.004% × $12,345.00 × 10 sh = $4.94.'`.
    - "Use default fee" calls `onUse` once; "Go back" and `✕` call `onBack`.
    - The ko body is `'수수료가 비어 있어 기본 수수료가 적용됩니다: 0.004% × $12,345.00 × 10주 = $4.94.'`.
  - `PendingRow.test.tsx`, `describe('edit hints')`:
    - After typing qty `'11'`, the qty input has `data-edit="changed"` and its `title` is `'Changed from what vision read'`.
    - After clearing the fee on the `ROW` fixture (fee 100), the fee input has `data-edit="erased"` and its `title` is `'Cleared — the default fee will be booked'`.
    - After clearing the price, the price input has `data-edit="erased"` and its `title` is `'Cleared — enter a value before confirming'`.
    - An untouched row has no `[data-edit]` element.
  - `PendingDefaultFee.test.tsx` (new file), `describe('default fee popup')`, using `PendingTable` with the same confirm-call recorder as Task 5 (copy the helper, as each web test file does):
    - `clearing a read fee asks before booking the default fee, then confirms with feeCents null`:
      1. Clear the fee and click Confirm. A dialog titled `'Use the default fee?'` is open, its body contains `'0.004% × $12345.00 × 10 sh = $4.94'` (the price as the field holds it), and `calls.length` is `0`.
      2. Press `'Use default fee'`. The keep prompt opens (the row has an image, and the fee is an edit).
      3. Press `'Discard'`. `calls[0].body` is `{ overrides: { feeCents: null } }`. Discard sends no `keepImage`: `api.confirmPending` adds it only when it is true, and that request shape must not change.
    - `Go back posts nothing and leaves the field blank`: after Go back, `calls.length` is `0`, no dialog is open, and the fee input value is `''`.
    - `a blank fee on a feeless row asks too, then confirms with no overrides`: on a row with `fee: null`, `detected.fee: null` and `hasImage: false`, clear the fee, click Confirm and press `'Use default fee'`. Then `calls[0].body` is `{}`.
    - `a comma-grouped price still gets the popup`: on the feeless row, type the price `'12,345.00'`, clear the fee and click Confirm. The dialog `'Use the default fee?'` is open and its body contains `'$12,345.00'`.
    - `a typed fee never shows the popup`: set the fee to `'1.00'` and click Confirm. No `'Use the default fee?'` dialog appears.
    - `Reject never shows the popup`.
- [ ] **Step 2: Run `bun test apps/web/src/fieldeditstate.test.ts apps/web/src/components/forms/DefaultFeePrompt.test.tsx apps/web/src/components/forms/PendingDefaultFee.test.tsx apps/web/src/components/forms/PendingRow.test.tsx`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `fieldEditState`, checked in order:
    1. `null` for the field `standingIssue` names.
    2. `'erased'` when `values[field].trim() === ''` and either the detected value is non-null (same `d` fallback as `pendingEdits`) or the field is `fee` and `autoFeeUsd(values.shares, values.price, row.costPpm) !== ''`. The second case covers a feeless row whose derived prefill was cleared.
    3. `'changed'` when `pendingEdits` includes the field.
    4. Otherwise `null`.
  - `PendingRow`: pass `data-edit`, the class and the `title` to each of the five controls through one small helper.
  - `PendingTable`: add the `'fee'` stage before the keep stage, and render `DefaultFeePrompt` when `decision?.stage === 'fee'`. Use `values.price` for the price shown, with grouping kept as typed.
  - Wave B Task 8 has already added the `archived` note to `submit`. Leave it intact.
- [ ] **Step 4: Run `bun test apps/web && bun run typecheck`.** Expected: PASS, exit 0, including `catalog.test.ts`. Run `wc -l apps/web/src/components/forms/PendingTable.tsx apps/web/src/components/forms/PendingRow.tsx apps/web/src/components/forms/PendingRow.test.tsx apps/web/src/components/forms/PendingDefaultFee.test.tsx apps/web/src/fieldeditstate.test.ts apps/web/src/pendingvalues.ts`: each must be ≤ ~300 lines.
- [ ] **Step 5: Commit** `feat: hint edited and erased pending values and confirm a blank fee with the default-fee formula`.

---

### Task 11: Final verification

- [ ] **Step 1:** Run `bun test`. Expected: all pass (`db.test.ts` self-skips).
- [ ] **Step 2:** Run `bun run typecheck`. Expected: exit 0.
- [ ] **Step 3:** Run `git diff main --stat -- apps/server packages`. Expected: empty (no server changes).
- [ ] **Step 4:** Run `rg -n "[\p{Han}\p{Cyrillic}]" apps/web/src docs/superpowers/plans/2026-11-18-web-polish-a11y.md`. Expected: no output.

---

## Not in this wave

- The Korean native read of every machine-translated string, including `keepImageDiscard`'s "삭제" wording (#50, needs a human).
- Any server-side change. That includes the parked missed-date and `fee_overridden` rulings, the archive janitor, `{ archived: false }` (wave B), the non-transactional review delete and the `GET /api/pending` N+1.
- Test-only gaps for existing behaviour (wave C).
- `eslint-disable` lines in `hooks.tsx:45` and `SimReplay.tsx:61` (the repo has no ESLint; not raised by the sources).
