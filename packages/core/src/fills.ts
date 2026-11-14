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
 * else null when every bucket is held. Shared by planning and booking so
 * the two can never drift.
 */
export function nextBuyBucketIndex(state: RunState): number | null {
  const closedIdx = new Set(state.closed.map((c) => c.index))
  let fallback: number | null = null
  for (const b of state.buckets) {
    if (b.state !== 'empty') continue
    if (!closedIdx.has(b.index)) return b.index
    if (fallback === null) fallback = b.index
  }
  return fallback
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
    nb.shares = bucket.shares - shares
  }
  next.cashCents += proceeds - feeCents
  return next
}