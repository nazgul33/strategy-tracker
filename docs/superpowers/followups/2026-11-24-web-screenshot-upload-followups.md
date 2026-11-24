# Web screenshot upload — deferred follow-ups

Date: 2026-11-24
Branch: `feat/web-screenshot-upload` (`6755ae5..` HEAD)
Spec: `docs/superpowers/specs/2026-11-24-web-screenshot-upload-design.md`
Plan: `docs/superpowers/plans/2026-11-24-web-screenshot-upload.md`

The branch adds `POST /api/captures` on a routing core shared with the Telegram
bot, and an upload popup on the run page and the Pending page. The whole-branch
review found no Critical issue; its three Important findings and seven smaller
ones were fixed on the branch. What follows is what the task reviews and the
whole-branch review found and the branch deliberately left.

## Behaviour an operator could notice

- **Leaving the page mid-upload.** The popup cannot be dismissed while files
  upload, but browser Back or a hash change still unmounts it. The remaining
  files keep uploading (`UploadDialog.tsx` `start`), and the page never learns
  an upload happened, so it does not refresh. The rows are in Pending, and a
  re-upload is deduplicated.
- **The pending-head link is dead on the run page.** A pinned upload's result
  line links to `#/runs/<id>` (`uploadlines.ts`), which is the page the operator
  is already on.
- **Refusal lines accumulate.** A refused file's line stays in the picker until
  "Upload more"; picking the same wrong file twice shows it twice.
- **English fragments in Korean result lines.** The vision `detail` text
  (`http 500`, `no fills recognized`) is interpolated as the server wrote it.
  The bot does the same.
- **Size text.** A file just under 1 MiB reads "1024 KB" (`fileSizeText`).
- **No way to stop a batch or retry one file.** Up to 50 seconds per file with
  the popup locked; a failed file is retried by picking it again. Not in the spec.
- **A 401 mid-upload** shows "The request failed (unauthorized)" without a
  redirect to login, like every other mutation dialog.

## Hardening left open

- **Declared mime is trusted.** The route checks `file.type` against the
  allow-list and does not read magic bytes. A mislabelled file only fails vision.
- **A chunked body without a length** is bounded only by Bun's 128 MB
  `maxRequestBodySize`; the 8 MB check runs after parsing.
- **`visionTimeoutMs` is not validated** in `extractWithin` (`capture-route.ts`):
  0, a negative number or `NaN` is an immediate timeout. Its one caller passes
  the constant 50 000.
- **Only a first `unknown-run` event becomes 404.** The core emits it first and
  returns, so a later one cannot occur today; the wire type does not enforce it.
- **Mirrored constants.** `UPLOAD_MIMES`, `MAX_UPLOAD_BYTES` and
  `VISION_TIMEOUT_DETAIL` on the web repeat server values and are held together
  by comments. A source-text pin like the one in `catalog.test.ts` would catch
  drift.
- **`CaptureOutcomeDto` is looser than the server's union**: one all-optional
  object instead of three variants.
- **A 200 answer whose JSON body is literally `null`** makes `uploadCapture`
  throw a `TypeError` rather than an `ApiError` (`call()` returns the body
  as-is). The file still shows as failed, with the raw message.

## Polish

- `scripts/e2e-web-upload.ts` lost its trailing newline in the fix pass.
- `apps/web/src/api.ts`: the comment "call() has the status no more" should read
  "call() does not return the status".

## Test gaps

- No route-level test that a declared `Content-Length` over the cap answers 413
  before the body is read (only `declaredTooLarge` is unit-tested).
- `runId` sent as a file part (the non-string branch) is untested.
- No test that thumbnails' object URLs are revoked on remove or unmount;
  `testing/upload.ts` `ensureObjectUrls` patches the global `URL` and never
  restores it (inert under happy-dom today).
- The `idleTimeout` pin in `main-boot-order.test.ts` matches `main.ts` as source
  text, because `main()` has no seam for a fake server.
- `Modal.test.tsx` is 410 lines (384 before the branch) and is due a split.
- The Tab trap in `Modal.tsx` lets focus leave when the focused control becomes
  disabled (`index === -1` returns without `preventDefault`). The upload popup
  moves focus itself on each phase change, so no host hits this today.

## Not from this branch

- `apps/web/src/components/RecalcSummary.test.tsx` prints six React `act(...)`
  warnings on `main` as well.
