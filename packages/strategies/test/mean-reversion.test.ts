import { describe, test, expect } from 'bun:test'
import { bucketBudgetCents, buyShares, sellTarget, ageBuckets, computeOrders, DEFAULT_MR_PARAMS } from '@st/strategies'
import { emptyState, applyBuyFill, formatUsd } from '@st/core'
import type { Bucket } from '@st/core'

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
    const run = { id: 1, name: 'r', ticker: 'X', strategyKey: 'mean-reversion' as const, costPpm: 30, poolCents: 1_000_000, status: 'active' as const }
    const plan = computeOrders(run, state, { lastClose: 3402300n })
    expect(plan.orders.length).toBe(1)
    expect(plan.orders[0]).toEqual({ kind: 'buy_loc', bucketIndex: 0, limitPrice: 3402200n, shares: 2 })
  })
  test('all held no bucket', () => {
    const state = emptyState(10)
    for (let i = 0; i < 10; i++) state.buckets[i]!.state = 'held'
    const run = { id: 1, name: 'r', ticker: 'X', strategyKey: 'mean-reversion' as const, costPpm: 30, poolCents: 1_000_000, status: 'active' as const }
    const plan = computeOrders(run, state, { lastClose: 3402300n })
    expect(plan.orders.filter(o => o.kind === 'buy_loc').length).toBe(0)
    expect(plan.notices).toContainEqual({ code: 'no-bucket-available' })
  })
  test('shares zero', () => {
    const state = emptyState(10)
    const run = { id: 1, name: 'r', ticker: 'X', strategyKey: 'mean-reversion' as const, costPpm: 30, poolCents: 50_000, status: 'active' as const }
    const plan = computeOrders(run, state, { lastClose: 3402300n })
    expect(plan.orders.length).toBe(0)
    expect(plan.notices).toContainEqual({ code: 'shares-zero', params: { price: '340.22' } })
  })
  test('held sell_loc', () => {
    const state = emptyState(10)
    const b: Bucket = { index: 3, state: 'held', shares: 5, buyPrice: 3411300n, buyFeeCents: 0, filledOn: '2026-11-08' }
    state.buckets[3] = b
    const run = { id: 1, name: 'r', ticker: 'X', strategyKey: 'mean-reversion' as const, costPpm: 30, poolCents: 1_000_000, status: 'active' as const }
    const plan = computeOrders(run, state, { lastClose: 3402300n })
    const so = plan.orders.find(o => o.kind === 'sell_loc' && o.bucketIndex === 3)
    expect(so?.limitPrice).toBe(3411605n)
  })
  test('sell capped', () => {
    const state = emptyState(10)
    const b: Bucket = { index: 4, state: 'held', shares: 5, buyPrice: 4500000n, buyFeeCents: 0, filledOn: '2026-11-08' }
    state.buckets[4] = b
    const run = { id: 1, name: 'r', ticker: 'X', strategyKey: 'mean-reversion' as const, costPpm: 30, poolCents: 1_000_000, status: 'active' as const }
    const plan = computeOrders(run, state, { lastClose: 3402300n })
    expect(plan.orders.find(o => o.kind === 'sell_loc' && o.bucketIndex === 4)).toBeUndefined()
    expect(plan.skips.find(o => o.kind === 'sell_loc' && o.bucketIndex === 4)).toBeDefined()
    const target = sellTarget(4500000n, 30, 5n)
    expect(plan.notices).toContainEqual({ code: 'sell-capped', params: { bucket: '4', price: formatUsd(target) } })
  })
  test('force sell', () => {
    const state = emptyState(10)
    const b: Bucket = { index: 1, state: 'force_sell', shares: 120, buyPrice: 3402300n, buyFeeCents: 0, filledOn: '2026-11-08' }
    state.buckets[1] = b
    const run = { id: 1, name: 'r', ticker: 'X', strategyKey: 'mean-reversion' as const, costPpm: 30, poolCents: 1_000_000, status: 'active' as const }
    const plan = computeOrders(run, state, { lastClose: 3402300n })
    expect(plan.orders).toContainEqual({ kind: 'market_sell', bucketIndex: 1, limitPrice: 0n, shares: 120 })
    expect(plan.orders.find(o => o.kind === 'sell_loc' && o.bucketIndex === 1)).toBeUndefined()
  })
  test('purity', () => {
    const state = emptyState(10)
    const before = state.buckets.map(b => b.shares)
    const run = { id: 1, name: 'r', ticker: 'X', strategyKey: 'mean-reversion' as const, costPpm: 30, poolCents: 1_000_000, status: 'active' as const }
    computeOrders(run, state, { lastClose: 3402300n })
    expect(state.buckets.map(b => b.shares)).toEqual(before)
  })
})
