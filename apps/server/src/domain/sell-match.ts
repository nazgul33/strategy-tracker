import { DomainError, type RunState, type ISODate, type Bucket } from '@st/core'

export interface OrderRow { id: number; runId: number; tradeDate: string; kind: string; bucketIdx: number; limitPrice: bigint; shares: number; status: string }

// Every order kind that sells a held bucket.
export const SELL_SIDE_KINDS: readonly string[] = ['sell_loc', 'stop_sell', 'market_sell']

// The open sell-side orders of one bucket and run from `fromTradeDate` onwards,
// lowest id first, minus `exceptId` (the order a fill matched). Open is load-bearing:
// a stale leg's day is over at the broker and a filled or cancelled leg is no longer
// live, so neither is pulled or announced.
//
// `>= fromTradeDate`, not `===` (the spec records this): a fill captured for an earlier
// day and confirmed after the morning re-plan would otherwise leave today's freshly
// planned target and stop open — two live broker orders against shares already sold.
export function openSellLegs(orders: OrderRow[], key: { runId: number; bucketIdx: number; fromTradeDate: string }, exceptId: number | null): OrderRow[] {
  return orders
    .filter((o) => o.runId === key.runId && o.bucketIdx === key.bucketIdx && o.tradeDate >= key.fromTradeDate && o.status === 'open' && o.id !== exceptId && SELL_SIDE_KINDS.includes(o.kind))
    .sort((a, b) => a.id - b.id)
}

// The stale sell-side orders of one bucket and run dated exactly `tradeDate`, minus
// `exceptId`, lowest id first. A fill that empties the bucket retires them silently
// (no message: that broker day is over), otherwise a later rebuy of the bucket would
// let one pass the shares gate and absorb an unrelated late fill of the same day.
export function staleSellLegs(orders: OrderRow[], key: { runId: number; bucketIdx: number; tradeDate: string }, exceptId: number | null): OrderRow[] {
  return orders
    .filter((o) => o.runId === key.runId && o.bucketIdx === key.bucketIdx && o.tradeDate === key.tradeDate && o.status === 'stale' && o.id !== exceptId && SELL_SIDE_KINDS.includes(o.kind))
    .sort((a, b) => a.id - b.id)
}

export interface SellFillKey { runId: number; filledOn: ISODate; shares: number; price: bigint }

export type PriceLegKind = 'sell_loc' | 'stop_sell'
// distance = |fill price - limitPrice|
export interface PriceLeg { orderId: number; bucketIdx: number; kind: PriceLegKind; limitPrice: bigint; distance: bigint }
export interface MarketLeg { orderId: number; bucketIdx: number; kind: 'market_sell' }
export type SellLeg = PriceLeg | MarketLeg
// price: the exact-price rung or price distance decided; market: the market-sell rung.
// A share-count pick carries no attribution, so it has no rule value.
// order-price, ordered-shares, shares, price, older: the steps of the order-type rule (sell-attribute.ts).
export type AttributionRule = 'price' | 'market' | 'order-price' | 'ordered-shares' | 'shares' | 'older'
export interface SellAttribution { shares: number; price: bigint; rule: AttributionRule; chosen: SellLeg; alternatives: SellLeg[] }
export interface SellMatch { order: OrderRow; attribution: SellAttribution | null }

const cmp = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0)
const kindRank = (k: PriceLegKind): number => (k === 'sell_loc' ? 0 : 1)
const absDiff = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a)

export function legOf(o: OrderRow, price: bigint): SellLeg | null {
  switch (o.kind) {
    case 'sell_loc':
    case 'stop_sell':
      return { orderId: o.id, bucketIdx: o.bucketIdx, kind: o.kind, limitPrice: o.limitPrice, distance: absDiff(price, o.limitPrice) }
    case 'market_sell':
      return { orderId: o.id, bucketIdx: o.bucketIdx, kind: 'market_sell' }
    default:
      return null
  }
}

