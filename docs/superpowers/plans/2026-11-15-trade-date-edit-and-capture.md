# Trade Date Editing + Capture Date Extraction — Implementation Plan

Spec: `docs/superpowers/specs/2026-11-15-trade-date-edit-and-capture-design.md`

Work in a dedicated worktree (skill `using-git-worktrees`), branch `feature/trade-date`.
Every task is TDD: write the failing test, run it, implement, re-run, `bun run typecheck`, commit.
All commands run from the repo root. Tests that don't need a DB: `bun test <file>`.

Conventions reminder: `filledOn` is an `ISODate` string `YYYY-MM-DD`; server tests use the
fake-repo style of their own suite; commits are `feat:` / `test:` scoped per task below.

---

## Task 1 — Domain: `rebookFill` accepts a new trade date

**Files**
- test: `apps/server/test/rebooking.test.ts` (append into the existing `describe('rebookFill')`)
- src: `apps/server/src/domain/recompute.ts`
- src: `apps/server/src/db/repos.ts` (patch type widening only)

**Interface decided**
- `RebookEdit` gains `filledOn?: ISODate`. When absent the stored date is untouched.
- `rebookFill` builds ONE patch object reused in three places: the replayed history row,
  `fillRepo.update`, and the returned `fill`.

**Test to add** (in `describe('rebookFill')`, after the existing tests; `fakeRepos`/`deps`/
`getState`/`createRun`/`bookBuy`/`ageOf` helpers already exist in this file, `TODAY = '2026-01-15'`):

```ts
test('rebooking the trade date recomputes bucket age and persists the date', async () => {
  const f = fakeRepos()
  const runId = await createRun(f, 100_000, 2)
  await bookBuy(f, runId, { idx: 0, shares: 10, price: '10.00', feeCents: 500, filledOn: '2026-01-14' })
  expect((await getState(f, runId)).ages.[0]).toBe(ageOf('2026-01-14'))
  const res = await rebookFill(runId, { fillId: 1, shares: 10, priceStr: '10.00', feeCents: 500, filledOn: '2026-01-08' }, deps(f))
  expect(res.fill.filledOn).toBe('2026-01-08')
  expect(res.deltaCents).toBe(0) // same shares/price/fee: cash effect is only the age shift
  expect(f._stores.fills.find((x: any) => x.id === 1)).toMatchObject({ filledOn: '2026-01-08', shares: 10 })
  const st = await getState(f, runId)
  expect(st.ages.[0]).toBe(ageOf('2026-01-08'))
  expect(ageOf('2026-01-08')).toBeGreaterThan(ageOf('2026-01-14')) // the age really moved
})
```

Note: `rebuildState` writes an `adjust` ledger row only when `delta !== 0`; with an unchanged
qty/price/fee there is none — do not assert on `adjustRows(f)` here.

**Implementation** in `rebookFill` (`apps/server/src/domain/recompute.ts`):

```ts
export interface RebookEdit { fillId: number; shares: number; priceStr: string; feeCents: number | null; filledOn?: ISODate }
```

Replace the three patched-row expressions (history map ~line 66, `fillRepo.update` ~line 71,
return ~line 75) with one patch:

```ts
const patch = { shares: edit.shares, price, fee, ...(edit.filledOn ? { filledOn: edit.filledOn } : {}) }
const patched = history.map((f) => (f.id === edit.fillId ? { ...f, ...patch } : f))
// ...rebuild unchanged...
await repos.fillRepo.update(runId, edit.fillId, patch)
// ...ledger unchanged...
return { fill: { ...match, ...patch }, deltaCents: delta }
```

In `apps/server/src/db/repos.ts` widen the `fillRepo.update` patch type
(~line 122) to `{ shares?: number; price?: bigint; fee?: number; filledOn?: string }`.
No migration — the `fills.filledOn` column already exists.

**Run:** `bun test apps/server/test/rebooking.test.ts` → all pass. **Commit:**
`feat: allow rebooking a fill's trade date`

---

## Task 2 — Route: PUT `/runs/:id/fills/:fillId` accepts `filledOn`

**Files**
- test: `apps/server/test/http.test.ts`
- src: `apps/server/src/http/routes/fills.ts`

**Test to add** (new `describe('http fill edit date', ...)`, style: reuse `makeFakes` /
`makeDeps` / `createApp` exactly like the other describes in this file; `deps.today()` is
`'2026-11-10'`):

