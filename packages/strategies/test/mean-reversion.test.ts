import { describe, test, expect } from 'bun:test'
import { bucketBudgetCents, buyShares, sellTarget, ageBuckets, computeOrders, progressView, DEFAULT_MR_PARAMS, buyLimit, sellLimit } from '@st/strategies'
import { emptyState, applyBuyFill, applySellFill } from '@st/core'
import type { Bucket, Run } from '@st/core'
import { parseUsd } from '@st/core/money'

describe('core money pins', () => {
  test('bucketBudgetCents', () => expect(bucketBudgetCents(1_000_000)).toBe(100_000))
  test('sellTarget literal', () => {
    // 3402300*60/1e6 = 204.138 -> 204
    expect(sellTarget(3402300n, 30, 100n)).toBe(3402604n)
  })
  test('buyShares', () => {
    expect(buyShares(100_000, 3402300n)).toBe(2)
    expect(buyShares(5_000, 3402300n)).toBe(0)
  })
})

describe('ageBuckets', () => {
  test('pins', () => {
    expect(ageBuckets({}, '2026-11-09', { 0: '2026-11-05' })[0]).toBe(2)
    expect(ageBuckets({}, '2026-11-11', { 0: '2026-11-09' })[0]).toBe(2)
    expect(ageBuckets({}, '2026-11-09', { 0: '2026-11-09' })[0]).toBe(0)
    expect(ageBuckets({}, '2026-11-27', { 0: '2026-11-25' })[0]).toBe(1)
  })
  test('missing/empty', () => {
    expect(ageBuckets({}, '2026-11-09', { 0: '' })[0] ?? 0).toBe(0)
  })
})

