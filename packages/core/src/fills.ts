import { roundDiv } from './money'
import { DomainError } from './domain'
import type { Bucket, ClosedBucket, ISODate, RunState } from './domain'

function clone(state: RunState): RunState {
  return {
    buckets: state.buckets.map((b) => ({ ...b })),
    cashCents: state.cashCents,
    closed: state.closed.map((c) => ({ ...c })),
    ages: { ...state.ages },
  }
}

export function emptyState(bucketCount: number): RunState {
  const buckets: Bucket[] = []
  for (let i = 0; i < bucketCount; i++) {
    buckets.push({ index: i, state: 'empty', shares: 0, buyPrice: 0n, buyFeeCents: 0, filledOn: '' })
  }
  return { buckets, cashCents: 0, closed: [], ages: {} }
}

/**
 * Bucket a next buy should take: the lowest empty index never present in
 * `closed` (never used), else the lowest empty (previously closed) index,
 * else null when no bucket is empty. Shared by planning and booking so
 * the two can never drift. With `buyOn`, buckets that closed a tranche on
 * that day are skipped (no sell and buy on the same day in one bucket).
 */
export function nextBuyBucketIndex(state: RunState, buyOn?: ISODate): number | null {
  const closedIdx = new Set(state.closed.map((c) => c.index))
  const closedToday = new Set(
    buyOn === undefined ? [] : state.closed.filter((c) => c.closedOn === buyOn).map((c) => c.index),
  )
  let fresh: number | null = null
  let fallback: number | null = null
  for (const b of state.buckets) {
    if (b.state !== 'empty') continue
    if (closedToday.has(b.index)) continue
    // Min explicitly so "lowest" never relies on bucket array order.
    if (closedIdx.has(b.index)) fallback = fallback === null ? b.index : Math.min(fallback, b.index)
    else fresh = fresh === null ? b.index : Math.min(fresh, b.index)
  }
  return fresh ?? fallback
}

export function advanceDay(state: RunState, maxAgeDays = 20): RunState {
  const next = clone(state)
  for (const b of next.buckets) {
    if (b.state === 'held' || b.state === 'force_sell') {
      const idx = b.index
      const newAge = (next.ages[idx] ?? 0) + 1
      next.ages[idx] = newAge
      if (b.state === 'held' && newAge > maxAgeDays) {
        b.state = 'force_sell'
      }
    }
  }
  return next
}

export function applyBuyFill(
  state: RunState,
  bucketIndex: number,
  shares: number,
  price: bigint,
  feeCents: number,
  filledOn: ISODate = '',
): RunState {
  const bucket = state.buckets[bucketIndex]
  if (!bucket) {
    throw new DomainError('bucket-not-found')
  }
  if (bucket.state !== 'empty') {
    throw new DomainError('bucket-not-empty')
  }
  if (!Number.isInteger(shares) || shares <= 0) {
    throw new DomainError('invalid-shares')
  }
  const next = clone(state)
  const cost = Number(roundDiv(price * BigInt(shares), 100n))
  const nb = next.buckets[bucketIndex]!
  nb.state = 'held'
  nb.shares = shares
  nb.buyPrice = price
  nb.buyFeeCents = feeCents
  nb.filledOn = filledOn
  next.ages[bucketIndex] = 0
  next.cashCents -= cost + feeCents
  return next
}

/**
 * True for a `held` bucket that has not been partly sold: no closed tranche
 * of this index was opened on the bucket's current `filledOn`.
 */
export function isMergeableBucket(state: RunState, bucketIndex: number): boolean {
  const b = state.buckets[bucketIndex]
  if (!b || b.state !== 'held') return false
  return !state.closed.some((c) => c.index === bucketIndex && c.openedOn === b.filledOn)
}

/** Lowest mergeable bucket filled on `filledOn`, else null. */
export function sameDayBuyBucketIndex(state: RunState, filledOn: ISODate): number | null {
  let best: number | null = null
  for (const b of state.buckets) {
    if (b.filledOn !== filledOn || !isMergeableBucket(state, b.index)) continue
    best = best === null ? b.index : Math.min(best, b.index)
  }
  return best
}

/** Adds another execution of a buy to a held bucket at the weighted-average price. */
export function addBuyFill(
  state: RunState,
  bucketIndex: number,
  shares: number,
  price: bigint,
  feeCents: number,
  opts: { checkMergeable?: boolean } = {},
): RunState {
  const bucket = state.buckets[bucketIndex]
  if (!bucket) throw new DomainError('bucket-not-found')
  if (bucket.state === 'empty') throw new DomainError('bucket-not-held')
  // History replay passes checkMergeable: false so existing data always rebuilds.
  if ((opts.checkMergeable ?? true) && !isMergeableBucket(state, bucketIndex)) throw new DomainError('bucket-not-mergeable')
  if (!Number.isInteger(shares) || shares <= 0) throw new DomainError('invalid-shares')
  const next = clone(state)
  const nb = next.buckets[bucketIndex]!
  const n = BigInt(shares)
  const total = BigInt(bucket.shares) + n
  nb.buyPrice = roundDiv(bucket.buyPrice * BigInt(bucket.shares) + price * n, total)
  nb.shares = bucket.shares + shares
  nb.buyFeeCents = bucket.buyFeeCents + feeCents
  next.cashCents -= Number(roundDiv(price * n, 100n)) + feeCents
  return next
}

export function applySellFill(
  state: RunState,
  bucketIndex: number,
  shares: number,
  price: bigint,
  feeCents: number,
  closedOn: ISODate = '',
): RunState {
  const bucket = state.buckets[bucketIndex]
  if (!bucket) {
    throw new DomainError('bucket-not-found')
  }
  if (bucket.state === 'empty') {
    throw new DomainError('bucket-not-held')
  }
  if (!Number.isInteger(shares) || shares <= 0) {
    throw new DomainError('invalid-shares')
  }
  if (shares > bucket.shares) {
    throw new DomainError('too-many-shares')
  }
  const next = clone(state)
  const nb = next.buckets[bucketIndex]!
  const proceeds = Number(roundDiv(price * BigInt(shares), 100n))
  if (shares === bucket.shares) {
    const closedEntry: ClosedBucket = {
      index: bucket.index,
      shares: bucket.shares,
      buyPrice: bucket.buyPrice,
      soldPrice: price,
      buyFeeCents: bucket.buyFeeCents,
      sellFeeCents: feeCents,
      openedOn: bucket.filledOn,
      closedOn,
    }
    next.closed = [...next.closed, closedEntry]
    nb.state = 'empty'
    nb.shares = 0
    nb.buyPrice = 0n
    nb.buyFeeCents = 0
    nb.filledOn = ''
    delete next.ages[bucketIndex]
  } else {
    const buyFeePart = Math.round((bucket.buyFeeCents * shares) / bucket.shares)
    const trancheEntry: ClosedBucket = {
      index: bucket.index,
      shares,
      buyPrice: bucket.buyPrice,
      soldPrice: price,
      buyFeeCents: buyFeePart,
      sellFeeCents: feeCents,
      openedOn: bucket.filledOn,
      closedOn,
    }
    next.closed = [...next.closed, trancheEntry]
    nb.shares = bucket.shares - shares
    nb.buyFeeCents = bucket.buyFeeCents - buyFeePart
  }
  next.cashCents += proceeds - feeCents
  return next
}