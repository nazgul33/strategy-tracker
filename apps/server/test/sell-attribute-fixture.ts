// Shared setup for the pure sell-attribution tests: buckets and orders are built directly, no repos or booking.
import { expect } from 'bun:test'
import { applyBuyFill, DomainError, emptyState, type RunState } from '@st/core'
import { parseUsd } from '@st/core/money'
import type { OrderEvidence, SellOrderType } from '../src/domain/order-type'
import type { SellInput } from '../src/domain/sell-attribute'
import type { OrderRow, SellPick } from '../src/domain/sell-match'

export const D = '2026-11-12', Y = '2026-11-11'

// 10 buckets; each B bought at 100.00 on boughtOn (default '2026-11-01'); forced sets bucket.state = 'force_sell'
export function stateOf(bs: Array<{ idx: number; shares: number; boughtOn?: string; forced?: boolean }>): RunState {
  let s = emptyState(10)
  for (const b of bs) {
    s = applyBuyFill(s, b.idx, b.shares, parseUsd('100.00'), 0, b.boughtOn ?? '2026-11-01')
    if (b.forced) s.buckets[b.idx]!.state = 'force_sell'
  }
  return s
}

// Order ids run 1, 2, 3... in call order; call resetOrderIds from beforeEach so every test starts at 1.
let nextId = 1
export const resetOrderIds = (): void => { nextId = 1 }
export function ord(idx: number, kind: 'sell_loc' | 'stop_sell' | 'market_sell', price: string | null, shares: number, over: Partial<OrderRow> = {}): OrderRow {
  return { id: nextId++, runId: 1, tradeDate: D, kind, bucketIdx: idx, limitPrice: price === null ? 0n : parseUsd(price), shares, status: 'open', ...over }
}
export const ev = (type: SellOrderType, orderPrice?: string, orderedShares?: number): OrderEvidence =>
  ({ type, orderPrice: orderPrice === undefined ? null : parseUsd(orderPrice), orderedShares: orderedShares ?? null })
export const sell = (shares: number, price: string, evidence?: OrderEvidence, bucketIdx?: number): SellInput =>
  ({ runId: 1, filledOn: D, shares, price: parseUsd(price), evidence, bucketIdx })
export const throwsKind = (fn: () => unknown, kind: string): void => {
  try { fn() } catch (e) { expect(e).toBeInstanceOf(DomainError); expect((e as DomainError).kind).toBe(kind); return }
  throw new Error(`expected DomainError(${kind}), nothing thrown`)
}
export const alts = (p: SellPick): number[] => p.attribution!.alternatives.map((a) => a.orderId)
