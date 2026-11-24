# Capture Error Messages — Amendment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the operator's three rulings: the API key is masked as `sk-L....9c2e` instead of `[redacted]`, the vision service's original error gets its own line, and a 200 answer that is not an OpenAI chat-completions envelope becomes a fourth kind, `incompatible`.

**Architecture:** The extractor (`packages/ingest`) swaps its word-blanking `redactKey` for a linear-time `maskKey` in a new module and reclassifies two of its 200-answer failures. The `bad-extract` event gains `reason: 'incompatible'`. Telegram (`capture-bad-extract-message.ts` + `packages/telegram/src/i18n.ts`) and the web (`uploadlines.ts` + en/ko catalogs) each word the new line order from the event, as they do today.

**Tech Stack:** Bun + TypeScript, `bun:test`, Hono server, React web app with flat JSON catalogs.

**Spec:** `docs/superpowers/specs/2026-11-24-capture-error-messages-design.md`, section "Amendment (2026-11-24, after the final review)". Where the Amendment disagrees with earlier text in that file, the Amendment wins. Nothing outside the Amendment changes.

## Global Constraints

- English only in code, comments and docs; Korean only in catalogs and in tests that pin Korean output.
- No source file over ~300 lines (`wc -l` checks are given where a file is close).
- `packages/*` never import `apps/*`. All user-facing copy lives in the Telegram catalog (`packages/telegram/src/i18n.ts`) and the web catalogs (`apps/web/src/i18n/en.json`, `ko.json`).
- Web catalogs: identical key sets, identical placeholders per key, keys in `localeCompare` order (pinned by `apps/web/src/catalog.test.ts`).
- Detail pipeline order stays: collapse whitespace → mask key → strip trailing `.`/`?`/`!` (+ trim) → cap at 200 code points (199 + `…` when cut). The pick order of the error message (`error.message`, string `error`, `message`, `detail`, body text) is unchanged.
- **Anti-goal (hard):** no run of 8 or more consecutive characters of the key appears in an extractor result, an event, an HTTP answer, a Telegram reply, a notice row or a log line. The first 4 and last 4 characters of the key may appear. Known, accepted gap from the Amendment's own rule: a key of exactly 8 characters has no middle and is shown as sent (real provider keys are far longer). A key that itself contains `.` could in theory line up with the inserted dots; accepted, no provider issues such keys.
- Unchanged on purpose: the in-use line (shows only the key's *source*), the source words (`Settings`/`env`/`not set`, `설정`/`환경변수`/`API Key 없음`), the setup-advice line, the web timeout line, the 8-character partial-run threshold, the 200-character cap.
- Every task ends with `bun run typecheck` and `bun test` green (baseline before Task 1: `bun test` 2029 pass / 87 skip / 0 fail).
- Commit style `feat|fix|docs|test|refactor|chore:`; one commit per task.

## Review Focus

- A huge or repetitive error body (a proxy's HTML page; a body that repeats a key prefix tens of thousands of times; a key and text made of one repeated pair) must come back in well under a second and still capped — Task 1, timing tests.
- A local server run with a placeholder key (`test`, `ollama`, `sk-no-key-required`) must leave model names and ordinary words alone, except an 8-character run of a long key, which is partly dotted (`....ired`) — Task 1.
- A key echoed near the end of a long body, where the 200 cap would cut it, must be masked before the cut, so the line shows `sk-L....9c2e` and never a raw fragment — Task 1, mask-before-cap test.
- OpenAI's own masked project key in a 401 (`sk-proj-****3456` with a `sk-proj-…` key) must show no raw 8-run: `sk-p....****3456` — Task 1.
- A wrong base URL that serves an HTML page with status 200 must read as "not an OpenAI-compatible API" with setup advice, not "try again" — Task 3 (`response body not json`, and `no content` for `{}`).

## Copy (exact)

Telegram catalog (`packages/telegram/src/i18n.ts`):

| Key | Change | English | Korean | Task |
| --- | --- | --- | --- | --- |
| `capture-bad-extract-http` | text changed | `The vision service did not accept the request.` | `비전 서비스가 요청을 받아들이지 않았습니다.` | 2 |
| `capture-vision-original-error` | added | `Original error: {detail}` | `원본 오류: {detail}` | 2 |
| `capture-bad-extract-incompatible` | added | `The vision service answered, but not as an OpenAI-compatible API.` | `비전 서비스가 응답했지만 OpenAI 호환 API 형식이 아닙니다.` | 3 |
| `capture-vision-incompatible-advice` | added | `Make sure the configured vision API is OpenAI-compatible. A URL or model changed in Settings applies after a server restart.` | `설정된 비전 API가 OpenAI 호환인지 확인하세요. 설정에서 바꾼 URL이나 모델은 서버를 다시 시작해야 적용됩니다.` | 3 |

Web catalogs (`apps/web/src/i18n/en.json` / `ko.json`), same texts:

| Key | Change | Task |
| --- | --- | --- |
| `upload.badExtractHttp` | text changed (as `capture-bad-extract-http`) | 2 |
| `upload.visionOriginalError` | added (as `capture-vision-original-error`) | 2 |
| `upload.badExtractIncompatible` | added (as `capture-bad-extract-incompatible`) | 3 |
| `upload.visionIncompatibleAdvice` | added (as `capture-vision-incompatible-advice`) | 3 |

Resulting `localeCompare` order of the touched web keys (verified with `localeCompare`): `upload.badExtractEmpty`, `upload.badExtractHttp`, `upload.badExtractIncompatible`, `upload.badExtractUnparseable`, … `upload.visionIncompatibleAdvice`, `upload.visionInUse`, `upload.visionOriginalError`, `upload.visionSetupAdvice`, `upload.visionSourceEnv`, …

The suggested Korean texts are used unchanged: they match the neighbouring advice line's tone (`…확인하세요.`, `…적용됩니다.`) and reuse its second sentence verbatim.

## Line order after this change (both channels)

| Event | Lines |
| --- | --- |
| `http` | main (`…did not accept the request.`), in-use, setup advice, original error |
| `incompatible` | main (`…not as an OpenAI-compatible API.`), in-use, incompatible advice, original error |
| `unparseable` | main with inline `— {detail}`, in-use (unchanged) |
| `empty` | main only (unchanged) |
| `outcome: 'rejected'` | the `empty` main line only (unchanged) |
| web `http` with detail `vision timed out` | the timeout line only (unchanged; Telegram passes no time limit, so it never sees this) |

Web tones: main `error`/depth 0; in-use, advice and original error `info`/depth 1; both advice lines carry `href: '#/settings'`; the original-error line has no href.

---

### Task 1: Mask the key instead of blanking the word

**Files:**
- Create: `packages/ingest/src/mask-key.ts`
- Create: `packages/ingest/test/mask-key.test.ts`
- Modify: `packages/ingest/src/extract.ts:67-90,106-112` (drop `KEY_RUN` and `redactKey`; `normalizeErrorText` calls `maskKey`)
- Modify: `packages/ingest/test/extract-http-error.test.ts:97-114` (expected strings) and append new extractor-level cases
- Modify: `apps/server/test/capture-route.test.ts:74`, `apps/server/test/capture-replies.test.ts:98`, `apps/server/test/http-captures.test.ts:175`
- Modify: `AGENTS.md` repo map line `ingest/src/ extract.ts prompt.ts` → `ingest/src/ extract.ts mask-key.ts prompt.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function maskKey(text: string, key: string): string` in `packages/ingest/src/mask-key.ts` (not exported from the package index; `extract.ts` imports it). `ExtractResult` is unchanged. Failure `detail` strings now carry the masked key; with the shared leak fixture (`LEAK_KEY = 'sk-LEAKCHECK-7f3a9c2e'`, `keyEchoFetch` in `apps/server/test/wire-capture-fakes.ts`) the detail is exactly `http 401: Incorrect API key provided: sk-L....9c2e; masked sk-LEA*********9c2e`. Telegram and web wording do not change in this task (the detail still sits inside `— {detail}.`).

**The masking algorithm (exact).** Input: `text` (untrusted, any length, already whitespace-collapsed) and `key`. Output: `text` with key characters replaced. Indices are UTF-16 code units (keys are ASCII in practice).

1. Let `L = key.length`. If `L <= 8`, return `text` unchanged (no middle; also covers `''` for a missing key).
2. A key index `i` is an *edge* index if `i < 4` or `i >= L - 4`; otherwise it is a *middle* index.
3. Build `windows: Map<string, number>` once per call: for every `k` in `0 … L-8`, let `w = key.slice(k, k + 8)` and `bits` = the 8-bit mask with bit `j` (0–7) set when `k + j` is a middle index; store `windows.get(w) | bits` (OR, so a window that occurs at several key positions keeps the union).
4. `masked = new Uint8Array(text.length)`. For every `t` in `0 … text.length-8`: `bits = windows.get(text.slice(t, t + 8))`; if defined, set `masked[t + j] = 1` for each set bit `j`.
5. Build the output left to right: an unmasked code unit is copied; each maximal stretch of consecutive masked code units becomes exactly `....` (four dots), whatever its length.

Consequences the tests pin: any run of ≥ 8 consecutive key characters is a union of matching 8-windows, so whole-key occurrences, partial runs, adjacent and overlapping runs are all handled by step 4, and touching masked stretches merge into one `....`. **Alignment rule:** when a text run matches the key at more than one position, a character is masked if *any* matching alignment puts it on a middle index; it stays only if every alignment puts it on an edge index (hides more, never less). For `L >= 9` every 8-window contains at least one middle index, so every matched 8-run is broken and the anti-goal holds. Cost is O(8·n) map lookups for a text of `n` code units plus O(8·L) setup, independent of how often a window repeats in the key. No regular expression is built from the key and none runs over the text inside `maskKey`.

**Interaction with the strip:** the strip runs after the mask, so a message that ends in a mask loses its dots (`… sk-LEAKCHECK` → `… sk-L`) and a message that is only a masked middle becomes empty (→ `http <status>`, or `network error` for a thrown message). Accepted: it shows less of the key, never more. Pinned below.

- [ ] **Step 1: Write the failing unit tests** in `packages/ingest/test/mask-key.test.ts` (import `maskKey` from `'../src/mask-key'`; `const K = 'sk-LEAKCHECK-7f3a9c2e'`):

```ts
test('the whole key keeps its first and last 4 around four dots', () => {
  expect(maskKey(K, K)).toBe('sk-L....9c2e')
})
test('in place, inside a word and next to punctuation', () => {
  expect(maskKey(`Bearer:${K}, rejected`, K)).toBe('Bearer:sk-L....9c2e, rejected')
  expect(maskKey(`xx${K}yy`, K)).toBe('xxsk-L....9c2eyy')
})
test('the key twice, apart and adjacent', () => {
  expect(maskKey(`${K} and ${K}`, K)).toBe('sk-L....9c2e and sk-L....9c2e')
  expect(maskKey(K + K, K)).toBe('sk-L....9c2esk-L....9c2e')
})
test('partial echoes of 8+ characters: prefix, suffix, middle, all but the last character', () => {
  expect(maskKey('key sk-LEAKCHECK rejected', K)).toBe('key sk-L.... rejected')
  expect(maskKey('key ending CHECK-7f3a9c2e rejected', K)).toBe('key ending ....9c2e rejected')
  expect(maskKey('id AKCHECK-7f here', K)).toBe('id .... here')
  expect(maskKey('sk-LEAKCHECK-7f3a9c2', K)).toBe('sk-L....9c2')
})
test('touching masked stretches become one set of four dots', () => {
  expect(maskKey('AKCHECK-7fEAKCHECK', K)).toBe('....')
})
test('a 7-character run and the service\'s own masked form are kept', () => {
  expect(maskKey('key ending 7f3a9c2 rejected', K)).toBe('key ending 7f3a9c2 rejected')
  expect(maskKey('masked sk-LEA*********9c2e', K)).toBe('masked sk-LEA*********9c2e')
})
test('a 9-character key has one middle character; 8 or fewer are never masked', () => {
  expect(maskKey('token abcdXefgh ok', 'abcdXefgh')).toBe('token abcd....efgh ok')
  expect(maskKey('token abcdefgh ok', 'abcdefgh')).toBe('token abcdefgh ok')
  expect(maskKey("model 'qwen2.5-vl:latest' not found", 'test')).toBe("model 'qwen2.5-vl:latest' not found")
  expect(maskKey('anything', '')).toBe('anything')
})
test('a word-like placeholder key dots an 8-character run of itself', () => {
  expect(maskKey('API key required', 'sk-no-key-required')).toBe('API key ....ired')
})
test('a run that aligns with the key at several positions is masked if any alignment is middle', () => {
  expect(maskKey('xx abababab yy', 'ab'.repeat(6))).toBe('xx .... yy')
})
```

- [ ] **Step 2: Update and extend the extractor tests** in `packages/ingest/test/extract-http-error.test.ts` (currently 114 lines; stays under 300):
  - Rename the test at line 97 to `'the whole key and 8+ character runs of it are masked; masked forms and short runs are kept'` and change its expectations: line 102 → `['http', 'http 401: bad key sk-L....9c2e']`; line 103 → `['http', 'http 401: key ending ....9c2e rejected']`; line 106 → `['http', 'refused for Bearer sk-L....9c2e']`; lines 101 and 104 unchanged.
  - Rename the test at line 108 to `'ordinary words sharing short runs with the key are kept; keys of 8 characters or fewer are never masked'`; line 112 → `.toEqual(['http', 'http 401: token abcde refused, abcd ok'])`; the other two expectations unchanged.
  - Append (with `const KEY = 'sk-LEAKCHECK-7f3a9c2e'` hoisted to module scope):

```ts
test('a mask at the end of the message loses its dots to the punctuation strip', async () => {
  const cfg = { ...CFG, apiKey: KEY }
  expect(await detailOf(failWith(401, 'unknown key sk-LEAKCHECK'), cfg)).toEqual(['http', 'http 401: unknown key sk-L'])
  expect(await detailOf(failWith(401, 'AKCHECK-7f'), cfg)).toEqual(['http', 'http 401'])
  expect(await detailOf(throwing('AKCHECK-7f'), cfg)).toEqual(['http', 'network error'])
})
test('the key is masked before the cap', async () => {
  expect(await detailOf(failWith(401, `${'a'.repeat(180)} ${KEY}`), { ...CFG, apiKey: KEY }))
    .toEqual(['http', `http 401: ${'a'.repeat(180)} sk-L....9c2e`])
})
test("OpenAI's masked project key loses its 8-character prefix run", async () => {
  expect(await detailOf(failWith(401, 'Incorrect API key provided: sk-proj-****3456'), { ...CFG, apiKey: 'sk-proj-abcdef123456' }))
    .toEqual(['http', 'http 401: Incorrect API key provided: sk-p....****3456'])
})
test('masking a long repetition of a key prefix is linear', async () => {
  const started = performance.now()
  expect(await detailOf(failWith(401, 'sk-LEAKCHECK'.repeat(40_000)), { ...CFG, apiKey: KEY }))
    .toEqual(['http', `http 401: ${'sk-L....'.repeat(24)}sk-L...…`])
  expect(performance.now() - started).toBeLessThan(1000)
})
test('masking with a key whose windows repeat is linear', async () => {
  const started = performance.now()
  expect(await detailOf(failWith(401, 'ab'.repeat(250_000)), { ...CFG, apiKey: 'ab'.repeat(32) })).toEqual(['http', 'http 401'])
  expect(performance.now() - started).toBeLessThan(1000)
})
```

(`throwing` is already defined at line 84 of the file; the appended tests come after it. Each expected string above was checked against a scratch implementation of the algorithm; both timing cases ran in under 20 ms.)

- [ ] **Step 3: Update the server leak expectations** (each test keeps its `keyParts(...)` assertions as they are):
  - `apps/server/test/capture-route.test.ts:74` → `detail: 'http 401: Incorrect API key provided: sk-L....9c2e; masked sk-LEA*********9c2e',`
  - `apps/server/test/capture-replies.test.ts:98` → `'The vision service did not accept the request — http 401: Incorrect API key provided: sk-L....9c2e; masked sk-LEA*********9c2e.',`
  - `apps/server/test/http-captures.test.ts:175` → `expect(event.detail).toBe('http 401: Incorrect API key provided: sk-L....9c2e; masked sk-LEA*********9c2e')`

- [ ] **Step 4: Run to verify failure**

Run: `bun test packages/ingest apps/server/test/capture-route.test.ts apps/server/test/capture-replies.test.ts apps/server/test/http-captures.test.ts`
Expected: FAIL — `mask-key.test.ts` cannot resolve `../src/mask-key`; the updated expectations still see `[redacted]`.

- [ ] **Step 5: Implement `maskKey(text: string, key: string): string`** in `packages/ingest/src/mask-key.ts` exactly as the algorithm above (constants `EDGE = 4`, `RUN = 8`; one comment line saying it is linear and builds no regex from the key). In `extract.ts` delete `KEY_RUN` and `redactKey`, import `maskKey`, and make `normalizeErrorText` call `stripTrailingPunctuation(maskKey(collapsed, apiKey))`; update its comment to "key masked before the cap".

- [ ] **Step 6: Run to verify pass, then the whole suite**

Run: `bun test packages/ingest apps/server/test/capture-route.test.ts apps/server/test/capture-replies.test.ts apps/server/test/http-captures.test.ts` → all pass.
Run: `bun run typecheck` → exit 0. Run: `bun test` → 0 fail. Run: `grep -rn '\[redacted\]' packages apps --include=*.ts` → no output.

- [ ] **Step 7: Commit**

```bash
git add packages/ingest apps/server/test/capture-route.test.ts apps/server/test/capture-replies.test.ts apps/server/test/http-captures.test.ts AGENTS.md
git commit -m "feat: mask the vision API key as its first and last 4 characters instead of [redacted]"
```

---

### Task 2: The original error on its own line

**Files:**
- Modify: `packages/telegram/src/i18n.ts:41` (text) and add `capture-vision-original-error` after `capture-vision-setup-advice`
- Modify: `apps/server/src/wire/capture-bad-extract-message.ts`
- Modify: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json` (`upload.badExtractHttp` text; add `upload.visionOriginalError` between `upload.visionInUse` and `upload.visionSetupAdvice`)
- Modify: `apps/web/src/uploadlines.ts`
- Test: `apps/server/test/capture-bad-extract-message.test.ts`, `apps/server/test/capture-replies.test.ts`, `apps/server/test/wire-capture-routing.test.ts:75-86`, `apps/web/src/uploadlines.test.ts:121-150`, `apps/web/src/uploadlines.ko.test.ts:15-19`, `apps/web/src/catalog.test.ts:105-124`

**Interfaces:**
- Consumes: the masked `detail` from Task 1 (format unchanged otherwise).
- Produces: Telegram key `capture-vision-original-error` (`{detail}`); module-private `originalError(detail: string, lang: Lang): string` in `capture-bad-extract-message.ts`, called exactly once in that file so Task 3 can reuse it. Web key `upload.visionOriginalError` (`{detail}`); module-private `originalErrorLine(detail: string, t: Translate): UploadLine` in `uploadlines.ts` returning `line('info', 1, …)` with no href. `BadExtractEvent` and `CaptureEventDto` are unchanged in this task.

- [ ] **Step 1: Update the Telegram tests**
  - `capture-bad-extract-message.test.ts`, `http` (en): `[ "The vision service did not accept the request.", 'In use: model qwen2.5-vl (Settings), URL http://lm:1234/v1 (env), key (not set).', ADVICE_EN, "Original error: http 404: The model 'x' is not loaded" ].join('\n')`; test name `'http: main line, in-use line, setup advice, original error'`.
  - Same file, `http` (ko): `[ '비전 서비스가 요청을 받아들이지 않았습니다.', '사용 중: 모델 qwen2.5-vl (설정), URL http://lm:1234/v1 (환경변수), 키 (API Key 없음).', ADVICE_KO, "원본 오류: http 404: The model 'x' is not loaded" ].join('\n')`. `unparseable` and `empty` expectations unchanged.
  - Brace test: `.split('\n')[3]` `.toBe('Original error: http 400: unknown field {model}')`.
  - `capture-replies.test.ts` `TEXT` → `['The vision service did not accept the request.', 'In use: model m (env), URL https://vision.example/v1 (env), key (env).', ADVICE_EN, 'Original error: http 500'].join('\n')`; Korean row → `['비전 서비스가 요청을 받아들이지 않았습니다.', '사용 중: 모델 m (환경변수), URL https://vision.example/v1 (환경변수), 키 (환경변수).', '스크린샷 문제가 아니라 비전 설정 문제입니다. 설정에서 바꾼 URL이나 모델은 서버를 다시 시작해야 적용됩니다.', '원본 오류: http 500'].join('\n')`.
  - Leak test (line 97-99) → `expect(sent[0]!.split('\n')[0]).toBe('The vision service did not accept the request.')` and `expect(sent[0]!.split('\n')[3]).toBe('Original error: http 401: Incorrect API key provided: sk-L....9c2e; masked sk-LEA*********9c2e')`; the `keyParts` assertions stay.
  - Source pin (line 125 area): keep `expect(msg.match(/t\('capture-bad-extract-/g)).toHaveLength(3)` and add `expect(msg.match(/t\('capture-vision-original-error'/g)).toHaveLength(1)`; all other pins unchanged.
  - `wire-capture-routing.test.ts:77-80` → `['The vision service did not accept the request.', 'In use: model vision-model (env), URL https://vision.example/v1 (env), key (env).', ADVICE_EN, 'Original error: http 500: boom'].join('\n')`; line 86 → `.toContain('Original error: http 500: boom')`.

- [ ] **Step 2: Update the web tests**
  - `uploadlines.test.ts` http test: first line text `'The vision service did not accept the request.'`; append `{ tone: 'info', depth: 1, text: "Original error: http 404: The model 'x' is not loaded", href: undefined }` after the advice line; rename to `'bad-extract http: error, the vision config in use, the setup advice linking to Settings, and the original error'`.
  - Brace test: `captureEventLines(…)[3]!.text` `.toBe('Original error: http 400: unknown field {model}')`.
  - Vision-timeout test unchanged (still exactly one line).
  - `uploadlines.ko.test.ts` http: `['비전 서비스가 요청을 받아들이지 않았습니다.', '사용 중: 모델 qwen2.5-vl (설정), URL http://lm:1234/v1 (환경변수), 키 (API Key 없음).', '스크린샷 문제가 아니라 비전 설정 문제입니다. 설정에서 바꾼 URL이나 모델은 서버를 다시 시작해야 적용됩니다.', '원본 오류: http 404: Not Found']`.
  - `catalog.test.ts` "values are inserted literally": `lookup('en', 'upload.visionOriginalError', { detail: \`a ${seq} b\` })` `.toBe(\`Original error: a ${seq} b\`)`; "inherited properties do not match": `lookup('en', 'upload.visionOriginalError', Object.create({ detail: 'x' }))` `.toContain('{detail}')`.

- [ ] **Step 3: Run to verify failure**

Run: `bun test apps/server/test/capture-bad-extract-message.test.ts apps/server/test/capture-replies.test.ts apps/server/test/wire-capture-routing.test.ts apps/web/src/uploadlines.test.ts apps/web/src/uploadlines.ko.test.ts apps/web/src/catalog.test.ts`
Expected: FAIL on the new line and the changed main line.

- [ ] **Step 4: Implement**
  - Catalogs: texts from the Copy table (Task 2 rows), in both channels and both languages.
  - `badExtractMessage` `http` case: `[t('capture-bad-extract-http', lang), visionInUse(…), t('capture-vision-setup-advice', lang), originalError(detail, lang)].join('\n')`; `originalError` calls `t('capture-vision-original-error', lang, { detail })`. Update the header comment to name the four lines.
  - `uploadlines.ts` http branch: `[line('error', 0, t('upload.badExtractHttp')), visionInUseLine(…), advice line (unchanged), originalErrorLine(event.detail, t)]`; the timeout check stays before it.

- [ ] **Step 5: Verify**

Run the Step 3 command → pass. `bun run typecheck` → exit 0. `bun test` → 0 fail. `wc -l apps/web/src/uploadlines.test.ts` → ≤ 300 (expected 267).

- [ ] **Step 6: Commit**

```bash
git add packages/telegram/src/i18n.ts apps/server/src/wire/capture-bad-extract-message.ts apps/server/test apps/web/src
git commit -m "feat: show the vision service's original error on its own line"
```

---

### Task 3: A fourth kind — not an OpenAI-compatible answer

**Files:**
- Modify: `packages/ingest/src/extract.ts:3,161,165`
- Modify: `apps/server/src/wire/capture-route.ts:16-18,83-87`
- Modify: `apps/server/src/wire/capture-bad-extract-message.ts`
- Modify: `packages/telegram/src/i18n.ts` (add `capture-bad-extract-incompatible` after `capture-bad-extract-http`, `capture-vision-incompatible-advice` after `capture-vision-setup-advice`)
- Modify: `apps/web/src/api.captures.types.ts:17`, `apps/web/src/uploadlines.ts`, `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ko.json`
- Test: `packages/ingest/test/extract.test.ts:204-209`, `apps/server/test/capture-route.test.ts`, `apps/server/test/capture-bad-extract-message.test.ts`, `apps/server/test/capture-replies.test.ts:125`, `apps/web/src/uploadlines.test.ts`, `apps/web/src/uploadlines.ko.test.ts`

**Interfaces:**
- Consumes: `originalError(detail, lang)` (Telegram) and `originalErrorLine(detail, t)` (web) from Task 2; keys `capture-vision-original-error` / `upload.visionOriginalError`.
- Produces:
  - `ExtractResult = { ok: true; fills: RawFill[] } | { ok: false; reason: 'http' | 'unparseable' | 'incompatible' | 'empty'; detail: string }`. `incompatible` is returned for a 200 answer whose body is not JSON (`detail: 'response body not json'`) or whose `choices[0].message.content` is not a string (`detail: 'no content'`). `no images`, `no json`, `json parse failed`, `missing fills` stay `unparseable`. The capture-row status stored by `ingestCapture` (`'unparseable'` for any failed extract) is unchanged.
  - `BadExtractEvent = { type: 'bad-extract'; reason: 'http' | 'unparseable' | 'incompatible'; detail: string; vision: VisionInUse } | { type: 'bad-extract'; reason: 'empty'; detail: string }`; `badExtract(reason: 'http' | 'unparseable' | 'incompatible' | 'empty', detail: string, vision: VisionInUse): BadExtractEvent`.
  - Web `CaptureEventDto` bad-extract variant: `reason: 'http' | 'unparseable' | 'incompatible'`.
  - Both channels handle `incompatible` in this task, so there is no commit in which it renders as anything else. (`badExtractMessage`'s `never` default makes the Telegram case a compile error until it is handled.)

- [ ] **Step 1: Write the failing tests**
  - `extract.test.ts:204` → test `'200 with non-JSON body -> incompatible, not a crash'`, `expect(r.reason).toBe('incompatible')` and `expect(r.detail).toBe('response body not json')` (inside `if (!r.ok)`); add `'200 without message content -> incompatible'`: fetch answers `{ ok: true, status: 200, json: async () => ({}) }` → `reason 'incompatible'`, `detail 'no content'`. Test `b) unparseable` (line 38) stays `unparseable`.
  - `capture-route.test.ts`, after the unparseable test: `'a 200 answer that is not an OpenAI reply is incompatible and names the config in use'` with a fetch answering `{ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } }` → `expect(r.events).toEqual([{ type: 'bad-extract', reason: 'incompatible', detail: 'response body not json', vision: IN_USE }])`.
  - `capture-bad-extract-message.test.ts`, en, event `{ type: 'bad-extract', reason: 'incompatible', detail: 'response body not json', vision: { ...VISION, keySource: 'env' } }`:
    ```
    The vision service answered, but not as an OpenAI-compatible API.
    In use: model qwen2.5-vl (Settings), URL http://lm:1234/v1 (env), key (env).
    Make sure the configured vision API is OpenAI-compatible. A URL or model changed in Settings applies after a server restart.
    Original error: response body not json
    ```
    and ko (in the Korean test, renamed `'Korean, all four events'`):
    ```
    비전 서비스가 응답했지만 OpenAI 호환 API 형식이 아닙니다.
    사용 중: 모델 qwen2.5-vl (설정), URL http://lm:1234/v1 (환경변수), 키 (환경변수).
    설정된 비전 API가 OpenAI 호환인지 확인하세요. 설정에서 바꾼 URL이나 모델은 서버를 다시 시작해야 적용됩니다.
    원본 오류: response body not json
    ```
  - `capture-replies.test.ts:125` → `expect(msg.match(/t\('capture-bad-extract-/g)).toHaveLength(4)`; `expect(msg.match(/t\('capture-vision-original-error'/g)).toHaveLength(1)` stays.
  - `uploadlines.test.ts`, new test `'bad-extract incompatible: error, config in use, compatibility advice linking to Settings, and the original error'`, same event as above:
    ```ts
    [
      { tone: 'error', depth: 0, text: 'The vision service answered, but not as an OpenAI-compatible API.', href: undefined },
      { tone: 'info', depth: 1, text: 'In use: model qwen2.5-vl (Settings), URL http://lm:1234/v1 (env), key (env).', href: undefined },
      { tone: 'info', depth: 1, text: 'Make sure the configured vision API is OpenAI-compatible. A URL or model changed in Settings applies after a server restart.', href: '#/settings' },
      { tone: 'info', depth: 1, text: 'Original error: response body not json', href: undefined },
    ]
    ```
  - `uploadlines.ko.test.ts`: the same event in Korean → the four Korean lines above, as an array.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/ingest apps/server/test/capture-route.test.ts apps/server/test/capture-bad-extract-message.test.ts apps/server/test/capture-replies.test.ts apps/web/src/uploadlines.test.ts apps/web/src/uploadlines.ko.test.ts`
Expected: FAIL (reason still `unparseable`; no wording for `incompatible`).

- [ ] **Step 3: Implement**
  - Extractor: widen `ExtractResult.reason`; lines 161 and 165 return `reason: 'incompatible'` with the same details.
  - `capture-route.ts`: widen `BadExtractEvent` and `badExtract` as in Interfaces; no other change (the emit lines pinned by `capture-replies.test.ts` keep their text).
  - Telegram: add the two catalog entries; `badExtractMessage` gains `case 'incompatible'`: `[t('capture-bad-extract-incompatible', lang), visionInUse(…), t('capture-vision-incompatible-advice', lang), originalError(detail, lang)].join('\n')`. Update the header comment ("setup-related kinds (http, incompatible)").
  - Web: widen the DTO; add the two keys in both catalogs at the positions listed in the Copy section; `badExtractLines` checks the timeout only when `event.reason === 'http'`, then renders `http` and `incompatible` through one path that picks main key `upload.badExtractHttp` / `upload.badExtractIncompatible` and advice key `upload.visionSetupAdvice` / `upload.visionIncompatibleAdvice` by reason, followed by `originalErrorLine`.

- [ ] **Step 4: Verify**

Run the Step 2 command → pass. `bun run typecheck` → exit 0. `bun test` → 0 fail. `wc -l apps/web/src/uploadlines.test.ts apps/server/src/wire/capture-bad-extract-message.ts apps/web/src/uploadlines.ts` → each ≤ 300 (expected about 280 / 55 / 120). If `uploadlines.test.ts` would pass 300, move the new incompatible test into a new `apps/web/src/uploadlines.incompatible.test.ts` instead.

- [ ] **Step 5: Commit**

```bash
git add packages/ingest packages/telegram/src/i18n.ts apps/server/src/wire apps/server/test apps/web/src
git commit -m "feat: report a vision answer that is not OpenAI-compatible as its own kind"
```

---

### Task 4: README, follow-ups, full verification

**Files:**
- Modify: `README.md` (line 159 "one of three messages" → "one of four messages"; section `### Reading a failed capture`, currently lines 179–197)
- Modify: `docs/superpowers/followups/2026-11-24-capture-error-messages-followups.md`

**Interfaces:**
- Consumes: the behaviour of Tasks 1–3. Produces: nothing for code.

- [ ] **Step 1: Update the README.** At line 159 change "answered with one of three messages" to "answered with one of four messages". Replace the section (from the `### Reading a failed capture` heading up to, not including, `## Schedules`) with exactly:

```markdown
### Reading a failed capture

Telegram and the web word a failed capture the same way. The two setup-related messages name the
model, URL and key source the server is running with (the "In use" line, each marked `Settings` or
`env`, `not set` for a missing key) and end with an "Original error" line: the vision service's own
answer, or the connection error, on one line, at most 200 characters, never translated. A URL or
model changed in Settings applies only after a server restart; the key is re-read on every capture.

- **"The vision service did not accept the request."** The service refused the request or could not
  be reached. The original error says why — for example a model name it does not serve, a rejected
  key, or a rate limit.
- **"The vision service answered, but not as an OpenAI-compatible API."** Something answered at the
  configured URL, but not with an OpenAI chat-completions reply (original error
  `response body not json` or `no content`) — typically a base URL that points at a web page or at a
  different kind of API. Make sure the configured vision API is OpenAI-compatible.
- **"The vision model answered, but not in a form the tracker understands — …"**: try again; if it
  keeps happening, the model in use is probably not suited to reading screenshots.
- **"No fills were found in this image."**: the screenshot does not show the fills list; book the
  fill manually.

The API key is never shown in full. Where the service's answer echoes it, it appears as its first 4
and last 4 characters around four dots — `sk-LEAKCHECK-7f3a9c2e` reads `sk-L....9c2e`, and the dots
are always four, whatever the key's length. A partial echo of 8 or more consecutive characters of the
key is masked the same way: the characters from the key's middle become four dots. At the very end of
the line those dots are trimmed with the sentence punctuation. A key of 8 characters or fewer has no
middle and is never masked, so placeholder keys such as `test`, `local` or `ollama` change nothing.
With a longer word-like placeholder key, an ordinary word that is 8 characters of it is partly dotted:
under the key `sk-no-key-required` the word `required` reads `....ired`. For a vision server that
needs no key, leave the key unset.
```

- [ ] **Step 2: Update the follow-ups file**
  - Intro paragraph: "which of three things went wrong" → "which of four things went wrong"; "with the API key redacted" → "with the API key masked".
  - Delete the whole `## Decisions for the operator` section (all three items; decided and built by the Amendment).
  - Replace the `sk-proj-` item with: "**OpenAI's masked project key is partly dotted.** `sk-proj-` is 8 characters of an `sk-proj-…` key, so `sk-proj-****abcd` in a 401 answer shows as `sk-p....****abcd`."
  - Reword the vision-timeout item's last clause to: "if it ever does, the reply would be the `did not accept the request` message with setup advice and `Original error: vision timed out`."
  - Add under "Behaviour an operator could notice": "**A newer server with an older web bundle.** A cached tab that predates `incompatible` renders it through its `http` branch (\"did not accept the request — response body not json.\" with setup advice)."
  - Delete the test-gap item "No test pins 'redact before cap'…" (Task 1 pins mask-before-cap) and the item "Trailing punctuation separated by a space survives the strip…" (the detail of `http` and `incompatible` no longer sits inside a sentence; `unparseable` details are fixed strings). Keep every other item.

- [ ] **Step 3: Check the docs**

Run: `grep -n 'redacted' README.md docs/superpowers/followups/2026-11-24-capture-error-messages-followups.md` → no output.

- [ ] **Step 4: Full verification** (MariaDB test container on 127.0.0.1:3307 is up)

Run: `bun run typecheck` → exit 0.
Run: `bun test` → summary `… pass / 87 skip / 0 fail` (pass count above the 2029 baseline by the tests added in Tasks 1–3).
Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun test` → `0 fail` (baseline 2100 pass).
Run: `TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts` (from the repo root) → `e2e OK — 175 assertions passed` (the e2e steps exercise no vision failure, so the count is unchanged).
Report the three summary lines in the task report.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/followups/2026-11-24-capture-error-messages-followups.md
git commit -m "docs: README and follow-ups for the capture error messages amendment"
```
