import type { RunState, ISODate, Bucket } from '@st/core'

export interface OrderRow { id: number; runId: number; tradeDate: string; kind: string; bucketIdx: number; limitPrice: bigint; shares: number; status: string }

// Every order kind that sells a held bucket.
const SELL_SIDE_KINDS: readonly string[] = ['sell_loc', 'stop_sell', 'market_sell']

// The open sell-side orders of one bucket, run and trade date, lowest id first,
// minus `exceptId` (the order a fill matched). Open is load-bearing: a leg an
// earlier partial fill already flipped to filled must not be reported again.
export function openSellLegs(orders: OrderRow[], key: { runId: number; bucketIdx: number; tradeDate: string }, exceptId: number | null): OrderRow[] {
  return orders
    .filter((o) => o.runId === key.runId && o.bucketIdx === key.bucketIdx && o.tradeDate === key.tradeDate && o.status === 'open' && o.id !== exceptId && SELL_SIDE_KINDS.includes(o.kind))
    .sort((a, b) => a.id - b.id)
}

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