describe('computeOrders', () => {
  test('fresh 10 bucket', () => {
    const state = emptyState(10)
    const run = { id: 1, name: 'r', ticker: 'X', strategyKey: 'mean-reversion' as const, costPpm: 30, buyGapPpm: 0, sellGapPpm: 0, poolCents: 1_000_000, status: 'active' as const }
    const plan = computeOrders(run, state, { lastClose: 3402300n })
    expect(plan.orders.length).toBe(1)
    expect(plan.orders[0]).toEqual({ kind: 'buy_loc', bucketIndex: 0, limitPrice: 3402200n, shares: 2 })
  })
  test('all held no bucket', () => {
    const state = emptyState(10)
    for (let i = 0; i < 10; i++) state.buckets[i]!.state = 'held'
    const run = { id: 1, name: 'r', ticker: 'X', strategyKey: 'mean-reversion' as const, costPpm: 30, buyGapPpm: 0, sellGapPpm: 0, poolCents: 1_000_000, status: 'active' as const }
    const plan = computeOrders(run, state, { lastClose: 3402300n })
    expect(plan.orders.filter(o => o.kind === 'buy_loc').length).toBe(0)
    expect(plan.notices).toContainEqual({ code: 'no-bucket-available' })
  })
  test('shares zero', () => {
    const state = emptyState(10)
    const run = { id: 1, name: 'r', ticker: 'X', strategyKey: 'mean-reversion' as const, costPpm: 30, buyGapPpm: 0, sellGapPpm: 0, poolCents: 50_000, status: 'active' as const }
    const plan = computeOrders(run, state, { lastClose: 3402300n })
    expect(plan.orders.length).toBe(0)
    expect(plan.notices).toContainEqual({ code: 'shares-zero', params: { price: '340.22' } })
  })
  test('held sell_loc', () => {
    const state = emptyState(10)
    const b: Bucket = { index: 3, state: 'held', shares: 5, buyPrice: 3411300n, buyFeeCents: 0, filledOn: '2026-11-08' }
    state.buckets[3] = b
    const run = { id: 1, name: 'r', ticker: 'X', strategyKey: 'mean-reversion' as const, costPpm: 30, buyGapPpm: 0, sellGapPpm: 0, poolCents: 1_000_000, status: 'active' as const }
    const plan = computeOrders(run, state, { lastClose: 3402300n })
    const so = plan.orders.find(o => o.kind === 'sell_loc' && o.bucketIndex === 3)
    expect(so?.limitPrice).toBe(3411605n)
  })
  test('high target sells anyway (no cap)', () => {
    const state = emptyState(10)
    const b: Bucket = { index: 4, state: 'held', shares: 5, buyPrice: 4500000n, buyFeeCents: 0, filledOn: '2026-11-08' }
    state.buckets[4] = b
    const run = { id: 1, name: 'r', ticker: 'X', strategyKey: 'mean-reversion' as const, costPpm: 30, buyGapPpm: 0, sellGapPpm: 0, poolCents: 1_000_000, status: 'active' as const }
    const plan = computeOrders(run, state, { lastClose: 3402300n })
    const target = sellTarget(4500000n, 30, 5n)
    expect(plan.orders).toContainEqual({ kind: 'sell_loc', bucketIndex: 4, limitPrice: target, shares: 5, ageDays: 0 })
    expect(plan.skips).toEqual([])
    expect(plan.notices).toEqual([])
  })
  test('force sell', () => {
    const state = emptyState(10)
    const b: Bucket = { index: 1, state: 'force_sell', shares: 120, buyPrice: 3402300n, buyFeeCents: 0, filledOn: '2026-11-08' }
    state.buckets[1] = b
    const run = { id: 1, name: 'r', ticker: 'X', strategyKey: 'mean-reversion' as const, costPpm: 30, buyGapPpm: 0, sellGapPpm: 0, poolCents: 1_000_000, status: 'active' as const }
    const plan = computeOrders(run, state, { lastClose: 3402300n })
    expect(plan.orders).toContainEqual({ kind: 'market_sell', bucketIndex: 1, limitPrice: 0n, shares: 120, ageDays: 0 })
    expect(plan.orders.find(o => o.kind === 'sell_loc' && o.bucketIndex === 1)).toBeUndefined()
  })
  test('purity', () => {
    const state = emptyState(10)
    const before = state.buckets.map(b => b.shares)
    const run = { id: 1, name: 'r', ticker: 'X', strategyKey: 'mean-reversion' as const, costPpm: 30, buyGapPpm: 0, sellGapPpm: 0, poolCents: 1_000_000, status: 'active' as const }
    computeOrders(run, state, { lastClose: 3402300n })
    expect(state.buckets.map(b => b.shares)).toEqual(before)
  })
  test('sell orders carry the bucket age stamped at plan time; buys do not', () => {
    const run = { id: 1, name: 'r', ticker: 'X', strategyKey: 'mean-reversion' as const, costPpm: 30, buyGapPpm: 0, sellGapPpm: 0, poolCents: 1_000_000, status: 'active' as const }
    let state = emptyState(10)
    state = applyBuyFill(state, 0, 10, 3402200n, 34, '2026-11-02')
    state = applyBuyFill(state, 1, 5, 3402200n, 17, '2026-10-01')
    state.ages[0] = 15
    state.ages[1] = 101
    state.buckets[1]!.state = 'force_sell'
    const plan = computeOrders(run, state, { lastClose: 3402300n })
    const buy = plan.orders.find((o) => o.kind === 'buy_loc')!
    const loc = plan.orders.find((o) => o.kind === 'sell_loc')!
    const forced = plan.orders.find((o) => o.kind === 'market_sell')!
    expect(buy.bucketIndex).toBe(2) // lowest empty bucket
    expect(buy.ageDays).toBeUndefined()
    expect(loc.bucketIndex).toBe(0)
    expect(loc.ageDays).toBe(15)
    expect(forced.bucketIndex).toBe(1)
    expect(forced.ageDays).toBe(101)
  })
})

describe('progressView', () => {
  test('empty state: zeros and winRate null', () => {
    const v = progressView(emptyState(10))
    expect(v).toEqual({ heldCount: 0, cashCents: 0, exposureCents: 0, realizedCents: 0, winRate: null })
  })
  test('held exposure = price*shares/100 per bucket; realized derived from closed', () => {
    let s = emptyState(10)
    s = applyBuyFill(s, 0, 10, 3402200n, 34, '2026-11-02')
    s = applyBuyFill(s, 1, 5, 1000000n, 5, '2026-11-03')
    s = applySellFill(s, 1, 5, 999900n, 5, '2026-11-04')
    const v = progressView(s)
    expect(v.heldCount).toBe(1)
    expect(v.cashCents).toBe(s.cashCents)
    expect(v.exposureCents).toBe(340220)
    expect(v.realizedCents).toBe(-15)
    expect(v.winRate).toBe(0)
  })
  test('realized rounds half-up on the gross delta; win counted', () => {
    let s = emptyState(10)
    s = applyBuyFill(s, 0, 3, 1000000n, 0, '2026-11-02')
    s = applySellFill(s, 0, 3, 1000050n, 0, '2026-11-03')
    const v = progressView(s)
    expect(v.realizedCents).toBe(2)
    expect(v.winRate).toBe(1)
  })
  test('winRate = wins / all closed', () => {
    let s = emptyState(10)
    s = applyBuyFill(s, 0, 1, 1000000n, 0, '2026-11-02')
    s = applyBuyFill(s, 1, 1, 1000000n, 0, '2026-11-02')
    s = applySellFill(s, 0, 1, 1000100n, 0, '2026-11-03')
    s = applySellFill(s, 1, 1, 999900n, 0, '2026-11-03')
    expect(progressView(s).winRate).toBe(0.5)
  })
})

