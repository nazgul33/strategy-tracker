# Capture Error Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A failed capture tells the operator which of three things went wrong (vision refused the request, vision answered in an unusable form, no fills in the image), carries the vision service's own error text, and for setup-related failures names the model, URL and key source in use, on Telegram and on the web, in English and Korean.

**Architecture:** The extractor puts the service's error text (whitespace-collapsed, key-redacted, capped at 200 characters) into `detail`. The routing core carries the extractor's `reason` and, for `http`/`unparseable`, a `VisionInUse` snapshot (values plus `settings`/`env`/`none` sources) on the `bad-extract` event; `main.ts` supplies the sources. Telegram words the event in a new pure module `wire/capture-bad-extract-message.ts`; the web words it in `uploadlines.ts` from its own catalogs.

**Tech Stack:** Bun + TypeScript, `bun:test`, Hono (HTTP), React web app with flat en/ko JSON catalogs, Telegram catalog in `packages/telegram/src/i18n.ts`.

**Spec:** `docs/superpowers/specs/2026-11-24-capture-error-messages-design.md`

## Global Constraints

- English only in code, comments and docs; Korean only inside the catalogs (`packages/telegram/src/i18n.ts`, `apps/web/src/i18n/ko.json`).
- No source file over ~300 lines; `packages/*` never import `apps/*`; `fetch` stays injectable; all copy in en/ko catalogs.
- The API key value, or any 4-or-more-character run of it, never appears in an event, a message, a log line or a notice. Only its source (`settings` / `env` / `none`) is reported.
- Event shape (exact names, used by every task):
  ```ts
  export type VisionSource = 'settings' | 'env'
  export interface VisionInUse { model: string; modelSource: VisionSource; baseUrl: string; baseUrlSource: VisionSource; keySource: VisionSource | 'none' }
  export type BadExtractEvent =
    | { type: 'bad-extract'; reason: 'http' | 'unparseable'; detail: string; vision: VisionInUse }
    | { type: 'bad-extract'; reason: 'empty'; detail: string }
  ```
  (A discriminated union: the spec's `vision?` made exact — present for `http`/`unparseable`, absent for `empty`.)
- The vision timeout stays `reason: 'http'`, `detail: 'vision timed out'` (`VISION_TIMEOUT_DETAIL`). The core's "no fills recognized" and a `rejected` outcome are `empty`.
- Notice kind for the Telegram reply stays `capture-bad-extract`; no System notice for web uploads.
- Non-goals, do not touch: Settings-over-env precedence, re-reading URL/model without a restart, retries, the web "vision took too long" text, the 503 `vision-not-configured` answer.
- Commit style `feat|fix|docs|test|refactor|chore:`. After every task: `bun run typecheck` and `bun test` green.

## Exact copy

English is fixed by the spec. Source words fill `{modelSource}`, `{baseUrlSource}`, `{keySource}`.

**Telegram** (`packages/telegram/src/i18n.ts`, `CATALOG`; insert where `capture-bad-extract` is now, remove `capture-bad-extract`):

| Key | en | ko |
| --- | --- | --- |
| `capture-bad-extract-http` | `The vision service did not accept the request — {detail}.` | `비전 서비스가 요청을 받아들이지 않았습니다 — {detail}.` |
| `capture-bad-extract-unparseable` | `The vision model answered, but not in a form the tracker understands — {detail}. Try again; if it keeps happening, check the vision model.` | `비전 모델이 응답했지만 트래커가 이해할 수 있는 형식이 아닙니다 — {detail}. 다시 시도하고, 계속 반복되면 비전 모델을 확인하세요.` |
| `capture-bad-extract-empty` | `No fills were found in this image. Check that it shows the fills list, or book the fill manually.` | `이 이미지에서 체결을 찾지 못했습니다. 체결 내역 화면인지 확인하거나 체결을 직접 예약하세요.` |
| `capture-vision-in-use` | `In use: model {model} ({modelSource}), URL {baseUrl} ({baseUrlSource}), key ({keySource}).` | `사용 중: 모델 {model} ({modelSource}), URL {baseUrl} ({baseUrlSource}), 키 ({keySource}).` |
| `capture-vision-setup-advice` | `This is a vision setup problem, not the screenshot. A URL or model changed in Settings applies after a server restart.` | `스크린샷 문제가 아니라 비전 설정 문제입니다. 설정에서 바꾼 URL이나 모델은 서버를 다시 시작해야 적용됩니다.` |
| `vision-source-settings` | `Settings` | `설정` |
| `vision-source-env` | `env` | `env` |
| `vision-source-none` | `not set` | `없음` |

**Web** (`apps/web/src/i18n/en.json` and `ko.json`; remove `upload.badExtract`; keep localeCompare order — the new `upload.badExtract*` keys go between `upload.ambiguous` and `upload.bookedEarlier`, the `upload.vision*` keys between `upload.title` and `upload.visionTimeout`):

| Key | en | ko |
| --- | --- | --- |
| `upload.badExtractEmpty` | same text as `capture-bad-extract-empty` | same as Telegram ko |
| `upload.badExtractHttp` | same text as `capture-bad-extract-http` | same as Telegram ko |
| `upload.badExtractUnparseable` | same text as `capture-bad-extract-unparseable` | same as Telegram ko |
| `upload.visionInUse` | same text as `capture-vision-in-use` | same as Telegram ko |
| `upload.visionSetupAdvice` | same text as `capture-vision-setup-advice` | same as Telegram ko |
| `upload.visionSourceEnv` | `env` | `env` |
| `upload.visionSourceNone` | `not set` | `없음` |
| `upload.visionSourceSettings` | `Settings` | `설정` |

Removed keys and their only users: `capture-bad-extract` (text) — used only by `apps/server/src/wire/capture.ts:53`; `upload.badExtract` — used only by `apps/web/src/uploadlines.ts:20`. Each removing task greps for the key and finds no remaining use (the notice *kind* string `'capture-bad-extract'` stays).

## Decisions (the spec's "Left to the builder")

- Keys as in the copy tables; in-use and advice lines are separate catalog keys; source words are catalog keys; composition is in code (Telegram: lines joined with `\n`; web: separate `UploadLine`s).
- `getVisionApiKey(): Promise<VisionApiKey>` with `export interface VisionApiKey { key: string; source: VisionSource | 'none' }`; `CaptureRouteDeps.vision` becomes `{ baseUrl: string; baseUrlSource: VisionSource; model: string; modelSource: VisionSource }`. The key value goes only into `cfg.apiKey` of the vision request.
- Sources mirror the existing `settings.x || env.x` resolution: a non-empty Settings value is `settings`, otherwise `env` (even when the env value is empty too); the key is `none` only when both are empty.
- The extractor redacts the key from every failure `detail` it builds, because OpenAI-style services echo a masked key in 401 bodies (`sk-proj-****abcd`), which would break the anti-goal.

## Review Focus

1. The vision service echoes the key (whole, or masked with only a few real characters) in its error body → the detail shows `[redacted]` in place of that word, on every channel. Pinned in Task 1 (extractor), Task 2 (event + HTTP body), Task 3 (Telegram reply, notice row, log line).
2. A proxy answers with a multi-line HTML error page → one line, at most 200 characters plus the `http <status>: ` prefix, no raw newlines in the Telegram reply. Pinned in Task 1.
3. No key set in Settings or env → the in-use line says `key (not set)` / `키 (없음)`, never an empty pair of parentheses. Pinned in Task 2 (core) and Task 3 (wording).
4. A service message containing brace text such as `{model}` → rendered literally, not substituted by a later placeholder. Pinned in Task 3 (Telegram) and Task 4 (web, whose `lookup` substitutes sequentially).
5. A web upload that times out → still only the "Vision took too long" line, no in-use or advice line. Pinned in Task 4.

---

### Task 1: The vision service's error text in `detail`

**Files:**
- Modify: `packages/ingest/src/extract.ts` (the `!res.ok` branch and the network-failure `catch`)
- Create: `packages/ingest/test/extract-http-error.test.ts`
- Modify: `apps/server/test/wire-capture-routing.test.ts:73,77` (its fake vision answers 500 with body `boom`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ExtractResult` unchanged in type. On a non-OK response `detail` is `http <status>: <message>` or `http <status>`; on a network failure it is the thrown message. Neither ever contains a 4-character run of `cfg.apiKey` (when the key has 4+ characters). Later tasks rely on `detail === 'http 500'` for fakes that answer `{ ok: false, status: 500 }` with no `text` method.

Rules (decided here, not in the spec):
- The body is read with `await res.text()` only when `!res.ok`; the OK path is unchanged (`res.json()`). If `res.text` is missing or throws/rejects, the body is `''`.
- Message pick, in order: JSON-parsed body's `error.message` if a string with non-whitespace content; else top-level `error` if such a string; else top-level `message` if such a string; else the raw body text (also when the body is not JSON, or is JSON of another shape).
- Then: collapse every whitespace run to one space and trim; redact; if the result is empty, `detail` is `http <status>`; otherwise, if it has more than 200 code points (`[...s].length`), keep the first 199 code points and append `…` (U+2026), so a cut message is exactly 200 code points; `detail` is `http <status>: <message>`.
- Redaction, as a private `redactKey(text: string, apiKey: string): string`: when `apiKey.length < 4`, return `text` unchanged; otherwise split `text` on `/(\s+)/` (keeping the separators) and replace every non-whitespace token that contains any 4-character substring of `apiKey` with `[redacted]`. Case-sensitive.
- Network failure: `detail` is `redactKey(String(e?.message ?? e), cfg.apiKey)` — the thrown message as today, unless it contains key parts.

- [ ] **Step 1: Write the failing tests** in `packages/ingest/test/extract-http-error.test.ts`. A local helper `failWith(status: number, body: string | (() => Promise<string>) | undefined)` returns a fetch fake answering `{ ok: false, status, text }` (`text` omitted when `undefined`); `CFG = { baseUrl: 'http://x', apiKey: 'k', model: 'm', maxTokens: 100 }`; `detailOf(fetch, cfg = CFG)` runs `extractFills([{ base64: 'AAA', mime: 'image/png' }], cfg, fetch)` and returns `r.ok ? null : [r.reason, r.detail]`.

```ts
test('OpenAI error shape: error.message', async () => {
  const body = JSON.stringify({ error: { message: "The model 'x' is not loaded; currently serving 'y'", type: 'invalid_request_error' } })
  expect(await detailOf(failWith(404, body))).toEqual(['http', "http 404: The model 'x' is not loaded; currently serving 'y'"])
})
test('top-level string error, then top-level message', async () => {
  expect(await detailOf(failWith(404, '{"error":"model not found"}'))).toEqual(['http', 'http 404: model not found'])
  expect(await detailOf(failWith(401, '{"message":"Unauthorized"}'))).toEqual(['http', 'http 401: Unauthorized'])
})
test('other JSON and plain text are used as the body text', async () => {
  expect(await detailOf(failWith(404, '{"detail":"Not Found"}'))).toEqual(['http', 'http 404: {"detail":"Not Found"}'])
  expect(await detailOf(failWith(502, 'Bad Gateway'))).toEqual(['http', 'http 502: Bad Gateway'])
})
test('an HTML error page collapses to one line', async () => {
  expect(await detailOf(failWith(502, '<html>\n  <body>\n\t<h1>502 Bad Gateway</h1>\n  </body>\n</html>\n')))
    .toEqual(['http', 'http 502: <html> <body> <h1>502 Bad Gateway</h1> </body> </html>'])
})
test('empty, whitespace-only, unreadable or missing body keeps http <status>', async () => {
  expect(await detailOf(failWith(500, ''))).toEqual(['http', 'http 500'])
  expect(await detailOf(failWith(500, '  \n\t '))).toEqual(['http', 'http 500'])
  expect(await detailOf(failWith(503, async () => { throw new Error('stream broke') }))).toEqual(['http', 'http 503'])
  expect(await detailOf(failWith(500, undefined))).toEqual(['http', 'http 500'])
})
test('cap: 200 code points kept whole, 201 cut to 199 plus an ellipsis', async () => {
  expect(await detailOf(failWith(400, 'a'.repeat(200)))).toEqual(['http', `http 400: ${'a'.repeat(200)}`])
  expect(await detailOf(failWith(400, 'a'.repeat(201)))).toEqual(['http', `http 400: ${'a'.repeat(199)}…`])
  // the cap applies after collapsing: 266 raw characters, 200 after
  const spaced = Array(67).fill('ab').join('\n\n')
  expect(await detailOf(failWith(400, spaced))).toEqual(['http', `http 400: ${Array(67).fill('ab').join(' ')}`])
})
test('the body is read only on a non-OK answer', async () => {
  let textCalls = 0
  const ok = (async () => ({ ok: true, status: 200, text: async () => { textCalls++; return '' }, json: async () => ({ choices: [{ message: { content: '{"fills":[]}' } }] }) })) as unknown as typeof fetch
  expect(await detailOf(ok)).toEqual(['empty', 'no valid fills'])
  expect(textCalls).toBe(0)
})
test('a network failure keeps the thrown message', async () => {
  const down = (async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1234') }) as unknown as typeof fetch
  expect(await detailOf(down)).toEqual(['http', 'connect ECONNREFUSED 127.0.0.1:1234'])
})
test('the key, whole or masked, is redacted from the detail', async () => {
  const KEY = 'sk-LEAKCHECK-7f3a9c2e'
  const cfg = { ...CFG, apiKey: KEY }
  const masked = JSON.stringify({ error: { message: 'Incorrect API key provided: sk-LEA*********9c2e. You can find your API key at https://x.' } })
  expect(await detailOf(failWith(401, masked), cfg)).toEqual(['http', 'http 401: Incorrect API key provided: [redacted] You can find your API key at https://x.'])
  expect(await detailOf(failWith(401, `bad key ${KEY}`), cfg)).toEqual(['http', 'http 401: bad key [redacted]'])
  const thrown = (async () => { throw new Error(`refused for Bearer ${KEY}`) }) as unknown as typeof fetch
  expect(await detailOf(thrown, cfg)).toEqual(['http', 'refused for Bearer [redacted]'])
})
```

- [ ] **Step 2: Run** `bun test packages/ingest/test/extract-http-error.test.ts` — expected FAIL (details are `http <status>` only; no redaction).

- [ ] **Step 3: Implement** the rules above in `packages/ingest/src/extract.ts`: private `redactKey(text: string, apiKey: string): string` and private `visionErrorDetail(status: number, body: string, apiKey: string): string`; the `!res.ok` branch reads the body (guarded) and returns `{ ok: false, reason: 'http', detail: visionErrorDetail(res.status, body, cfg.apiKey) }`; the `catch` applies `redactKey`. Nothing exported newly.

- [ ] **Step 4: Update** `apps/server/test/wire-capture-routing.test.ts` test "extract failure: no pending row, user sees the reason, admin notified": its fake answers 500 with body `boom`, so the expected text becomes `'Could not read fills from this image — http 500: boom. Book the fill manually in the web UI.'` (line 73) and the `toContain` becomes `'Could not read fills from this image — http 500: boom'` (line 77). (Task 3 rewords it again.)

- [ ] **Step 5: Verify**
  - `bun test packages/ingest` — PASS (old `extract.test.ts` "c) http 401" still passes: its fake has no `text`, so `http 401`).
  - `wc -l packages/ingest/src/extract.ts` — under 300 (about 190).
  - `bun run typecheck` and `bun test` — green.

- [ ] **Step 6: Commit**
```bash
git add packages/ingest/src/extract.ts packages/ingest/test/extract-http-error.test.ts apps/server/test/wire-capture-routing.test.ts
git commit -m "feat: carry the vision service's own error text in the extract detail, with the key redacted"
```

---

### Task 2: Kind and vision-in-use on the `bad-extract` event

**Files:**
- Modify: `apps/server/src/wire/capture-route.ts` (types, `CaptureRouteDeps`, both `bad-extract` emits)
- Modify: `apps/server/src/wire/deps.ts` (two source helpers)
- Modify: `apps/server/src/main.ts:39-44` (`captureRouteDeps`)
- Modify (deps shape only): `apps/server/test/capture-route.test.ts`, `apps/server/test/capture-replies.test.ts`, `apps/server/test/wire-capture-fakes.ts`, `apps/server/test/wire-capture-routing.test.ts`, `apps/server/test/wire-capture-confirm.test.ts`, `apps/server/test/vision-review-reject.test.ts`, `scripts/e2e.ts:101,145-146`
- Modify (tests): `apps/server/test/capture-route.test.ts`, `apps/server/test/http-captures.test.ts`, `apps/server/test/wire.test.ts`, `apps/server/test/main-boot-order.test.ts`, `apps/server/test/capture-replies.test.ts` (core-side pin lines only), `apps/server/test/wire-capture-fakes.ts` (leak helpers)

**Interfaces:**
- Consumes: Task 1's redacted `detail`.
- Produces (exported from `apps/server/src/wire/capture-route.ts`): `VisionSource`, `VisionInUse`, `BadExtractEvent` (exactly as in Global Constraints), `VisionApiKey { key: string; source: VisionSource | 'none' }`, `CaptureEvent` with `BadExtractEvent` replacing the old `{ type: 'bad-extract'; detail: string }` member, and
  ```ts
  export interface CaptureRouteDeps {
    repos: RepoSurface
    vision: { baseUrl: string; baseUrlSource: VisionSource; model: string; modelSource: VisionSource }
    getVisionApiKey(): Promise<VisionApiKey>
    today(): string
    fetchImpl?: typeof fetch
  }
  ```
  Private in the same file: `badExtract(reason: 'http' | 'unparseable' | 'empty', detail: string, vision: VisionInUse): BadExtractEvent` (drops `vision` for `empty`). Both emits are `await emit(badExtract(extract.reason, extract.detail, inUse))` and `await emit(badExtract('empty', 'no fills recognized', inUse))`, where `inUse` is built from `deps.vision` and the `source` of the key fetched for this capture.
- Produces (exported from `apps/server/src/wire/deps.ts`): `visionSource(saved: string | undefined): VisionSource` (`'settings'` when `saved` is a non-empty string, else `'env'`) and `resolveVisionApiKey(saved: string | undefined, fromEnv: string): VisionApiKey`.
- Produces (exported from `apps/server/test/wire-capture-fakes.ts`, used by Task 3): `LEAK_KEY = 'sk-LEAKCHECK-7f3a9c2e'`; `keyEchoFetch: typeof fetch` answering `{ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: \`Incorrect API key provided: ${LEAK_KEY}; masked sk-LEA*********9c2e\` } }) }`; `keyParts(text: string): string[]` returning every 4-character substring of `LEAK_KEY` found in `text` (expected `[]`).
- Web between tasks: the web does not import server types; until Task 4 it reads only `detail` and shows the old "Could not read fills…" line for every kind. Telegram still sends the old text until Task 3 (`tellBadExtract(chatId, event.detail)` compiles against the union).

- [ ] **Step 1: Write the failing tests.**

`apps/server/test/wire.test.ts`, new `describe('vision sources')`:
```ts
expect(visionSource('http://a')).toBe('settings')
expect(visionSource('')).toBe('env')
expect(visionSource(undefined)).toBe('env')
expect(resolveVisionApiKey('sk-s', 'sk-e')).toEqual({ key: 'sk-s', source: 'settings' })
expect(resolveVisionApiKey('', 'sk-e')).toEqual({ key: 'sk-e', source: 'env' })
expect(resolveVisionApiKey(undefined, '')).toEqual({ key: '', source: 'none' })
```

`apps/server/test/capture-route.test.ts`: the `routing()` helper passes `vision: { baseUrl: 'https://vision.example/v1', baseUrlSource: 'env', model: 'vision-model', modelSource: 'settings' }` and `getVisionApiKey: async () => opts.key ?? { key: 'k', source: 'settings' }` (add `key?: VisionApiKey` to its opts). `const IN_USE: VisionInUse = { model: 'vision-model', modelSource: 'settings', baseUrl: 'https://vision.example/v1', baseUrlSource: 'env', keySource: 'settings' }`.
- "vision failure is a bad-extract with the extractor's detail": `expect(r.events).toEqual([{ type: 'bad-extract', reason: 'http', detail: 'http 500', vision: IN_USE }])`.
- new "an unreadable answer is unparseable and names the config in use": fetch answers OK with content `"I can't read this"` → `[{ type: 'bad-extract', reason: 'unparseable', detail: 'no json', vision: IN_USE }]`.
- new "an image without fills is empty and carries no config": fetch answers OK with content `'{"fills":[]}'` → `toEqual([{ type: 'bad-extract', reason: 'empty', detail: 'no valid fills' }])` and `expect('vision' in r.events[0]!).toBe(false)`.
- new "no key anywhere is reported as none": `key: { key: '', source: 'none' }` with `vision500` → `vision: { ...IN_USE, keySource: 'none' }`.
- "a vision read slower than the limit…": `[{ type: 'bad-extract', reason: 'http', detail: 'vision timed out', vision: IN_USE }]`.
- new "the key value never reaches an event": `key: { key: LEAK_KEY, source: 'env' }`, `fetchImpl: keyEchoFetch` → `expect(keyParts(JSON.stringify(r.events))).toEqual([])` and `expect(r.events[0]).toMatchObject({ reason: 'http', detail: 'http 401: Incorrect API key provided: [redacted] masked [redacted]', vision: { keySource: 'env' } })`.

`apps/server/test/http-captures.test.ts`:
- "a bad-extract is a 200 result and records no notice": the event becomes `{ type: 'bad-extract', reason: 'http', detail: 'http 500', vision: { model: 'm', modelSource: 'settings', baseUrl: 'http://x', baseUrlSource: 'env', keySource: 'none' } }`; assertions unchanged.
- new "the key value never reaches the upload answer": deps use the real `makeCaptureRouting({ repos: f.repos, vision: { baseUrl: 'http://x', baseUrlSource: 'env', model: 'm', modelSource: 'env' }, getVisionApiKey: async () => ({ key: LEAK_KEY, source: 'settings' }), today: () => '2026-11-10', fetchImpl: keyEchoFetch })`; with `console.error` spied, POST one PNG with no runId → status 200, `keyParts(await res.text())` is `[]`, `keyParts(JSON.stringify(errors.mock.calls))` is `[]`, `f.notifications` is `[]`.

`apps/server/test/main-boot-order.test.ts`, second test, add:
```ts
expect(src).toContain('baseUrlSource: visionSource(settings.visionBaseUrl)')
expect(src).toContain('modelSource: visionSource(settings.visionModel)')
expect(src).toContain('resolveVisionApiKey((await repos.settingsRepo.getAll()).visionApiKey, env.visionApiKey)')
```
(the two existing `settings.x || env.x` pins stay).

`apps/server/test/capture-replies.test.ts`, last test — replace the three core lines with:
```ts
expect(core.match(/emit\(badExtract\(/g)).toHaveLength(2)
expect(core.match(/emit\(badExtract\(extract\.reason, extract\.detail, /g)).toHaveLength(1)
expect(core.match(/emit\(badExtract\('empty', 'no fills recognized', /g)).toHaveLength(1)
expect(core.match(/emit\(\{ type: 'bad-extract'/g)).toBeNull()
expect(core).not.toContain('capture-bad-extract')
```
(its four `src` lines stay as they are until Task 3).

- [ ] **Step 2: Run** `bun test apps/server/test/wire.test.ts apps/server/test/capture-route.test.ts apps/server/test/http-captures.test.ts apps/server/test/main-boot-order.test.ts apps/server/test/capture-replies.test.ts` — expected FAIL (missing exports, old event shape).

- [ ] **Step 3: Implement** the types, `badExtract`, the two emits and the new `CaptureRouteDeps` in `capture-route.ts` (`apiKey: key.key` in `cfg`; never put the key object or value anywhere else); `visionSource` and `resolveVisionApiKey` in `deps.ts` (type-only import from `./capture-route`); in `main.ts` keep the `visionBaseUrl` / `visionModel` lines and write `vision: { baseUrl: visionBaseUrl, baseUrlSource: visionSource(settings.visionBaseUrl), model: visionModel, modelSource: visionSource(settings.visionModel) }` and `getVisionApiKey: async () => resolveVisionApiKey((await repos.settingsRepo.getAll()).visionApiKey, env.visionApiKey)`.

- [ ] **Step 4: Update every other deps fixture** to the new shape, keeping each file's existing values and adding `baseUrlSource: 'env', modelSource: 'env'` and `getVisionApiKey: async () => ({ key: <existing string>, source: 'env' as const })`: `capture-replies.test.ts` setup (`'k'`), `wire-capture-fakes.ts` `makeCapture` (`'test-vision-key'`), `wire-capture-routing.test.ts` (`'test-vision-key'`), `wire-capture-confirm.test.ts` (`'k'`), `vision-review-reject.test.ts` (`'k'`), `scripts/e2e.ts` lines 101 and 145–146 (`'e2e-key'`, edit in place without adding lines). Add `LEAK_KEY`, `keyEchoFetch`, `keyParts` to `wire-capture-fakes.ts`. Then `grep -rn "getVisionApiKey: async () => '" apps scripts` finds nothing.

- [ ] **Step 5: Verify**
  - The Step 2 command — PASS.
  - `wc -l scripts/e2e.ts apps/server/src/wire/capture-route.ts apps/server/src/wire/deps.ts apps/server/test/capture-route.test.ts apps/server/test/wire-capture-fakes.ts` — e2e.ts still 298, every file under 300.
  - `bun run typecheck` and `bun test` — green.

- [ ] **Step 6: Commit**
```bash
git add apps/server/src apps/server/test scripts/e2e.ts
git commit -m "feat: carry the failure kind and the vision config in use, with its sources, on bad-extract events"
```

---

### Task 3: Telegram wording for the three kinds

**Files:**
- Create: `apps/server/src/wire/capture-bad-extract-message.ts`
- Create: `apps/server/test/capture-bad-extract-message.test.ts`
- Modify: `packages/telegram/src/i18n.ts` (copy table above)
- Modify: `apps/server/src/wire/capture.ts` (`tellBadExtract` and its two callers)
- Modify: `apps/server/test/capture-replies.test.ts`, `apps/server/test/wire-capture-routing.test.ts:73,77`
- Modify: `AGENTS.md` (repo map)

**Interfaces:**
- Consumes: `BadExtractEvent`, `VisionInUse` from `apps/server/src/wire/capture-route.ts` (Task 2); `LEAK_KEY`, `keyEchoFetch`, `keyParts` from `apps/server/test/wire-capture-fakes.ts` (Task 2); `t`, `Lang` from `@st/telegram/i18n`.
- Produces: `export function badExtractMessage(event: BadExtractEvent, lang: Lang): string` — `http`: main, in-use, advice lines; `unparseable`: main, in-use; `empty`: main only; joined with `'\n'`. Each kind's main key is written as a literal `t('capture-bad-extract-<kind>', …)` call (the pin counts three); source words via `t(\`vision-source-${source}\`, lang)`. In `capture.ts`: `async function tellBadExtract(chatId: string, event: BadExtractEvent): Promise<void>` records and sends `badExtractMessage(event, lang)` through `broadcastNotice` with `{ kind: 'capture-bad-extract' }`; callers are `await tellBadExtract(chatId, event)` and `await tellBadExtract(chatId, { type: 'bad-extract', reason: 'empty', detail: 'no fills recognized' })`.

- [ ] **Step 1: Write the failing tests.**

`apps/server/test/capture-bad-extract-message.test.ts` with `const VISION: VisionInUse = { model: 'qwen2.5-vl', modelSource: 'settings', baseUrl: 'http://lm:1234/v1', baseUrlSource: 'env', keySource: 'none' }`, `const ADVICE_EN = 'This is a vision setup problem, not the screenshot. A URL or model changed in Settings applies after a server restart.'`:
```ts
expect(badExtractMessage({ type: 'bad-extract', reason: 'http', detail: "http 404: The model 'x' is not loaded", vision: VISION }, 'en')).toBe([
  "The vision service did not accept the request — http 404: The model 'x' is not loaded.",
  'In use: model qwen2.5-vl (Settings), URL http://lm:1234/v1 (env), key (not set).',
  ADVICE_EN,
].join('\n'))
expect(badExtractMessage({ type: 'bad-extract', reason: 'unparseable', detail: 'no json', vision: { ...VISION, keySource: 'env' } }, 'en')).toBe([
  'The vision model answered, but not in a form the tracker understands — no json. Try again; if it keeps happening, check the vision model.',
  'In use: model qwen2.5-vl (Settings), URL http://lm:1234/v1 (env), key (env).',
].join('\n'))
expect(badExtractMessage({ type: 'bad-extract', reason: 'empty', detail: 'no valid fills' }, 'en'))
  .toBe('No fills were found in this image. Check that it shows the fills list, or book the fill manually.')
// ko, same three events: the ko strings of the copy table, with
// '사용 중: 모델 qwen2.5-vl (설정), URL http://lm:1234/v1 (env), 키 (없음).' as the in-use line of the http case
// a detail with brace text is not substituted
expect(badExtractMessage({ type: 'bad-extract', reason: 'http', detail: 'http 400: unknown field {model}', vision: VISION }, 'en').split('\n')[0])
  .toBe('The vision service did not accept the request — http 400: unknown field {model}.')
```

`apps/server/test/capture-replies.test.ts`:
- `TEXT` becomes `['The vision service did not accept the request — http 500.', 'In use: model m (env), URL https://vision.example/v1 (env), key (env).', ADVICE_EN].join('\n')`; the Korean test expects `['비전 서비스가 요청을 받아들이지 않았습니다 — http 500.', '사용 중: 모델 m (env), URL https://vision.example/v1 (env), 키 (env).', '스크린샷 문제가 아니라 비전 설정 문제입니다. 설정에서 바꾼 URL이나 모델은 서버를 다시 시작해야 적용됩니다.'].join('\n')`. The two `notice failed:` log assertions are unchanged.
- new "the key value never reaches a reply, a notice or a log line": `setup({ getVisionApiKey: async () => ({ key: LEAK_KEY, source: 'settings' }), fetchImpl: keyEchoFetch })`, `notificationRepo.insert` throws `db-down` (so a log line is written), `console.error`/`console.log`/`console.warn` spied → `keyParts` of `JSON.stringify(sent)`, of `JSON.stringify(f.notifications)` and of each spy's `JSON.stringify(mock.calls)` are all `[]`; `sent[0]` starts with `'The vision service did not accept the request — http 401: Incorrect API key provided: [redacted]'` and contains `'key (Settings)'`. Repeat without the throwing insert and assert `keyParts(JSON.stringify(rows(f)))` is `[]`.
- the source pin test — replace the four `src` lines (the `core` lines from Task 2 stay):
```ts
const msg = await Bun.file(new URL('../src/wire/capture-bad-extract-message.ts', import.meta.url)).text()
expect(src.match(/badExtractMessage\(/g)).toHaveLength(1)
expect(src.match(/t\('capture-bad-extract/g)).toBeNull()
expect(src.match(/await tellBadExtract\(chatId, /g)).toHaveLength(2)
expect(src.match(/await tellBadExtract\(chatId, event\)/g)).toHaveLength(1)
expect(src.match(/await tellBadExtract\(chatId, \{ type: 'bad-extract', reason: 'empty', detail: 'no fills recognized' \}\)/g)).toHaveLength(1)
expect(msg.match(/t\('capture-bad-extract-/g)).toHaveLength(3)
```

`apps/server/test/wire-capture-routing.test.ts` "extract failure…": expected text `['The vision service did not accept the request — http 500: boom.', 'In use: model vision-model (env), URL https://vision.example/v1 (env), key (env).', ADVICE_EN].join('\n')` (line 73), and `toContain('The vision service did not accept the request — http 500: boom.')` (line 77).

- [ ] **Step 2: Run** `bun test apps/server/test/capture-bad-extract-message.test.ts apps/server/test/capture-replies.test.ts apps/server/test/wire-capture-routing.test.ts` — expected FAIL.

- [ ] **Step 3: Implement** the catalog entries (remove `capture-bad-extract`), `badExtractMessage`, and the `tellBadExtract` change. `grep -rn "'capture-bad-extract'" apps packages scripts` then shows only the notice kind in `capture.ts` and the log assertions in `capture-replies.test.ts`.

- [ ] **Step 4: Update `AGENTS.md`** repo map: add `wire/capture-bad-extract-message.ts` after `wire/capture-pending-message.ts`, and `capture-bad-extract-message` before `capture-claim` in the test list.

- [ ] **Step 5: Verify**
  - Step 2 command — PASS; `bun test packages/telegram` — PASS (placeholder parity).
  - `wc -l apps/server/src/wire/capture.ts` — at most 245 (241 before).
  - `bun run typecheck` and `bun test` — green.

- [ ] **Step 6: Commit**
```bash
git add packages/telegram/src/i18n.ts apps/server/src/wire apps/server/test AGENTS.md
git commit -m "feat: word failed Telegram captures by kind, with the vision config in use and setup advice"
```

---

### Task 4: Web wording, README note and full verification

**Files:**
- Modify: `apps/web/src/api.captures.types.ts`
- Modify: `apps/web/src/uploadlines.ts` (replace `badExtract`)
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json` (copy table above)
- Modify: `apps/web/src/uploadlines.test.ts`
- Modify: `README.md` (Telegram section, line 158–159; "Screenshot upload (web)" section)

**Interfaces:**
- Consumes: the server's JSON for `BadExtractEvent` (Task 2), mirrored, not imported.
- Produces in `api.captures.types.ts`: `export type VisionSourceDto = 'settings' | 'env'`, `export interface VisionInUseDto { model: string; modelSource: VisionSourceDto; baseUrl: string; baseUrlSource: VisionSourceDto; keySource: VisionSourceDto | 'none' }`, and in `CaptureEventDto` the member `{ type: 'bad-extract'; detail: string }` replaced by `| { type: 'bad-extract'; reason: 'http' | 'unparseable'; detail: string; vision: VisionInUseDto } | { type: 'bad-extract'; reason: 'empty'; detail: string }`.
- Produces in `uploadlines.ts`: private `badExtractLines(event: Extract<CaptureEventDto, { type: 'bad-extract' }>, t: Translate): UploadLine[]`:
  - `reason === 'http' && detail === VISION_TIMEOUT_DETAIL` → `[error, 0, upload.visionTimeout]` only;
  - `http` → `[error, 0, upload.badExtractHttp {detail}]`, `[info, 1, upload.visionInUse {…}]`, `[info, 1, upload.visionSetupAdvice, href '#/settings']`;
  - `unparseable` → the error line with `upload.badExtractUnparseable {detail}` and the in-use line;
  - `empty` → `[error, 0, upload.badExtractEmpty]`.
  - The `rejected` outcome returns `[line('error', 0, t('upload.badExtractEmpty'))]`. Source words via `upload.visionSourceSettings` / `Env` / `None`.

- [ ] **Step 1: Write the failing tests** in `apps/web/src/uploadlines.test.ts` (`const VISION: VisionInUseDto = { model: 'qwen2.5-vl', modelSource: 'settings', baseUrl: 'http://lm:1234/v1', baseUrlSource: 'env', keySource: 'none' }`):
```ts
// 'rejected' and new 'bad-extract empty'
[{ tone: 'error', depth: 0, text: 'No fills were found in this image. Check that it shows the fills list, or book the fill manually.', href: undefined }]
// 'bad-extract http'
view(captureEventLines({ type: 'bad-extract', reason: 'http', detail: "http 404: The model 'x' is not loaded", vision: VISION }, t)) toEqual [
  { tone: 'error', depth: 0, text: "The vision service did not accept the request — http 404: The model 'x' is not loaded.", href: undefined },
  { tone: 'info', depth: 1, text: 'In use: model qwen2.5-vl (Settings), URL http://lm:1234/v1 (env), key (not set).', href: undefined },
  { tone: 'info', depth: 1, text: 'This is a vision setup problem, not the screenshot. A URL or model changed in Settings applies after a server restart.', href: '#/settings' },
]
// 'bad-extract unparseable' (keySource 'env')
[
  { tone: 'error', depth: 0, text: 'The vision model answered, but not in a form the tracker understands — no json. Try again; if it keeps happening, check the vision model.', href: undefined },
  { tone: 'info', depth: 1, text: 'In use: model qwen2.5-vl (Settings), URL http://lm:1234/v1 (env), key (env).', href: undefined },
]
// 'vision timeout': event { type: 'bad-extract', reason: 'http', detail: 'vision timed out', vision: VISION } → only the existing timeout line
// brace text in the detail stays literal
captureEventLines({ type: 'bad-extract', reason: 'http', detail: 'http 400: unknown field {model}', vision: VISION }, t)[0]!.text
  === 'The vision service did not accept the request — http 400: unknown field {model}.'
// 'ko catalog': lookup('ko', 'upload.visionInUse', { model: 'm', modelSource: lookup('ko', 'upload.visionSourceSettings'), baseUrl: 'u', baseUrlSource: 'env', keySource: lookup('ko', 'upload.visionSourceNone') })
//   === '사용 중: 모델 m (설정), URL u (env), 키 (없음).'
```

- [ ] **Step 2: Run** `bun test apps/web/src/uploadlines.test.ts` — expected FAIL.

- [ ] **Step 3: Implement** the DTO, `badExtractLines`, and the catalog edits (remove `upload.badExtract`; `grep -rn "upload.badExtract\"\|'upload.badExtract'" apps/web/src` finds nothing).

- [ ] **Step 4: README.** In "Telegram", replace the sentence (wrapped over lines 158–159) `A screenshot the vision model cannot read is answered with "Could not read fills…", and that reply is also listed under System notices.` with `A screenshot that cannot be read is answered with one of three messages (see "Reading a failed capture" below), and that reply is also listed under System notices.` At the end of "Screenshot upload (web)" add:

```markdown
### Reading a failed capture

Telegram and the web word a failed capture the same way:

- **"The vision service did not accept the request — …"** is a vision setup problem, not the
  screenshot. The text after the dash is the service's own answer (for example a model name it does
  not serve). The "In use" line names the model, URL and key source the server is running with, each
  marked `Settings` or `env` (`not set` for a missing key). A URL or model changed in Settings
  applies only after a server restart; the key is re-read on every capture.
- **"The vision model answered, but not in a form the tracker understands — …"**: try again; if it
  keeps happening, the model in use is probably not suited to reading screenshots.
- **"No fills were found in this image."**: the screenshot does not show the fills list; book the
  fill manually.

The API key itself is never shown, only where it came from.
```

- [ ] **Step 5: Verify**
  - `bun test apps/web` — PASS (incl. `catalog.test.ts`: key parity, placeholder parity, localeCompare order).
  - `wc -l apps/web/src/uploadlines.ts apps/web/src/uploadlines.test.ts` — both under 300.
  - `bun run typecheck` — green; `bun test` — green.
  - DB suite: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` — record the final `N pass / 0 fail` line.
  - E2E: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts` (from the repo root) — record its final summary line; it must report no failures.

- [ ] **Step 6: Commit**
```bash
git add apps/web/src README.md
git commit -m "feat: word failed web uploads by kind, with the vision config in use and a Settings link"
```
