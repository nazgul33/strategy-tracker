# Web errors and form accessibility (#69, #78, #79, #80)

Group B of the open follow-ups. Branch: `fix/issues-69-80`.

## Intent

Make the web app's dialogs and forms complete for keyboard and screen-reader users, and give every screen worded error copy instead of the browser's raw text.

- **#69 (what remains of it):** while a dialog is open, the page behind it is `inert`. A screen reader then can't wander into the background, and a mouse or touch can't reach it either. The focus trap, Escape, initial focus and focus restore already shipped in #82.
- **#78:** a form field's hint becomes the control's *description* (`aria-describedby`), no longer part of its *name*.
- **#79:** the Compare dialog marks a field vision missed with the same `border-warning` the pending row uses, until the operator fills it.
- **#80:** every screen maps errors the same way: no connection → "Could not reach the server…", known server codes → worded copy, anything else → a worded fallback that keeps the code visible. The morning trigger's failure gets its own worded message instead of `http-500`.

## Non-goals

- A manual screen-reader pass (stays on #69) and the colour-only resting "changed" mark (goes with #68). #69 gets a comment, not a close.
- Moving dialogs into a portal.
- #68's phone layout and browser check; the Korean native read (#50). New Korean copy is added to that list.
- Splitting oversized test files (#81).

## Approaches considered for the inert background (#69)

1. **Inert siblings along the dialog's ancestor chain (chosen).** On open, `Modal` walks from its overlay up to `<body>` and sets `inert` on every sibling of every ancestor. On close, it undoes exactly what it set. No DOM moves, so tests that query inside a dialog's page container keep working.
2. Portal every dialog to `document.body` and mark `#root` inert. Textbook, but it moves every dialog out of its container, and many tests look there.
3. Leave it. The focus trap and `aria-modal` cover keyboard users, but not virtual-cursor or pointer users.

## Design

### Inert background — `apps/web/src/components/Modal.tsx` (#69)

- On mount: for each ancestor from the overlay up to (not including) `<html>`, mark every element sibling inert.
- Reference-counted per element (module-level `WeakMap<Element, number>`). An element that was already inert before any dialog touched it is never un-inerted. Nested dialogs and step swaps (the new panel mounts before the old one's cleanup) leave the right set inert.
- On unmount (including StrictMode's simulated unmount): decrement, and remove `inert` when the count reaches zero.
- The outer dialog's own content stays reachable through the inner dialog only where the inner one doesn't cover it. An inner dialog rendered inside the outer panel makes the outer panel's other children inert, which is the intent.
- Constraint: a live region that must announce while a dialog is open lives inside that dialog (check `KeepNotices`, `role="status"` notes in `EditRunModal`/`CreateRunForm`). If one sits outside, move it in or explain why it can wait until the dialog closes.
- The inert bookkeeping may move to its own small module *(builder's call)*.

### Field hints as descriptions — `apps/web/src/components/ui.tsx` (#78)

- `Field` generates a hint id (`useId`) and renders `<div><label>{label}{control}</label>{hint}</div>`, with the hint outside the `<label>` and given that id.
- The single child control gets `aria-describedby` merged with any it already has (`cloneElement`). No hint → no attribute.
- Callers don't change: CreateRunForm, SimConfigFields, FillDialog, PendingReviewDialog. Tests that find controls by label text keep working; tests that read the hint inside the label are updated.
- In the Compare dialog the hint text changes as the operator edits, and only the description changes with it.

### Missed fields in the Compare dialog — `PendingReviewDialog.tsx` (#79)

- `standingIssues(row, draft)` marks each missed, still-blank field's control with `border-warning`, merged with the edit-hint classes, exactly as `PendingRow` does.

### Worded errors — new `apps/web/src/errortext.ts` (#80)

- `errorText(err: unknown, t, keyPrefix?: string): string`:
  - `NetworkError` → `t('errNetwork')` (existing).
  - `ApiError` with a `keyPrefix` whose `${keyPrefix}.${code}` exists in the catalog → that copy (keeps today's `fillErr.*` behaviour).
  - `ApiError` 5xx or `http-5xx` → new `errServer` ("The server had a problem ({code}). Try again; if it keeps failing, check the server log.").
  - Other `ApiError` → new `errRequest` ("The request failed ({code}).").
  - Anything else → its message.
- Every raw-message site in the issue (and `RunsList` trigger/bulk, `RunDetail`, `SystemNotices` older-page, `hooks.useAsync`) uses it. `useAsync` keeps its `failure` value; its `error` string becomes the worded text.
- `simErrorText` and `visionReviewErrorText` keep their own screen-specific copy, built on `errorText` for the shared cases *(builder's call: thin wrappers)*.
- `handleUnauthorized` behaviour is unchanged.

### Morning trigger — `apps/server/src/http/app.ts` + `RunsList.tsx` (#80 comment)

- `POST /api/trigger/morning` catches a pipeline throw, logs it, and answers `500 { error: 'pipeline-error' }`. The System notices feed already carries the full warning.
- `ApiErrorCode` gains `'pipeline-error'`. The Runs page shows the new `triggerErr.pipeline-error` copy: "The morning pipeline stopped before planning any run. See System notices below." / Korean equivalent.

### Copy

New en/ko keys: `errServer`, `errRequest`, `triggerErr.pipeline-error`. Korean is drafted here and added to #50's list for a native read.

## Constraints

- File size: the ~300-line convention is not enforced on this branch (operator ruling); files may grow and get split later. Don't split files here.
- All user-facing copy via en/ko catalogs; the web catalog parity tests stay green.
- `bun test`, `bun run typecheck` and `scripts/e2e.ts` pass.
- Close #78, #79 and #80 with the PR; comment on #69 with what is left.

## Left to the builder

Module placement of the inert helper, wrapper shape for the sim and review error helpers, test file placement, and commit split.
