# Web errors and form accessibility (#69, #78, #79, #80) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a dialog is open the page behind it is `inert`; a form field's hint is the control's description instead of part of its name; the Compare dialog marks a field vision missed like the pending row does; and every screen words a failed request through one helper, with the morning trigger's failure getting its own sentence.

**Architecture:** A small module (`components/inert.ts`) keeps a per-element count of the open dialogs that hold it inert, and `Modal` takes a hold on mount and gives it back on unmount, before it restores focus. `Field` renders its hint after the `<label>` and clones `aria-describedby` onto its single child. One helper, `errorText(err, t, keyPrefix?)`, replaces every hand-formatted error; `useAsync` derives its `error` from the caught value at render time, so it follows the page language. `POST /api/trigger/morning` answers `500 { error: 'pipeline-error' }`.

**Tech Stack:** React 18, TypeScript, Tailwind 3, Hono, Bun test with happy-dom 21 (`@happy-dom/global-registrator`), en/ko JSON catalogs.

**Spec:** `docs/superpowers/specs/2026-11-23-web-errors-and-a11y-design.md` (issues #69, #78, #79, #80; read them with `gh issue view <n> --comments`)
**Models:** implementer subagents run on Sonnet 5.5; per-task reviewers on Opus 5.5; the whole-branch review on Fable 5.2.
**Branch:** `fix/issues-69-80`. Line numbers are from the commit this plan was written on; later tasks locate by symbol.

## Global Constraints

- Work only in this worktree. Run every command from the worktree root.
- File size: the ~300-line convention is **not enforced on this branch** (operator ruling in the spec). Do not split files and do not make net-zero edits for size.
- Every user-facing string goes through `apps/web/src/i18n/en.json` and `ko.json` with the exact text this plan gives. Both catalogs stay in `localeCompare` key order with identical keys and placeholders (`apps/web/src/catalog.test.ts`).
- English only in code, comments and tests; Korean only in `ko.json` values and in tests that pin ko catalog output; never Chinese or Cyrillic characters.
- Dialogs stay inline: no portal, no DOM moves.
- `handleUnauthorized` (`components/hooks.tsx`) keeps its behaviour and its two call sites.
- Web tests register happy-dom before importing React (`GlobalRegistrator.register()` then `await import('react-dom/client')`), as every existing `*.test.tsx` does. Tests assert the `inert` **attribute**, never what a browser does with it. Two happy-dom facts this plan relies on: `focus()` on an element inside an `[inert]` subtree is ignored, and `click()` is still delivered there.
- `fetch` stays injectable: tests use `apps/web/src/testing/fetchStub.ts` (`installFetchStub`, `restoreFetch`).
- Commit style `feat|fix|docs|test|refactor|chore:`; one commit per task.
- `bun test` and `bun run typecheck` both pass at the end of every task. Baseline before Task 1: 1683 pass, 81 skip, 0 fail. Expected after each task (no `TEST_DATABASE_URL`): 1696, 1704, 1708, 1715, 1715, 1726, 1734.
- Do not close any issue and do not open the PR. The PR closes #78, #79 and #80; #69 and #50 only get comments (Task 8).

## Decisions (the spec's "left to the builder" items, and calls made while planning)

- **Inert helper:** its own module, `apps/web/src/components/inert.ts`, one export `holdBackgroundInert(overlay: Element): () => void`.
- **`<head>` is not marked.** The walk covers the overlay and every ancestor below `<body>`; `<body>`'s only sibling is `<head>`, which renders nothing.
- **Beyond the spec's wording, flagged for the operator:** with inert in place, a dialog that mounts inside a region an older dialog already holds inert (a result popup that arrives after a request, while the operator opened another dialog) would leave both dialogs inert and the page stuck until reload. So (a) a hold *lifts* `inert` off any of its own ancestors that an older hold marked, and puts it back on release; (b) `Modal`'s keystroke owner is the last `[role=dialog]` that is not inside `[inert]`, instead of the last in document order. Both are pinned in Task 1. Three overlapping dialogs in three separate subtrees are not specified.
- **Live regions (the spec's constraint), checked:** `EditRunModal`'s three `role="status"` notes and its `ErrorNote`s, `CreateRunForm`'s `runStarted` / `costDefaultFailed` notes and its alert, and `FillDialog`'s error line all render inside their dialog. `KeepNoticeList` and the pending table's `role="alert"` action error sit outside every dialog on purpose (they must outlive it). They are written after the dialog that started the action has closed (`setDecision(null)` runs before `submit`), so they are not inert when they change. The one gap: the operator opens another dialog while that request is in flight; the notice then appears silently and stays on screen with its Dismiss button until read. Left as is, and named in the #69 comment.
- **Content that mounts behind an open dialog is not marked** (no `MutationObserver`): the overlay still covers it for the pointer and the focus trap still holds the keyboard. Named in the #69 comment.
- **`Field` markup:** `<div><label class="block"><span>{label}</span>{control}</label><span id data-field-hint>{hint}</span></div>`. The control's own `aria-describedby` ids come first, the hint id last. Children that are not exactly one element are rendered untouched (the hint is still shown).
- **`errorText`:** "server" means `status >= 500` or a code matching `/^http-5\d\d$/` (the rule `visionreviewerrors.ts` already uses). "Exists in the catalog" means `t(key) !== key`. A 401 reads "The request failed (unauthorized)."; redirecting stays `handleUnauthorized`'s job.
- **`useAsync`:** the string state becomes a `failed` flag, and `error` is computed at render as `errorText(failure, t)`, so a standing load error follows a language switch. Action errors stored with `setX(...)` keep the language they were set in, as every such message already does.
- **Wrappers:** `simErrorText` and `visionReviewErrorText` keep their `ApiError` branch unchanged and end with `return errorText(err, t)`; their test files do not change.
- **Sim screens:** `pages/Sim.tsx` and `pages/SimRun.tsx` word their *load* error with `simErrorText(failure, t)` (as `VisionReview.tsx` does with its helper), so one screen never shows two sentences for the same failure and a deleted simulation reads "This simulation no longer exists." Not on the issue's list; follows from the spec's Intent.
- **`EditRunModal`** keeps its own `gap update failed ({code})` copy for an `ApiError`; only its raw fallback goes through `errorText`.
- **Route log line:** `console.error('morning trigger failed:', String(e))`.
- **Test placement:** new `components/inert.test.ts`, `components/Field.test.tsx`, `components/useAsync.test.tsx` (`hooks.test.tsx` runs without a DOM), `errortext.test.ts`; everything else extends the existing colocated test file. New shared fixture `testing/offline.ts`.

## Review Focus

1. **A dialog swaps to its next step, or mounts twice under StrictMode, and then closes:** nothing on the page may stay `inert` (a leaked attribute leaves part of the page dead until reload). Pinned in Task 1 (`inert.test.ts` swap and double-release cases, the StrictMode case in `Modal.test.tsx`, the fee-popup → keep-prompt flow and the fill form → delete step → back flow).
2. **Typing in the Compare dialog makes a hint appear, change or go away:** the field keeps its DOM node and its focus, its name stays "Qty", and only the description changes. Pinned in Task 2.
3. **Failures that are neither a known code nor a plain network error:** a proxy's bodiless 502 on the trigger reads as a server problem with `http-502` and does not blame the pipeline; an unknown 4xx code stays visible; a validation `Error` keeps its own sentence; a server code can never reach a catalog key outside its prefix. Pinned in Task 4 (`errortext.test.ts`) and Task 6 (`RunsList.test.tsx`).
4. **A load error is on screen and the operator switches language:** the error is re-worded, not left in the old language; a rejection with no value still counts as an error. Pinned in Task 6 (`useAsync.test.tsx`).
5. **A second dialog opens while another is open elsewhere on the page:** the newest one stays reachable and owns Escape, and closing it gives the older one back. Pinned in Task 1.

---

## File Structure

| File | Change | Responsibility in this plan |
| --- | --- | --- |
| `apps/web/src/components/inert.ts` | create | Per-element hold and lift counts; `holdBackgroundInert` |
| `apps/web/src/components/Modal.tsx` | modify | Takes a hold on mount, releases before restoring focus; keystroke owner ignores inert dialogs |
| `apps/web/src/components/ui.tsx` | modify | `Field`: hint outside the label, `aria-describedby` on the control |
| `apps/web/src/components/forms/PendingReviewDialog.tsx` | modify | `border-warning` on a missed, still-blank field |
| `apps/web/src/errortext.ts` | create | `errorText(err, t, keyPrefix?)`, `Translate` |
| `apps/web/src/i18n/en.json`, `ko.json` | modify | `errRequest`, `errServer`, `triggerErr.pipeline-error` |
| `apps/web/src/api.ts` | modify | `ApiErrorCode` gains `'pipeline-error'` |
| `apps/web/src/simerrors.ts`, `visionreviewerrors.ts` | modify | Shared cases delegate to `errorText` |
| `apps/server/src/http/app.ts` | modify | `/api/trigger/morning` answers `500 { error: 'pipeline-error' }` |
| `apps/web/src/components/hooks.tsx` | modify | `useAsync.error` derived from `failure` |
| `apps/web/src/testing/offline.ts` | create | `goOffline`: a fetch that rejects, for tests |
| `apps/web/src/components/SystemNotices.tsx`, `pages/{RunsList,RunDetail,Settings,Sim,SimRun}.tsx` | modify | Page-level error sites |
| `apps/web/src/components/forms/{FillDialog,CorrectionList,PendingTable,EditRunModal,CreateRunForm}.tsx` | modify | Form and dialog error sites |
| `AGENTS.md` | modify | Repo map lists the three new files |

## Not in this plan

- A pass with a real screen reader (stays on #69) and the colour-only resting "changed" mark (goes with #68).
- A native read of the Korean copy (#50; Task 8 adds the new keys to its list). Splitting oversized test files (#81).
- `pages/Login.tsx`: with the server down it says "Sign-in failed." That is worded copy, not raw text, and the page is not on the issue's list. Left.
- `components/RunPanels.tsx`: its two bare `catch` blocks show fixed catalog copy (`cancelFailed`, `dialog.deleteFailed`). Left.

---

### Task 1: The page behind an open dialog is inert (#69)

**Files:**
- Create: `apps/web/src/components/inert.ts`, `apps/web/src/components/inert.test.ts`
- Modify: `apps/web/src/components/Modal.tsx:88-109` (the mount effect), `:115-120` (`onKeyDown`), the doc comment at `:56-57`
- Modify: `apps/web/src/components/Modal.test.tsx`, `apps/web/src/components/forms/PendingDefaultFee.test.tsx`, `apps/web/src/components/forms/FillDialogFocus.test.tsx`
- Modify: `AGENTS.md:44` (add `inert` to the `components/{…}` list, after `Modal`)

**Interfaces:**
- Consumes: nothing.
- Produces (`apps/web/src/components/inert.ts`):

```ts
/** Makes everything outside `overlay` inert until the returned release is called (calling it twice is harmless). */
export function holdBackgroundInert(overlay: Element): () => void
```

- [ ] **Step 1: Write the failing helper tests** — `apps/web/src/components/inert.test.ts`:

```ts
// The bookkeeping behind the dialog's inert background, on a bare DOM (no React).
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';

GlobalRegistrator.register();

const { holdBackgroundInert } = await import('./inert');

afterAll(() => {
  GlobalRegistrator.unregister();
});

// <body><header/><main><section#card><button#row/><div#slot/></section><aside/></main><footer/></body>
let header: HTMLElement, main: HTMLElement, card: HTMLElement, row: HTMLElement, slot: HTMLElement, aside: HTMLElement, footer: HTMLElement;
const el = (tag: string, parent: Element, id: string) => {
  const node = document.createElement(tag);
  node.id = id;
  parent.appendChild(node);
  return node;
};
const inertIds = () => Array.from(document.querySelectorAll('[inert]')).map((n) => n.id || n.tagName).sort();

beforeEach(() => {
  header = el('header', document.body, 'header');
  main = el('main', document.body, 'main');
  card = el('section', main, 'card');
  row = el('button', card, 'row');
  slot = el('div', card, 'slot');
  aside = el('aside', main, 'aside');
  footer = el('footer', document.body, 'footer');
});

afterEach(() => {
  for (const n of [header, main, footer]) n.remove();
  document.querySelectorAll('[inert]').forEach((n) => n.removeAttribute('inert'));
});

describe('holdBackgroundInert', () => {
  it('marks every sibling along the chain up to body, never the chain or <head>, and release clears them', () => {
    const release = holdBackgroundInert(el('div', slot, 'overlay'));
    expect(inertIds()).toEqual(['aside', 'footer', 'header', 'row']);
    expect(document.head.hasAttribute('inert')).toBe(false);
    release();
    expect(inertIds()).toEqual([]);
  });

  it('leaves an element that was already inert exactly as it was', () => {
    aside.setAttribute('inert', '');
    const release = holdBackgroundInert(el('div', slot, 'overlay'));
    release();
    expect(inertIds()).toEqual(['aside']);
  });

  it('a nested hold adds its own set and gives back only that', () => {
    const outer = el('div', main, 'outer');
    const field = el('input', outer, 'field');
    const releaseOuter = holdBackgroundInert(outer);
    const releaseInner = holdBackgroundInert(el('div', outer, 'inner'));
    expect(inertIds()).toEqual(['aside', 'card', 'field', 'footer', 'header']);
    releaseInner();
    expect(inertIds()).toEqual(['aside', 'card', 'footer', 'header']);
    releaseOuter();
    expect(inertIds()).toEqual([]);
    expect(field.hasAttribute('inert')).toBe(false);
  });

  it('a step swap where the new panel mounts first leaves the newer set, then nothing', () => {
    const a = el('div', slot, 'a');
    const releaseA = holdBackgroundInert(a);
    const b = el('div', slot, 'b');
    const releaseB = holdBackgroundInert(b);
    a.remove();
    releaseA();
    expect(inertIds()).toEqual(['aside', 'footer', 'header', 'row']);
    expect(b.hasAttribute('inert')).toBe(false);
    releaseB();
    expect(inertIds()).toEqual([]);
  });

  it('calling a release twice does not give back another hold', () => {
    const a = el('div', slot, 'a');
    const releaseA = holdBackgroundInert(a);
    const releaseB = holdBackgroundInert(el('div', a, 'b'));
    releaseB();
    releaseB();
    expect(inertIds()).toEqual(['aside', 'footer', 'header', 'row']);
    releaseA();
    expect(inertIds()).toEqual([]);
  });

  it('two sibling overlays held one after the other: the later one stays reachable', () => {
    const a = el('div', slot, 'a');
    const b = el('div', slot, 'b');
    const releaseA = holdBackgroundInert(a);
    const releaseB = holdBackgroundInert(b);
    expect(a.hasAttribute('inert')).toBe(true);
    expect(b.closest('[inert]')).toBeNull();
    releaseB();
    expect(a.hasAttribute('inert')).toBe(false);
    expect(b.hasAttribute('inert')).toBe(true);
    releaseA();
    expect(inertIds()).toEqual([]);
  });

  it('an overlay that opens inside a region another dialog holds inert is lifted out of it, then put back', () => {
    const pageDialog = el('div', main, 'pageDialog'); // e.g. the pool dialog, a sibling of the card
    const releasePage = holdBackgroundInert(pageDialog);
    expect(card.hasAttribute('inert')).toBe(true);
    const late = el('div', slot, 'late'); // a result popup that mounts inside the card afterwards
    const releaseLate = holdBackgroundInert(late);
    expect(late.closest('[inert]')).toBeNull();
    expect(pageDialog.hasAttribute('inert')).toBe(true);
    expect(row.hasAttribute('inert')).toBe(true);
    releaseLate();
    expect(card.hasAttribute('inert')).toBe(true);
    expect(pageDialog.hasAttribute('inert')).toBe(false);
    releasePage();
    expect(inertIds()).toEqual([]);
  });

  it('the older dialog closing first leaves nothing behind once the lifted one closes too', () => {
    const releasePage = holdBackgroundInert(el('div', main, 'pageDialog'));
    const late = el('div', slot, 'late');
    const releaseLate = holdBackgroundInert(late);
    releasePage();
    expect(late.closest('[inert]')).toBeNull();
    expect(inertIds()).toEqual(['aside', 'footer', 'header', 'pageDialog', 'row']);
    releaseLate();
    expect(inertIds()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/web/src/components/inert.test.ts`
Expected: FAIL — `Cannot find module './inert'`.

- [ ] **Step 3: Implement `holdBackgroundInert` in `apps/web/src/components/inert.ts`**

Two module-level maps: `holds: WeakMap<Element, number>` (how many open dialogs hold the element inert) and `lifts: WeakMap<Element, number>` (how many have lifted it). The rules, which the tests above pin one by one:

- Walk `node` from `overlay` upwards while `node !== document.body` and `node.parentElement !== null`.
- At each `node`: if `holds` has it above 0, an older dialog marked this node; count a lift, remove its `inert` attribute and remember it in this call's `lifted` list.
- For each element child of `node.parentElement` other than `node`: when its hold count is 0 and it already has `inert`, skip it (not ours, never counted); otherwise set `inert=""` when the count is 0, add one to the count, and remember it in this call's `held` list.
- The returned release runs once (a closed-over flag). For each `held`: subtract one; at 0 delete the entry and remove `inert`. For each `lifted`: subtract one lift; at 0 delete the entry and, if `holds` still has the element above 0, set `inert=""` again.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/web/src/components/inert.test.ts`
Expected: 8 pass, 0 fail.

- [ ] **Step 5: Write the failing dialog tests**

`apps/web/src/components/Modal.test.tsx` — three edits to existing tests, three new tests.

In `keeps focus inside when Tab is pressed outside the dialog`, replace the three lines that focus the opener and press Tab on it with:

```ts
    // The page behind is inert, so nothing there can take focus; what is left is focus
    // falling to <body> (the focused control went away, or a click on the page chrome).
    await act(async () => (document.activeElement as HTMLElement).blur());
    expect(document.activeElement).toBe(document.body);
    const ev = press(document.body, 'Tab');
```

In `closes only the last dialog in document order on Escape when two are mounted`, add before the `press`:

```ts
    const [firstDialog, secondDialog] = Array.from(document.querySelectorAll('[role=dialog]'));
    expect(firstDialog!.closest('[inert]')).not.toBeNull();
    expect(secondDialog!.closest('[inert]')).toBeNull();
```

In `keeps focus on the autoFocus child under StrictMode, and restores the opener on close`, add `expect(byId('opener').closest('[inert]')).not.toBeNull();` after the first `expect` (the dialog is open) and `expect(document.querySelector('[inert]')).toBeNull();` as the last line (StrictMode mounts the effect twice; the page must be held once and given back).

Add after the two-dialogs test:

```ts
  // A result popup can arrive (after a request) while another dialog is open, and
  // sit earlier in the document: the one that opened last is the one in use.
  it('a dialog that opens later but earlier in the document owns Escape and stays reachable', async () => {
    const closed: string[] = [];
    const tree = (withFirst: boolean) =>
      d(
        'div',
        null,
        withFirst && d(Modal, { key: 'first', title: 'First', onClose: () => closed.push('first'), children: d('button', null, 'a') }),
        d(Modal, { key: 'second', title: 'Second', onClose: () => closed.push('second'), children: d('button', null, 'b') }),
      );
    await act(async () => root.render(tree(false)));
    await act(async () => root.render(tree(true)));
    const [firstDialog, secondDialog] = Array.from(document.querySelectorAll('[role=dialog]'));
    expect(firstDialog!.getAttribute('aria-label')).toBe('First');
    expect(firstDialog!.closest('[inert]')).toBeNull();
    expect(secondDialog!.closest('[inert]')).not.toBeNull();

    press(document.body, 'Escape');

    expect(closed).toEqual(['first']);
  });
```

Add before `keeps the header close button in the tab order`:

```ts
  const inertOutside = (el: Element) => el.closest('[inert]') !== null;

  it('makes the page behind inert while open, and nothing stays inert after it closes', async () => {
    const outside = document.createElement('p');
    document.body.appendChild(outside);
    try {
      await show();
      expect(inertOutside(byId('opener'))).toBe(true);
      expect(inertOutside(outside)).toBe(true);
      expect(inertOutside(topPanel())).toBe(false);
      expect(document.body.hasAttribute('inert')).toBe(false);
      await click(headerClose(topPanel()));
      expect(document.querySelector('[inert]')).toBeNull();
    } finally {
      outside.remove();
    }
  });

  it('an inner dialog makes the rest of the outer one inert, and gives it back on close', async () => {
    await show();
    const openInner = Array.from(topPanel().querySelectorAll('button')).find((b) => b.textContent === 'Open inner')!;
    await focus(openInner);
    await click(openInner);
    expect(inertOutside(byTestId('first'))).toBe(true);
    expect(inertOutside(openInner)).toBe(true);
    expect(inertOutside(byTestId('inner'))).toBe(false);
    expect(inertOutside(byId('opener'))).toBe(true);

    press(document.body, 'Escape');
    expect(dialogCount()).toBe(1);
    expect(inertOutside(byTestId('first'))).toBe(false);
    expect(inertOutside(byId('opener'))).toBe(true);

    press(document.body, 'Escape');
    expect(dialogCount()).toBe(0);
    expect(document.querySelector('[inert]')).toBeNull();
  });
```

`apps/web/src/components/forms/PendingDefaultFee.test.tsx` — add as the last test of `describe('auto fee popup')`:

```ts
  // Each popup makes the table behind it inert; the swap from one to the next must
  // hand that over, and the last one closing must give all of it back.
  it('the table is inert under each popup in turn and free again afterwards', async () => {
    await renderWithConfirmCalls(ROW);
    const table = () => container.querySelector('table')!;
    await type('Fee', '');
    await pressButton('Confirm');
    expect(table().closest('[inert]')).not.toBeNull();
    expect(dialog(TITLE)!.closest('[inert]')).toBeNull();

    await pressButton('Use auto fee');
    expect(table().closest('[inert]')).not.toBeNull();
    expect(container.querySelector('[role=dialog]')!.closest('[inert]')).toBeNull();

    await pressButton('Discard');
    expect(container.querySelector('[role=dialog]')).toBeNull();
    expect(document.querySelector('[inert]')).toBeNull();
  });
```

`apps/web/src/components/forms/FillDialogFocus.test.tsx` — add as the last test of `describe('FillDialog focus')`:

```ts
  it('leaves nothing inert after the form, the delete step and back again', async () => {
    await openFromEdit();
    expect(editButton().closest('[inert]')).not.toBeNull();
    await press(button('Delete'));
    expect(editButton().closest('[inert]')).not.toBeNull();
    expect(button('Cancel').closest('[inert]')).toBeNull();
    await press(button('Cancel'));
    expect(editButton().closest('[inert]')).not.toBeNull();
    await press(closeX());
    expect(document.querySelector('[inert]')).toBeNull();
  });
```

- [ ] **Step 6: Run to verify they fail**

Run: `bun test apps/web/src/components/Modal.test.tsx apps/web/src/components/forms/PendingDefaultFee.test.tsx apps/web/src/components/forms/FillDialogFocus.test.tsx`
Expected: FAIL — 7 tests: the two-dialogs test, the StrictMode test, the three new `Modal` tests and the two flow tests, each on a `closest('[inert]')` expectation. (The edited Tab test passes before and after; it only stops relying on focusing an inert opener.)

- [ ] **Step 7: Wire the helper into `Modal`**

Three edits in `apps/web/src/components/Modal.tsx`:

1. In the mount effect, right after `modalOpeners.set(panel, opener.raw)` and before the initial-focus line: `const release = holdBackgroundInert(overlay)`, where `overlay` is the `role="dialog"` element (`panel.parentElement`).
2. `release()` is the **first statement of that effect's cleanup**: before the `if (panel.isConnected) return` line (StrictMode's simulated unmount must give the hold back; the re-run of the effect takes it again) and before the focus restore (an opener that is still inert cannot take focus; `restores focus to the opener when closed` fails otherwise).
3. In `onKeyDown`, the dialog list becomes `Array.from(document.querySelectorAll('[role=dialog]')).filter((el) => el.closest('[inert]') === null)`; update the comment above it: the dialog in use is the last one that is not inert.

Add one sentence to `Modal`'s doc comment: the page behind is inert while it is open.

- [ ] **Step 8: Run to verify everything passes**

Run: `bun test apps/web/src && bun run typecheck`
Expected: 0 fail; typecheck prints no errors. `bun test` (whole repo): 1696 pass.

- [ ] **Step 9: Update `AGENTS.md` and commit**

```bash
git add apps/web/src/components/inert.ts apps/web/src/components/inert.test.ts apps/web/src/components/Modal.tsx apps/web/src/components/Modal.test.tsx apps/web/src/components/forms/PendingDefaultFee.test.tsx apps/web/src/components/forms/FillDialogFocus.test.tsx AGENTS.md
git commit -m "feat: make the page behind an open dialog inert (#69)"
```

---

### Task 2: A field's hint is its description, not part of its name (#78)

**Files:**
- Modify: `apps/web/src/components/ui.tsx:132-140` (`Field`; `react` import at `:4`)
- Create: `apps/web/src/components/Field.test.tsx`
- Modify: `apps/web/src/components/forms/PendingReviewDialogHints.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `Field`'s props are unchanged (`{ label: string; hint?: string; children: ReactNode }`) and no caller changes. DOM contract other tests rely on: the control stays inside the `<label>`, whose first `<span>` holds the label text; the hint is a `<span data-field-hint id={useId()}>` after the label.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/components/Field.test.tsx`:

Scaffold as `apps/web/src/components/Modal.test.tsx:4-22` (register happy-dom, the dynamic React imports, `d`, the act flag) with `const { Field, Input } = await import('./ui')`, and inside `describe('Field', …)` the `container` / `root` declarations and the `beforeEach`, `afterEach` and `afterAll` of `Modal.test.tsx:120-121` and `:131-145`. Then:

```ts
  const render = (node: React.ReactNode) => act(async () => root.render(node));
  const input = (id = 'x') => container.querySelector(`#${id}`) as HTMLInputElement;
  const describedBy = (el: Element) =>
    (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => document.getElementById(id)?.textContent);

  it('keeps the hint out of the label and wires it as the description', async () => {
    await render(d(Field, { label: 'Price', hint: 'Commas group thousands', children: d(Input, { id: 'x' }) }));
    expect(input().closest('label')!.textContent).toBe('Price');
    expect(describedBy(input())).toEqual(['Commas group thousands']);
    expect(container.querySelector('[data-field-hint]')!.closest('label')).toBeNull();
  });

  it('adds nothing when there is no hint', async () => {
    await render(d(Field, { label: 'Qty', children: d(Input, { id: 'x' }) }));
    expect(input().hasAttribute('aria-describedby')).toBe(false);
    expect(container.querySelector('[data-field-hint]')).toBeNull();
    expect(input().closest('label')!.textContent).toBe('Qty');
  });

  it("keeps the control's own description and puts the hint after it", async () => {
    await render(
      d(
        'div',
        null,
        d('span', { id: 'own-note' }, 'Own note'),
        d(Field, { label: 'Fee', hint: 'Auto fee', children: d(Input, { id: 'x', 'aria-describedby': 'own-note' }) }),
      ),
    );
    expect(describedBy(input())).toEqual(['Own note', 'Auto fee']);
  });

  it('gives each field its own hint', async () => {
    await render(
      d(
        'div',
        null,
        d(Field, { label: 'A', hint: 'hint a', children: d(Input, { id: 'a' }) }),
        d(Field, { label: 'B', hint: 'hint b', children: d(Input, { id: 'b' }) }),
      ),
    );
    expect(describedBy(input('a'))).toEqual(['hint a']);
    expect(describedBy(input('b'))).toEqual(['hint b']);
  });

  it('a hint that comes and goes keeps the same control and its focus', async () => {
    const field = (hint?: string) => d(Field, { label: 'Qty', hint, children: d(Input, { id: 'x' }) });
    await render(field());
    const before = input();
    before.focus();
    await render(field('Changed from what vision read'));
    expect(input()).toBe(before);
    expect(document.activeElement).toBe(before);
    expect(describedBy(input())).toEqual(['Changed from what vision read']);
    await render(field());
    expect(input()).toBe(before);
    expect(input().hasAttribute('aria-describedby')).toBe(false);
  });

  it('children that are not one element are rendered as they are, with the hint still shown', async () => {
    await render(d(Field, { label: 'Pair', hint: 'two controls', children: [d(Input, { key: 'a', id: 'a' }), d(Input, { key: 'b', id: 'b' })] }));
    expect(input('a').hasAttribute('aria-describedby')).toBe(false);
    expect(container.querySelector('[data-field-hint]')!.textContent).toBe('two controls');
  });
```

`apps/web/src/components/forms/PendingReviewDialogHints.test.tsx` — add before `the derived fee carries its hint but no edit marker`:

```ts
  const description = (label: string) =>
    (input(label).getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => document.getElementById(id)?.textContent);
  const nameOf = (label: string) => input(label).closest('label')!.textContent;

  it('a hint is the field description and never part of its name', async () => {
    await show();
    expect(input('Qty').hasAttribute('aria-describedby')).toBe(false);
    await act(async () => {
      setInputValue(input('Qty'), '11');
    });
    expect(nameOf('Qty')).toBe('Qty');
    expect(description('Qty')).toEqual(['Changed from what vision read']);
    await act(async () => {
      setInputValue(input('Qty'), '');
    });
    expect(nameOf('Qty')).toBe('Qty');
    expect(description('Qty')).toEqual([lookup('en', 'pendingFieldErased')]);
  });

  it('a hint that appears while typing leaves the field focused', async () => {
    await show();
    const qty = input('Qty');
    qty.focus();
    await act(async () => {
      setInputValue(qty, '11');
    });
    expect(input('Qty')).toBe(qty);
    expect(document.activeElement).toBe(qty);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/web/src/components/Field.test.tsx apps/web/src/components/forms/PendingReviewDialogHints.test.tsx`
Expected: FAIL — the label text reads `PriceCommas group thousands`, `describedBy` is `[]`, no `[data-field-hint]` element.

- [ ] **Step 3: Rewrite `Field` in `apps/web/src/components/ui.tsx`**

Same signature. `const hintId = useId()`. When `hint !== undefined` and `isValidElement(children)`, the control is `cloneElement(children, { 'aria-describedby': own ? `${own} ${hintId}` : hintId })`, where `own` is the child's existing `aria-describedby` prop (type the child as `ReactElement<{ 'aria-describedby'?: string }>` to read and set it); otherwise the children are rendered untouched. The markup (the label and hint classes are today's, unchanged):

```tsx
    <div>
      <label className="block">
        <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
        {control}
      </label>
      {hint !== undefined && (
        <span id={hintId} data-field-hint className="mt-1 block text-[11px] leading-snug text-muted-foreground">
          {hint}
        </span>
      )}
    </div>
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test apps/web/src && bun run typecheck`
Expected: 0 fail (no other test file needs a change: they find controls through `label > span` and the control inside the label, which still holds); typecheck prints no errors. `bun test`: 1704 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui.tsx apps/web/src/components/Field.test.tsx apps/web/src/components/forms/PendingReviewDialogHints.test.tsx
git commit -m "fix: a form field's hint is its description, not part of its name (#78)"
```

---

### Task 3: The Compare dialog marks a field vision missed (#79)

**Files:**
- Modify: `apps/web/src/components/forms/PendingReviewDialog.tsx:5` (import), `:26-33` (`hintFor`)
- Modify: `apps/web/src/components/forms/PendingReviewDialogHints.test.tsx`

**Interfaces:**
- Consumes: `standingIssues(row: PendingFillDto, values: RowValues): MissedField[]` from `apps/web/src/pendingvalues.ts` (exists; the row uses it the same way in `PendingRow.tsx:73-74`). `Field`'s DOM contract from Task 2.
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the failing tests** — in `PendingReviewDialogHints.test.tsx`, after the two tests Task 2 added:

```ts
  describe('a field vision missed', () => {
    const missedPrice: PendingFillDto = { ...ROW, price: '', detected: { ...ROW.detected!, price: null } };
    const missedDate: PendingFillDto = { ...ROW, filledOn: '2026-11-09', detected: { ...ROW.detected!, filledOn: null } };
    const warned = () =>
      Array.from(container.querySelectorAll('[role=dialog] input, [role=dialog] select'))
        .filter((el) => el.className.split(' ').includes('border-warning'))
        .map((el) => el.closest('label')!.querySelector('span')!.textContent);

    it('carries the warning border until it is filled in, like the row', async () => {
      await show(missedPrice, { ...VALUES, price: '' });
      expect(warned()).toEqual(['Price']);
      expect(input('Price').className).toContain('w-full');
      expect(input('Price').hasAttribute('data-edit')).toBe(false);
      await act(async () => {
        setInputValue(input('Price'), '12.50');
      });
      expect(warned()).toEqual([]);
      expect(input('Price').getAttribute('data-edit')).toBe('filled');
    });

    it('gets the solid warning back, not the dashed erased look, when emptied again', async () => {
      await show(missedPrice, { ...VALUES, price: '' });
      await act(async () => {
        setInputValue(input('Price'), '12.50');
      });
      await act(async () => {
        setInputValue(input('Price'), '');
      });
      expect(warned()).toEqual(['Price']);
      expect(input('Price').className).not.toContain('border-dashed');
      expect(input('Price').hasAttribute('data-edit')).toBe(false);
    });

    it('marks every missed field at once: date and side', async () => {
      await show({ ...missedDate, side: '', detected: { ...missedDate.detected!, side: null } }, { ...VALUES, filledOn: '', side: '' });
      expect(warned()).toEqual(['Trade date', 'Side']);
    });

    it('a complete row and a row missing only its ticker mark nothing', async () => {
      await show();
      expect(warned()).toEqual([]);
      await show({ ...ROW, ticker: '' });
      expect(warned()).toEqual([]);
      expect(container.querySelector('[role=dialog]')!.getAttribute('aria-label')).toContain('?');
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/web/src/components/forms/PendingReviewDialogHints.test.tsx`
Expected: FAIL — three of the four: `warned()` is `[]` where a field name is expected (`a complete row…` already passes).

- [ ] **Step 3: Add the mark in `PendingReviewDialog.tsx`**

Compute `standingIssues(row, draft)` once per render. In `hintFor`, the control's base class is `w-full border-warning` when the issues include the field and `w-full` otherwise; the edit-hint `look` is appended to that base as today (both branches of the existing ternary).

- [ ] **Step 4: Run to verify they pass**

Run: `bun test apps/web/src && bun run typecheck`
Expected: 0 fail; typecheck prints no errors. `bun test`: 1708 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/forms/PendingReviewDialog.tsx apps/web/src/components/forms/PendingReviewDialogHints.test.tsx
git commit -m "fix: the Compare dialog marks a field vision missed, like the pending row (#79)"
```

---

### Task 4: `errorText`, its copy, and the two screen helpers built on it (#80)

**Files:**
- Create: `apps/web/src/errortext.ts`, `apps/web/src/errortext.test.ts`
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Modify: `apps/web/src/api.ts:35-61` (`ApiErrorCode`)
- Modify: `apps/web/src/simerrors.ts`, `apps/web/src/visionreviewerrors.ts`
- Modify: `AGENTS.md:42` (add `errortext.ts` to the `apps/web/src/` list)

**Interfaces:**
- Consumes: `ApiError` (`status: number`, `code: ApiErrorCode`) and `NetworkError` from `apps/web/src/api.ts`.
- Produces (`apps/web/src/errortext.ts`):

```ts
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Words a caught request failure. `keyPrefix` names the screen's own codes, e.g. 'fillErr' for `fillErr.not-last`. */
export function errorText(err: unknown, t: Translate, keyPrefix?: string): string
```

- Produces catalog keys `errRequest`, `errServer` (both take `{code}`) and `triggerErr.pipeline-error`; `ApiErrorCode` member `'pipeline-error'`.

- [ ] **Step 1: Write the failing test** — `apps/web/src/errortext.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

import { ApiError, NetworkError } from './api';
import type { ApiErrorCode } from './api';
import { errorText } from './errortext';
import { lookup } from './i18n/catalog';

const en = (k: string, p?: Record<string, string | number>) => lookup('en', k, p);
const ko = (k: string, p?: Record<string, string | number>) => lookup('ko', k, p);
const api = (status: number, code: string) => new ApiError(status, code as ApiErrorCode);

describe('errorText', () => {
  it('words an unreachable server, whatever the browser called it', () => {
    expect(errorText(new NetworkError('Failed to fetch'), en)).toBe('Could not reach the server. Check the connection and try again.');
    expect(errorText(new NetworkError('NetworkError when attempting to fetch resource.'), en, 'fillErr')).toBe(en('errNetwork'));
  });

  it('uses the prefixed catalog copy when the code has one', () => {
    expect(errorText(api(422, 'not-last'), en, 'fillErr')).toBe('Only the last fill of a bucket can be deleted.');
    expect(errorText(api(422, 'no-run'), en, 'recalcErr')).toBe('Run not found.');
    expect(errorText(api(500, 'pipeline-error'), en, 'triggerErr')).toBe(
      'The morning pipeline stopped before planning any run. See System notices below.',
    );
  });

  it('a code with no copy under the prefix, or no prefix at all, keeps its code in a worded fallback', () => {
    expect(errorText(api(422, 'weird-code'), en, 'fillErr')).toBe('The request failed (weird-code).');
    expect(errorText(api(422, 'not-last'), en)).toBe('The request failed (not-last).');
    expect(errorText(api(404, 'http-404'), en)).toBe('The request failed (http-404).');
    expect(errorText(api(401, 'unauthorized'), en)).toBe('The request failed (unauthorized).');
  });

  it('a 5xx status or an http-5xx code reads as a server problem', () => {
    const server = (code: string) =>
      `The server had a problem (${code}). Try again; if it keeps failing, check the server log.`;
    expect(errorText(api(500, 'http-500'), en)).toBe(server('http-500'));
    expect(errorText(api(502, 'http-502'), en, 'triggerErr')).toBe(server('http-502'));
    expect(errorText(api(500, 'apply-exploded'), en, 'fillErr')).toBe(server('apply-exploded'));
    expect(errorText(api(400, 'http-503'), en)).toBe(server('http-503'));
  });

  it('a server code cannot reach a catalog key outside its prefix', () => {
    expect(errorText(api(400, 'errNetwork'), en)).toBe('The request failed (errNetwork).');
    expect(errorText(api(400, 'not-last'), en, 'recalcErr')).toBe('The request failed (not-last).');
    expect(errorText(api(400, 'errNetwork'), en, 'fillErr')).toBe('The request failed (errNetwork).');
  });

  it('anything else keeps its own message', () => {
    expect(errorText(new Error('Check the values'), en, 'fillErr')).toBe('Check the values');
    expect(errorText('boom', en)).toBe('boom');
    expect(errorText(undefined, en)).toBe('undefined');
  });

  it('ko copy', () => {
    expect(errorText(new NetworkError('Failed to fetch'), ko)).toBe('서버에 연결할 수 없습니다. 연결을 확인하고 다시 시도하세요.');
    expect(errorText(api(503, 'http-503'), ko)).toBe(
      '서버에 문제가 발생했습니다 (http-503). 다시 시도하고, 계속 실패하면 서버 로그를 확인하세요.',
    );
    expect(errorText(api(409, 'weird-code'), ko)).toBe('요청에 실패했습니다 (weird-code).');
    expect(errorText(api(500, 'pipeline-error'), ko, 'triggerErr')).toBe(
      '아침 파이프라인이 런을 하나도 계획하지 못하고 중단되었습니다. 아래 시스템 알림을 확인하세요.',
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/web/src/errortext.test.ts`
Expected: FAIL — `Cannot find module './errortext'`.

- [ ] **Step 3: Add the copy.** Insert these lines, each directly after the key named (that is their `localeCompare` position; checked when this plan was written):

`en.json`, after `"errorUnauthorized"`:

```json
  "errRequest": "The request failed ({code}).",
  "errServer": "The server had a problem ({code}). Try again; if it keeps failing, check the server log.",
```

`en.json`, after `"today"`:

```json
  "triggerErr.pipeline-error": "The morning pipeline stopped before planning any run. See System notices below.",
```

`ko.json`, after `"errorUnauthorized"`:

```json
  "errRequest": "요청에 실패했습니다 ({code}).",
  "errServer": "서버에 문제가 발생했습니다 ({code}). 다시 시도하고, 계속 실패하면 서버 로그를 확인하세요.",
```

`ko.json`, after `"today"`:

```json
  "triggerErr.pipeline-error": "아침 파이프라인이 런을 하나도 계획하지 못하고 중단되었습니다. 아래 시스템 알림을 확인하세요.",
```

- [ ] **Step 4: Add `'pipeline-error'` to `ApiErrorCode`** in `apps/web/src/api.ts`, after `'sim-finalized'`.

- [ ] **Step 5: Implement `errorText` in `apps/web/src/errortext.ts`**, in this order:

1. `NetworkError` → `t('errNetwork')`.
2. `ApiError` with a `keyPrefix`: `key = `${keyPrefix}.${err.code}``; when `t(key) !== key`, return it.
3. `ApiError` otherwise: `err.status >= 500 || /^http-5\d\d$/.test(err.code)` → `t('errServer', { code: err.code })`, else `t('errRequest', { code: err.code })`.
4. Anything else: `err instanceof Error ? err.message : String(err)`.

- [ ] **Step 6: Build the two screen helpers on it.** In `simerrors.ts` and `visionreviewerrors.ts` the `ApiError` branch stays exactly as it is; everything after it becomes `return errorText(err, t)`, and the `NetworkError` check and import go. Their test files (`simerrors.test.ts`, `visionreviewerrors.test.ts`) are not edited and must stay green.

- [ ] **Step 7: Run to verify it passes**

Run: `bun test apps/web/src && bun run typecheck`
Expected: 0 fail (`catalog.test.ts` included); typecheck prints no errors. `bun test`: 1715 pass.

- [ ] **Step 8: Update `AGENTS.md` and commit**

```bash
git add apps/web/src/errortext.ts apps/web/src/errortext.test.ts apps/web/src/i18n/en.json apps/web/src/i18n/ko.json apps/web/src/api.ts apps/web/src/simerrors.ts apps/web/src/visionreviewerrors.ts AGENTS.md
git commit -m "feat: one helper words every failed request, with server and request fallbacks (#80)"
```

---

### Task 5: The morning trigger answers `pipeline-error` (#80)

**Files:**
- Modify: `apps/server/src/http/app.ts:74-77`
- Modify: `apps/server/test/http-orders.test.ts:18-32`

**Interfaces:**
- Consumes: `deps.triggerMorning: () => Promise<string>` (unchanged; `apps/server/src/main.ts:86` already rejects when the pipeline stops, after `runMorningPipeline` has recorded the `warn-pipeline-error` notice).
- Produces: `POST /api/trigger/morning` → `200 { result: string }` as before, or `500 { "error": "pipeline-error" }` when `triggerMorning` rejects. Task 6's Runs page test relies on that body.

- [ ] **Step 1: Tighten the existing test.** Rename `trigger morning answers 500 when the pipeline rejects` to `trigger morning answers 500 pipeline-error when the pipeline rejects, and logs why`, and add after `expect(res.status).toBe(500)`:

```ts
      expect(await res.json()).toEqual({ error: 'pipeline-error' })
      expect(errors.mock.calls).toEqual([['morning trigger failed:', 'Error: boom']])
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/server/test/http-orders.test.ts`
Expected: FAIL — the body is Hono's plain-text "Internal Server Error", so `res.json()` rejects.

- [ ] **Step 3: Catch in the route.** `app.post('/api/trigger/morning', …)` wraps the call in `try`/`catch`: on a throw, `console.error('morning trigger failed:', String(e))` and `return c.json({ error: 'pipeline-error' }, 500)`. The success path is unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/server && bun run typecheck`
Expected: 0 fail; typecheck prints no errors. `bun test`: 1715 pass (no new test). `scripts/e2e.ts` stubs `triggerMorning` and asserts nothing about its error shape (checked), so it is not affected.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/http/app.ts apps/server/test/http-orders.test.ts
git commit -m "fix: the morning trigger answers pipeline-error when the pipeline stops (#80)"
```

---

### Task 6: Loads and page actions use the worded text (#80)

**Files:**
- Modify: `apps/web/src/components/hooks.tsx:7-60` (`AsyncData`, `useAsync`)
- Create: `apps/web/src/components/useAsync.test.tsx`, `apps/web/src/testing/offline.ts`
- Modify: `apps/web/src/components/SystemNotices.tsx:46`, `apps/web/src/pages/RunsList.tsx:93,110`, `apps/web/src/pages/RunDetail.tsx:86,99-108`, `apps/web/src/pages/Settings.tsx:42`, `apps/web/src/pages/Sim.tsx:66,163`, `apps/web/src/pages/SimRun.tsx:14,26`
- Modify tests: `components/SystemNotices.test.tsx`, `pages/RunsList.test.tsx`, `pages/RunDetail.test.tsx`, `pages/Sim.test.tsx`, `pages/SimRun.test.tsx`
- Modify: `AGENTS.md:43` (add `offline` to the `testing/{…}` list)

**Interfaces:**
- Consumes: `errorText(err: unknown, t: Translate, keyPrefix?: string): string` from `apps/web/src/errortext.ts`; catalog keys `errNetwork`, `errRequest`, `errServer`, `triggerErr.pipeline-error`, `recalcErr.*`; `simErrorText(err: unknown, t): string` from `apps/web/src/simerrors.ts`; the trigger's `500 { error: 'pipeline-error' }` (Task 5).
- Produces: `AsyncData<T>.error` is the worded text for the current language, `undefined` after a success; `failure` keeps the caught value. Test fixture (`apps/web/src/testing/offline.ts`), used again in Task 7:

```ts
/**
 * Makes every later request that matches `method` and `urlPart` fail the way an unreachable
 * server does (fetch rejects with a TypeError). Call it after `installFetchStub`; other requests
 * still reach the stub, and `restoreFetch()` puts the original fetch back.
 */
export function goOffline(method = 'GET', urlPart = ''): void
```

- [ ] **Step 1: Write `apps/web/src/testing/offline.ts`** to the signature above: wrap the current `globalThis.fetch`; a request whose upper-cased method equals `method` and whose URL includes `urlPart` returns `Promise.reject(new TypeError('Failed to fetch'))`, any other goes to the wrapped fetch.

- [ ] **Step 2: Write the failing tests**

`apps/web/src/components/useAsync.test.tsx`:

Scaffold as `apps/web/src/components/Modal.test.tsx:4-22` with these imports after the React ones: `useAsync` from `./hooks`, `ApiError` and `NetworkError` from `../api`, `LangProvider` and `useLang` from `../i18n`. Inside `describe('useAsync error text', …)` use the `container` / `root` declarations and hooks of `Modal.test.tsx:120-121` and `:131-145`, and also run `localStorage.removeItem('st-lang')` in `beforeEach` and `afterEach` and `seenFailure = undefined` in `beforeEach`. Then:

```ts
// Module level, before the describe.
let next: () => Promise<string>;
let seenFailure: unknown;

function Probe() {
  const { data, error, failure, reload } = useAsync(() => next(), []);
  const { setLang } = useLang();
  seenFailure = failure;
  return d(
    'div',
    null,
    d('p', { id: 'data' }, data ?? ''),
    d('p', { id: 'error' }, error ?? ''),
    d('button', { id: 'reload', onClick: () => void reload() }, 'reload'),
    d('button', { id: 'ko', onClick: () => setLang('ko') }, 'ko'),
  );
}

  // Inside the describe.
  const text = (id: string) => document.getElementById(id)!.textContent;
  const settle = () =>
    act(async () => {
      await Promise.resolve();
    });
  const press = async (id: string) => {
    await act(async () => document.getElementById(id)!.click());
    await settle();
  };
  const render = async () => {
    await act(async () => root.render(d(LangProvider, null, d(Probe))));
    await settle();
  };

  it('an unreachable server is worded, and failure keeps the caught value', async () => {
    const caught = new NetworkError('Failed to fetch');
    next = () => Promise.reject(caught);
    await render();
    expect(text('error')).toBe('Could not reach the server. Check the connection and try again.');
    expect(seenFailure).toBe(caught);
  });

  it('a server failure keeps its code in worded copy', async () => {
    next = () => Promise.reject(new ApiError(500, 'http-500'));
    await render();
    expect(text('error')).toBe('The server had a problem (http-500). Try again; if it keeps failing, check the server log.');
  });

  it('a standing error follows a language switch', async () => {
    next = () => Promise.reject(new NetworkError('Failed to fetch'));
    await render();
    await press('ko');
    expect(text('error')).toBe('서버에 연결할 수 없습니다. 연결을 확인하고 다시 시도하세요.');
  });

  it('a rejection with no value still counts as an error, and a later success clears it', async () => {
    next = () => Promise.reject(undefined);
    await render();
    expect(text('error')).toBe('undefined');
    next = () => Promise.resolve('ok');
    await press('reload');
    expect(text('error')).toBe('');
    expect(text('data')).toBe('ok');
    expect(seenFailure).toBeUndefined();
  });
```

`apps/web/src/components/SystemNotices.test.tsx` — import `goOffline` from `'../testing/offline'`. In `a failed first load shows the error and Retry reloads it` and in `a failed Show older keeps the loaded rows and can be retried`, replace the first `expect(container.querySelector('[role="alert"]')).not.toBeNull()` with:

```ts
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(
      'The server had a problem (http-500). Try again; if it keeps failing, check the server log.',
    );
```

and add before `Show older on an expired session…`:

```ts
  it('Show older with the server unreachable is worded, in the page language', async () => {
    localStorage.setItem('st-lang', 'ko');
    await render();
    goOffline('GET', '?before=9');
    await click(buttonByText('이전 알림 더 보기'));
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('서버에 연결할 수 없습니다. 연결을 확인하고 다시 시도하세요.');
    expect(previews().length).toBe(3);
  });
```

`apps/web/src/pages/RunsList.test.tsx` — import `goOffline` from `'../testing/offline'`. Next to `trigger`, add a second route object and register it right after `trigger` in `installFetchStub([...])`; reset both in `beforeEach`:

```ts
const bulk = { method: 'POST' as const, url: '/api/runs/bulk-status', status: 200, json: { updated: 1 } as unknown };
```

```ts
    trigger.json = { result: '"conflict"' };
    bulk.status = 200;
    bulk.json = { updated: 1 };
```

In `a failed morning trigger shows the error and still reloads the notices`, add `trigger.json = { error: 'pipeline-error' };` after `trigger.status = 500;` and replace the `toContain('http-500')` line with:

```ts
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(
      'The morning pipeline stopped before planning any run. See System notices below.',
    );
```

Add at the end of the describe:

```ts
  const alertText = () => container.querySelector('[role="alert"]')?.textContent;
  const SERVER = (code: string) => `The server had a problem (${code}). Try again; if it keeps failing, check the server log.`;
  const NETWORK = 'Could not reach the server. Check the connection and try again.';

  it('a trigger that fails outside the pipeline does not blame the pipeline', async () => {
    trigger.status = 502;
    trigger.json = {};
    await clickTrigger();
    expect(alertText()).toBe(SERVER('http-502'));
  });

  it('a trigger with the server unreachable says so', async () => {
    goOffline('POST', '/api/trigger/morning');
    await clickTrigger();
    expect(alertText()).toBe(NETWORK);
  });

  it('a failed list reload is worded and can be retried', async () => {
    goOffline('GET', '/api/runs');
    await clickTrigger();
    expect(alertText()).toBe(NETWORK);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Retry')).toBe(true);
  });

  it('a failed bulk action is worded with its code', async () => {
    bulk.status = 500;
    bulk.json = {};
    await act(async () => (container.querySelector('input[aria-label="Test run"]') as HTMLInputElement).click());
    const pause = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Pause (1)');
    await act(async () => pause!.click());
    await flush();
    expect(alertText()).toBe(SERVER('http-500'));
  });
```

`apps/web/src/pages/RunDetail.test.tsx` — rename `falls back to the raw code for unknown recalc errors` to `an unknown recalc error keeps its code in worded copy` and replace its last line with:

```ts
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('The request failed (zzz).');
```

`apps/web/src/pages/Sim.test.tsx` — add at the end of `describe('SimPage gap fields')`:

```ts
  it('a failed list load reads in the sim wording, with its code', async () => {
    restoreFetch();
    stub = installFetchStub([settingsRoute, { url: '/api/sim', status: 500, json: {} }]);
    await act(async () => {
      root.render(d(SimPage));
    });
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('The server hit an error (http-500). Try again.');
  });
```

`apps/web/src/pages/SimRun.test.tsx` — add at the end of `describe('SimRunPage')`:

```ts
  it('a simulation that is gone says so instead of showing the code', async () => {
    restoreFetch();
    installFetchStub([{ url: '/api/sim/3', status: 404, json: { error: 'not-found' } }]);
    await act(async () => {
      root.render(d(SimRunPage, { id: 3 }));
    });
    await flush();
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('This simulation no longer exists.');
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `bun test apps/web/src/components/useAsync.test.tsx apps/web/src/components/SystemNotices.test.tsx apps/web/src/pages`
Expected: FAIL — the new and edited expectations show `Failed to fetch`, `http-500`, `http-502`, `pipeline-error`, `zzz`, `not-found` or English where Korean is expected. (`a rejection with no value…` already passes; it pins behaviour the rewrite must keep.)

- [ ] **Step 4: Derive `useAsync`'s error.** In `components/hooks.tsx`: call `useT()` in `useAsync`; replace the `error` string state with a `failed` boolean (`true` in the `catch`, `false` on success); return `error: failed ? errorText(failure, t) : undefined`. `handleUnauthorized(e)` stays where it is. Update the `AsyncData.error` doc comment: worded for the current language by `errorText`.

- [ ] **Step 5: Route the page sites through `errorText`**

| Site | Becomes |
| --- | --- |
| `SystemNotices.tsx` `showOlder` catch | `setOlderError(errorText(err, t))` (the `handleUnauthorized(err)` line before it stays) |
| `RunsList.tsx` `triggerMorning` catch | `setTriggerError(errorText(err, t, 'triggerErr'))` |
| `RunsList.tsx` `runBulk` catch | `setBulkError(errorText(err, t))` |
| `RunDetail.tsx` `setStatus` catch | `setActionError(errorText(err, t))` |
| `RunDetail.tsx` `recalc` catch (the whole `if (err instanceof ApiError) … else …`) | `setActionError(errorText(err, t, 'recalcErr'))`; drop the `ApiError` import, now unused |
| `Settings.tsx` `onSubmit` catch | `setSaveError(errorText(err, t))` |
| `Sim.tsx` list-load `ErrorNote`, `SimRun.tsx` load `ErrorNote` | `message={simErrorText(failure, t)}`, with `failure` taken from `useAsync` next to `error` (which still gates the branch) |

- [ ] **Step 6: Run to verify they pass**

Run: `bun test apps/web/src && bun run typecheck`
Expected: 0 fail; typecheck prints no errors. `bun test`: 1726 pass.

- [ ] **Step 7: Update `AGENTS.md` and commit**

```bash
git add apps/web/src/components/hooks.tsx apps/web/src/components/useAsync.test.tsx apps/web/src/testing/offline.ts apps/web/src/components/SystemNotices.tsx apps/web/src/components/SystemNotices.test.tsx apps/web/src/pages AGENTS.md
git commit -m "fix: loads and page actions show worded errors, and the morning trigger names the pipeline (#80)"
```

---

### Task 7: Forms and dialogs use the worded text; no screen formats an error by hand (#80)

**Files:**
- Modify: `apps/web/src/components/forms/FillDialog.tsx:64-72` (`showFailure`), `CorrectionList.tsx:49-57`, `PendingTable.tsx:115-123` (`reportError`), `EditRunModal.tsx:79`, `CreateRunForm.tsx:127`
- Modify tests: `FillDialog.test.tsx`, `CorrectionList.test.tsx`, `PendingTable.test.tsx`, `EditRunModal.test.tsx`, `CreateRunForm.test.tsx` (all in `apps/web/src/components/forms/`)
- Modify: `apps/web/src/errortext.test.ts` (the source scan)

**Interfaces:**
- Consumes: `errorText(err: unknown, t: Translate, keyPrefix?: string): string` (Task 4); `goOffline(method = 'GET', urlPart = ''): void` from `apps/web/src/testing/offline.ts` (Task 6); catalog keys `fillErr.*`, `errNetwork`, `errRequest`, `errServer`.
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the failing tests.** Each file imports `goOffline` from `'../../testing/offline'`.

`FillDialog.test.tsx` — replace `falls back to the raw message for an unknown error code` with:

```ts
  it('an unknown error code keeps its code in worded copy', async () => {
    putFailure = { status: 422, error: 'weird-code' };
    await render({ costPpm: 30, fill: fillDto(), deletable: true });
    await clickButton('Save');
    expect(errorText()).toBe('The request failed (weird-code).');
  });

  it('a save with the server unreachable is worded and keeps the dialog open', async () => {
    await render({ costPpm: 30, fill: fillDto(), deletable: true });
    goOffline('PUT');
    await clickButton('Save');
    expect(errorText()).toBe('Could not reach the server. Check the connection and try again.');
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
  });
```

`CorrectionList.test.tsx` — in `shows the load error instead of rendering nothing when GET fails`, the last line becomes:

```ts
    expect(container.textContent).toContain(
      'The server had a problem (boom-load). Try again; if it keeps failing, check the server log.',
    );
```

Rename `unknown 422 code falls back to the raw code` to `an unknown 422 code keeps its code in worded copy`; its last line becomes `expect(container.textContent).toContain('The request failed (weird-kind).');`. Add after it:

```ts
  it('apply with the server unreachable is worded and keeps the row', async () => {
    stub([ROW]);
    await render();
    goOffline('POST', '/api/corrections/1/apply');

    await click('Apply');

    expect(container.textContent).toContain('Could not reach the server. Check the connection and try again.');
    expect(container.textContent).not.toContain('Failed to fetch');
    expect(button('Apply')).toBeDefined();
  });
```

`PendingTable.test.tsx` — replace `falls back to the raw code for an unknown 422 confirm error` with:

```ts
  const actionError = () => container.querySelector('[data-testid="pendingActionError"]')?.textContent;

  it('an unknown 422 confirm error keeps its code in worded copy', async () => {
    stubFetch('weird-code', ROW, 422);
    await renderTable(root);
    await clickConfirm();
    expect(actionError()).toBe('The request failed (weird-code).');
  });

  it('a confirm with the server unreachable is worded and keeps the row', async () => {
    stubFetch('conflict');
    await renderTable(root);
    goOffline('POST', '/api/pending');
    await clickConfirm();
    expect(actionError()).toBe('Could not reach the server. Check the connection and try again.');
    expect(container.textContent).toContain('AAPL');
  });
```

`EditRunModal.test.tsx` — add at the end of `describe('EditRunModal cut-loss')`:

```ts
  const alertText = () => document.querySelector('[role="alert"]')?.textContent;

  it('a refused save names the gap update and keeps the code', async () => {
    restoreFetch();
    calls = installFetchStub([{ method: 'POST', url: '', status: 422, json: { error: 'invalid-body' } }]);
    await render();
    await save();
    expect(alertText()).toBe('gap update failed (invalid-body)');
    expect(saved).toBe(0);
  });

  it('a save with the server unreachable is worded', async () => {
    await render();
    goOffline('POST');
    await save();
    expect(alertText()).toBe('Could not reach the server. Check the connection and try again.');
    expect(saved).toBe(0);
  });
```

`CreateRunForm.test.tsx` — add at the end of `describe('CreateRunForm gap fields')`:

```ts
  const alertText = () => document.querySelector('[role="alert"]')?.textContent;
  const fillAndSubmit = async () => {
    await act(async () => {
      root.render(d(CreateRunForm));
    });
    await act(async () => {
      setInputValue(inputByLabel('Ticker'), 'QQQ');
      setInputValue(inputByLabel('Pool'), '10000');
    });
    await submitForm();
  };

  it('a refused create keeps its code in worded copy', async () => {
    restoreFetch();
    stub = installFetchStub([
      { url: '/api/settings', json: { visionBaseUrl: '', visionModel: '', digestLang: 'en', hasVisionApiKey: false, defaultCostPpm: 700 } },
      { method: 'POST', url: '/api/runs', status: 400, json: { error: 'invalid-body' } },
    ]);
    await fillAndSubmit();
    expect(alertText()).toBe('The request failed (invalid-body).');
  });

  it('a create with the server unreachable is worded', async () => {
    goOffline('POST', '/api/runs');
    await fillAndSubmit();
    expect(alertText()).toBe('Could not reach the server. Check the connection and try again.');
  });
```

`apps/web/src/errortext.test.ts` — add a second describe:

```ts
// One helper words every failed request. A screen that formats the caught value itself
// brings back the browser's "Failed to fetch"; api.ts only stores that text on NetworkError.
describe('raw error text', () => {
  it('no screen formats a caught error by hand', async () => {
    const src = new URL('.', import.meta.url).pathname;
    const raw = /\b(err|e|error)\.message\b|String\((err|e|error)\)|=== key \? err\./;
    const offenders: string[] = [];
    for (const file of new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: src })) {
      if (/\.test\.tsx?$/.test(file) || file.startsWith('testing/') || file === 'api.ts' || file === 'errortext.ts') continue;
      if (raw.test(await Bun.file(src + file).text())) offenders.push(file);
    }
    expect(offenders.sort()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/web/src/components/forms apps/web/src/errortext.test.ts`
Expected: FAIL — raw `weird-code`, `weird-kind`, `invalid-body` or `Failed to fetch` where worded copy is expected, and the scan lists exactly `components/forms/CorrectionList.tsx`, `CreateRunForm.tsx`, `EditRunModal.tsx`, `FillDialog.tsx`, `PendingTable.tsx`. (`a refused save names the gap update…` already passes; it pins copy this task must keep.) If the scan lists any other file, an earlier task missed a site: fix it here and say so in the report.

- [ ] **Step 3: Route the form sites through `errorText`**

| Site | Becomes |
| --- | --- |
| `FillDialog.tsx` `showFailure` | `const showFailure = (err: unknown) => setError(errorText(err, t, 'fillErr'))`; drop the `ApiError` import, now unused |
| `CorrectionList.tsx` `act` catch: the last two branches (`else if (err instanceof ApiError) {…} else {…}`) | one `else { setActionError(errorText(err, t, 'fillErr')) }`; the `correction-stale` and 409 branches stay |
| `PendingTable.tsx` `reportError`: the last two branches | one `else { setActionError(errorText(err, t, 'fillErr')) }`; the `ticker-mismatch` and 409 branches stay |
| `EditRunModal.tsx` `submit` catch | the `ApiError` line stays; the `else` becomes `setSubmitError(errorText(err, t))` |
| `CreateRunForm.tsx` `submit` catch | `setError(errorText(err, t))` |

The comments that describe the old fallback ("the rest fall back to the raw server code") go with the code they describe.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test apps/web/src && bun run typecheck`
Expected: 0 fail; typecheck prints no errors. `bun test`: 1734 pass, 81 skip, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/forms apps/web/src/errortext.test.ts
git commit -m "fix: forms and dialogs show worded errors; no screen formats a caught error by hand (#80)"
```

---

### Task 8: Whole-branch verification, then the issue comments

**Files:** none (this task changes no file and makes no commit).

**Interfaces:**
- Consumes: the finished branch.
- Produces: one comment on #69 and one on #50. No issue is closed.

- [ ] **Step 1: Unit suites and types**

Run: `bun test && bun run typecheck`
Expected: 1734 pass, 81 skip, 0 fail; typecheck prints no errors.

- [ ] **Step 2: Check the test database is up** — `docker ps --format '{{.Names}}' | grep -x st-mariadb-test`. It was running when this plan was written. If it prints nothing, do **not** start or create the container: stop here and report that Steps 3 to 6 are still to do.

- [ ] **Step 3: DB suite and the E2E smoke**

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test`
Expected: 0 fail (the DB-gated files now run instead of skipping).

Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`
Expected: exit 0 and a last line starting `e2e OK` (128 assertions when this plan was written).

- [ ] **Step 4: Confirm the repo map.** `AGENTS.md` lists `errortext.ts` (line 42), `offline` in `testing/{…}` (line 43) and `inert` in `components/{…}` (line 44). If one is missing, add it and commit `docs: list the new web modules in the repo map`.

If any of Steps 1 to 3 failed, stop and report; post nothing.

- [ ] **Step 5: Comment on #69** (it stays open):

```bash
gh issue comment 69 --body-file - <<'EOF'
Shipped on `fix/issues-69-80`: while a dialog is open, everything outside it is `inert` (`apps/web/src/components/inert.ts`, taken and released by `Modal`). Nested dialogs, step swaps and StrictMode leave nothing inert behind, an element that was already inert is left alone, and focus still returns to the opener. Form-field hints are now the control's description (#78).

Still open here:
- a pass with a real screen reader: dialogs, the inert background, field hints, alerts;
- content that mounts behind a dialog while it is open is not marked inert (there is no observer). The overlay covers it and the focus trap holds the keyboard, but a virtual cursor can reach it;
- the keep-screenshot notices and the pending table's action alert live outside every dialog. If another dialog happens to be open when one of them changes, it is not announced; the notice stays on screen until dismissed.

Moved: the colour-only resting "changed" mark goes with #68.
EOF
```

- [ ] **Step 6 (the final step): Comment on #50** with the new Korean copy:

```bash
gh issue comment 50 --body-file - <<'EOF'
Three more machine-written Korean strings from `fix/issues-69-80` (#80) for the same native read. They are the web app's fallback error messages.

| Key | English | Korean |
| --- | --- | --- |
| `errServer` | The server had a problem ({code}). Try again; if it keeps failing, check the server log. | 서버에 문제가 발생했습니다 ({code}). 다시 시도하고, 계속 실패하면 서버 로그를 확인하세요. |
| `errRequest` | The request failed ({code}). | 요청에 실패했습니다 ({code}). |
| `triggerErr.pipeline-error` | The morning pipeline stopped before planning any run. See System notices below. | 아침 파이프라인이 런을 하나도 계획하지 못하고 중단되었습니다. 아래 시스템 알림을 확인하세요. |

Where they show: `errServer` and `errRequest` on any screen when a request fails with a code the catalog has no sentence for (`{code}` is the server's code, left untranslated). `triggerErr.pipeline-error` on the Runs page when "Run morning pipeline" fails; it points at the System notices panel right below, which carries `digest.warn-pipeline-error`.
EOF
```

Report the two comment URLs.
