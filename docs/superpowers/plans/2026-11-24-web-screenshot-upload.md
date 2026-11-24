# Web screenshot upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The operator can upload broker screenshots from the web app (pinned to a run from the run page, auto-routed by ticker from the Pending page). The upload goes through the same pin and auto-route rules the Telegram bot uses, and a popup shows what each capture produced.

**Architecture:** The pin and auto-route half of the Telegram `onPhoto` moves into a transport-neutral routing core (`wire/capture-route.ts`) that reports typed events through an async sink. Telegram turns each event into the reply it sends today. A new `POST /api/captures` route validates a multipart upload, calls the core through an injected `HttpDeps.routeCapture` with a 50-second vision limit, and returns the events as JSON. The web gets `api.uploadCapture`, a pure event→lines mapper, an `UploadDialog` popup, and an upload button on the run page and on the Pending page.

**Tech Stack:** Bun 1.4.5, TypeScript, Hono 4.13, React 18, Tailwind 3, Bun test with happy-dom 21 (`@happy-dom/global-registrator`), en/ko JSON catalogs.

**Spec:** `docs/superpowers/specs/2026-11-24-web-screenshot-upload-design.md`
**Branch:** `feat/web-screenshot-upload`. Line numbers are from the commit this plan was written on. Later tasks locate code by symbol.
**Execution:** subagent-driven: one fresh implementer per task, then a reviewer per task.

## Global Constraints

- Work only in this worktree and run every command from its root. The worktree has no `node_modules`: run `bun install` once before Task 1. It writes only the git-ignored `node_modules/`.
- English only in code, comments and tests. Korean appears only in `apps/web/src/i18n/ko.json` values (and in tests that pin ko catalog output). Never Chinese or Cyrillic characters.
- No source file over ~300 lines. Every task that touches a file near the limit has a `wc -l` step.
- `packages/*` never import `apps/*`. `fetch` stays injectable (server: `fetchImpl`; web tests: `apps/web/src/testing/fetchStub.ts`).
- Every user-facing web string goes through `apps/web/src/i18n/en.json` **and** `ko.json` with the exact text given in Task 7. Both catalogs keep identical keys, identical `{placeholders}` and `localeCompare` key order (`apps/web/src/catalog.test.ts`).
- Anti-goals: no Telegram reply changes (text, order, keyboard, which replies are recorded as notices), and no second copy of the pin and auto-route rules.
- Non-goals: no confirm or reject inside the popup, no job queue, polling or resumable upload, no Telegram message about a web upload, no image conversion (HEIC stays unsupported), no schema change and no migration.
- The existing `apps/server/test/wire-capture-*.test.ts`, `capture-replies.test.ts` and `booking-capture-*.test.ts` keep their assertions untouched. The only exception is the source-text pin at `capture-replies.test.ts:74-79`, which Task 1 rewrites. Fixture changes for a changed constructor signature are allowed.
- Pinned values: `MAX_IMAGE_BYTES = 8 * 1024 * 1024` (existing, `domain/capture-image.ts`); accepted mimes `image/jpeg`, `image/png`, `image/webp`, `image/gif`; web vision limit `50_000` ms; `Bun.serve` `idleTimeout: 60` (seconds); error codes `vision-not-configured` (503), `invalid-body` (400), `unsupported-image` (415), `image-too-large` (413), `no-run` (404), `capture-failed` (500).
- Image bytes become base64 with `Buffer.from(bytes).toString('base64')`, the bot's encoding (`packages/telegram/src/bot.ts:56`). `ingestCapture` hashes that string, so the same screenshot dedups across the bot and the web.
- Commit style `feat|fix|docs|test|refactor|chore:`, one commit per task. `bun run typecheck` and `bun test` pass at the end of every task. Record the `bun test` pass/skip/fail counts before Task 1 and report the new counts in each task's report.

## Decisions (the spec's "Left to the builder" items, and calls made while planning)

- **Routing core:** module `apps/server/src/wire/capture-route.ts`, factory `makeCaptureRouting(deps: CaptureRouteDeps): RouteCapture`, event union `CaptureEvent`, sink `CaptureEventSink`. `CaptureDeps` (in `wire/capture.ts`) becomes `CaptureRouteDeps` plus `repos: CaptureRepos`, `lang`, `allowedChatIds` and `send`, so every existing `makeCaptureHandlers({...})` call compiles unchanged.
- **Vision time limit:** an optional `visionTimeoutMs` on the request. When the timer fires, the core aborts the vision `fetch` through an `AbortSignal` and reports `bad-extract` with detail `VISION_TIMEOUT_DETAIL = 'vision timed out'`. Without the option, `fetch` gets no signal at all (Telegram unchanged).
- **Injected HTTP function:** `HttpDeps.routeCapture: RouteCapture`, the same type the core returns. `main.ts` passes `makeCaptureRouting(...)` built from the same deps object the Telegram handlers get. The route checks "vision configured" against `deps.defaultSettings.visionBaseUrl` / `visionModel`, which `main.ts` already fills with the boot-resolved Settings-or-env values. The route never reads `settingsRepo`.
- **Body cap:** two layers, both before the vision call. (1) A declared `Content-Length` above `MAX_UPLOAD_BODY_BYTES = MAX_IMAGE_BYTES + 64 * 1024` gets 413 before the body is read. (2) After parsing, `file.size > MAX_IMAGE_BYTES` gets 413, in the spec's check order. A chunked body without a length is still bounded by Bun's `maxRequestBodySize` default of 128 MB (`bun-types` `serve.d.ts:842-845`). Hono's `bodyLimit` is not used: as middleware it would answer 413 before the 503 check.
- **Multipart parsing:** `await c.req.formData()` in a `try`. A parse failure, `getAll('image').length !== 1`, a non-`File` image, or a `runId` that is present but fails `parseId` gives 400 `invalid-body`.
- **Allow-list export:** `domain/capture-image.ts` exports its existing set as `export const ALLOWED_MIMES: ReadonlySet<string>` (same name, now exported).
- **Unknown pinned run over HTTP:** if the first collected event is `unknown-run`, the route answers 404 `{ error: 'no-run' }`. The 200 body type excludes `unknown-run`.
- **No System notice for a web `bad-extract`:** the HTTP route never calls `broadcastNotice`.
- **Env:** `EnvConfig` gains top-level `visionBaseUrl: string` and `visionModel: string`, read with or without a token. `TelegramEnv` keeps its two vision fields, so the existing `wire.test.ts` pins stay as they are. `main.ts` falls back to the top-level fields.
- **Web API split:** `apps/web/src/api.ts` is at 292 lines. `ApiErrorCode`, `ApiError`, `NetworkError` and `call` move to a new `apps/web/src/api.call.ts`, and `api.ts` re-exports the three public names. Capture DTOs go in a new `apps/web/src/api.captures.types.ts`, re-exported with `export type *` (the `api.notices.ts` pattern).
- **Pure web helpers:** `apps/web/src/uploadpick.ts` holds the pick-time checks and size text. `apps/web/src/uploadlines.ts` holds the event→lines mapping, the item type and the "go to pending" rule.
- **Modal switch:** `Modal` gains `dismissible?: boolean` (default `true`). When it is `false`, the backdrop click, the ✕ (rendered `disabled`) and Escape all do nothing.
- **Popup:** `apps/web/src/components/forms/UploadDialog.tsx`, with `UploadPicker.tsx` (drop zone, input, file list) and `UploadResults.tsx` (lines) beside it. `onClose(outcome: UploadCloseOutcome)` with `{ uploaded, goToPending }`. `uploaded` turns true once any request has been sent, whatever its result: a 500 or a lost connection may still have written rows, and a refresh is cheap.
- **"Go to pending" is primary** when any file's events contain an `outcome` with at least one pending row, or a conflict with `matchedKind: 'booked'` whose `correction?.status === 'open'`. Otherwise the primary button is "Close". "Upload more" is always shown in the done state and returns to an empty picker. `uploaded` stays as it was.
- **Result line order inside one `outcome`** follows the bot: conflicts head (only when there are both pending rows and conflicts), conflict lines, booked-earlier warning (only with pending rows), pending head (a link to `#/runs/:id`), then one line per fill with its fix-in-Pending reasons below it.
- **What moves out of `RunDetail.tsx`:** the title block and the header actions row (lines 122-156) move to a new `apps/web/src/components/RunHeader.tsx`. The markup and classes stay identical, so existing RunDetail tests pass unchanged.
- **Refresh after an upload:** on the Pending page, a `refresh` counter feeds `PendingTable refreshKey` (in place, typed edits survive) and remounts `CorrectionList` via `key`. On the run page, `panelKey` is incremented and the run reloaded. An `uploadKey` is appended to the `CorrectionList` key so it re-reads too. "Go to pending" calls the existing `selectTab('pending')`.
- **`scripts/e2e.ts` is already 317 lines.** Task 10 moves its deterministic-sim block (fixtures and step) to `scripts/e2e-sim.ts` before adding the new step.
- **`idleTimeout` (verified):** `bun-types` 1.4.4 (the version `bun.lock` pins; there are no 1.4.5 types, and the worktree has no `node_modules`; read from `~/.bun/install/cache/bun-types@1.4.4@@@1/serve.d.ts:951-958`) documents `idleTimeout` as "the number of seconds to wait before timing out a connection due to inactivity", `@default 10`. A runtime probe on the installed Bun 1.4.5 matched this. With no option, a handler sleeping 25 s was reset after about 12 s, and Bun printed `Bun.serve() timed out a request after 10 seconds. Pass idleTimeout to configure.` With `idleTimeout: 60` a 12 s handler answered 200. With `idleTimeout: 2` a 5 s handler was reset. The unit is seconds, so `60` is right. Side note: `Server.timeout(request, seconds)` exists (`serve.d.ts:1236`) and could set a per-request limit from `main.ts`'s fetch wrapper. The spec's server-wide setting is kept as decided.

