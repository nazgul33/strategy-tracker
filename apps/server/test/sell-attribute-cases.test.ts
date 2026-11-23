import { beforeEach, describe, expect, test } from 'bun:test'
import { applyBuyFill, DomainError, emptyState, type RunState } from '@st/core'
import { parseUsd } from '@st/core/money'
import type { OrderEvidence, SellOrderType } from '../src/domain/order-type'
import { attributeSell, type SellInput } from '../src/domain/sell-attribute'
import type { OrderRow, SellPick } from '../src/domain/sell-match'

const D = '2026-11-12', Y = '2026-11-11'

function stateOf(bs: Array<{ idx: number; shares: number; boughtOn?: string; forced?: boolean }>): RunState {
  let s = emptyState(10)
  for (const b of bs) {
    s = applyBuyFill(s, b.idx, b.shares, parseUsd('100.00'), 0, b.boughtOn ?? '2026-11-01')
    if (b.forced) s.buckets[b.idx]!.state = 'force_sell'
  }
  return s
}
let nextId = 1
beforeEach(() => { nextId = 1 })
function ord(idx: number, kind: 'sell_loc' | 'stop_sell' | 'market_sell', price: string | null, shares: number, over: Partial<OrderRow> = {}): OrderRow {
  return { id: nextId++, runId: 1, tradeDate: D, kind, bucketIdx: idx, limitPrice: price === null ? 0n : parseUsd(price), shares, status: 'open', ...over }
}
const ev = (type: SellOrderType, orderPrice?: string, orderedShares?: number): OrderEvidence =>
  ({ type, orderPrice: orderPrice === undefined ? null : parseUsd(orderPrice), orderedShares: orderedShares ?? null })
const sell = (shares: number, price: string, evidence?: OrderEvidence, bucketIdx?: number): SellInput =>
  ({ runId: 1, filledOn: D, shares, price: parseUsd(price), evidence, bucketIdx })
const throwsKind = (fn: () => unknown, kind: string): void => {
  try { fn() } catch (e) { expect(e).toBeInstanceOf(DomainError); expect((e as DomainError).kind).toBe(kind); return }
  throw new Error(`expected DomainError(${kind}), nothing thrown`)
}
const alts = (p: SellPick): number[] => p.attribution!.alternatives.map((a) => a.orderId)

const T = 'sell_loc', S = 'stop_sell'
const two = (a = 10, b = 10): RunState => stateOf([{ idx: 0, shares: a }, { idx: 1, shares: b }])
const targets = (): OrderRow[] => [ord(0, T, '60.00', 10), ord(1, T, '62.00', 10)]
const stops = (): OrderRow[] => [ord(0, S, '97.00', 10), ord(1, S, '99.00', 10)]