function makeRun(): Run {
  return { id: 1, name: 'r', ticker: 'X', strategyKey: 'mean-reversion', costPpm: 200, buyGapPpm: 0, sellGapPpm: 0, poolCents: 1_000_000, status: 'active' }
}

function mkBucket(index: number, state: Bucket['state'], shares: number, buyPrice: bigint, filledOn: string): Bucket {
  return { index, state, shares, buyPrice, buyFeeCents: 0, filledOn }
}

describe('buyLimit', () => {
  test('default gap keeps close - $0.01, cent-rounded', () => {
    expect(buyLimit(parseUsd('34.56'), 0)).toBe(parseUsd('34.55'))
    expect(buyLimit(parseUsd('34.5678'), 0)).toBe(parseUsd('34.56')) // ceil(34.5578)
  })
  test('percent gap below close, ceiling to cents', () => {
    expect(buyLimit(parseUsd('100'), 5_000)).toBe(parseUsd('99.50')) // 0.5%
    expect(buyLimit(parseUsd('34.5678'), 5_000)).toBe(parseUsd('34.40')) // ceil(34.394961)
    expect(buyLimit(parseUsd('0.01'), 50_000)).toBe(parseUsd('0.01')) // ceil(0.0095): sub-cent floors back up to 1¢
  })
  test('edges: 0 and 100 percent', () => {
    expect(buyLimit(parseUsd('10'), 1_000_000)).toBe(0n)
  })
})

describe('sellLimit', () => {
  test('default gap keeps legacy sellTarget exactly', () => {
    expect(sellLimit(parseUsd('33.43'), 200, 100, 0)).toBe(sellTarget(parseUsd('33.43'), 200, 100n))
  })
  test('percent gap above buy price, truncate to cents', () => {
    expect(sellLimit(parseUsd('100'), 200, 100, 10_000)).toBe(parseUsd('101'))
    expect(sellLimit(parseUsd('33.43'), 200, 100, 300_000)).toBe(parseUsd('43.45')) // 43.459 → 43.45
  })
  test('edges: 100 percent doubles buy price', () => {
    expect(sellLimit(parseUsd('12.34'), 200, 100, 1_000_000)).toBe(parseUsd('24.68'))
  })
})

describe('computeOrders with gaps', () => {
  test('buy and sell_loc prices follow run gaps', () => {
    const run = { ...makeRun(), buyGapPpm: 10_000, sellGapPpm: 200_000 } // 1% below close, 20% above buy
    const state = emptyState(10)
    state.buckets[0] = mkBucket(0, 'held', 100, parseUsd('90'), '2026-11-02')
    const plan = computeOrders(run, state, { lastClose: parseUsd('100') })
    expect(plan.orders.find(o => o.kind === 'buy_loc')?.limitPrice).toBe(parseUsd('99'))       // 100 × 0.99
    expect(plan.orders.find(o => o.kind === 'sell_loc')?.limitPrice).toBe(parseUsd('108'))     // 90 × 1.20
  })
  test('unset gaps keep legacy prices', () => {
    const state = emptyState(10)
    state.buckets[0] = mkBucket(0, 'held', 100, parseUsd('90'), '2026-11-02')
    const plan = computeOrders(makeRun(), state, { lastClose: parseUsd('100') })
    expect(plan.orders.find(o => o.kind === 'buy_loc')?.limitPrice).toBe(parseUsd('99.99'))
    expect(plan.orders.find(o => o.kind === 'sell_loc')?.limitPrice).toBe(sellTarget(parseUsd('90'), 200, 100n))
  })
})