## Review Focus

1. **The same screenshot goes in through Telegram and then the web (or twice through the web).** It must report a duplicate and never create a second pending row. This needs both paths to produce the identical base64 string. Pinned in Task 4 (the route passes `Buffer.from(bytes).toString('base64')`) and Task 10 (a photo sent through the bot handler, then the same bytes uploaded on the web, reports `duplicate`).
2. **A file that is not a supported image.** An iPhone HEIC, a PDF, or a dropped file whose `type` is the empty string must be refused at pick time with the server's wording, and with 415 if it reaches the server anyway. Pinned in Task 7 (`pickRefusal` for `''`, `image/heic`, `application/pdf`) and Task 4 (`image/heic` → 415, vision never called).
3. **The operator tries to close the popup while a capture is in flight** (Escape, backdrop, ✕, Cancel). Nothing may close it, and the result must still appear. Pinned in Task 6 (Modal) and Task 8 (held request).
4. **The connection drops mid-upload, or one of several files fails.** The remaining files still upload in order, and the failed file says the capture may have completed and to check Pending. Pinned in Task 8 (three files: ok, network error, duplicate).
5. **The run behind a run-page upload was deleted, or vision is not configured on a bot-less install.** The popup must say so plainly (run gone, or set it up in Settings) instead of showing a bare code. Pinned in Task 4 (404 `no-run`, 503 `vision-not-configured`), Task 3 (vision env read without a token) and Task 8 (Settings link).

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `apps/server/src/wire/capture-route.ts` | create | Routing core: pinned lookup, extraction (optional time limit), pin filter, ticker auto-route, events |
| `apps/server/src/wire/capture.ts` | modify | Caption regex, event → Telegram reply mapping, confirm/status/orders (unchanged) |
| `apps/server/src/http/routes/captures.ts` | create | `POST /api/captures`: checks, base64, core call, JSON events |
| `apps/server/src/http/app.ts` | modify | `HttpDeps.routeCapture`, mount `capturesRouter` |
| `apps/server/src/domain/capture-image.ts` | modify | export `ALLOWED_MIMES` |
| `apps/server/src/wire/deps.ts` | modify | top-level `visionBaseUrl` / `visionModel` |
| `apps/server/src/main.ts` | modify | env fallback, shared core deps, `routeCapture`, `idleTimeout: 60` |
| `apps/server/test/capture-route.test.ts` | create | core events per branch, time limit |
| `apps/server/test/http-captures.test.ts` | create | route rejections, pinned, auto, 404, 500 |
| `apps/server/test/{capture-replies,wire,main-boot-order}.test.ts`, `http-fakes.ts` | modify | rewritten pin, env tests, source pin, `routeCapture` default |
| `apps/web/src/api.call.ts` | create | `ApiErrorCode`, `ApiError`, `NetworkError`, `call` |
| `apps/web/src/api.captures.types.ts` | create | `CaptureEventDto` and friends |
| `apps/web/src/api.ts` | modify | `uploadCapture`, re-exports |
| `apps/web/src/uploadpick.ts`, `uploadlines.ts` | create | pure pick checks / event lines |
| `apps/web/src/components/Modal.tsx` | modify | `dismissible` |
| `apps/web/src/components/forms/{UploadDialog,UploadPicker,UploadResults}.tsx` | create | popup |
| `apps/web/src/components/RunHeader.tsx` | create | run title + header actions (moved) |
| `apps/web/src/pages/{RunDetail,Pending}.tsx` | modify | upload buttons, refresh |
| `apps/web/src/testing/upload.ts` | create | file/pick/paste/drop/upload-stub helpers |
| `apps/web/src/i18n/{en,ko}.json` | modify | Task 7 keys |
| `scripts/e2e-web-upload.ts`, `scripts/e2e-sim.ts` | create | new step; moved sim step |
| `scripts/e2e.ts`, `scripts/e2e-ctx.ts` | modify | `routeCapture`, `ctx.upload`, step call |
| `AGENTS.md`, `README.md` | modify | repo map, env table, the new way in |

---

### Task 1: Routing core extracted from the Telegram handler

**Files:**
- Create: `apps/server/src/wire/capture-route.ts`
- Modify: `apps/server/src/wire/capture.ts:31-180` (types, `extractOrTell`, `onPhoto`; `sendOutcome` and `conflictLine` stay)
- Modify: `apps/server/test/capture-replies.test.ts:72-79` (the one source pin)
- Test: `apps/server/test/capture-route.test.ts`

**Interfaces:**
- Consumes: `ingestCapture`, `CaptureOutcome`, `RepoSurface` from `../domain/booking`; `extractFills` from `@st/ingest`; test fakes `makeCaptureFakes`, `activeRun`, `visionFetch`, `multiVisionFetch`, `PNG_B64` from `apps/server/test/wire-capture-fakes.ts`.
- Produces (in `apps/server/src/wire/capture-route.ts`):
  ```ts
  export interface CaptureRouteDeps {
    repos: RepoSurface
    vision: { baseUrl: string; model: string }
    getVisionApiKey(): Promise<string>
    today(): string
    fetchImpl?: typeof fetch
  }
  export type CaptureEvent =
    | { type: 'unknown-run'; id: number }
    | { type: 'bad-extract'; detail: string }
    | { type: 'pin-nomatch'; runId: number; ticker: string }
    | { type: 'pin-skipped'; runId: number; tickers: string[] }
    | { type: 'no-run'; ticker: string }
    | { type: 'ambiguous'; ticker: string }
    | { type: 'outcome'; runId: number; ticker: string; outcome: CaptureOutcome }
  export type CaptureEventSink = (event: CaptureEvent) => Promise<void>
  export interface RouteCaptureRequest { image: { base64: string; mime: string }; pinnedRunId: number | null }
  export type RouteCapture = (req: RouteCaptureRequest, emit: CaptureEventSink) => Promise<void>
  export function makeCaptureRouting(deps: CaptureRouteDeps): RouteCapture
  ```
  In `wire/capture.ts`: `export interface CaptureDeps extends CaptureRouteDeps { repos: CaptureRepos; lang?: Lang; allowedChatIds: string[]; send(chatId: string, text: string, extra?: Record<string, unknown>): Promise<void> }`. `CaptureRepos` and `makeCaptureHandlers` keep their names and exports.

- [ ] **Step 1: Write the failing core tests** in `apps/server/test/capture-route.test.ts`. Use a local helper `routing(opts: FakeOpts & { fetchImpl?: typeof fetch })` that builds the core over `makeCaptureFakes(opts).repos` (vision `{ baseUrl: 'https://vision.example/v1', model: 'vision-model' }`, key `'k'`, today `'2026-11-10'`, `fetchImpl` defaulting to `visionFetch`). It collects events into an array and exposes `run(pinnedRunId)`, which sends `{ base64: PNG_B64, mime: 'image/png' }`. Count vision calls by wrapping `fetchImpl`. Tests:
  - `unknown pinned run: one unknown-run event, no vision call`: `events` equals `[{ type: 'unknown-run', id: 42 }]`, vision calls `0`, `captures.length` `0`.
  - `vision failure is a bad-extract with the extractor's detail`: fetch answers `{ ok: false, status: 500 }`, so `events` equals `[{ type: 'bad-extract', detail: 'http 500' }]` and `captures.length` is `0`.
  - `a pinned paused run books its own ticker`: runs `[{ ...activeRun(7, 'NVDA'), status: 'paused' }]`, `run(7)`. Then `events` has length 1 and `toMatchObject` `{ type: 'outcome', runId: 7, ticker: 'NVDA', outcome: { pending: [{ runId: 7, ticker: 'NVDA', side: 'buy', shares: 10, price: '180.50', filledOn: '2026-11-10', needsBucket: false, dateAfterToday: false }] } }`.
  - `a pinned run with no fill of its ticker`: runs `[activeRun(1, 'NVDA'), activeRun(3, 'AAPL')]`, `run(3)`. Then `events` equals `[{ type: 'pin-nomatch', runId: 3, ticker: 'AAPL' }]`.
  - `a pinned run reports foreign tickers before its outcome`: `multiVisionFetch`, runs `[activeRun(1, 'NVDA')]`, `run(1)`. Then `events.map((e) => e.type)` equals `['pin-skipped', 'outcome']` and `events[0]` equals `{ type: 'pin-skipped', runId: 1, tickers: ['AAPL'] }`.
  - `auto-route: one outcome per ticker group, in fill order`: `multiVisionFetch`, runs `[activeRun(1, 'NVDA'), activeRun(2, 'AAPL')]`, `run(null)`. Then `events.map((e) => [e.type, 'ticker' in e ? e.ticker : null])` equals `[['outcome', 'NVDA'], ['outcome', 'AAPL']]`.
  - `auto-route: no-run and ambiguous do not stop the other group`: with `[activeRun(1, 'NVDA')]` the types are `['outcome', 'no-run']` and `events[1]` is `{ type: 'no-run', ticker: 'AAPL' }`. With `[activeRun(1, 'NVDA'), activeRun(2, 'AAPL'), activeRun(3, 'AAPL')]` the second event is `{ type: 'ambiguous', ticker: 'AAPL' }`.
  - `auto-route considers active runs only`: runs `[{ ...activeRun(1, 'NVDA'), status: 'paused' }]`, `run(null)`. Then `events` equals `[{ type: 'no-run', ticker: 'NVDA' }]`.
  - `the same image twice is a duplicate outcome`: two `run(null)` calls with `[activeRun(1, 'NVDA')]`. `events[1]` equals `{ type: 'outcome', runId: 1, ticker: 'NVDA', outcome: 'duplicate' }`.
  - `a throw in the second ticker group leaves the first group's event delivered`: `multiVisionFetch`, both runs active, and `pendingRepo.insert` throws `new Error('db-down')` when `row.ticker === 'AAPL'`. Then `await expect(run(null)).rejects.toThrow('db-down')` and `events.map((e) => e.type)` equals `['outcome']`.

