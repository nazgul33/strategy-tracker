# Capture error messages

Branch: `feat/capture-error-messages`. A small change; approved by the operator in conversation.

## Intent

A failed capture says "Could not read fills from this image — http 404" on Telegram and on the web, whatever went wrong, and the web adds "upload a clearer screenshot". On 2026-11-24 the cause was a stale vision model name saved in Settings, and the message gave no way to tell a vision setup problem from a bad screenshot. The operator wants the message to say which it is, to carry the vision service's own explanation, and to name where each vision setting in use came from: Settings or env.

## Goals

- The vision service's own error text reaches the operator.
- Three kinds of failure get three messages, on Telegram and on the web, in English and Korean.
- A setup-related message names the vision model, URL and key in use, each with its source.

## Non-goals

- Changing how Settings override env, or re-reading the URL or model without a restart.
- Retries.
- The web's "vision took too long" message and the 503 `vision-not-configured` answer.
- A System notice for a web upload (unchanged: Telegram replies are recorded, web results are not).

## Anti-goal

- The API key itself, or any run of 8 or more of its characters, appearing in a message, an event, a log line or a notice. Only its source is reported.

## Approaches

1. **The event carries the failure kind and the config in use; each channel words it (chosen).** The extractor already classifies a failure as `http`, `unparseable` or `empty`; today that is dropped before the message is written. Carrying it on the `bad-extract` event lets Telegram and the web pick their own wording from one source of truth.
2. Build the finished sentence on the server and pass it as `detail`. Rejected: the web words results from its own en/ko catalogs in the operator's chosen language, while the server knows only the bot's language.
3. Leave one message and only append the service's text. Rejected: "upload a clearer screenshot" stays wrong for a setup problem, which is the complaint.

## Design

### Vision error text — `packages/ingest/src/extract.ts`

On a non-OK answer the extractor reads the response body and puts the service's message in `detail`: `http 404: The model 'x' is not loaded; currently serving 'y'`.

- The message is `error.message` when the body is JSON of the OpenAI error shape, a top-level string `error`, `message` or `detail` (the FastAPI shape) when it is that, and otherwise the body text. Whitespace is collapsed and the message is capped at 200 characters, with an ellipsis when cut.
- Trailing sentence punctuation (`.`, `?`, `!`) is trimmed from the message, so the sentence it is placed in does not end in ".." or "?.".
- An empty or unreadable body leaves `detail` as `http <status>`, as today.
- A network failure uses the thrown message, put through the same collapsing, redaction, trimming and cap *(changed after the final review: Bun's connection-refused message ends in a question mark, and an unbounded thrown message broke "one line, bounded")*. A thrown message that is empty after that reads `network error`.
- **The key is redacted from every failure `detail`** (found while planning: services echo the key in a 401 answer, some of them whole). Any word that contains the whole key, or a run of 8 or more consecutive characters of it, is replaced by `[redacted]`. A key shorter than 8 characters is matched whole, and one shorter than 4 is not redacted at all. *(My call on the threshold: a service's own masked form, such as `sk-…abcd`, shows a few real characters on purpose and is left as sent. Matching runs as short as 4 would also blank ordinary words that happen to share letters with the key, such as "project" for an `sk-proj-…` key, and those words are what this change exists to show.)*
  - **Known limits of this rule** (final review): `sk-proj-` is exactly 8 characters, so OpenAI's masked form of a project key is redacted as well. With a word-like placeholder key, as local servers are often run with (`test`, `local`, `sk-no-key-required`, `lm-studio`), the rule also hides ordinary words that contain the key or an 8-character run of it, such as a model name containing "test". The README says so and advises leaving the key unset for a keyless server. Whether to change the rule is the operator's call.

### The event — `apps/server/src/wire/capture-route.ts`

`bad-extract` gains the kind and, for the two setup-related kinds, the config in use:

```ts
type VisionSource = 'settings' | 'env'
interface VisionInUse {
  model: string; modelSource: VisionSource
  baseUrl: string; baseUrlSource: VisionSource
  keySource: VisionSource | 'none'   // 'none': no key set anywhere
}
{ type: 'bad-extract'; reason: 'http' | 'unparseable' | 'empty'; detail: string; vision?: VisionInUse }
```

- `reason` is the extractor's own. The core's "no fills recognized" (no ticker group) is `empty`. A `rejected` outcome is worded as `empty` by both channels.
- `vision` is present when `reason` is `http` or `unparseable`, and absent for `empty`.
- The vision timeout stays `reason: 'http'` with `detail: VISION_TIMEOUT_DETAIL`.
- `CaptureRouteDeps.vision` gains the two sources, and `getVisionApiKey()` returns the key with its source. `apps/server/src/main.ts` knows both: it already resolves `settings.x || env.x` at boot for the URL and model, and per capture for the key. The values reported are the ones the server is running with, not what the Settings page shows now.

### Wording

| Kind | English |
| --- | --- |
| `http` | The vision service did not accept the request — {detail}. |
| `unparseable` | The vision model answered, but not in a form the tracker understands — {detail}. Try again; if it keeps happening, check the vision model. |
| `empty` | No fills were found in this image. Check that it shows the fills list, or book the fill manually. |
| in-use line (`http`, `unparseable`) | In use: model {model} ({modelSource}), URL {baseUrl} ({baseUrlSource}), key ({keySource}). |
| advice line (`http`) | This is a vision setup problem, not the screenshot. A URL or model changed in Settings applies after a server restart. |

Source words: `Settings`, `env`, and `not set` for a missing key.

- **Telegram** (`packages/telegram/src/i18n.ts`, `apps/server/src/wire/capture.ts`): one reply per failure, the lines joined with newlines, still sent and recorded through the one recording helper with notice kind `capture-bad-extract`. The old `capture-bad-extract` text is replaced; tests that pin it change on purpose.
- **Web** (`apps/web/src/uploadlines.ts`, catalogs, `api.captures.types.ts`): the main line as an error line, the in-use and advice lines beneath it; the advice line links to `#/settings`. `upload.badExtract` is replaced. The timeout line is unchanged and gets no in-use line.

## Constraints

- Conventions from `AGENTS.md`: files under ~300 lines, all copy in en/ko catalogs, injectable `fetch`, `packages/*` never import `apps/*`.
- Tests: the extractor for each body shape and the cap; the core for the kind and the in-use config on each branch, and that no key value is in any event; Telegram and web wording for each kind in both languages' catalogs; the existing source pin in `capture-replies.test.ts` still proves every "could not read" reply goes through the one recording helper.
- `bun run typecheck`, `bun test`, the DB suite and `scripts/e2e.ts` pass.
- `README.md` gains a short troubleshooting note on reading these messages.

## Left to the builder

- Catalog key names and the Korean wording, kept close to the existing texts.
- Whether the in-use and advice lines are separate catalog keys or composed in code.
- How the key's source is threaded (the shape of `getVisionApiKey`'s return), as long as the key value never leaves the vision request.
