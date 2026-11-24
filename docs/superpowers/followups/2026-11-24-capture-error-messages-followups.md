# Capture error messages — deferred follow-ups

Date: 2026-11-24
Branch: `feat/capture-error-messages` (`5548820..` HEAD)
Spec: `docs/superpowers/specs/2026-11-24-capture-error-messages-design.md`
Plan: `docs/superpowers/plans/2026-11-24-capture-error-messages.md`

The branch makes a failed capture say which of three things went wrong, carries
the vision service's own error text with the API key redacted, and names the
vision model, URL and key source in use. The whole-branch review found no
Critical issue and no path that leaks the key; its one Important finding was
documented and seven smaller ones were fixed on the branch. What follows is
what the reviews found and the branch deliberately left.

## Decisions for the operator

- **Redaction and placeholder keys.** Any word containing the key, or 8
  consecutive characters of it, becomes `[redacted]`. With a word-like key
  (`test`, `local`, `sk-no-key-required`, `lm-studio`) that also hides ordinary
  words: key `test` turns `model 'qwen2.5-vl:latest' not found` into
  `model [redacted] not found`. The README documents it. Alternatives: redact
  only the whole key, or only keys above some length.
- **The advice line is attached to every refused request.** "This is a vision
  setup problem, not the screenshot" overstates it for a rate limit (429), a
  transient 5xx, or an image the service found too large (400/413). The first
  line carries the service's own text, so the cause is still readable.
- **A web page answered with 200 reads as "the vision model answered".** A wrong
  base URL that returns an HTML page with status 200 is classified `unparseable`
  (`response body not json`, `no content`): it gets the in-use line but no setup
  advice. Those two cases are closer to setup than to the model.

## Behaviour an operator could notice

- **OpenAI's masked project key is redacted too.** `sk-proj-` is exactly 8
  characters, so `sk-proj-****abcd` in a 401 answer shows as `[redacted]`.
- **Telegram has no wording for a vision timeout.** Unreachable today, because
  the bot passes no time limit; if it ever does, the reply would be "did not
  accept the request" with setup advice.
- **An older server with a newer web bundle.** `uploadlines.ts` reads
  `event.vision` without a guard, so a cached tab against a rolled-back server
  would fail to render an `http` failure line.

## Test gaps and polish

- No test pins "redact before cap" as an order; either order holds the rule,
  because a cut fragment of 8 or more key characters is still redacted. The
  thrown-error branch relies on sharing `normalizeErrorText` with the HTTP branch.
- Trailing punctuation separated by a space survives the strip: a body of
  `what? .` gives `http 404: what?`, which the sentence then ends with `?.`.
- A thrown value that is not an `Error` and is `undefined` gives the detail
  `undefined` (`String(e?.message ?? e)` in `extract.ts`).
- `ADVICE_EN` is defined in three server test files.
- `describe` and test names in `apps/server/test/capture-replies.test.ts` still
  quote "could not read fills".
- `packages/ingest/test/extract-http-error.test.ts` mixes semicolon styles.
- The 200-code-point cap copies the whole message into an array to count it.
- The upload popup's long-text wrapping (`min-w-0 break-words`) is asserted by
  class name only; it has not been looked at in a browser.
- No catalog key uses the same placeholder twice, so the single-pass `lookup`
  has no test for a repeated placeholder.
