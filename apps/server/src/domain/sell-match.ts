import type { RunState, ISODate, Bucket } from '@st/core'

export interface OrderRow { id: number; runId: number; tradeDate: string; kind: string; bucketIdx: number; limitPrice: bigint; shares: number; status: string }

// Every order kind that sells a held bucket.
const SELL_SIDE_KINDS: readonly string[] = ['sell_loc', 'stop_sell', 'market_sell']

// The open sell-side orders of one bucket and run from `fromTradeDate` onwards,
// lowest id first, minus `exceptId` (the order a fill matched). Open is load-bearing:
// a leg an earlier partial fill already flipped to filled must not be reported again.
//
// `>= fromTradeDate`, not `===` (the spec records this): a fill captured for an earlier
// day and confirmed after the morning re-plan would otherwise leave today's freshly
// planned target and stop open — two live broker orders against shares already sold.
export function openSellLegs(orders: OrderRow[], key: { runId: number; bucketIdx: number; fromTradeDate: string }, exceptId: number | null): OrderRow[] {
  return orders
    .filter((o) => o.runId === key.runId && o.bucketIdx === key.bucketIdx && o.tradeDate >= key.fromTradeDate && o.status === 'open' && o.id !== exceptId && SELL_SIDE_KINDS.includes(o.kind))
    .sort((a, b) => a.id - b.id)
}

interface SellFillKey { runId: number; filledOn: ISODate; shares: number; price: bigint }

export type LegKind = 'sell_loc' | 'stop_sell'
// distance = |fill price - limitPrice|
export interface SellLeg { orderId: number; bucketIdx: number; kind: LegKind; limitPrice: bigint; distance: bigint }
export interface SellAttribution { shares: number; price: bigint; chosen: SellLeg; alternatives: SellLeg[] }
export interface SellMatch { order: OrderRow; attribution: SellAttribution | null }

const cmp = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0)
const kindRank = (k: LegKind): number => (k === 'sell_loc' ? 0 : 1)
const absDiff = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a)

function toLeg(o: OrderRow, price: bigint): SellLeg {
  return { orderId: o.id, bucketIdx: o.bucketIdx, kind: o.kind as LegKind, limitPrice: o.limitPrice, distance: absDiff(price, o.limitPrice) }
}

// Which open sell order does a sell fill belong to? Every candidate must be open
// and of this run and trade date; all but the exact-price rung must also sit on a
// held bucket with at least `shares` (see the exemption at rung 1a below).
// Each held bucket carries two live legs: a limit-on-close target (sell_loc) and
// a stop-market (stop_sell, limitPrice = trigger), with trigger < buyPrice < sellLimit.
//   target fill: prints at the close, at or ABOVE its limit  => price >= limit
//   stop fill:   triggers on the way down, at or BELOW trigger => price <= trigger
// For one bucket the two tests are disjoint. Across buckets they are not: a loose
// trigger on one bucket can sit above another bucket's target, and a loose target
// below another bucket's trigger. A fixed kind precedence (any target before any
// stop) was wrong across buckets: in issue #43 a 96.50 stop fill was booked to
// another bucket's 91.00 target, because 96.50 >= 91.00, although the 97.00 stop
// on the bucket that really sold was 0.50 away. Order:
//   1a  exact target: a sell_loc with limitPrice === price
//   1b  nearest: every sell_loc with price >= limit and every stop_sell with
//       price <= trigger; smallest |price - limitPrice| wins, then sell_loc before
//       stop_sell, then lowest bucketIdx
//   1c  market_sell, lowest bucketIdx
// null leaves the caller's fallback. On 1a and 1b the result also carries the
// admissible legs of OTHER buckets (nearest first) so the operator can be told the
// attribution was a judgement call. It lists only target and stop legs; market_sell
// legs on other buckets are not listed, and a fill matched on 1c or by the fallback
// carries no attribution (see the spec's known limitations).
export function matchSellOrder(orders: OrderRow[], state: RunState, input: SellFillKey): SellMatch | null {
  const onDay = orders.filter((o) => o.status === 'open' && o.runId === input.runId && o.tradeDate === input.filledOn)
  const live = onDay.filter((o) => {
    const b = state.buckets.find((x: Bucket) => x.index === o.bucketIdx)
    return !!b && b.state !== 'empty' && b.shares >= input.shares
  })
  const candidates: SellLeg[] = live
    .filter((o) => (o.kind === 'sell_loc' && input.price >= o.limitPrice) || (o.kind === 'stop_sell' && input.price <= o.limitPrice))
    .map((o) => toLeg(o, input.price))
    .sort((a, b) => cmp(a.distance, b.distance) || kindRank(a.kind) - kindRank(b.kind) || a.bucketIdx - b.bucketIdx)

  // Exact price is read from `onDay`, not `live`, so it skips the uniform
  // "non-empty bucket with shares >= fill.shares" gate (the spec records this).
  // Under the gate an exact-price sell with impossible shares is filtered out, the
  // chain falls through, and the fill is booked into a DIFFERENT bucket while the
  // sibling cancel pulls that bucket's legs — leaving the bucket that really sold
  // held in the tracker with two live broker orders, the design's first anti-goal.
  // Matching it here makes applySellFill throw 'too-many-shares' (a 422 the operator
  // resolves) instead. 1b/1c keep the gate, where it is load-bearing for ranking.
  const exact = onDay.filter((o) => o.kind === 'sell_loc' && o.limitPrice === input.price).sort((a, b) => a.bucketIdx - b.bucketIdx)[0]
  const attribute = (order: OrderRow, chosen: SellLeg): SellMatch => {
    const alternatives = candidates.filter((c) => c.bucketIdx !== order.bucketIdx)
    return { order, attribution: alternatives.length ? { shares: input.shares, price: input.price, chosen, alternatives } : null }
  }
  if (exact) return attribute(exact, toLeg(exact, input.price))

  const nearest = candidates[0]
  if (nearest) return attribute(live.find((o) => o.id === nearest.orderId)!, nearest)

  const market = live.filter((o) => o.kind === 'market_sell').sort((a, b) => a.bucketIdx - b.bucketIdx)[0]
  return market ? { order: market, attribution: null } : null
}