- [ ] **Step 2: Run them to verify they fail**
  Run: `bun test apps/server/test/capture-route.test.ts`
  Expected: FAIL (`Cannot find module '../src/wire/capture-route'`).

- [ ] **Step 3: Implement `makeCaptureRouting` in `apps/server/src/wire/capture-route.ts`** by moving the logic of `onPhoto` (`capture.ts:76-143`) and `extractOrTell` (`capture.ts:59-73`, `maxTokens: 4096`) and replacing every `send`/`tellBadExtract`/`sendOutcome` with an `await emit(...)` of the matching event. The rules stay identical: the pinned run has no status check, auto-route uses `status === 'active'`, groups follow `Map` insertion order, and the empty-groups branch emits `{ type: 'bad-extract', detail: 'no fills recognized' }`. The module has exactly two `type: 'bad-extract'` literals (the extract failure and the empty groups), no `t(` and no `send`.

- [ ] **Step 4: Rewire `onPhoto` in `apps/server/src/wire/capture.ts`.** It keeps the caption regex, computes `pinnedRunId = m ? Number(m[1]) : null` and calls the core once (built in `makeCaptureHandlers` from `deps`). It maps events in a `switch (event.type)` inside a local `reply(chatId: string, event: CaptureEvent): Promise<void>`:
  - `unknown-run`: `t('unknown-run', lang, { id })`
  - `bad-extract`: `await tellBadExtract(chatId, event.detail)`
  - `pin-nomatch`: `t('capture-pin-nomatch', lang, { ticker, id: runId })`
  - `pin-skipped`: `t('capture-pin-skipped', lang, { tickers: tickers.join(', '), id: runId })`
  - `no-run`: `t('capture-no-run', lang, { ticker })`
  - `ambiguous`: `t('capture-ambiguous', lang, { ticker })`
  - `outcome`: `await sendOutcome(chatId, event.outcome)` (unchanged, including `await tellBadExtract(chatId, 'no fills recognized')` for `'rejected'`)

  Remove `extractOrTell` and the now unused imports. Define `CaptureDeps` as in Interfaces.

- [ ] **Step 5: Rewrite the source pin** `every "could not read fills" reply goes through the one recording helper` in `apps/server/test/capture-replies.test.ts` (keep its name and comment intent; update the comment to name both files):
  ```ts
  const src = await Bun.file(new URL('../src/wire/capture.ts', import.meta.url)).text()
  const core = await Bun.file(new URL('../src/wire/capture-route.ts', import.meta.url)).text()
  expect(src.match(/t\('capture-bad-extract'/g)).toHaveLength(1)
  expect(src.match(/await tellBadExtract\(chatId, /g)).toHaveLength(2)
  expect(src.match(/await tellBadExtract\(chatId, event\.detail\)/g)).toHaveLength(1)
  expect(src.match(/await tellBadExtract\(chatId, 'no fills recognized'\)/g)).toHaveLength(1)
  expect(core.match(/type: 'bad-extract'/g)).toHaveLength(2)
  expect(core.match(/type: 'bad-extract', detail: 'no fills recognized'/g)).toHaveLength(1)
  expect(core).not.toContain('capture-bad-extract')
  ```

- [ ] **Step 6: Run the core tests and the untouched Telegram suites**
  Run: `bun test apps/server/test/capture-route.test.ts apps/server/test/capture-replies.test.ts apps/server/test/wire-capture-photo.test.ts apps/server/test/wire-capture-routing.test.ts apps/server/test/wire-capture-confirm.test.ts apps/server/test/wire-capture-status.test.ts apps/server/test/wire-capture-choice.test.ts apps/server/test/booking-capture-corrections.test.ts apps/server/test/booking-capture-dedup.test.ts apps/server/test/booking-capture-order.test.ts apps/server/test/booking-capture-reupload.test.ts`
  Expected: all PASS. `git diff --stat -- apps/server/test` lists only `capture-replies.test.ts` (the pin) and the new file.

- [ ] **Step 7: Full check and size**
  Run: `bun run typecheck`, `bun test`, `wc -l apps/server/src/wire/capture.ts apps/server/src/wire/capture-route.ts`
  Expected: typecheck exits 0, tests 0 fail, both files ≤ 300 lines (`capture.ts` should drop to about 230).

- [ ] **Step 8: Commit**
  ```bash
  git add apps/server/src/wire/capture-route.ts apps/server/src/wire/capture.ts apps/server/test/capture-route.test.ts apps/server/test/capture-replies.test.ts
  git commit -m "refactor: move capture pin and auto-route rules into a transport-neutral routing core"
  ```

### Task 2: Vision time limit in the routing core

**Files:**
- Modify: `apps/server/src/wire/capture-route.ts`
- Test: `apps/server/test/capture-route.test.ts`

**Interfaces:**
- Consumes: Task 1's `makeCaptureRouting`, `RouteCaptureRequest`.
- Produces: `RouteCaptureRequest` gains `visionTimeoutMs?: number`. `export const VISION_TIMEOUT_DETAIL = 'vision timed out'`.