```ts
test('PUT fill with filledOn updates the stored date; invalid filledOn is 400', async () => {
  const f = makeFakes()
  const app = createApp(makeDeps(f))
  const auth = { Authorization: `Bearer ${(await (await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })).json()).token}` }
  const id = (await (await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r', ticker: 'A', costPpm: 100, poolCents: 100000 }), headers: { 'content-type': 'application/json', ...auth } })).json()).id
  await app.request(`/api/runs/${id}/fills`, { method: 'POST', body: JSON.stringify({ side: 'buy', shares: 10, price: '10.00', filledOn: '2026-11-09' }), headers: { 'content-type': 'application/json', ...auth } })
  const fillId = f.fills[0]!.id

  const ok = await app.request(`/api/runs/${id}/fills/${fillId}`, { method: 'PUT', body: JSON.stringify({ qty: 10, priceCents: 1000, feeCents: 500, filledOn: '2026-11-03' }), headers: { 'content-type': 'application/json', ...auth } })
  expect(ok.status).toBe(200)
  expect(f.fills[0]!.filledOn).toBe('2026-11-03')

  for (const bad of ['11/03', '2026-11-3', 'yesterday', '']) {
    const res = await app.request(`/api/runs/${id}/fills/${fillId}`, { method: 'PUT', body: JSON.stringify({ qty: 10, priceCents: 1000, feeCents: 500, filledOn: bad }), headers: { 'content-type': 'application/json', ...auth } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid-body')
  }
  expect(f.fills[0]!.filledOn).toBe('2026-11-03') // rejected bodies never touched the row

  // omitted filledOn keeps the stored date (regression guard for Task 1's optional patch)
  const keep = await app.request(`/api/runs/${id}/fills/${fillId}`, { method: 'PUT', body: JSON.stringify({ qty: 12, priceCents: 1000, feeCents: 500 }), headers: { 'content-type': 'application/json', ...auth } })
  expect(keep.status).toBe(200)
  expect(f.fills[0]!.filledOn).toBe('2026-11-03')
})
```

If the manual-fill POST fake needs `price` as a string check `runs.ts` (~line 229) body
shape first — it takes `{ side, shares, price, fee?, filledOn }` and the fake `fillRepo.insert`
just pushes what `manualFill` passes.

**Implementation** in `fills.ts` PUT handler: destructure `filledOn` from the body, validate
in the existing guard — when `filledOn !== undefined` it must be a string matching
`/^\d{4}-\d{2}-\d{2}$/`, else `invalid-body` 400 — and forward it in the `rebookFill` call
(`filledOn: filledOn as string | undefined`). Add the ISO regex as a module const
(`const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/`).

**Run:** `bun test apps/server/test/http.test.ts`. **Commit:**
`feat: accept filledOn on the fill-edit PUT route`

---

## Task 3 — Ingest: extract the execution date from the screenshot

**Files**
- test: `packages/ingest/test/extract.test.ts`
- src: `packages/ingest/src/prompt.ts`
- src: `packages/ingest/src/extract.ts`
- src: `apps/server/src/wire/capture.ts`

**Interface decided**
- `RawFill` gains `date?: string` (ISO `YYYY-MM-DD`).
- `VisionConfig` gains `today?: string` (ISO). When present it is appended to the prompt and
  used to window-validate extracted dates; when absent any regex-valid date is kept.
- Window: `|date − today| <= 45 days`, inclusive. Out-of-window or malformed ⇒ field dropped,
  fill kept. Never invalidate a fill over its date.

**Tests to add** (existing `fakeFetch`/`okJson`/`CFG` helpers; the suite already uses
a)…h), so these commit as i) and j)):

```ts
test('i) keeps an ISO date inside the window and injects today into the prompt', async () => {
  const content = '{"fills":[{"side":"buy","ticker":"SOXL","shares":"10","price":"4.20","date":"2026-11-14"}]}';
  const f = fakeFetch([okJson(content)]);
  const r = await extractFills([{ base64: 'AAAA', mime: 'image/png' }], { ...CFG, today: '2026-11-15' }, f);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.fills[0]!.date).toBe('2026-11-14');
  const body = JSON.parse(f.calls[0].init.body);
  const text = body.messages[0].content[0].text as string;
  expect(text).toContain('Today is 2026-11-15');
});

test('j) drops malformed or far-out dates but keeps the fill', async () => {
  const content = JSON.stringify({ fills: [
    { side: 'buy', ticker: 'A', shares: '1', price: '1.00', date: '11.14' },
    { side: 'buy', ticker: 'B', shares: '1', price: '1.00', date: '2025-06-01' },
    { side: 'buy', ticker: 'C', shares: '1', price: '1.00', date: '2026-11-14T00:00:00' },
    { side: 'buy', ticker: 'D', shares: '1', price: '1.00', date: '2026-10-01' },
  ]});
  const f = fakeFetch([okJson(content)]);
  const r = await extractFills([{ base64: 'AAAA', mime: 'image/png' }], { ...CFG, today: '2026-11-15' }, f);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.fills.map((x) => x.ticker)).toEqual(['A', 'B', 'C', 'D']); // all fills survive
    expect(r.fills.map((x) => x.date)).toEqual([undefined, undefined, undefined, '2026-10-01']);
  }
});
```

