# Cancel-reason capture — design

Date: 2026-11-11. Approved by operator in chat.

## Problem

`orders.status` can be `cancelled`, but nothing in the app can cancel an order, and
there is nowhere to record *why* a limit order was pulled. The operator wants every
cancellation to carry a reason, captured at the moment of cancelling, visible in the
web UI and announced in Telegram.

## Decisions (operator-approved)

1. **Reasons are a fixed dropdown of 4 codes**, not free text:
   `broker-filled` (filled elsewhere at broker / 증권사에서 별도 체결),
   `strategy-change` (strategy change / 전략 변경),
   `stale-price` (price no longer valid / 가격 무효화),
   `other` (other / 기타).
   All copy in the en/ko catalogs (web i18n JSON + telegram i18n CATALOG).
2. **Cancel entry point is the web**: each `open` order row in `OrderTable` gets a
   Cancel button → modal with reason `<Select>` → confirm. No Telegram-side cancelling
   (that stays out of scope).
3. **Telegram behavior = push notification**: after a successful web cancel, send
   `order-cancelled` text to every allowed chat (same `send` used by digests) and
   record one `notifications` row per chat (mirrors `pipeline/day.ts`).
4. **Persistence**: new nullable `orders.cancel_reason varchar(32)` column (drizzle
   migration). Reasons stored as the kebab-case code.
5. **Domain rule** (`cancelOrder` in `domain/booking.ts`): only an `open` order of the
   given run can be cancelled; invalid reason / unknown order / non-open are rejected
   with distinct errors. HTTP maps: `invalid-reason`→400, `order-not-found`→404,
   `order-not-open`→409.
6. **HTTP**: `POST /api/runs/:id/orders/:orderId/cancel` body `{ reason }` (session
   auth, like every other run route).
7. **Display**: the existing reason column of `OrderTable` shows the translated
   cancel reason on `cancelled` rows (skip reason unchanged on others). Old cancelled
   rows with `cancelReason = null` render like today (empty).

## Out of scope

Telegram inline-keyboard cancelling, free-text reasons, bulk cancel, un-cancel.
