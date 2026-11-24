# Web screenshot upload

Branch: `feat/web-screenshot-upload`.

## Intent

A broker screenshot can only enter the tracker through the Telegram bot today. The operator wants to upload one from the web app as well: a button and a popup on the run page, plus a global one that routes fills to runs by ticker. Everything after the photo arrives (vision extraction, dedup, corrections, pending rows, confirm/reject, screenshot retention) already exists and is already driven from the web; only the front door is missing.

## Goals

- Upload from a run page: the capture is pinned to that run, as a Telegram caption `#7` pins it today.
- Upload from the Pending page: fills are routed to the one active run for each ticker, as an uncaptioned Telegram photo is today.
- The web path and the Telegram path share one set of routing rules.
- The operator sees in the popup what the capture produced, then lands on the pending rows.

## Non-goals

- Confirming or rejecting fills inside the upload popup. The Pending table does that, with editing.
- A background job queue, progress polling, or resumable uploads.
- Telegram messages about a web upload. Booking notices from a later confirm still fan out as today.
- Image conversion or downscaling (HEIC stays unsupported).
- Any schema change. `captures.chat_id` is already nullable and already written as `null`.

## Anti-goals

- Changing any Telegram reply: text, order, keyboard, or which replies are recorded as notices.
- A second copy of the pin and auto-route rules.

## Approaches

1. **Shared routing core, the upload request waits for the result (chosen by the operator).** The pin/auto-route half of `onPhoto` becomes a transport-neutral function. Telegram renders its output as chat messages, a new HTTP route returns it as JSON. One set of rules; the cost is a refactor of working Telegram code, pinned by the existing `wire-capture-*` tests.
2. Separate web-only path that calls `ingestCapture` directly. No risk to Telegram, but the routing rules exist twice and drift.
3. Background job with polling. Suits slow vision or bulk uploads, but needs job state and failure surfacing, and loses in-flight work on restart. Too much for a single-operator app.

## Design

### Routing core — `apps/server/src/wire/`

`capture.ts` is at 291 lines, so the routing moves to a new module (builder names it; `wire/capture-route.ts` suggested).