export interface Pair { order: OrderRow; leg: SellLeg }
export type PricePair = { order: OrderRow; leg: PriceLeg }
export const isPrice = (p: Pair): p is PricePair => p.leg.kind !== 'market_sell'
export const byBucket = (a: Pair, b: Pair): number => a.order.bucketIdx - b.order.bucketIdx || a.order.id - b.order.id
export const nearestFirst = (a: PricePair, b: PricePair): number => cmp(a.leg.distance, b.leg.distance) || kindRank(a.leg.kind) - kindRank(b.leg.kind) || byBucket(a, b)

export function poolOf(orders: OrderRow[], input: SellFillKey): Pair[] {
  const pool: Pair[] = []
  for (const order of orders) {
    if (order.runId !== input.runId || order.tradeDate !== input.filledOn || (order.status !== 'open' && order.status !== 'stale')) continue
    const leg = legOf(order, input.price)
    if (leg) pool.push({ order, leg })
  }
  return pool
}
export const fits = (p: Pair, price: bigint): boolean => p.leg.kind === 'market_sell' || (p.leg.kind === 'sell_loc' ? price >= p.leg.limitPrice : price <= p.leg.limitPrice)

// Which sell-side order does a sell fill belong to?
//   Pool        orders of this run dated on the fill's trade date, of a sell-side kind
//               (sell_loc, stop_sell, market_sell), open or stale. A stale order is one whose
//               day ended without a booked fill, which is what a late-captured fill is.
//               Filled and cancelled orders never take part.
//   Gate        a pool order passes when its bucket is not empty and holds at least fill.shares.
//   Admissible  a gated order that fits the price: sell_loc when price >= limit, stop_sell when
//               price <= trigger, market_sell at any price.
// Each held bucket carries two live legs: a limit-on-close target (sell_loc) and
// a stop-market (stop_sell, limitPrice = trigger), with trigger < buyPrice < sellLimit.
//   target fill: prints at the close, at or ABOVE its limit  => price >= limit
//   stop fill:   triggers on the way down, at or BELOW trigger => price <= trigger
// For one bucket the two tests are disjoint. Across buckets they are not: a loose
// trigger on one bucket can sit above another bucket's target, and a loose target
// below another bucket's trigger. A fixed kind precedence (any target before any
// stop) was wrong across buckets: in issue #43 a 96.50 stop fill was booked to
// another bucket's 91.00 target, because 96.50 >= 91.00, although the 97.00 stop
// on the bucket that really sold was 0.50 away. First hit wins:
//   1  exact price: the OPEN sell_loc legs with limitPrice === price (a stale one never
//      takes this rung: on a bucket emptied since it would throw for a fill that belongs
//      elsewhere). Among those that pass the gate, the single one sized like the fill
//      (order shares === fill shares), else the lowest bucket. If none passes the gate the
//      lowest bucket's leg is returned anyway, so an exact-price print its bucket cannot
//      cover fails loudly in applySellFill (too-many-shares / bucket-not-held) instead of
//      landing in another bucket and pulling that bucket's legs.
//   2  share count, only when rung 1 found no exact-price leg: exactly one admissible order
//      (any kind) sized like the fill. None or several: next rung.
//   3  nearest: admissible sell_loc and stop_sell together; smallest |price - limitPrice|,
//      then sell_loc before stop_sell, then lowest bucketIdx.
//   4  market: the lowest-bucket admissible market_sell.
// null leaves the caller's fallback. The result carries the admissible legs of OTHER buckets
// (price legs in rung-3 order, then market sells by bucket) so the operator can be told the
// attribution was a judgement call; a rung-2 pick carries none (a normal multi-target exit
// would otherwise notify for every fill but the last). The caller flips the order to filled
// only when the fill empties its bucket, so a partial fill leaves the rest a candidate.
// An operator-chosen bucket skips all of this: see matchForcedLeg.
export function matchSellOrder(orders: OrderRow[], state: RunState, input: SellFillKey): SellMatch | null {
  const pool = poolOf(orders, input)
  const covers = (p: Pair): boolean => {
    const b = state.buckets.find((x: Bucket) => x.index === p.order.bucketIdx)
    return !!b && b.state !== 'empty' && b.shares >= input.shares
  }
  const admissible = pool.filter((p) => covers(p) && fits(p, input.price))

  const pick = (chosen: Pair, rule: AttributionRule): SellMatch => {
    const others = admissible.filter((p) => p.order.bucketIdx !== chosen.order.bucketIdx)
    const alternatives = [...others.filter(isPrice).sort(nearestFirst), ...others.filter((p) => !isPrice(p)).sort(byBucket)].map((p) => p.leg)
    return { order: chosen.order, attribution: alternatives.length ? { shares: input.shares, price: input.price, rule, chosen: chosen.leg, alternatives } : null }
  }

  const exact = pool.filter((p) => p.order.status === 'open' && p.order.kind === 'sell_loc' && p.order.limitPrice === input.price).sort(byBucket)
  if (exact.length) {
    const gated = exact.filter(covers)
    const sized = gated.filter((p) => p.order.shares === input.shares)
    return pick(sized.length === 1 ? sized[0]! : gated[0] ?? exact[0]!, 'price')
  }

  const sized = admissible.filter((p) => p.order.shares === input.shares)
  if (sized.length === 1) return { order: sized[0]!.order, attribution: null }

  const nearest = admissible.filter(isPrice).sort(nearestFirst)[0]
  if (nearest) return pick(nearest, 'price')

  const market = admissible.filter((p) => !isPrice(p)).sort(byBucket)[0]
  return market ? pick(market, 'market') : null
}

