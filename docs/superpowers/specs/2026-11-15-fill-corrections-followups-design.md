# Fill corrections — follow-ups (short design)

Date: 2026-11-15 · Size: small change · Status: approved in conversation
Parent: `2026-11-15-fill-corrections-design.md` (same branch, `feat/fill-corrections`, before merge)

## Intent

Close the review leftovers of the fill-corrections branch before it merges. Out of
scope: issues #22, #23, #24.

## Behaviour and layout (operator-approved calls)

1. **Missing cited fill during capture.** When a conflict cites a booked fill that is
   gone by the time corrections are recorded (only reachable through the unlocked
   DELETE race, issue #22), the conflict carries a marker and Telegram sends a new
   line `capture-conflict-gone` instead of "Correction listed in Pending":
   en `⚠️ {side} {shares} {ticker} on {date} — extracted ${extracted}, but booked fill #{id} no longer exists. Nothing to correct.`
   ko `⚠️ {date} {ticker} {side} {shares}주 — 추출 가격 ${extracted}, 예약된 체결 #{id}이(가) 더 이상 없습니다. 수정할 항목이 없습니다.`
2. **Readable Apply errors.** `CorrectionList` maps a 422 domain error code through the
   same `fillErr.*` catalog the fill dialog uses (falling back to the raw code only if
   no key exists).
3. **Pending page layout.** Page `<h1>` becomes "Pending" / "확인 대기" (existing nav
   label wording); two titled sections: "Corrections (from screenshots)" (existing
   `correctionsTitle`) and "Unconfirmed fills" / "미확인 체결" (existing
   `pendingTitle` value) as the second section's heading.
4. **Unchanged by decision:** a second, different screenshot reusing an open correction
   is not kept "live" (re-send re-reads and repeats the conflict line) — permitted by
   the parent spec; not worth extra tracking.

## Clean-ups (no behaviour change)

- Shared fake correction repo returns copies and normalizes `captureId`/`proposedFee`
  to `null` like MariaDB; a non-DB parity test runs the db.test repo scenario against
  the fake.
- With copies, the concurrent-apply test genuinely proves the in-lock re-read.
- Test tightening: over-qty sell refusal asserts it is the replay error (not
  `immutable-field`); HTTP sell-edit asserts the adjust row and `deltaCents`; HTTP 422
  branch on apply covered; "fresh open beats fresh dismissed" covered; IMG_2109 DB test
  asserts the neighbouring fills are untouched, the re-sent pending row's side, and the
  found sell is defined.
- Move correction endpoint tests out of `http.test.ts` into
  `apps/server/test/http-corrections.test.ts` (sharing existing helpers via export).
- RunDetail: no double list load after an action (drop the remount key on
  `CorrectionList` or the internal reload when `onChanged` is supplied — builder's
  call, must still refresh).
- `bookingDeps` in correction routes typed without `as any` (if the sibling routes'
  type allows; otherwise keep and note).
- Rewrap `capture-claim.ts` comment and the unwrapped spec line; even out the
  destructuring in `ingestCapture`.

## Constraints

Same as the parent spec: bigint myriadths / integer cents, ≤ ~300-line source files,
en/ko catalogs, no migrations, prod DB never touched.