- One function takes the image, an optional pinned run id, and an event sink, and reports what happened as a sequence of typed events *(my call: events through a sink, not one return value. Telegram then sends each reply at the moment it does today, so a throw in the second ticker group still leaves the first group's replies delivered.)*
- Events, in the order today's replies are sent:
  - `unknown-run { id }`: the pinned run does not exist. Emitted before any vision call, as today.
  - `bad-extract { detail }`: vision failed, or no fills were recognized.
  - `pin-nomatch { runId, ticker }`, `pin-skipped { runId, tickers }`.
  - `no-run { ticker }`, `ambiguous { ticker }`.
  - `outcome { runId, ticker, outcome: CaptureOutcome }`: one per `ingestCapture` call.
- It needs only `repos`, `vision`, `getVisionApiKey`, `today` and `fetchImpl` from `CaptureDeps`. No chat id, no `send`, no language.
- `onPhoto` keeps the caption regex, calls the core, and maps each event to exactly the reply it sends today, including `tellBadExtract` recording for `bad-extract` and for a `rejected` outcome.
- The pinned run needs no status check (a paused or closed run can be pinned today); auto-route considers `active` runs only. Both unchanged.
- An optional vision time limit: when given, the vision request is aborted after that long and reported as `bad-extract` with a detail that says it timed out. Telegram passes none, so its behaviour is unchanged. No capture row is claimed for a failed extraction (as today), so the same file can be uploaded again.

### HTTP route — `apps/server/src/http/routes/captures.ts`

`POST /api/captures`, `multipart/form-data`, under the existing auth middleware.

- Fields: `image` (one file, required), `runId` (optional, positive integer via `parseId`).
- `HttpDeps` gains one injected function for the routing core, built in `main.ts` from the same vision config and key reader the Telegram handlers use, so tests inject a fake and the route never reads settings itself.
- Checks before the vision call, in this order:
  - vision base URL or model empty → 503 `vision-not-configured`
  - no `image` file, or a malformed `runId` → 400 `invalid-body`
  - mime not one of jpeg, png, webp, gif → 415 `unsupported-image` (export the allow-list from `domain/capture-image.ts`)
  - more than `MAX_IMAGE_BYTES` (8 MB) → 413 `image-too-large`
- Bytes become `{ base64, mime }` with `Buffer.from(bytes).toString('base64')`, the same encoding the bot uses. `ingestCapture` hashes that string, so the encoding must not differ.
- Response 200 `{ events }` through `jsonBig`. A `bad-extract` is a result, not an HTTP error. An `unknown-run` event becomes 404 `no-run` with no body events.
- An unexpected throw → 500 `capture-failed`, logged. Rows written by earlier ticker groups stay and show up in Pending.
- The route passes a 50-second vision time limit to the routing core *(my call: the answer then always arrives inside the 60-second connection window, so a slow read is reported in the popup as "vision took too long" and never ends as a dropped connection with an unknown result)*.
- A web `bad-extract` is not recorded as a System notice *(my call: with the time limit the operator always sees it in the popup; the notice exists for replies a web-only operator would otherwise miss)*.

### Vision config without the bot — `apps/server/src/wire/deps.ts`, `main.ts`

`VISION_BASE_URL` and `VISION_MODEL` are read only when `TELEGRAM_BOT_TOKEN` is set today, so a bot-less install would have no vision config for web uploads. The project treats Telegram as optional, so:

- `parseEnv` reads both variables whether or not a token is set. They stay required when a token is set, and become optional (empty) without one. `apps/server/test/wire.test.ts` pins the no-token case and is extended, not loosened.
- The Settings page values still override env, and are still read once at boot (a change there needs a restart, as today). Re-reading them per capture is out of scope.
- `README.md` env table updated.

### Timeout — `apps/server/src/main.ts`

`Bun.serve` gets `idleTimeout: 60` (operator's decision; the default is 10 seconds). Set on the server, so it covers every route *(my call: `createApp` has no handle on the server for a per-request timeout, and the morning trigger benefits too)*.

### Web client — `apps/web/src/api.ts`, `api.types.ts`

- `api.uploadCapture(file: File, runId?: number): Promise<CaptureEventDto[]>` posts `FormData` with the bearer header and no explicit `content-type`.
- `ApiErrorCode` gains `unsupported-image`, `image-too-large`, `capture-failed`, `vision-not-configured`.
- `CaptureEventDto` mirrors the server events; conflicts and pending rows carry what `CaptureConflict` and `PendingFillRow` carry.

### Upload popup — `apps/web/src/components/forms/` (new component)

Opened with an optional `runId`. Three states:

```
┌ Upload screenshot ───────────────────────────┐
│  ┌────────────────────────────────────────┐  │
│  │  Drop screenshots here, paste,         │  │
│  │  or [choose files]                     │  │
│  └────────────────────────────────────────┘  │
│  ▣ fills-1.png   412 KB                 [✕]  │
│  ▣ fills-2.png   388 KB                 [✕]  │
│                       [Cancel]  [Upload (2)] │
└──────────────────────────────────────────────┘

  uploading: each file shows waiting / reading… / done

┌ Upload screenshot ───────────────────────────┐
│  fills-1.png                                 │
│   ✓ NVDA → run #7: 2 fills waiting           │
│      Buy 10 @ $131.20 on 2026-11-23          │
│      Sell 10 @ $134.05 on 2026-11-23         │
│        ⚠ choose the bucket in Pending        │
│   – TSLA: no active run                      │
│  fills-2.png                                 │
│   – Already uploaded, nothing new            │
│                 [Upload more]  [Go to pending]│
└──────────────────────────────────────────────┘
```

- Picking: file input (`accept` the four mimes, `multiple`), drag and drop, and clipboard paste while the popup is open. Each picked file shows a thumbnail, name and size and can be removed. A wrong type or an oversized file is refused at pick time with the same wording as the server errors.
- Several files are uploaded one at a time, in pick order *(my call: several screenshots per trading day is the normal case; sequential keeps each request inside the timeout and the vision endpoint unloaded)*. A failed file does not stop the rest.
- While an upload is in flight the popup cannot be dismissed (Escape, backdrop, ✕ and Cancel are inert) *(my call: dismissing would lose the result of a capture that still completes)*. `Modal` already has `closeOnEscape`; the backdrop and ✕ have no switch yet, so the builder adds the smallest one.
- Result lines per file, one per event, localized in en and ko:
  - pending rows: ticker, run link `#/runs/:id`, each fill as side, shares, price, date, with the three "fix in Pending" reasons the bot uses (date substituted, date after today, bucket to choose)
  - `bookedEarlier`: the "may be duplicates" warning
  - conflicts: the four variants the bot words today (open correction, dismissed before, booked fill gone, pending row differs)
  - `duplicate`, `bad-extract` (and a `rejected` outcome), `no-run`, `ambiguous`, `pin-nomatch`, `pin-skipped`
  - a request failure: `errorText` with a `captureErr` prefix. `vision-not-configured` points to Settings. A `NetworkError` (a real connection loss, since the server answers within the window) says the capture may still have completed and to check Pending
- Web copy for `no-run` and `ambiguous` points to the run page's upload button, not to `/capture <runId>`.
- "Go to pending" is the primary button when any file produced pending rows or a correction; otherwise "Close".

### Entry points

- **Run page** (`pages/RunDetail.tsx`): an "Upload screenshot" button beside "Add fill" opens the popup with the run id. Closing after any completed upload reloads the run and refreshes the panels; "Go to pending" also selects the Pending tab.
- **Pending page** (`pages/Pending.tsx`): the same button in the page header opens the popup with no run id. Closing after any completed upload refreshes the pending table in place (`refreshKey`, so typed edits survive) and the correction list.

`RunDetail.tsx` is at 293 lines, so the builder moves something out of it to stay under ~300.

## Constraints

- Conventions from `AGENTS.md`: files under ~300 lines, all copy in the en/ko catalogs, injectable `fetch`, no `packages/*` importing `apps/*`.
- The existing `wire-capture-*`, `capture-replies` and `booking-capture-*` tests pass without edits to their assertions. Fixture changes for a changed constructor signature are fine. One exception: the source-text pin at `apps/server/test/capture-replies.test.ts:74-79` counts `tellBadExtract` call sites in `capture.ts` and cannot survive the move. It is rewritten to pin the same guarantee on the new structure: every `bad-extract` event and every `rejected` outcome reaches the one recording helper *(my call: the event list stays as designed; the test's intent is kept, its mechanics change)*.
- New tests: the routing core's events for every branch, including the vision time limit; `parseEnv` with vision variables and no token; the HTTP route (each rejection, pinned, auto-routed, 404, 500) on the `http-fakes.ts` pattern; the popup and both entry points on the `apps/web/src/testing/` pattern; a web-upload step in `scripts/e2e.ts` covering a pinned upload, an auto-routed upload and a repeat that reports a duplicate.
- `bun run typecheck`, `bun test`, the DB suite and `scripts/e2e.ts` pass.
- `AGENTS.md` repo map and `README.md` updated for the new files and the new way in.

## Left to the builder

- Names of the new module, function, event type and component; the exact shape of the injected `HttpDeps` function.
- Whether the body cap is enforced by Hono's `bodyLimit`, a `Content-Length` check, or the file size after parsing, as long as an oversized upload never reaches the vision call.
- How the correction list is refreshed after an upload (remount key or a refresh prop).
- Catalog key names and the exact en/ko wording, kept close to the bot's existing texts in `packages/telegram/src/i18n.ts`.
- What moves out of `RunDetail.tsx`.
- Confirming Bun's `idleTimeout` default and unit against the installed version (1.4.5) before relying on it.