// The fill's bucket is the operator's: which of that bucket's orders on the fill day (open or
// stale, sell-side, fitting the price) did it take? First exactly one with shares === fill.shares,
// then the nearest price leg (sell_loc before stop_sell on a tie), then a market_sell; null when
// none fits. No gate: applySellFill validates the bucket.
export function matchForcedLeg(orders: OrderRow[], input: SellFillKey & { bucketIdx: number }): OrderRow | null {
  const fitting = poolOf(orders, input).filter((p) => p.order.bucketIdx === input.bucketIdx && fits(p, input.price))
  const sized = fitting.filter((p) => p.order.shares === input.shares)
  if (sized.length === 1) return sized[0]!.order
  const nearest = fitting.filter(isPrice).sort(nearestFirst)[0]
  if (nearest) return nearest.order
  return fitting.filter((p) => !isPrice(p)).sort(byBucket)[0]?.order ?? null
}

export interface SellPick { bucketIdx: number; orderId: number | null; attribution: SellAttribution | null }

// The whole sell-side choice: the operator's bucket when given (never attributed), else the
// matched order's bucket, else the lowest non-empty bucket holding enough shares (no order
// flipped, no attribution).
export function pickSellBucket(orders: OrderRow[], state: RunState, input: SellFillKey & { bucketIdx?: number | null }): SellPick {
  if (input.bucketIdx != null) return { bucketIdx: input.bucketIdx, orderId: matchForcedLeg(orders, { ...input, bucketIdx: input.bucketIdx })?.id ?? null, attribution: null }
  const match = matchSellOrder(orders, state, input)
  if (match) return { bucketIdx: match.order.bucketIdx, orderId: match.order.id, attribution: match.attribution }
  const candidates = state.buckets
    .filter((b: Bucket) => b.state !== 'empty' && b.shares >= input.shares)
    .sort((a: Bucket, b: Bucket) => a.index - b.index)
  if (!candidates.length) throw new DomainError('no-bucket-for-sell')
  return { bucketIdx: candidates[0]!.index, orderId: null, attribution: null }
}
