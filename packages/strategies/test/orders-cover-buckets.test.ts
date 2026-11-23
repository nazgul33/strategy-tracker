import { describe, test, expect } from 'bun:test'
import { computeOrders } from '@st/strategies'
import { emptyState, applyBuyFill } from '@st/core'

// The morning pipeline re-plans a run that has no order today and relies on this: a run
// with a held or force_sell bucket always gets an order, so "no order today" means
// nothing was aged yet (advanceDay ages only those buckets).
describe('computeOrders covers every held and force_sell bucket', () => {
  const base = { id: 1, name: 'r', ticker: 'X', strategyKey: 'mean-reversion' as const, costPpm: 30, buyGapPpm: 0, sellGapPpm: 0, poolCents: 1_000_000, status: 'active' as const }
  test.each([0, 30_000])('with cut-loss %p', (cutLossPpm) => {
    let state = emptyState(10)
    for (const i of [0, 1, 2, 3]) state = applyBuyFill(state, i, 5, 3402200n, 17, '2026-11-02')
    state.buckets[2]!.state = 'force_sell'
    state.buckets[3]!.state = 'force_sell'
    const plan = computeOrders({ ...base, cutLossPpm }, state, { lastClose: 3402300n })
    for (const b of state.buckets.filter((x) => x.state === 'held' || x.state === 'force_sell')) {
      const kinds = plan.orders.filter((o) => o.bucketIndex === b.index && o.kind !== 'buy_loc').map((o) => o.kind)
      expect(kinds.length).toBeGreaterThan(0)
      expect(kinds).toContain(b.state === 'held' ? 'sell_loc' : 'market_sell')
    }
  })
})
