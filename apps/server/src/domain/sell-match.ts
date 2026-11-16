import type { RunState, ISODate, Bucket } from '@st/core'
import type { OrderRow } from './booking'

interface SellFillKey { runId: number; filledOn: ISODate; shares: number; price: bigint }

const cmp = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0)

// Which open sell order does a sell fill belong to? Every candidate must be open,
// of this run and trade date, and sit on a held bucket with at least `shares`.
// Each held bucket carries two live legs: a limit-on-close target (sell_loc) and
// a stop-market (stop_sell, limitPrice = trigger), with trigger < buyPrice < sellLimit.
//   target fill: prints at the close, at or ABOVE its limit  => price >= limit
//   stop fill:   triggers on the way down, at or BELOW trigger => price <= trigger
// For one bucket the two tests are disjoint. Across buckets they are not: a loose
// trigger on one bucket can sit above another bucket's target, so an ordinary
// target fill would also satisfy price <= that trigger. A fill at or above SOME
// bucket's target must therefore be read as a target before it is read as anyone's
// stop. Order: exact target, target at/under the price (highest limit = tightest
// fit), stop at/over the price (lowest trigger = tightest fit), market_sell.
// Every tie breaks on the lowest bucketIdx. null leaves the caller's fallback.
export function matchSellOrder(orders: OrderRow[], state: RunState, input: SellFillKey): OrderRow | null {
  const live = orders.filter((o) => {
    if (o.status !== 'open' || o.runId !== input.runId || o.tradeDate !== input.filledOn) return false
    const b = state.buckets.find((x: Bucket) => x.index === o.bucketIdx)
    return !!b && b.state !== 'empty' && b.shares >= input.shares
  })
  const pick = (kind: string, test: (o: OrderRow) => boolean, rank: (a: OrderRow, b: OrderRow) => number): OrderRow | null =>
    live.filter((o) => o.kind === kind && test(o)).sort((a, b) => rank(a, b) || a.bucketIdx - b.bucketIdx)[0] ?? null
  return (
    pick('sell_loc', (o) => o.limitPrice === input.price, () => 0) ??
    pick('sell_loc', (o) => input.price >= o.limitPrice, (a, b) => cmp(b.limitPrice, a.limitPrice)) ??
    pick('stop_sell', (o) => input.price <= o.limitPrice, (a, b) => cmp(a.limitPrice, b.limitPrice)) ??
    pick('market_sell', () => true, () => 0)
  )
}
