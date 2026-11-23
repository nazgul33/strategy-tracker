import { test, expect } from 'bun:test'
import { emptyState, applyBuyFill, type ISODate } from '@st/core'
import { parseUsd } from '@st/core/money'
import { emptiedBuckets, retireLegs, type EmptyCause } from '../src/domain/retire-legs'
import type { OrderRow } from '../src/domain/sell-match'

const D: ISODate = '2026-11-12'
const Y: ISODate = '2026-11-11'
const YY: ISODate = '2026-11-10'
const T: ISODate = '2026-11-13'

const row = (id: number, kind: string, status: string, tradeDate: string, over: Partial<OrderRow> = {}): OrderRow =>
  ({ id, runId: 1, tradeDate, kind, bucketIdx: 1, limitPrice: 100n, shares: 10, status, ...over })

async function run(orders: OrderRow[], cause: EmptyCause, key = { runId: 1, bucketIdx: 1 }) {
  const calls: Array<[number, string, string | undefined]> = []
  const repos = { orderRepo: { setStatus: async (id: number, status: string, reason?: string) => { calls.push([id, status, reason]) } } }
  const cancelled = await retireLegs(repos as never, orders, key, cause)
  return { calls, cancelled }
}

test('emptiedBuckets lists the buckets that went from held to empty', () => {
  let prev = emptyState(5)
  for (const i of [2, 4]) prev = applyBuyFill(prev, i, 10, parseUsd('100.00'), 0, '2026-11-01')
  const next = structuredClone(prev)
  next.buckets[2]!.state = 'empty'
  next.buckets[2]!.shares = 0
  expect(emptiedBuckets(prev, next)).toEqual([2])
})

test('sold: cancels the open legs, then the stale legs of that day, then flips the leg', async () => {
  const orders = [
    row(1, 'sell_loc', 'open', D),
    row(2, 'stop_sell', 'open', D),
    row(3, 'market_sell', 'stale', D),
    row(4, 'sell_loc', 'open', T),
    row(5, 'sell_loc', 'stale', Y),
  ]
  const { calls, cancelled } = await run(orders, { kind: 'sold', filledOn: D, legId: 2 })
  expect(calls).toEqual([[1, 'cancelled', 'broker-filled'], [4, 'cancelled', 'broker-filled'], [3, 'cancelled', 'broker-filled'], [2, 'filled', undefined]])
  expect(cancelled).toEqual([1, 4])
})

test('sold with legId null flips nothing', async () => {
  const orders = [row(1, 'sell_loc', 'open', D), row(2, 'stop_sell', 'open', D), row(3, 'sell_loc', 'stale', D)]
  const { calls, cancelled } = await run(orders, { kind: 'sold', filledOn: D, legId: null })
  expect(calls).toEqual([[1, 'cancelled', 'broker-filled'], [2, 'cancelled', 'broker-filled'], [3, 'cancelled', 'broker-filled']])
  expect(cancelled).toEqual([1, 2])
})

test("buy-removed: cancels open and stale legs from the buy's date on with reason other and flips nothing", async () => {
  const orders = [
    row(1, 'sell_loc', 'open', D),
    row(2, 'stop_sell', 'open', D),
    row(3, 'sell_loc', 'stale', Y),
    row(4, 'sell_loc', 'stale', YY),
    row(5, 'buy_loc', 'filled', Y),
  ]
  const { calls, cancelled } = await run(orders, { kind: 'buy-removed', filledOn: Y })
  expect(calls).toEqual([[1, 'cancelled', 'other'], [2, 'cancelled', 'other'], [3, 'cancelled', 'other']])
  expect(cancelled).toEqual([1, 2])
})

test('orders of another bucket or another run are never touched', async () => {
  const orders = [
    row(1, 'sell_loc', 'open', D, { bucketIdx: 2 }),
    row(2, 'stop_sell', 'open', D, { runId: 2 }),
    row(3, 'sell_loc', 'stale', D, { bucketIdx: 2 }),
    row(4, 'sell_loc', 'stale', D, { runId: 2 }),
  ]
  for (const cause of [{ kind: 'sold', filledOn: D, legId: null }, { kind: 'buy-removed', filledOn: D }] as EmptyCause[]) {
    const { calls, cancelled } = await run(orders, cause)
    expect(calls).toEqual([])
    expect(cancelled).toEqual([])
  }
})