`'2026-10-01'` is 45 days before `2026-11-15` (inclusive boundary, kept); `'2025-06-01'` is far out
(dropped). No `today` in `CFG` elsewhere keeps existing tests green because `date` is
optional and window checks only run when `today` is set — do not break tests a)–f).

**Implementation**

`packages/ingest/src/prompt.ts` — in `MPOP_FILL_EXTRACTION_PROMPT` add, to the per-fill field
list (next to the `fee` bullet):

```
- date: the execution date shown in the screenshot (당일체결 header or row date, e.g. "11.14", "2026.11.14", "Nov 14, 2026") as "YYYY-MM-DD".
```

and to the output-shape section after the `fee` line: `- date is an optional "YYYY-MM-DD" string.`
Also extend the example JSON object to include `"date":"2026-11-14"`.

`packages/ingest/src/extract.ts`:

```ts
export interface VisionConfig { baseUrl: string; apiKey: string; model: string; maxTokens: number; today?: string }
export interface RawFill { side: 'buy' | 'sell'; ticker: string; shares: number; price: string; fee?: string; date?: string }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
```

In `normalizeFill`, after the fee handling, before `return f`:

```ts
if (typeof raw?.date === 'string' && DATE_RE.test(raw.date.trim())) f.date = raw.date.trim();
```

In `extractFills`, window-filter after `normalizeFill`+`validateFill` pass (fills survive,
field goes):

```ts
if (nf.date && cfg.today && Math.abs(Date.parse(nf.date) - Date.parse(cfg.today)) > 45 * DAY_MS) delete nf.date;
```

And build the prompt text with the today line:

```ts
// `text` is taken by an existing local in extractFills — hence promptText.
const promptText = cfg.today ? `${MPOP_FILL_EXTRACTION_PROMPT}\nToday is ${cfg.today}. Resolve dates that omit the year against it.` : MPOP_FILL_EXTRACTION_PROMPT;
const content: any[] = [{ type: 'text', text: promptText }];
```

`apps/server/src/wire/capture.ts` — in `extractOrTell` add `today: deps.today()` to the
`cfg` literal (line ~31-36). That is the only wiring point: pinned and auto-route paths both
call `extractOrTell`.

**Run:** `bun test packages/ingest/test/extract.test.ts` and `bun test apps/server/test/wire.test.ts`
(wire tests use a fake fetch and don't assert bodies, so they only need to stay green).
**Commit:** `feat: extract the execution date from mPOP screenshots`

---

## Task 4 — Booking: pending rows carry the extracted date

**Files**
- test: `apps/server/test/booking.test.ts`
- src: `apps/server/src/domain/booking.ts`

**Test to add** (same style as the existing ingest capture tests; `fakeRepos()` from this
file, `deps.today = '2026-11-06'`):

```ts
test('capture with extracted dates books pendings on the screenshot date', async () => {
  const f = fakeRepos()
  const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
  const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'rd', poolCents: 100000, costPpm: 100, initialRunState: emptyState(2) })
  const ext: ExtractResult = { ok: true, fills: [
    { side: 'buy', ticker: 'AAPL', shares: 5, price: '10.00', date: '2026-11-04' },
    { side: 'buy', ticker: 'AAPL', shares: 2, price: '9.00' },
  ] }
  const out = await ingestCapture(runId, { base64: 'AAAA', mime: 'image/png' }, ext, deps)
  expect(out).not.toBe('duplicate')
  if (out === 'duplicate' || out === 'rejected') throw new Error('unreachable')
  expect(out.pending.map((p) => p.filledOn)).toEqual(['2026-11-04', '2026-11-06'])
  expect(f._stores.pending.map((p: any) => p.filledOn)).toEqual(['2026-11-04', '2026-11-06'])
  // and confirmation carries the pending date through to the booked fill
  await confirmPendingFill(out.pending[0]!.id, null, deps)
  expect(f._stores.fills[0]!.filledOn).toBe('2026-11-04')
})
```

**Implementation** in `booking.ts` `ingestCapture`: both the `pendingRepo.insert` call
(~line 143) and the `pendingRows.push` (~line 149) use `filledOn: f.date ?? deps.today`.
`confirmPendingFill` already reads `pending.filledOn` — no change.

Also in `booking.ts`, tighten `manualFill`'s signature so the new optional `RawFill.date`
never leaks into the manual path: `manualFill(runId, fill: Omit<RawFill, 'ticker' | 'date'> & { filledOn: ISODate }, ...)`.
Verify the manual-fill POST route in `apps/server/src/http/routes/runs.ts` still typechecks
(it builds the object from explicit body fields, so it will).

**Folded from Task 3 review (approved task, forward-looking minors):**

F-a. `packages/ingest/src/extract.ts` `normalizeFill` — calendar guard: keep `date` only when
it parses AND round-trips: `const ts = Date.parse(d); !Number.isNaN(ts) && new Date(ts).toISOString().slice(0, 10) === d`.
(Originally briefed as parse-only; empirically Bun's `Date.parse` rolls over `2026-02-30`/
`2026-02-29`/`2026-04-31` to valid timestamps, so parse-only lets calendar-invalid dates
through the window check and into a strict-mode DATE column.) Add test k) to
`packages/ingest/test/extract.test.ts`: fills with `date: '2026-13-45'` and `date: '2026-02-30'`
keep the fill but drop the date (with and without `today` set).