- [ ] **Step 1: Write the failing tests** (append a `describe('vision time limit')`; the helper's `run` takes an optional `visionTimeoutMs`):
  - `a vision read slower than the limit is a bad-extract and aborts the request`: `fetchImpl` records `init?.signal` and returns a promise that rejects only when that signal aborts. `run(null, 20)` with `[activeRun(1, 'NVDA')]` gives `events` equal to `[{ type: 'bad-extract', detail: 'vision timed out' }]`, the recorded `signal.aborted` is `true`, and `captures.length` is `0`.
  - `a timed-out file can be uploaded again`: after the timeout above, switch the fetch to `visionFetch` and `run(null, 20)` again. The new event is `type: 'outcome'` with a pending row (no capture was claimed by the failed read).
  - `a read inside the limit is unaffected`: `run(null, 1000)` with `visionFetch` gives one `outcome` event.
  - `without a limit the vision request carries no signal`: `run(null)`, so the recorded `init.signal` is `undefined`.

- [ ] **Step 2: Run to verify they fail**
  Run: `bun test apps/server/test/capture-route.test.ts`
  Expected: the four new tests FAIL (no timeout, signal present or missing).

- [ ] **Step 3: Implement the limit** as a private helper in `capture-route.ts`. When `visionTimeoutMs` is set, create an `AbortController` and pass `extractFills` a wrapped fetch that adds `signal: controller.signal` to `init`. Race `extractFills(...)` against a timer that first resolves `{ ok: false, reason: 'http', detail: VISION_TIMEOUT_DETAIL }` and then calls `controller.abort()`, and clear the timer in `finally`. Without the option, call `extractFills` exactly as before. The failure goes through the same single `emit({ type: 'bad-extract', detail: extract.detail })`, so the Task 1 pin (two `type: 'bad-extract'` literals) still holds.

- [ ] **Step 4: Run tests**
  Run: `bun test apps/server/test/capture-route.test.ts apps/server/test/capture-replies.test.ts`
  Expected: PASS.

- [ ] **Step 5: Full check**
  Run: `bun run typecheck`, `bun test`, `wc -l apps/server/src/wire/capture-route.ts` → 0 fail, ≤ 300 lines.

- [ ] **Step 6: Commit**
  ```bash
  git add apps/server/src/wire/capture-route.ts apps/server/test/capture-route.test.ts
  git commit -m "feat: optional vision time limit in the capture routing core"
  ```

### Task 3: Vision config without the bot, and a 60-second idle timeout

**Files:**
- Modify: `apps/server/src/wire/deps.ts:8-19,53-68,97-106`
- Modify: `apps/server/src/main.ts:29-30,97-99`
- Test: `apps/server/test/wire.test.ts`, `apps/server/test/main-boot-order.test.ts`

**Interfaces:**
- Produces: `EnvConfig.visionBaseUrl: string` and `EnvConfig.visionModel: string` (empty string when unset). `TelegramEnv` keeps `visionBaseUrl` / `visionModel`.

- [ ] **Step 1: Write the failing tests.** In `wire.test.ts`, inside `describe('parseEnv')`:
  - `vision variables are read without a bot token`: `parseEnv({ DATABASE_URL: 'mysql://x', APP_PASSWORD: 'p', SESSION_SECRET: 's', VISION_BASE_URL: 'https://vision.example/v1', VISION_MODEL: 'vision-model' })` gives `telegram` `null`, `visionBaseUrl` `'https://vision.example/v1'` and `visionModel` `'vision-model'`.
  - `without a token the vision variables are optional`: the same base with neither variable (and once with both `'  '`) gives `visionBaseUrl` `''`, `visionModel` `''`, and no throw.
  - `with a token the top-level vision values are the bot's`: `parseEnv(FULL_ENV)` gives `visionBaseUrl` equal to `cfg.telegram!.visionBaseUrl` and `visionModel` equal to `cfg.telegram!.visionModel`.

  In `main-boot-order.test.ts`, add `the HTTP server allows 60 idle seconds, so a 50-second vision read answers in time`: the `main.ts` source matches `/Bun\.serve\(\{\s*port: env\.port,\s*idleTimeout: 60,/`, and it contains `settings.visionBaseUrl || env.visionBaseUrl` and `settings.visionModel || env.visionModel`.

- [ ] **Step 2: Run to verify they fail**
  Run: `bun test apps/server/test/wire.test.ts apps/server/test/main-boot-order.test.ts`
  Expected: FAIL (`visionBaseUrl` undefined; source does not match).

- [ ] **Step 3: Implement.** `parseEnv` reads `VISION_BASE_URL` / `VISION_MODEL` with `get(...)` outside the token branch, keeps `require(...)` for both inside the token branch (so the missing-names message is unchanged), and returns them top-level (`?? ''`). In `main.ts`, use `settings.visionBaseUrl || env.visionBaseUrl` and `settings.visionModel || env.visionModel`, and add `idleTimeout: 60,` right after `port: env.port,` with the comment `// seconds; Bun's default is 10, and a web upload waits up to 50 s for vision`.

- [ ] **Step 4: Run tests**
  Run: `bun test apps/server/test/wire.test.ts apps/server/test/main-boot-order.test.ts`
  Expected: PASS, all existing parseEnv assertions unchanged.

- [ ] **Step 5: Full check** → `bun run typecheck`, `bun test`: 0 fail.

- [ ] **Step 6: Commit**
  ```bash
  git add apps/server/src/wire/deps.ts apps/server/src/main.ts apps/server/test/wire.test.ts apps/server/test/main-boot-order.test.ts
  git commit -m "feat: read vision config without a bot token and give the HTTP server a 60-second idle timeout"
  ```

### Task 4: `POST /api/captures`

**Files:**
- Create: `apps/server/src/http/routes/captures.ts`
- Modify: `apps/server/src/http/app.ts:26-46,66-73`, `apps/server/src/domain/capture-image.ts:8`, `apps/server/src/main.ts:37-45,80-91`, `apps/server/test/http-fakes.ts:228-240`, `scripts/e2e.ts:101-111`
- Test: `apps/server/test/http-captures.test.ts`

**Interfaces:**
- Consumes: Task 1/2 `RouteCapture`, `CaptureEvent`, `makeCaptureRouting`, `CaptureRouteDeps`; `parseId` (`http/params.ts`); `jsonBig` (`http/app.ts`); `MAX_IMAGE_BYTES`.
- Produces:
  - `HttpDeps.routeCapture: RouteCapture` (required).
  - `apps/server/src/http/routes/captures.ts`: `export function capturesRouter(deps: HttpDeps): Hono`, `export const CAPTURE_VISION_TIMEOUT_MS = 50_000`, `export const MAX_UPLOAD_BODY_BYTES = MAX_IMAGE_BYTES + 64 * 1024`, `export function declaredTooLarge(contentLength: string | undefined): boolean`.
  - `domain/capture-image.ts`: `export const ALLOWED_MIMES: ReadonlySet<string>`.
  - Wire contract the web mirrors: 200 `{ events: Exclude<CaptureEvent, { type: 'unknown-run' }>[] }` (through `jsonBig`). Errors are `{ error: code }` with the statuses in Global Constraints.
  - `makeDeps` in `http-fakes.ts` gets `routeCapture: async () => {}`.

- [ ] **Step 1: Write the failing tests** in `apps/server/test/http-captures.test.ts` (`makeFakes`, `makeDeps`, `loginAs`; a local `post(app, auth, body: FormData, headers?)` posting to `/api/captures`; a fake `routeCapture` that records each `RouteCaptureRequest` and emits scripted events; `png(size = 4)` returns `new File([new Uint8Array(size)], 'f.png', { type: 'image/png' })`):
  - `needs a session`: no auth gives 401.
  - `503 vision-not-configured when the base URL or the model is empty`: with `defaultSettings.visionModel: ''`, and separately `visionBaseUrl: ''`, the response is 503 `{ error: 'vision-not-configured' }` and the fake gets 0 calls.
  - `400 invalid-body`: no `image`; `image` as a string field; two `image` files; `runId` of `'abc'`, `'0'`, `'07'`, `'-1'` with a valid png. Each gives 400 `{ error: 'invalid-body' }` and 0 calls.
  - `415 unsupported-image`: `text/plain`, `image/heic`, and `''` types each give 415 `{ error: 'unsupported-image' }` and 0 calls.
  - `413 image-too-large above 8 MB, accepted at exactly 8 MB`: `png(MAX_IMAGE_BYTES + 1)` gives 413 `{ error: 'image-too-large' }` and 0 calls. `png(MAX_IMAGE_BYTES)` gives 200.
  - `declaredTooLarge`: `undefined` gives false, `String(MAX_UPLOAD_BODY_BYTES)` gives false, `String(MAX_UPLOAD_BODY_BYTES + 1)` gives true, `'abc'` gives false.
  - `pinned upload: the core gets the run id, the bot's base64 and the 50-second limit`: bytes `[1, 2, 3]` with `runId '7'` give a recorded request equal to `{ image: { base64: Buffer.from([1, 2, 3]).toString('base64'), mime: 'image/png' }, pinnedRunId: 7, visionTimeoutMs: 50_000 }`. The fake emits one `outcome` with a pending row. The response is 200 and its `events` equal what was emitted.
  - `auto-routed upload passes no run id`: the recorded `pinnedRunId` is `null`.
  - `an unknown pinned run is 404 no-run`: the fake emits `{ type: 'unknown-run', id: 9 }`, giving 404 `{ error: 'no-run' }`.
  - `a bad-extract is a 200 result and records no notice`: the fake emits `{ type: 'bad-extract', detail: 'http 500' }`. The response is 200 `{ events: [that event] }`, `f.notifications` is `[]` and `f.sent` is `[]`.
  - `an unexpected throw is 500 capture-failed and logged`: the fake emits one outcome, then throws `new Error('boom')`. The response is 500 `{ error: 'capture-failed' }`, and `console.error` (spied) was called with `'capture upload failed:'` and `'Error: boom'`.

- [ ] **Step 2: Run to verify they fail**
  Run: `bun test apps/server/test/http-captures.test.ts`
  Expected: FAIL (404 for the route / missing exports).

- [ ] **Step 3: Implement.** Export `ALLOWED_MIMES`. Write `capturesRouter`. It uses `r.post('/captures', ...)` with the check order: 503, `declaredTooLarge(c.req.header('content-length'))` → 413, form parse / field checks → 400, `ALLOWED_MIMES.has(file.type)` → 415, `file.size > MAX_IMAGE_BYTES` → 413. Then `Buffer.from(await file.arrayBuffer()).toString('base64')` and `await deps.routeCapture({ image, pinnedRunId, visionTimeoutMs: CAPTURE_VISION_TIMEOUT_MS }, async (e) => { events.push(e) })`. Wrap that in a `try` that logs `console.error('capture upload failed:', String(e))` and returns 500. Then return the `unknown-run` → 404 mapping or `c.json(jsonBig({ events }))`. Add `routeCapture: RouteCapture` to `HttpDeps` and `app.route('/api', capturesRouter(deps))` in `createApp`. In `main.ts`, build one `captureRouteDeps` object (`repos`, `vision`, `getVisionApiKey`, `today: todayEt`), spread it into `makeCaptureHandlers({ ...captureRouteDeps, lang, allowedChatIds, send })`, and pass `routeCapture: makeCaptureRouting(captureRouteDeps)` to `createApp`. Add `routeCapture: async () => {}` to `makeDeps`. In `scripts/e2e.ts`, import `makeCaptureRouting` from `'../apps/server/src/wire/capture-route'` and add `routeCapture: makeCaptureRouting({ repos, vision: { baseUrl: \`http://127.0.0.1:${vision.port}/v1\`, model: 'e2e-vision' }, getVisionApiKey: async () => 'e2e-key', today: () => TODAY })` to `httpDeps`.

- [ ] **Step 4: Run tests**
  Run: `bun test apps/server/test/http-captures.test.ts apps/server/test/main-boot-order.test.ts`
  Expected: PASS.

- [ ] **Step 5: Full check and size**
  Run: `bun run typecheck`, `bun test`, `wc -l apps/server/src/http/routes/captures.ts apps/server/src/main.ts apps/server/test/http-captures.test.ts`
  Expected: 0 fail, each ≤ 300.

- [ ] **Step 6: Commit**
  ```bash
  git add apps/server/src/http/routes/captures.ts apps/server/src/http/app.ts apps/server/src/domain/capture-image.ts apps/server/src/main.ts apps/server/test/http-captures.test.ts apps/server/test/http-fakes.ts scripts/e2e.ts
  git commit -m "feat: POST /api/captures routes an uploaded screenshot through the shared capture core"
  ```

### Task 5: Web client `uploadCapture` and the capture DTOs

**Files:**
- Create: `apps/web/src/api.call.ts`, `apps/web/src/api.captures.types.ts`
- Modify: `apps/web/src/api.ts:31-75,112-162,179-292`
- Test: `apps/web/src/api.captures.test.ts`

**Interfaces:**
- Consumes: the Task 4 wire contract.
- Produces:
  - `api.call.ts`: `export type ApiErrorCode` (existing members plus `'unsupported-image' | 'image-too-large' | 'capture-failed' | 'vision-not-configured'`), `export class ApiError`, `export class NetworkError`, `export async function call<T>(http: Http, url: string, init?: RequestInit): Promise<T>`, `export type Http`. `api.ts` re-exports `ApiError`, `NetworkError`, `type ApiErrorCode`, `type Http`, so every existing import from `./api` keeps working.
  - `api.captures.types.ts`:
    ```ts
    export interface CapturePendingRowDto { id: number; runId: number; captureId: number | null; side: 'buy' | 'sell'; ticker: string; shares: number; price: string; fee: string | null; filledOn: string; detectedFilledOn: string | null; status: string; needsBucket: boolean; dateAfterToday: boolean }
    interface CaptureConflictBaseDto { side: 'buy' | 'sell'; ticker: string; shares: number; extractedPrice: string; extractedFee: string | null; filledOn: string }
    export type CaptureConflictDto =
      | (CaptureConflictBaseDto & { matchedKind: 'booked'; bookedId: number; bookedPrice: string; correction: { id: number; status: 'open' | 'dismissed' } | { id: null; status: 'fill-gone' } | null })
      | (CaptureConflictBaseDto & { matchedKind: 'pending'; pendingId: number; pendingPrice: string })
    export type CaptureOutcomeDto = 'duplicate' | 'rejected' | { pending?: CapturePendingRowDto[]; conflicts?: CaptureConflictDto[]; bookedEarlier?: true }
    export type CaptureEventDto =
      | { type: 'bad-extract'; detail: string }
      | { type: 'pin-nomatch'; runId: number; ticker: string }
      | { type: 'pin-skipped'; runId: number; tickers: string[] }
      | { type: 'no-run'; ticker: string }
      | { type: 'ambiguous'; ticker: string }
      | { type: 'outcome'; runId: number; ticker: string; outcome: CaptureOutcomeDto }
    ```
    Prices are the USD strings the server formats (`'180.50'`), not myriadths.
  - `Api.uploadCapture(file: File, runId?: number): Promise<CaptureEventDto[]>`.

- [ ] **Step 1: Write the failing tests** in `apps/web/src/api.captures.test.ts` (no DOM; `createApi(http, { getToken: () => 'tok' })` with a recording `http`):
  - `posts the file as multipart with the bearer header and no content-type`: `uploadCapture(new File([new Uint8Array(3)], 'a.png', { type: 'image/png' }), 7)` → url `'/api/captures'`, method `'POST'`, `init.body instanceof FormData`, `(init.body as FormData).get('image')` is a `File` named `'a.png'`, `.get('runId') === '7'`, headers equal `{ Authorization: 'Bearer tok' }`.
  - `omits runId for a global upload`: `.get('runId') === null`.
  - `resolves to the events`: response `{ events: [{ type: 'no-run', ticker: 'TSLA' }] }` → resolves `[{ type: 'no-run', ticker: 'TSLA' }]`.
  - `an error body becomes ApiError with the code`: status 413 `{ error: 'image-too-large' }` → rejects `ApiError` with `status 413`, `code 'image-too-large'`.
  - `a thrown fetch becomes NetworkError`.

- [ ] **Step 2: Run to verify they fail**
  Run: `bun test apps/web/src/api.captures.test.ts` → FAIL (`uploadCapture` is not a function).

- [ ] **Step 3: Implement.** Move the pieces to `api.call.ts` verbatim. Add the four codes. Add the DTO file, `export type * from './api.captures.types'` in `api.ts`, and `uploadCapture`, which builds `FormData` (`image`, then `runId` only when given), calls `call<{ events: CaptureEventDto[] }>(http, '/api/captures', { method: 'POST', headers: headers(), body: form })` and returns `.events`.

- [ ] **Step 4: Run tests**
  Run: `bun test apps/web/src/api.captures.test.ts apps/web/src/api.test.ts apps/web/src/errortext.test.ts` → PASS.

- [ ] **Step 5: Full check and size** → `bun run typecheck`, `bun test`, `wc -l apps/web/src/api.ts apps/web/src/api.call.ts apps/web/src/api.captures.types.ts`: 0 fail, each ≤ 300.

- [ ] **Step 6: Commit**
  ```bash
  git add apps/web/src/api.ts apps/web/src/api.call.ts apps/web/src/api.captures.types.ts apps/web/src/api.captures.test.ts
  git commit -m "feat: web client uploadCapture and capture event DTOs"
  ```

### Task 6: Modal can be made non-dismissible

**Files:**
- Modify: `apps/web/src/components/Modal.tsx:60-73,130-135,163-181`
- Test: `apps/web/src/components/Modal.test.tsx`

**Interfaces:**
- Produces: `Modal` prop `dismissible?: boolean` (default `true`). When it is `false`, the backdrop click, the ✕ (rendered with `disabled`) and Escape never call `onClose`. Turning it back to `true` restores all three.

- [ ] **Step 1: Write the failing test** `a non-dismissible dialog ignores Escape, the backdrop and ✕`: render `Modal` with `dismissible: false` and a spy `onClose`, dispatch Escape keydown on `window`, click the `[role=dialog]` overlay, click the header ✕. The spy has 0 calls and the ✕ has the `disabled` attribute. Re-render with `dismissible: true`; Escape then calls it once.
- [ ] **Step 2: Run** `bun test apps/web/src/components/Modal.test.tsx` → the new test FAILS.
- [ ] **Step 3: Implement** the prop (the Escape branch also checks `dismissible`; add it to the `useCallback` deps).
- [ ] **Step 4: Run** `bun test apps/web/src/components/Modal.test.tsx` → PASS, existing tests untouched.
- [ ] **Step 5: Full check** → `bun run typecheck`, `bun test`: 0 fail.
- [ ] **Step 6: Commit**
  ```bash
  git add apps/web/src/components/Modal.tsx apps/web/src/components/Modal.test.tsx
  git commit -m "feat: Modal can be made non-dismissible while work is in flight"
  ```

### Task 7: Upload copy, pick checks and result lines

**Files:**
- Create: `apps/web/src/uploadpick.ts`, `apps/web/src/uploadlines.ts`
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Test: `apps/web/src/uploadpick.test.ts`, `apps/web/src/uploadlines.test.ts`

**Interfaces:**
- Consumes: Task 5 DTOs, `ApiError`, `NetworkError`; `errorText`, `Translate` (`apps/web/src/errortext.ts`).
- Produces:
  - `uploadpick.ts`: `export const UPLOAD_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const`, `export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024`, `export function pickRefusal(file: { type: string; size: number }): 'unsupported-image' | 'image-too-large' | null` (type checked first), `export function fileSizeText(bytes: number): string` (below 1 MiB: `${Math.max(1, Math.round(bytes / 1024))} KB`; otherwise `${(bytes / 1048576).toFixed(1)} MB`).
  - `uploadlines.ts`:
    ```ts
    export const VISION_TIMEOUT_DETAIL = 'vision timed out' // mirrors apps/server/src/wire/capture-route.ts
    export type UploadLineTone = 'ok' | 'info' | 'warn' | 'error'
    export interface UploadLine { tone: UploadLineTone; depth: 0 | 1 | 2; text: string; href?: string }
    export type UploadState = 'waiting' | 'reading' | 'done' | 'failed'
    export interface UploadItem { key: number; file: File; state: UploadState; events?: CaptureEventDto[]; error?: unknown }
    export function captureEventLines(event: CaptureEventDto, t: Translate): UploadLine[]
    export function uploadErrorLines(err: unknown, t: Translate): UploadLine[]
    export function uploadItemLines(item: Pick<UploadItem, 'events' | 'error'>, t: Translate): UploadLine[]
    export function wantsPending(items: Pick<UploadItem, 'events'>[]): boolean
    ```
  - Catalog keys below (later tasks use them by these exact names).

**Copy.** Add these entries to both catalogs. The `captureErr.*` block goes right after `cancelReasonStrategyChange`, the `upload.*` block right after `updateButton`, in the order listed (already `localeCompare` order). `{side}` is filled with `t('orderSideBuy')` / `t('orderSideSell')`.

| key | en | ko |
| --- | --- | --- |
| `captureErr.capture-failed` | The server failed while reading this screenshot. Fills from part of it may already be in Pending — check there before uploading it again. | 이 스크린샷을 처리하는 중 서버에 문제가 생겼습니다. 일부 체결은 이미 '확인 대기'에 있을 수 있으니 다시 업로드하기 전에 확인하세요. |
| `captureErr.image-too-large` | This image is larger than 8 MB. | 이 이미지는 8MB보다 큽니다. |
| `captureErr.invalid-body` | The upload was not understood. Pick the file again. | 업로드를 처리할 수 없습니다. 파일을 다시 선택하세요. |
| `captureErr.no-run` | This run no longer exists. | 이 런은 더 이상 없습니다. |
| `captureErr.unsupported-image` | Only JPEG, PNG, WebP and GIF images can be read. | JPEG, PNG, WebP, GIF 이미지만 읽을 수 있습니다. |
| `captureErr.vision-not-configured` | Vision is not set up: set the vision base URL and model in Settings, then restart the server. | 비전이 설정되지 않았습니다. 설정에서 비전 기본 URL과 모델을 입력한 뒤 서버를 다시 시작하세요. |
| `upload.ambiguous` | {ticker}: several active runs — open the run you mean and upload from its page. | {ticker}: 활성 런이 여러 개입니다 — 해당 런을 열고 그 페이지에서 업로드하세요. |
| `upload.badExtract` | Could not read fills from this image — {detail}. Book the fill manually, or upload a clearer screenshot. | 이미지에서 체결을 읽을 수 없습니다 — {detail}. 직접 예약하거나 더 선명한 스크린샷을 업로드하세요. |
| `upload.bookedEarlier` | Fills from this image were already confirmed earlier — the rows below may be duplicates. Check before confirming. | 이 이미지의 체결은 이전에 이미 확정되었습니다 — 아래 항목은 중복일 수 있으니 확인 후 확정하세요. |
| `upload.choose` | choose files | 파일 선택 |
| `upload.conflict` | {side} {shares} {ticker} on {date} — read ${extracted}, booked fill #{id} has ${dupPrice}. Correction listed in Pending. | {date} {ticker} {side} {shares}주 — 읽은 가격 ${extracted}, 예약된 체결 #{id} 가격 ${dupPrice}. 수정 제안은 '확인 대기'에서 처리하세요. |
| `upload.conflictDismissed` | {side} {shares} {ticker} on {date} — read ${extracted}, booked fill #{id} has ${dupPrice}. You dismissed this correction before; not listed again. | {date} {ticker} {side} {shares}주 — 읽은 가격 ${extracted}, 예약된 체결 #{id} 가격 ${dupPrice}. 이전에 무시한 수정 제안이므로 다시 표시하지 않습니다. |
| `upload.conflictGone` | {side} {shares} {ticker} on {date} — read ${extracted}, but booked fill #{id} no longer exists. Nothing to correct. | {date} {ticker} {side} {shares}주 — 읽은 가격 ${extracted}, 예약된 체결 #{id}이(가) 더 이상 없습니다. 수정할 항목이 없습니다. |
| `upload.conflictPending` | {side} {shares} {ticker} on {date} — read ${extracted}, but pending row #{id} has ${dupPrice}. Resolve that row first. | {date} {ticker} {side} {shares}주 — 읽은 가격 ${extracted}, 대기 중 행 #{id} 가격 ${dupPrice}. 먼저 해당 행을 처리하세요. |
| `upload.conflictsHead` | Conflicts — these were not booked: | 충돌 — 아래 체결은 예약되지 않았습니다: |
| `upload.dateAfterToday` | The trade date read ({date}) is after today — fix it in Pending. | 읽은 거래일({date})이 미래 날짜입니다 — '확인 대기'에서 수정하세요. |
| `upload.dateSubstituted` | No trade date was read, so {date} was used — check it in Pending. | 거래일을 읽지 못해 {date}을(를) 사용했습니다 — '확인 대기'에서 확인하세요. |
| `upload.done` | done | 완료 |
| `upload.drop` | Drop screenshots here, paste, or | 스크린샷을 여기에 놓거나 붙여 넣거나 |
| `upload.duplicate` | Already uploaded, nothing new — every fill is booked or pending, or a correction is waiting in Pending. | 이미 업로드한 이미지입니다 — 모든 체결이 이미 예약되었거나 대기 중이거나, 수정 제안이 '확인 대기'에 있습니다. |
| `upload.failed` | failed | 실패 |
| `upload.fillLine` | {side} {shares} @ ${price} on {date} | {date} {side} {shares}주 @ ${price} |
| `upload.goToPending` | Go to pending | 확인 대기로 이동 |
| `upload.more` | Upload more | 더 업로드 |
| `upload.needsBucket` | Choose the bucket in Pending. | '확인 대기'에서 버킷을 선택하세요. |
| `upload.networkLost` | The connection dropped before the server answered. The capture may still have completed — check Pending before uploading again. | 서버가 응답하기 전에 연결이 끊겼습니다. 캡처는 완료되었을 수 있으니 다시 업로드하기 전에 '확인 대기'를 확인하세요. |
| `upload.noRun` | {ticker}: no active run — open the run and upload from its page. | {ticker}: 활성 런이 없습니다 — 런을 열고 그 페이지에서 업로드하세요. |
| `upload.pendingHead` | {ticker} → run #{id}: {count} waiting in Pending | {ticker} → 런 #{id}: {count}건 확인 대기 중 |
| `upload.pinNomatch` | No {ticker} fills in this image — run #{id} unchanged. | 이 이미지에서 {ticker} 체결을 찾지 못했습니다 — 런 #{id}는 그대로입니다. |
| `upload.pinSkipped` | Ignored {tickers} — not the ticker of run #{id}. | {tickers}은(는) 런 #{id}의 종목이 아니므로 무시했습니다. |
| `upload.reading` | reading… | 읽는 중… |
| `upload.refused` | {name}: {reason} | {name}: {reason} |
| `upload.remove` | Remove {name} | {name} 제거 |
| `upload.submit` | Upload ({count}) | 업로드 ({count}) |
| `upload.title` | Upload screenshot | 스크린샷 업로드 |
| `upload.visionTimeout` | Vision took too long to answer — nothing was booked. Upload the file again. | 비전 응답이 너무 오래 걸려 아무것도 예약되지 않았습니다. 파일을 다시 업로드하세요. |
| `upload.waiting` | waiting | 대기 중 |

**Mapping rules for `captureEventLines`** (tone, depth):
- `outcome: 'duplicate'` → `info`/0 `upload.duplicate`
- `outcome: 'rejected'` → the same line as `bad-extract` with detail `'no fills recognized'`
- `outcome` object, in bot order:
  1. `upload.conflictsHead` `warn`/0, only when both `pending` and `conflicts` are non-empty
  2. each conflict at depth 0: `matchedKind 'pending'` → `upload.conflictPending` (`id: pendingId, dupPrice: pendingPrice`, warn); `correction?.status 'fill-gone'` → `upload.conflictGone` (`id: bookedId`, warn); `'dismissed'` → `upload.conflictDismissed` (info); otherwise `upload.conflict` (warn). All conflict lines pass `side, shares, ticker, date: filledOn, extracted: extractedPrice`, and the booked ones also `id: bookedId, dupPrice: bookedPrice`.
  3. `upload.bookedEarlier` `warn`/0 when `bookedEarlier` and pending is non-empty
  4. `upload.pendingHead` `ok`/0 with `{ ticker, id: runId, count: pending.length }` and `href: '#/runs/<runId>'`
  5. per row: `upload.fillLine` `ok`/1, then `warn`/2 reasons in this order: `upload.dateSubstituted` when `detectedFilledOn === null`, `upload.dateAfterToday` when `dateAfterToday`, `upload.needsBucket` when `needsBucket` (dates are `filledOn`)
- `bad-extract`: `error`/0 `upload.visionTimeout` when `detail === VISION_TIMEOUT_DETAIL`, else `upload.badExtract { detail }`
- `no-run`: `info`/0 `upload.noRun`. `ambiguous`: `info`/0 `upload.ambiguous`. `pin-nomatch`: `info`/0 `{ ticker, id: runId }`. `pin-skipped`: `info`/0 `{ tickers: tickers.join(', '), id: runId }`.

`uploadErrorLines`: a `NetworkError` gives `error`/0 `upload.networkLost`. An `ApiError` with code `vision-not-configured` gives `error`/0 with `errorText(err, t, 'captureErr')` and `href: '#/settings'`. Anything else gives `error`/0 `errorText(err, t, 'captureErr')`. `uploadItemLines` returns the error lines when `error !== undefined`, else the flat map of `captureEventLines` over `events ?? []`. `wantsPending` follows the rule in Decisions.

- [ ] **Step 1: Write the failing tests.** Use `t = (k, p) => lookup('en', k, p)` from `./i18n/catalog`. In `uploadpick.test.ts`:
  - `accepts the four image types up to 8 MB`: each `UPLOAD_MIMES` type at `MAX_UPLOAD_BYTES` gives `null`.
  - `refuses other types first`: `''`, `'image/heic'`, `'application/pdf'` give `'unsupported-image'`, even when oversized.
  - `refuses above 8 MB`: `image/png` at `MAX_UPLOAD_BYTES + 1` gives `'image-too-large'`.
  - `fileSizeText`: `412 * 1024` gives `'412 KB'`, `10` gives `'1 KB'`, `3 * 1048576 + 104858` gives `'3.1 MB'`.

  In `uploadlines.test.ts`, assert `text`/`tone`/`depth`/`href` exactly:
  - `pending rows: head with run link, fill lines, and the three fix-in-Pending reasons`: an outcome for run 7, `NVDA`, with two rows, the second `{ side: 'sell', shares: 10, price: '134.05', filledOn: '2026-11-23', detectedFilledOn: null, dateAfterToday: true, needsBucket: true }`. The lines are `NVDA → run #7: 2 waiting in Pending` (href `#/runs/7`), `Buy 10 @ $131.20 on 2026-11-23`, `Sell 10 @ $134.05 on 2026-11-23`, `No trade date was read, so 2026-11-23 was used — check it in Pending.`, `The trade date read (2026-11-23) is after today — fix it in Pending.`, `Choose the bucket in Pending.`, with depths `[0, 1, 1, 2, 2, 2]`.
  - `booked-earlier warning sits above the pending head`.
  - `conflicts: head only beside pending rows, and the four variants worded like the bot`: one line each for open (`upload.conflict` text with `$`-prefixed prices), dismissed (tone `info`), fill-gone, pending-row.
  - `duplicate`, `rejected`, `bad-extract`, `vision timeout`, `no-run`, `ambiguous`, `pin-nomatch`, `pin-skipped` give their exact en texts; `rejected` gives `Could not read fills from this image — no fills recognized. Book the fill manually, or upload a clearer screenshot.` and `pin-skipped` with `['AAPL', 'TSLA']` gives `Ignored AAPL, TSLA — not the ticker of run #1.`.
  - `request failures`: `new NetworkError('x')` gives the `upload.networkLost` text. `new ApiError(503, 'vision-not-configured')` gives its text with href `#/settings`. `new ApiError(413, 'image-too-large')` gives `This image is larger than 8 MB.`. `new ApiError(500, 'capture-failed')` gives the `captureErr.capture-failed` text.
  - `wantsPending`: true for any pending row, true for a booked conflict with `correction.status 'open'`, false for duplicate / no-run / dismissed or fill-gone / pending-kind conflicts / an error item.
  - `ko catalog renders the fill line in Korean`: `lookup('ko', 'upload.fillLine', { side: '매수', shares: 10, price: '131.20', date: '2026-11-23' })` gives `'2026-11-23 매수 10주 @ $131.20'`.
- [ ] **Step 2: Run** `bun test apps/web/src/uploadpick.test.ts apps/web/src/uploadlines.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement** the two modules and add the catalog entries.
- [ ] **Step 4: Run** `bun test apps/web/src/uploadpick.test.ts apps/web/src/uploadlines.test.ts apps/web/src/catalog.test.ts` → PASS (key parity, order and placeholder tests included).
- [ ] **Step 5: Full check and size** → `bun run typecheck`, `bun test`, `wc -l apps/web/src/uploadlines.ts apps/web/src/uploadpick.ts`: 0 fail, ≤ 300.
- [ ] **Step 6: Commit**
  ```bash
  git add apps/web/src/uploadpick.ts apps/web/src/uploadlines.ts apps/web/src/uploadpick.test.ts apps/web/src/uploadlines.test.ts apps/web/src/i18n/en.json apps/web/src/i18n/ko.json
  git commit -m "feat: upload copy, pick-time checks and capture result lines"
  ```

### Task 8: Upload popup

**Files:**
- Create: `apps/web/src/components/forms/UploadDialog.tsx`, `UploadPicker.tsx`, `UploadResults.tsx`, `apps/web/src/testing/upload.ts`
- Test: `apps/web/src/components/forms/UploadDialog.test.tsx` (picking) and `UploadDialogUpload.test.tsx` (uploading and results)

**Interfaces:**
- Consumes: `api.uploadCapture` (Task 5); `Modal dismissible` (Task 6); `pickRefusal`, `fileSizeText`, `UPLOAD_MIMES`, `UploadItem`, `uploadItemLines`, `wantsPending` and the `upload.*` keys (Task 7); `holdNext` (`testing/holdFetch.ts`).
- Produces:
  - `export interface UploadCloseOutcome { uploaded: boolean; goToPending: boolean }`
  - `export function UploadDialog({ runId, onClose }: { runId?: number; onClose: (outcome: UploadCloseOutcome) => void })` in `UploadDialog.tsx`.
  - `UploadPicker({ items, refused, onAdd, onRemove }: { items: UploadItem[]; refused: { name: string; reason: 'unsupported-image' | 'image-too-large' }[]; onAdd: (files: File[]) => void; onRemove: (key: number) => void })` and `UploadResults({ items }: { items: UploadItem[] })`.
  - Test ids used by Task 9 and the tests: `uploadInput` (the `<input type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif">`), `uploadDrop` (drop zone), `uploadSubmit`, `uploadGoToPending`, `uploadClose`, `uploadMore`.
  - `testing/upload.ts`: `imageFile(name: string, opts?: { type?: string; size?: number }): File` (default `image/png`, 4 bytes); `pickFiles(act, files)`, `dropFiles(act, files)`, `pasteFiles(act, files)` (define `files` on the `uploadInput` element and dispatch `change` on it; define `dataTransfer.files` on a `drop` event dispatched on `uploadDrop`; define `clipboardData.files` on a `paste` event dispatched on `window`); `stubUploads(answers: Array<{ status?: number; json: unknown } | 'network-error'>): { sent: { name: string; runId: string | null }[] }` (wraps the installed fetch: answers `POST /api/captures` in order, reads the `FormData`, passes everything else through); `countGets(urlPart: string): () => number`. If `URL.createObjectURL` is missing under happy-dom, the fixture installs a stub returning `blob:test/<n>` plus a no-op `revokeObjectURL`.

Behaviour: there are three phases, `picking` → `uploading` → `done`.
- **Picking.** The Modal title is `upload.title`. The drop zone shows `upload.drop` and a `upload.choose` button that clicks the input. Each item shows a thumbnail (`<img>` from an object URL, revoked on remove and unmount), its name, `fileSizeText` and a ✕ with `aria-label` `upload.remove`. Refused files show as `upload.refused` with `reason: t('captureErr.<code>')`. The footer has `cancel` and the primary `upload.submit { count }`, disabled at 0. A `paste` listener is on `window` only in this phase.
- **Uploading.** Files go one at a time in pick order. Each row shows `upload.waiting` / `upload.reading` / `upload.done` / `upload.failed`. The Modal gets `dismissible={false}` and Cancel is disabled. A rejected `uploadCapture` stores `error` and the loop continues.
- **Done.** `UploadResults` shows a file name header, then each line with a glyph by tone (`ok ✓`, `info –`, `warn ⚠`, `error ✕`), indented by depth. A line with `href` renders as an `<a>`. Buttons are `upload.more`, plus either `upload.goToPending` (primary, when `wantsPending(items)`) or `close` (primary). `onClose` gets `{ uploaded, goToPending }`.

- [ ] **Step 1: Write the failing tests.** Both files follow the `Pending.test.tsx` pattern (register happy-dom, then dynamic imports).

  `UploadDialog.test.tsx`:
  - `picked files show name and size and can be removed`: picking `fills-1.png` (412 KiB) and `fills-2.png` shows `fills-1.png`, `412 KB` and `Upload (2)`. Clicking `Remove fills-1.png` leaves `Upload (1)`.
  - `wrong type and oversized files are refused with the server wording`: `notes.pdf` (`application/pdf`), `heic.heic` (`image/heic`), `blank` (type `''`) and `big.png` (`MAX_UPLOAD_BYTES + 1`) show `notes.pdf: Only JPEG, PNG, WebP and GIF images can be read.` (same for the other two) and `big.png: This image is larger than 8 MB.`. `uploadSubmit` is disabled and reads `Upload (0)`.
  - `drop and paste add files`: one drop and one paste give `Upload (2)`.
  - `Cancel before uploading reports nothing uploaded`: `onClose` is called with `{ uploaded: false, goToPending: false }`.
  - `the input accepts the four image types, several at once`: `accept === 'image/jpeg,image/png,image/webp,image/gif'`, `multiple === true`.

  `UploadDialogUpload.test.tsx`:
  - `pinned upload sends the run id and shows the result lines`: with `runId: 7`, the answer is an outcome with one sell row with `needsBucket: true`. Then `sent` equals `[{ name: 'fills-1.png', runId: '7' }]`. The text contains `NVDA → run #7: 1 waiting in Pending`, `Sell 10 @ $134.05 on 2026-11-23` and `Choose the bucket in Pending.`. An `a[href="#/runs/7"]` exists, and `uploadGoToPending` exists with no `uploadClose`.
  - `global upload sends no run id`: `sent[0].runId === null`.
  - `files go one at a time in pick order, and a failure does not stop the rest`: three files with answers `[outcome, 'network-error', { json: { events: [{ type: 'outcome', runId: 1, ticker: 'NVDA', outcome: 'duplicate' }] } }]`, using `holdNext('POST', '/api/captures')` on the first. After a flush `sent.length === 1`; after release and a flush `sent.map((s) => s.name)` equals the pick order. File 2 shows the `upload.networkLost` text, file 3 the `upload.duplicate` text.
  - `while an upload is in flight Escape, the backdrop, ✕ and Cancel do nothing`: with a held request, press Escape, click the overlay, click the ✕, click `Cancel`. `onClose` has 0 calls. After release the done state renders.
  - `Close is primary when nothing reached Pending, and reports the upload`: a duplicate answer shows `uploadClose` and no `uploadGoToPending`. Clicking it calls `onClose` with `{ uploaded: true, goToPending: false }`.
  - `Go to pending reports goToPending`: `{ uploaded: true, goToPending: true }`.
  - `vision not configured points to Settings`: a 503 `{ error: 'vision-not-configured' }` answer shows the `captureErr.vision-not-configured` text and `a[href="#/settings"]`.
  - `Upload more returns to an empty picker and keeps the uploaded flag`: after Upload more, `Upload (0)` shows. Cancel then calls `onClose` with `{ uploaded: true, goToPending: false }`.
- [ ] **Step 2: Run** `bun test apps/web/src/components/forms/UploadDialog.test.tsx apps/web/src/components/forms/UploadDialogUpload.test.tsx` → FAIL (modules missing).
- [ ] **Step 3: Implement** the fixture and the three components.
- [ ] **Step 4: Run** the two test files → PASS.
- [ ] **Step 5: Full check and size** → `bun run typecheck`, `bun test`, `wc -l apps/web/src/components/forms/Upload*.tsx apps/web/src/testing/upload.ts`: 0 fail, each ≤ 300.
- [ ] **Step 6: Commit**
  ```bash
  git add apps/web/src/components/forms/UploadDialog.tsx apps/web/src/components/forms/UploadPicker.tsx apps/web/src/components/forms/UploadResults.tsx apps/web/src/components/forms/UploadDialog.test.tsx apps/web/src/components/forms/UploadDialogUpload.test.tsx apps/web/src/testing/upload.ts
  git commit -m "feat: screenshot upload popup with sequential uploads and per-file result lines"
  ```

### Task 9: Entry points on the run page and the Pending page

**Files:**
- Create: `apps/web/src/components/RunHeader.tsx`
- Modify: `apps/web/src/pages/RunDetail.tsx:122-156,62-70,202-223,272-277`, `apps/web/src/pages/Pending.tsx`
- Test: `apps/web/src/pages/RunDetailUpload.test.tsx`, `apps/web/src/pages/PendingUpload.test.tsx`

**Interfaces:**
- Consumes: `UploadDialog`, `UploadCloseOutcome` (Task 8); `imageFile`, `pickFiles`, `stubUploads`, `countGets` (`testing/upload.ts`); `RUN`, `runDetailRoutes`, `runDetailHelpers`, `buttonByText` (`testing/runDetail.ts`).
- Produces: `export function RunHeader({ run, busyStatus, onEditPool, onAskClose, onSetStatus, onAddFill, onUpload }: { run: Pick<RunDetailDto, 'name' | 'ticker' | 'status' | 'strategyKey' | 'costPpm' | 'poolCents' | 'createdAt'>; busyStatus: RunStatus | null; onEditPool: () => void; onAskClose: () => void; onSetStatus: (status: RunStatus) => void; onAddFill: () => void; onUpload: () => void })`. It renders the moved markup unchanged and adds a secondary `<Button data-testid="uploadScreenshot">{t('upload.title')}</Button>` right after the `tabManual` button. The Pending page header uses the same test id.

- [ ] **Step 1: Write the failing tests.**

  `RunDetailUpload.test.tsx` (the `RunDetailAddFill.test.tsx` setup; `stubUploads` installed after the fetch stub so it answers before the catch-all POST route):
  - `Upload screenshot sits right after Add fill in the header actions`: `tabManual.nextElementSibling` is the `uploadScreenshot` button with text `Upload screenshot`. The tab row buttons are unchanged.
  - `the popup pins the upload to this run`: open, pick, submit gives `sent[0].runId === '1'`.
  - `closing after an upload reloads the run`: set `runBody = { ...RUN, name: 'After upload' }` before clicking `uploadClose`. After a flush, the `h1` contains `After upload`.
  - `closing without an upload does not reload`: Cancel, then `countGets('/api/runs/1')()` is unchanged.
  - `Go to pending selects the Pending tab`: after `uploadGoToPending`, the tab button `Pending` has class `bg-primary`.

  `PendingUpload.test.tsx` (the `Pending.test.tsx` setup):
  - `the page header has the upload button and the popup is global`: the `uploadScreenshot` text is `Upload screenshot`, and an upload gives `sent[0].runId === null`. `headings('h1')` is still `['Pending']`.
  - `closing after an upload re-reads the pending table and the corrections`: the `countGets('/api/pending')` and `countGets('/api/corrections')` deltas are each `1` after `uploadClose`.
  - `closing without an upload re-reads nothing`: both deltas are `0`.
- [ ] **Step 2: Run** `bun test apps/web/src/pages/RunDetailUpload.test.tsx apps/web/src/pages/PendingUpload.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** Move the header into `RunHeader` (along with the imports only it uses: `Badge`, `costPercentText`, `isoDateTime`, `enumLabelKey`, `runActions`, `runStatusTone`). In `RunDetail`, add `uploadOpen` and `uploadKey` state, use `CorrectionList key={\`c${tabKey}-${uploadKey}\`}`, and mount `UploadDialog runId={run.id}`. Its `onClose` hides the dialog. Then: on `goToPending`, `setUploadKey((k) => k + 1)` and `selectTab('pending')`; otherwise, if `uploaded`, `setUploadKey((k) => k + 1)`, `setPanelKey((k) => k + 1)` and `void reload()`. In `Pending.tsx`, put the `h1` and the button in a `flex items-center justify-between` row and add a `refresh` counter for `PendingTable refreshKey={refresh}` and `CorrectionList key={\`c${refresh}\`} framed`. `onClose` bumps `refresh` when `uploaded` (and also when `goToPending`, since it is the same page).
- [ ] **Step 4: Run** the two new files plus `bun test apps/web/src/pages` → all PASS, and the existing RunDetail*/Pending tests are unchanged.
- [ ] **Step 5: Full check and size** → `bun run typecheck`, `bun test`, `wc -l apps/web/src/pages/RunDetail.tsx apps/web/src/components/RunHeader.tsx apps/web/src/pages/Pending.tsx`: 0 fail, `RunDetail.tsx` ≤ 300 (expected about 280).
- [ ] **Step 6: Commit**
  ```bash
  git add apps/web/src/components/RunHeader.tsx apps/web/src/pages/RunDetail.tsx apps/web/src/pages/Pending.tsx apps/web/src/pages/RunDetailUpload.test.tsx apps/web/src/pages/PendingUpload.test.tsx
  git commit -m "feat: upload screenshot buttons on the run page and the Pending page"
  ```

### Task 10: E2E web-upload step

**Files:**
- Create: `scripts/e2e-web-upload.ts`, `scripts/e2e-sim.ts`
- Modify: `scripts/e2e.ts` (move `BAR_FIXTURE`/`BARS` and the deterministic-sim block, lines 54-63 and 275-291; build `ctx.upload`; call the new step after `runVisionReview`), `scripts/e2e-ctx.ts`

**Interfaces:**
- Consumes: the real `POST /api/captures` (Task 4, already wired into `httpDeps`), `E2eCtx`, `jsonOf`.
- Produces:
  - `E2eCtx.upload: (fills: VisionFill[], form: FormData) => Promise<Response>`. It sets the fake vision answer to `fills` and posts `form` to `/api/captures` through `app.request` with `authorization: Bearer <token>` and no content-type, then restores `VISION_FILLS` in `finally`.
  - `scripts/e2e-web-upload.ts`: `export async function checkWebUpload(c: E2eCtx, today: string): Promise<void>`.
  - `scripts/e2e-sim.ts`: `export async function checkDeterministicSim(c: Pick<E2eCtx, 'ok'>, simRepo: Parameters<typeof runSim>[1]['repos']): Promise<void>` (the moved assertions, verbatim).

- [ ] **Step 1: Move the deterministic-sim block** into `checkDeterministicSim` (same `ok` labels) and call it where the block was.
- [ ] **Step 2: Write `checkWebUpload`.** It creates two runs over HTTP (`E2E web pin` ticker `WUPA`, `E2E web auto` ticker `WUPB`, `poolCents 1_000_000`, `costPpm 1_000`), with image bytes from distinct strings, and asserts with `c.ok`:
  - pinned: form `image = new File([Buffer.from('e2e-web-upload-pinned')], 'pinned.png', { type: 'image/png' })`, `runId = String(pinRun)`. Vision answers `[{ side: 'buy', ticker: 'WUPA', shares: 2, price: '50.00', fee: '0.10', date: today }, { side: 'buy', ticker: 'WUPB', shares: 1, price: '20.00', date: today }]`. Expect status 200 and `events.map((e) => e.type)` equal to `['pin-skipped', 'outcome']`; `events[0].tickers` equals `['WUPB']`; and `events[1]` has `runId === pinRun`, `outcome.pending.length === 1`, `outcome.pending[0].price === '50.00'`. `GET /captures/<captureId>/image` returns the uploaded bytes exactly.
  - auto-routed: the `e2e-web-upload-auto` bytes with no `runId`. Vision answers one `WUPB` buy (3 @ `21.00`). Expect a single `outcome` with `runId === autoRun` and one pending row.
  - repeat: the same auto bytes again. The single event is `{ type: 'outcome', runId: autoRun, ticker: 'WUPB', outcome: 'duplicate' }`, and `GET /pending` still has exactly one `WUPB` row.
  - cross-path: `c.photo` (the Telegram handler) with `e2e-web-upload-bot` bytes and a `WUPB` buy (4 @ `22.00`), then the same bytes as a web upload with no `runId`. The web event's `outcome` is `'duplicate'`.
  - unknown pinned run: `runId: '999999'` gives 404 `{ error: 'no-run' }`. A `text/plain` file gives 415 `{ error: 'unsupported-image' }`.
  - cleanup: reject every pending row whose `runId` is `pinRun` or `autoRun` (`POST /pending/:id/reject` returns 200), so later steps start with nothing pending from this step.
- [ ] **Step 3: Wire it** in `scripts/e2e.ts`: define `upload` next to `photo`, add it to `ctx`, and call `await checkWebUpload(ctx, TODAY)` right after `runVisionReview(...)`. Mention the web upload in the file's header flow comment.
- [ ] **Step 4: Typecheck and size**
  Run: `bun run typecheck`, `wc -l scripts/e2e.ts scripts/e2e-web-upload.ts scripts/e2e-sim.ts`
  Expected: exit 0, `scripts/e2e.ts` below 300, the others ≤ 300.
- [ ] **Step 5: Run the e2e** (needs the MariaDB test container from AGENTS.md):
  Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`
  Expected: exit 0 and a last line `e2e OK — <N> assertions passed`, including the new `ok` lines. If the database is not reachable, say so in the report and do **not** claim the e2e passed.
- [ ] **Step 6: Unit suite** → `bun test`: 0 fail.
- [ ] **Step 7: Commit**
  ```bash
  git add scripts/e2e.ts scripts/e2e-ctx.ts scripts/e2e-web-upload.ts scripts/e2e-sim.ts
  git commit -m "test: e2e web screenshot upload (pinned, auto-routed, duplicate across bot and web)"
  ```

### Task 11: Docs

**Files:**
- Modify: `AGENTS.md` (repo map), `README.md` (intro, env table, Settings paragraph, a "Screenshot upload (web)" section)

**Interfaces:**
- Consumes: the file names from Tasks 1-10.

- [ ] **Step 1: AGENTS.md repo map.** Add:
  - `wire/capture-route.ts` to the `wire/` line, `captures` to `http/routes/{...}`
  - `capture-route` and `http-captures` to the server test list
  - `api.call.ts api.captures.types.ts uploadlines.ts uploadpick.ts` to `apps/web/src/`
  - `RunHeader` to `components/{...}` and `UploadDialog,UploadPicker,UploadResults` to `components/forms/{...}`
  - `upload` to `testing/{...}`
  - `e2e-web-upload.ts e2e-sim.ts` to `scripts/`, plus a one-line note (`e2e-web-upload.ts = multipart uploads through POST /api/captures`)
- [ ] **Step 2: README.md.**
  - Intro line 5: screenshots come back "via Telegram or a web upload".
  - Env table: `VISION_BASE_URL` / `VISION_MODEL` become `Required: when token set`, with notes `read with or without a token; needed for any screenshot reading (Telegram or web upload)`.
  - Settings paragraph (lines 76-79): vision base URL, model and digest language are read at boot (a change needs a restart); the API key is re-read on every capture.
  - New section after "Telegram", "Screenshot upload (web)", with four points. The run page's "Upload screenshot" pins fills to that run. The Pending page's button auto-routes by ticker to the one active run (same rules as an uncaptioned photo). Accepted types are JPEG/PNG/WebP/GIF up to 8 MB. Results show in the popup and fills wait in Pending. The server's `idleTimeout` is 60 s and vision is cut off at 50 s, so a TLS reverse proxy in front must allow at least 60 s per request.
- [ ] **Step 3: Final verification**
  Run: `bun run typecheck`, `bun test`, then the DB suite `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` and the e2e `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts`.
  Expected: 0 fail everywhere and `e2e OK — …`. Report any DB-gated run that could not be done.
- [ ] **Step 4: Commit**
  ```bash
  git add AGENTS.md README.md
  git commit -m "docs: web screenshot upload in the repo map and README"
  ```