describe('attributeSell: the steps of case B', () => {
  test('20: step 1 keeps the target nearest the order price, and says so when the distance is not 0', () => {
    const orders = targets()
    const pick = attributeSell(orders, two(), sell(10, '63.00', ev('target', '61.80')))
    expect([pick.bucketIdx, pick.orderId]).toEqual([1, orders[1]!.id])
    expect(pick.attribution).toMatchObject({ rule: 'order-price' })
    expect(alts(pick)).toEqual([orders[0]!.id])
  })

  test('21: distance 0 on two buckets is not quiet and the shares decide', () => {
    const orders = [ord(0, T, '60.00', 10), ord(1, T, '60.00', 12)]
    const pick = attributeSell(orders, two(10, 12), sell(10, '63.00', ev('target', '60.00')))
    expect([pick.bucketIdx, pick.orderId]).toEqual([0, orders[0]!.id])
    expect(pick.attribution).toMatchObject({ rule: 'shares' })
    expect(alts(pick)).toEqual([orders[1]!.id])
  })

  test('22: an order price of 0 skips step 1 and the fill price decides', () => {
    const orders = targets()
    const pick = attributeSell(orders, two(), sell(10, '63.00', ev('target', '0.0000')))
    expect([pick.bucketIdx, pick.orderId]).toEqual([1, orders[1]!.id])
    expect(pick.attribution).toMatchObject({ rule: 'price' })
  })

  test('23: a stop never uses step 1; the fill price picks the nearest trigger', () => {
    const orders = stops()
    const pick = attributeSell(orders, two(), sell(10, '96.50', ev('stop')))
    expect([pick.bucketIdx, pick.orderId]).toEqual([0, orders[0]!.id])
    expect(pick.attribution).toMatchObject({ rule: 'price' })
    expect(alts(pick)).toEqual([orders[1]!.id])
  })

  test('24: ordered shares that match no candidate skip step 2', () => {
    const orders = stops()
    const pick = attributeSell(orders, two(), sell(10, '96.50', ev('stop', undefined, 7)))
    expect([pick.bucketIdx, pick.orderId]).toEqual([0, orders[0]!.id])
    expect(pick.attribution).toMatchObject({ rule: 'price' })
  })

  test('25: on a tie the bucket bought earlier is the older one', () => {
    const orders = [ord(0, S, '97.00', 10), ord(1, S, '97.00', 10)]
    const state = stateOf([{ idx: 0, shares: 10, boughtOn: '2026-11-03' }, { idx: 1, shares: 10, boughtOn: '2026-11-01' }])
    const pick = attributeSell(orders, state, sell(10, '96.50', ev('stop')))
    expect([pick.bucketIdx, pick.orderId]).toEqual([1, orders[1]!.id])
    expect(pick.attribution).toMatchObject({ rule: 'older' })
    expect(alts(pick)).toEqual([orders[0]!.id])
  })

  test('26: on the same buy date the lower bucket index is the older one', () => {
    const orders = [ord(0, S, '97.00', 10), ord(1, S, '97.00', 10)]
    const pick = attributeSell(orders, two(), sell(10, '96.50', ev('stop')))
    expect([pick.bucketIdx, pick.orderId]).toEqual([0, orders[0]!.id])
    expect(pick.attribution).toMatchObject({ rule: 'older' })
  })
})

describe('attributeSell: the pool and the gates', () => {
  const quietOnOne = (orders: OrderRow[]): void => {
    const pick = attributeSell(orders, two(), sell(10, '96.50', ev('stop')))
    expect([pick.bucketIdx, pick.orderId, pick.attribution]).toEqual([1, orders[1]!.id, null])
  }

  test('27: an order of another day is not in the pool', () => {
    quietOnOne([ord(0, S, '97.00', 10, { tradeDate: Y }), ord(1, S, '99.00', 10)])
  })

  test('28: a cancelled or a filled order is not in the pool', () => {
    for (const status of ['cancelled', 'filled']) quietOnOne([ord(0, S, '97.00', 10, { status }), ord(1, S, '99.00', 10)])
  })

  test('29: a stale order is a candidate', () => {
    const orders = [ord(0, S, '97.00', 10, { status: 'stale' }), ord(1, S, '99.00', 10)]
    const pick = attributeSell(orders, two(), sell(10, '96.50', ev('stop')))
    expect([pick.bucketIdx, pick.orderId]).toEqual([0, orders[0]!.id])
    expect(pick.attribution).toMatchObject({ rule: 'price' })
  })

  test('30: a bucket that does not cover the fill is not a candidate', () => {
    const orders = stops()
    const pick = attributeSell(orders, two(6, 10), sell(10, '96.50', ev('stop')))
    expect([pick.bucketIdx, pick.orderId, pick.attribution]).toEqual([1, orders[1]!.id, null])
  })

  test('31: an order that does not fit the price is not a candidate', () => {
    const orders = [ord(0, S, '97.00', 10), ord(1, S, '95.00', 10)]
    const pick = attributeSell(orders, two(), sell(10, '96.50', ev('stop')))
    expect([pick.bucketIdx, pick.orderId, pick.attribution]).toEqual([0, orders[0]!.id, null])
  })

  test('32: another run\'s orders are not in the pool, so two holders need a choice', () => {
    const orders = [ord(0, S, '97.00', 10, { runId: 2 }), ord(1, S, '99.00', 10, { runId: 2 })]
    throwsKind(() => attributeSell(orders, two(), sell(10, '96.50', ev('stop'))), 'choose-bucket')
  })
})
