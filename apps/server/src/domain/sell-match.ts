import type { RunState, ISODate, Bucket } from '@st/core'

export interface OrderRow { id: number; runId: number; tradeDate: string; kind: string; bucketIdx: number; limitPrice: bigint; shares: number; status: string }

// Every order kind that sells a held bucket.
const SELL_SIDE_KINDS: readonly string[] = ['sell_loc', 'stop_sell', 'market_sell']

// The open sell-side orders of one bucket and run from `fromTradeDate` onwards,
// lowest id first, minus `exceptId` (the order a fill matched). Open is load-bearing:
// a leg an earlier partial fill already flipped to filled must not be reported again.
//
// `>= fromTradeDate`, not `===`, is a deliberate deviation from the spec, which scoped
// the sibling cancel to the fill's own trade date: a fill captured for an earlier day
// and confirmed after the morning re-plan would otherwise leave today's freshly planned
// target and stop open — two live broker orders against shares already sold.
export function openSellLegs(orders: OrderRow[], key: { runId: number; bucketIdx: number; fromTradeDate: string }, exceptId: number | null): OrderRow[] {
  return orders
    .filter((o) => o.runId === key.runId && o.bucketIdx === key.bucketIdx && o.tradeDate >= key.fromTradeDate && o.status === 'open' && o.id !== exceptId && SELL_SIDE_KINDS.includes(o.kind))
    .sort((a, b) => a.id - b.id)
}

interface SellFillKey { runId: number; filledOn: ISODate; shares: number; price: bigint }

const cmp = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0)

// Which open sell order does a sell fill belong to? Every candidate must be open
// and of this run and trade date; all but the exact-price rung must also sit on a
// held bucket with at least `shares` (see the exemption at the first pick below).
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
  const onDay = orders.filter((o) => o.status === 'open' && o.runId === input.runId && o.tradeDate === input.filledOn)
  const live = onDay.filter((o) => {
    const b = state.buckets.find((x: Bucket) => x.index === o.bucketIdx)
    return !!b && b.state !== 'empty' && b.shares >= input.shares
  })
  const pick = (from: OrderRow[], kind: string, test: (o: OrderRow) => boolean, rank: (a: OrderRow, b: OrderRow) => number): OrderRow | null =>
    from.filter((o) => o.kind === kind && test(o)).sort((a, b) => rank(a, b) || a.bucketIdx - b.bucketIdx)[0] ?? null
  return (
    // Exact price is read from `onDay`, not `live`: a deliberate, recorded deviation
    // from the spec's uniform "non-empty bucket with shares >= fill.shares" gate.
    // Under the gate an exact-price sell with impossible shares is filtered out, the
    // chain falls through, and the fill is booked into a DIFFERENT bucket while the
    // sibling cancel pulls that bucket's legs — leaving the bucket that really sold
    // held in the tracker with two live broker orders, the design's first anti-goal.
    // Matching it here makes applySellFill throw 'too-many-shares' (a 422 the operator
    // resolves) instead. 1b/1c/1d keep the gate, where it is load-bearing for ranking.
    pick(onDay, 'sell_loc', (o) => o.limitPrice === input.price, () => 0) ??
    pick(live, 'sell_loc', (o) => input.price >= o.limitPrice, (a, b) => cmp(b.limitPrice, a.limitPrice)) ??
    pick(live, 'stop_sell', (o) => input.price <= o.limitPrice, (a, b) => cmp(a.limitPrice, b.limitPrice)) ??
    pick(live, 'market_sell', () => true, () => 0)
  )
}