F-b. Future-side window coverage in the same test file: with `today: '2026-11-15'`,
`'2026-12-30'` (+45, kept) and `'2026-12-31'` (+46, dropped).

**Run:** `bun test apps/server/test/booking.test.ts` plus `bun run typecheck`. **Commit:**
`feat: capture books pending fills on the extracted execution date`

---

## Task 5 — Web: date editable in the Edit fill dialog

**Files**
- test: `apps/web/src/components/forms/FillDialog.test.tsx`
- src: `apps/web/src/api.ts`
- src: `apps/web/src/components/forms/FillDialog.tsx`

**Tests to add/extend** (the dialog test file already mounts add- and modify-mode dialogs
and records fetch calls; follow its existing helpers `render`/`type`/`clickButton`/`calls`):

0. REWRITE the existing test `'modify mode: side and date locked, fields prefilled, PUTs
   recomputed auto-fee'` (~line 205) — it contradicts the new behavior. Rename it to
   `'modify mode: side locked, date editable, fields prefilled, PUTs recomputed auto-fee'`,
   flip `expect(inputByTestId('manualDateInput').disabled).toBe(true)` to `.toBe(false)`,
   and change the PUT body key assertion from
   `expect(Object.keys(put!.body).sort()).toEqual(['feeCents', 'priceCents', 'qty'])` to
   `expect(Object.keys(put!.body).sort()).toEqual(['feeCents', 'filledOn', 'priceCents', 'qty'])`
   plus `expect(put!.body.filledOn).toBe('2026-11-06')` (the prefilled date, untouched).
1. Modify mode: `manualDateInput` is present with `disabled === false` and the fill's current
   date as value.
2. Modify mode: changing the date input and submitting sends a PUT whose body JSON includes
   `filledOn: '<new date>'` alongside `qty/priceCents/feeCents`.
3. Modify mode: submitting with a non-ISO date value (set via `setInputValue` — type=date
   can still be emptied) shows the `manualInvalidDate` error and fires no PUT. Apply the same
   ISO guard to the modify branch in the component.

**Implementation**

`apps/web/src/api.ts` — `FillUpdatePayload` gains `filledOn?: string;` (extend the doc
comment: "optional new trade date").

`apps/web/src/components/forms/FillDialog.tsx`:
- Header comment (~lines 21-25): side is locked in modify mode, trade date is now editable
  ("modify mode … PUTs qty/price/fee/date — side stays locked because the server treats it
  as immutable").
- Date `Input` (~line 264): drop `disabled={modify}`.
- Modify branch of `submit` (~line 101): before building the payload add the same ISO guard
  the add branch uses (`/^\d{4}-\d{2}-\d{2}$/.test(filledOn)` → `manualInvalidDate`), then
  `payload = { qty: Number(shares), priceCents, feeCents: feeCentsVal, filledOn };`.

No new i18n keys — `manualFilledOn` and `manualInvalidDate` already exist in en/ko catalogs.

**Run:** `bun test apps/web/src/components/forms/FillDialog.test.tsx`, `bun run typecheck`.
**Commit:** `feat: let the Edit fill dialog change the trade date`

---

## Final verification

1. `bun test` — full suite green (db.test.ts self-skips without `TEST_DATABASE_URL`).
2. `bun run typecheck` — clean.
3. Optional DB pass if a test MariaDB is up: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test`.
4. Optional operator E2E: `TEST_DATABASE_URL=... bun scripts/e2e.ts`.
5. Then skill `finishing-a-development-branch`.
