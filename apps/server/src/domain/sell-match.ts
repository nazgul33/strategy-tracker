import type { ISODate } from '@st/core'

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
// The step of the order-type rule (sell-attribute.ts) that decided the bucket.
export type AttributionRule = 'order-price' | 'ordered-shares' | 'shares' | 'price' | 'older'
export interface SellAttribution { shares: number; price: bigint; rule: AttributionRule; chosen: SellLeg; alternatives: SellLeg[] }

const cmp = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0)
const kindRank = (k: PriceLegKind): number => (k === 'sell_loc' ? 0 : 1)
export const absDiff = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a)

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

// Which bucket and order a sell fill belongs to is decided in sell-attribute.ts; this file
// holds the order pool, the price-fit test and the matcher for a bucket the operator chose.

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
