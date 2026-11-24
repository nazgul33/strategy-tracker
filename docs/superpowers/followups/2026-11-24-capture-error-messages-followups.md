# Capture error messages — deferred follow-ups

Date: 2026-11-24
Branch: `feat/capture-error-messages` (`5548820..` HEAD)
Spec: `docs/superpowers/specs/2026-11-24-capture-error-messages-design.md`
Plan: `docs/superpowers/plans/2026-11-24-capture-error-messages.md`

The branch makes a failed capture say which of four things went wrong, carries
the vision service's own error text with the API key masked, and names the
vision model, URL and key source in use. The whole-branch review found no
Critical issue and no path that leaks the key; its one Important finding was
documented and seven smaller ones were fixed on the branch. What follows is
what the reviews found and the branch deliberately left.

## Behaviour an operator could notice

- **OpenAI's masked project key is partly dotted.** `sk-proj-` is 8 characters
  of an `sk-proj-…` key, so `sk-proj-****abcd` in a 401 answer shows as
  `sk-p....****abcd`.
- **Telegram has no wording for a vision timeout.** Unreachable today, because
  the bot passes no time limit; if it ever does, the reply would be the `did not
  accept the request` message with setup advice and
  `Original error: vision timed out`.
- **An older server with a newer web bundle.** `uploadlines.ts` reads
  `event.vision` without a guard, so a cached tab against a rolled-back server
  would fail to render an `http` failure line.
- **A newer server with an older web bundle.** A cached tab that predates
  `incompatible` renders it through its `http` branch ("did not accept the
  request — response body not json." with setup advice).

## Test gaps and polish

- A thrown value that is `undefined` or `null` gives the detail text
  `undefined` or `null`, and one that cannot be converted to a string would
  throw inside the extractor (`transportFailure` in `extract.ts`).
- `ADVICE_EN` is defined in three server test files.
- `describe` and test names in `apps/server/test/capture-replies.test.ts` still
  quote "could not read fills".
- `packages/ingest/test/extract-http-error.test.ts` mixes semicolon styles.
- The 200-code-point cap copies the whole message into an array to count it.
- The upload popup's long-text wrapping (`min-w-0 break-words`) is asserted by
  class name only; it has not been looked at in a browser.
- No catalog key uses the same placeholder twice, so the single-pass `lookup`
  has no test for a repeated placeholder.
- A key that contains a character outside the Basic Multilingual Plane can
  leave half of that character behind after masking (the mask works on UTF-16
  units; real keys are ASCII).
- A 200 answer that carries an `error` object is `incompatible` with the
  original error `no content`; the service's own message is not shown.
- An array-valued `message` in a 200 reply is treated as a message object and
  reads as `unparseable`; no test pins it either way.
- Telegram has no test for `$` sequences on the original-error line (its
  formatter inserts values literally; the web side is pinned).
- Four tests in `packages/ingest/test/extract-http-error.test.ts` assert a
  1000 ms wall-clock bound (two on the trailing-punctuation strip, two on
  masking); they catch only a severe regression.
