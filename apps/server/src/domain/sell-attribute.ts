import { DomainError, type Bucket, type RunState } from '@st/core'
import { kindOfType, NO_EVIDENCE, type OrderEvidence } from './order-type'
import { absDiff, byBucket, fits, isPrice, matchForcedLeg, nearestFirst, poolOf, type AttributionRule, type OrderRow, type Pair, type SellAttribution, type SellFillKey, type SellPick } from './sell-match'

export interface SellInput extends SellFillKey { bucketIdx?: number | null; evidence?: OrderEvidence }

const bucketsOf = (ps: Pair[]): Set<number> => new Set(ps.map((p) => p.order.bucketIdx))
const keep = (ps: Pair[], test: (p: Pair) => boolean): Pair[] => { const kept = ps.filter(test); return kept.length ? kept : ps }
function nearest(ps: Pair[], metric: (p: Pair) => bigint): Pair[] {
  const best = ps.reduce((m, p) => { const d = metric(p); return d < m ? d : m }, metric(ps[0]!))
  return ps.filter((p) => metric(p) === best)
}

// Which bucket, and which order, does a sell fill belong to? The broker's order type decides
// (spec: order-type attribution, section 4). Pool: this run's orders dated on the fill day,
// open or stale. A candidate is a pool order of the typed kind whose bucket covers the fill
// and whose price fits. The candidates are narrowed by order price (targets), ordered shares,
// remaining shares and fill price, each step skipped when it would leave nothing, then the
// bucket bought earliest wins. With no candidate the bucket is decided by holdings alone, and
// the operator chooses (DomainError 'choose-bucket') whenever that is still ambiguous. A
// bucket the operator gave is never attributed. The order flipped for an emptied bucket is
// the candidate left, else the bucket's order of the typed kind; a typed fill with no such
// order flips nothing, so every open leg of the emptied bucket is cancelled and announced.
// An untyped fill takes the matchForcedLeg one.
export function attributeSell(orders: OrderRow[], state: RunState, input: SellInput): SellPick {
  const ev = input.evidence ?? NO_EVIDENCE
  const kind = kindOfType(ev.type)
  const pool = poolOf(orders, input)
  const bucketOf = (idx: number): Bucket | undefined => state.buckets.find((b) => b.index === idx)
  const covers = (p: Pair): boolean => { const b = bucketOf(p.order.bucketIdx); return !!b && b.state !== 'empty' && b.shares >= input.shares }
  const decided = (bucketIdx: number): SellPick => ({ bucketIdx, orderId: flippedOrder(orders, pool, input, ev, bucketIdx), attribution: null })

  if (input.bucketIdx != null) return decided(input.bucketIdx)
  const candidates = kind ? pool.filter((p) => p.order.kind === kind && covers(p) && fits(p, input.price)) : []
  if (candidates.length) return decideAmong(candidates, state, input, ev)

  if (kind === null) {
    const fitting = bucketsOf(pool.filter((p) => covers(p) && fits(p, input.price)))
    if (fitting.size === 1) return decided([...fitting][0]!)
    if (fitting.size > 1) throw new DomainError('choose-bucket')
  }
  const holders = state.buckets.filter((b) => b.state !== 'empty' && b.shares >= input.shares)
  if (!holders.length) throw new DomainError('no-bucket-for-sell')
  if (holders.length > 1 || kind === 'market_sell') throw new DomainError('choose-bucket')
  return decided(holders[0]!.index)
}

export function sellNeedsChoice(orders: OrderRow[], state: RunState, input: SellInput): boolean {
  if (input.bucketIdx != null) return false
  try {
    attributeSell(orders, state, input)
    return false
  } catch (e) {
    return e instanceof DomainError && e.kind === 'choose-bucket'
  }
}

function decideAmong(cands: Pair[], state: RunState, input: SellInput, ev: OrderEvidence): SellPick {
  const holds = (p: Pair): Bucket => state.buckets.find((b) => b.index === p.order.bucketIdx)!
  const priced = ev.type === 'target' && ev.orderPrice !== null && ev.orderPrice > 0n
  const s1 = priced ? nearest(cands, (p) => absDiff(p.order.limitPrice, ev.orderPrice!)) : cands
  const s2 = ev.orderedShares === null ? s1 : keep(s1, (p) => p.order.shares === ev.orderedShares)
  const s3 = keep(s2, (p) => holds(p).shares === input.shares)
  const s4 = ev.type === 'market' ? s3 : nearest(s3, (p) => (isPrice(p) ? p.leg.distance : 0n))
  const byAge = (a: Pair, b: Pair): number => holds(a).filledOn.localeCompare(holds(b).filledOn) || byBucket(a, b)
  const chosen = [...s4].sort(byAge)[0]!

  // A notice exists only when the candidates span more than one bucket, so a step that did not
  // run (s1 unpriced, s2 without ordered shares) still spans them and is never the labelled rule.
  const others = cands.filter((p) => p.order.bucketIdx !== chosen.order.bucketIdx)
  const quiet = priced && bucketsOf(s1).size === 1 && s1[0]!.order.limitPrice === ev.orderPrice
  const steps: Array<[AttributionRule, Pair[]]> = [['order-price', s1], ['ordered-shares', s2], ['shares', s3], ['price', s4]]
  const rule: AttributionRule = steps.find(([, ps]) => bucketsOf(ps).size === 1)?.[0] ?? 'older'
  const alternatives = [
    ...others.filter(isPrice).sort(nearestFirst),
    ...others.filter((p) => !isPrice(p)).sort(byBucket),
  ].map((p) => p.leg)
  const attribution: SellAttribution | null = others.length && !quiet
    ? { shares: input.shares, price: input.price, rule, chosen: chosen.leg, alternatives }
    : null
  return { bucketIdx: chosen.order.bucketIdx, orderId: chosen.order.id, attribution }
}

function flippedOrder(orders: OrderRow[], pool: Pair[], input: SellInput, ev: OrderEvidence, bucketIdx: number): number | null {
  const kind = kindOfType(ev.type)
  const own = kind ? pool.filter((p) => p.order.bucketIdx === bucketIdx && p.order.kind === kind).map((p) => p.order).sort((a, b) => a.id - b.id) : []
  if (own.length) return (own.find((o) => o.shares === ev.orderedShares) ?? own.find((o) => o.shares === input.shares) ?? own[0]!).id
  if (kind) return null
  return matchForcedLeg(orders, { ...input, bucketIdx })?.id ?? null
}
