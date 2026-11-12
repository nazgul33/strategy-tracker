# Auto-calculate fill fee from configured cost

Date: 2026-11-12
Status: approved (2026-11-12)

## Intent

On the Run detail → "Add fill" tab, when the operator enters Price (and Shares),
the Fee field should be filled automatically using the run's configured cost
(`run.costPpm`), so the common case requires no fee typing.

## Goals

- Fee prefills from `feeCents(price, shares, costPpm)` as soon as price + shares are valid.
- Recompute whenever price or shares change (fee depends on both, not price alone).
- The value shown in the form is exactly the value sent to the server.

## Non-goals

- No server-side changes — `booking.ts` already computes the fee when the client
  omits it, and accepts a declared fee verbatim.
- No changes to pending-fill editing, screenshot capture, or the Sim run forms.
- No new global cost setting (cost stays per-run, `strategyRuns.costPpm`).

## Anti-goals

- Client math that disagrees with the server by even a cent.
- Overwriting a fee the operator deliberately typed.

## Approach considered

1. **Prefill the Fee input, editable** — chosen (operator picked). What you see is
   what gets sent; manual override is just typing in the field.
2. Preview hint under an empty field — keeps the server authoritative, but the
   operator never sees the actual submitted number in the field.
3. Read-only field + "Override" toggle — clearest intent, most new UI; more than
   the job needs.

## Design

- `RunDetail.tsx` passes `costPpm={run.costPpm}` into `ManualCaptureForm`.
- In `ManualCaptureForm`: on price/shares change, if both parse as valid inputs
  (price via the existing `usdOrNull` rule, shares a positive integer), set the
  fee input to `feeCents(parseUsd(price), shares, costPpm)` rendered as USD text
  (e.g. `1.02`). Uses `feeCents` + `parseUsd` from `@st/core/money` — the same
  half-up rounding the server uses, so client and server agree exactly.
- Manual override: a keystroke in the Fee field marks it user-owned; auto-prefill
  then stops overwriting it. Clearing the Fee field (empty string) returns it to
  auto mode. Programmatic prefills never set the user-owned flag.
- If price or shares become invalid/empty while the fee is still in auto mode,
  the prefilled fee is cleared (no stale numbers); a user-owned fee is left alone.
- Submission path is unchanged: a prefilled or typed fee is sent as `fee`; an
  empty fee is omitted and the server computes it from `costPpm`.
- No new i18n copy needed (no new visible labels).

## Tests

Extend `apps/web/src/components/forms/ManualCaptureForm.test.tsx`:
- Valid price + shares → Fee input shows the `feeCents` result (e.g. 340.23 × 100 @ 30 ppm → `0.10`).
- Editing price afterwards updates an auto fee.
- Typing a fee, then editing price → typed fee survives.
- Clearing the fee, then editing price → prefills again.
- Submit body: prefilled fee is sent as declared `fee`; cleared fee is omitted.
