import { test, expect, describe } from 'bun:test'
import { emptyState, applyBuyFill, applySellFill, advanceDay, nextBuyBucketIndex, addBuyFill, isMergeableBucket, sameDayBuyBucketIndex } from '../src/fills'
import { DomainError } from '../src/domain'
import { roundDiv } from '../src/money'

test('buy fill', () => {
  const s = emptyState(10)
  s.cashCents = 5_000_000
  const out = applyBuyFill(s, 0, 55, 3402300n, 34)
  expect(out.buckets[0]!.state).toBe('held')
  expect(out.buckets[0]!.shares).toBe(55)
  expect(out.buckets[0]!.buyPrice).toBe(3402300n)
  const cost = Number(roundDiv(3402300n * 55n, 100n))
  expect(out.cashCents).toBe(5_000_000 - (cost + 34))
  // input not mutated
  expect(s.buckets[0]!.state).toBe('empty')
  expect(s.cashCents).toBe(5_000_000)
})

test('partial sell', () => {
  const s = emptyState(1); s.cashCents = 0
  const b = applyBuyFill(s, 0, 300, 1000000n, 0)
  const out = applySellFill(b, 0, 120, 1020000n, 21)
  expect(out.buckets[0]!.state).toBe('held')
  expect(out.buckets[0]!.shares).toBe(180)
  expect(out.buckets[0]!.buyPrice).toBe(1000000n)
  // 2026-11-14: partial sells now record a tranche row (spec 2026-11-14-partial-sell-history)
  expect(out.closed.length).toBe(1)
  expect(out.closed[0]).toEqual({
    index: 0, shares: 120, buyPrice: 1000000n, soldPrice: 1020000n,
    buyFeeCents: 0, sellFeeCents: 21, openedOn: '', closedOn: '',
  })
  const proceeds = Number(roundDiv(1020000n * 120n, 100n))
  // cash increased by proceeds - 21 relative to after buy
  expect(out.cashCents - b.cashCents).toBe(proceeds - 21)
})

test('full sell', () => {
  const s = emptyState(1); s.cashCents = 0
  const b = applyBuyFill(s, 0, 300, 1000000n, 20, '2026-01-02')
  const p = applySellFill(b, 0, 120, 1020000n, 21)
  const out = applySellFill(p, 0, 180, 1020000n, 21, '2026-02-05')
  expect(out.buckets[0]!.state).toBe('empty')
  expect(out.buckets[0]!.shares).toBe(0)
  expect(out.buckets[0]!.buyPrice).toBe(0n)
  // 2026-11-14: the partial tranche now precedes the closing row (spec 2026-11-14-partial-sell-history)
  expect(out.closed.length).toBe(2)
  const cb = out.closed[1]!
  expect(cb.openedOn).toBe('2026-01-02')
  expect(cb.closedOn).toBe('2026-02-05')
  expect(cb.buyFeeCents).toBe(12) // 20 - round(20 * 120 / 300)
  expect(cb.sellFeeCents).toBe(21)
  const realized = Number(roundDiv((cb.soldPrice - cb.buyPrice) * BigInt(cb.shares), 100n)) - cb.buyFeeCents - cb.sellFeeCents
  expect(realized).toBe(35967)
})

test('throws', () => {
  const s = emptyState(1)
  const b = applyBuyFill(s, 0, 10, 1000000n, 0)
  expect(() => applySellFill(b, 0, 11, 1000000n, 0)).toThrow(DomainError)
  expect(() => applySellFill(emptyState(1), 0, 1, 1000000n, 0)).toThrow(DomainError)
  expect(() => applyBuyFill(b, 0, 1, 1000000n, 0)).toThrow(DomainError)
})

test('error kinds', () => {
  const s = emptyState(1)
  const b = applyBuyFill(s, 0, 10, 1000000n, 0)
  // invalid shares on buy
  for (const bad of [0, -1, 1.5, NaN]) {
    expect(() => applyBuyFill(s, 0, bad, 1000000n, 0)).toThrow(DomainError)
    try { applyBuyFill(s, 0, bad, 1000000n, 0) } catch (e) {
      expect((e as DomainError).kind).toBe('invalid-shares')
    }
  }
  // invalid shares on sell (NaN would otherwise slip past shares > held check)
  for (const bad of [0, -1, 1.5, NaN]) {
    expect(() => applySellFill(b, 0, bad, 1000000n, 0)).toThrow(DomainError)
    try { applySellFill(b, 0, bad, 1000000n, 0) } catch (e) {
      expect((e as DomainError).kind).toBe('invalid-shares')
    }
  }
  // out-of-range bucket index
  try { applyBuyFill(s, 10, 1, 1000000n, 0) } catch (e) {
    expect((e as DomainError).kind).toBe('bucket-not-found')
  }
  try { applySellFill(b, -1, 1, 1000000n, 0) } catch (e) {
    expect((e as DomainError).kind).toBe('bucket-not-found')
  }
})

test('cents rounding via roundDiv (buy cost and sell proceeds)', () => {
  // buy: 3402301 * 3 = 10206903 / 100 = 102069.03 -> rounds DOWN to 102069
  const s = emptyState(1); s.cashCents = 500_000
  const out = applyBuyFill(s, 0, 3, 3402301n, 0)
  expect(out.cashCents).toBe(500_000 - 102_069)
  // sell: 1000050 * 3 = 3000150 / 100 = 30001.5 -> half-up to 30002
  const sold = applySellFill(out, 0, 3, 1000050n, 0)
  expect(sold.cashCents - out.cashCents).toBe(30_002)
})

test('advanceDay 20/21', () => {
  const s = emptyState(1)
  const b = applyBuyFill(s, 0, 10, 1000000n, 0)
  let cur: any = b
  for (let i = 0; i < 20; i++) cur = advanceDay(cur)
  expect(cur.buckets[0].state).toBe('held')
  expect(cur.ages[0]).toBe(20)
  cur = advanceDay(cur)
  expect(cur.buckets[0].state).toBe('force_sell')
  expect(cur.ages[0]).toBe(21)
  // empty bucket no age
  const e = emptyState(1)
  const e2 = advanceDay(e)
  expect(e2.ages[0]).toBeUndefined()
  // input not mutated
  expect(b.buckets[0].state).toBe('held')
})

test('force_sell partial preserves', () => {
  const s = emptyState(1)
  const b = applyBuyFill(s, 0, 10, 1000000n, 0)
  let cur: any = b
  for (let i = 0; i < 21; i++) cur = advanceDay(cur)
  const out = applySellFill(cur, 0, 3, 1000000n, 0)
  expect(out.buckets[0].state).toBe('force_sell')
  expect(out.buckets[0].shares).toBe(7)
  // age preserved
  expect(out.ages[0]).toBe(21)
})

test('advanceDay honors custom maxAgeDays', () => {
  const s = emptyState(1)
  // custom small threshold: flip when age > 2
  let cur: any = applyBuyFill(s, 0, 10, 1000000n, 0)
  cur = advanceDay(cur, 2)
  expect(cur.buckets[0].state).toBe('held')
  expect(cur.ages[0]).toBe(1)
  cur = advanceDay(cur, 2)
  expect(cur.buckets[0].state).toBe('held')
  expect(cur.ages[0]).toBe(2)
  cur = advanceDay(cur, 2)
  expect(cur.buckets[0].state).toBe('force_sell')
  expect(cur.ages[0]).toBe(3)
  // custom large threshold: no flip at the default-20 boundary
  let big: any = applyBuyFill(s, 0, 10, 1000000n, 0)
  for (let i = 0; i < 21; i++) big = advanceDay(big, 30)
  expect(big.buckets[0].state).toBe('held')
  expect(big.ages[0]).toBe(21)
  // omitted arg keeps default 20
  let def: any = applyBuyFill(s, 0, 10, 1000000n, 0)
  for (let i = 0; i < 20; i++) def = advanceDay(def)
  expect(def.buckets[0].state).toBe('held')
  def = advanceDay(def)
  expect(def.buckets[0].state).toBe('force_sell')
})

test('advanceDay keeps incrementing force_sell', () => {
  const s = emptyState(1)
  let cur: any = applyBuyFill(s, 0, 10, 1000000n, 0)
  cur = advanceDay(cur)
  expect(cur.ages[0]).toBe(1) // first increment visible, not just final state
  for (let i = 0; i < 20; i++) cur = advanceDay(cur)
  expect(cur.buckets[0].state).toBe('force_sell')
  expect(cur.ages[0]).toBe(21)
  cur = advanceDay(cur)
  expect(cur.buckets[0].state).toBe('force_sell') // stays force_sell
  expect(cur.ages[0]).toBe(22) // keeps counting, capped at no ceiling
})

test('state survives JSON round-trip (ages keys become strings)', () => {
  // DB persistence will JSON-serialise ages -> keys are strings; numeric indexing still works
  const s = emptyState(1)
  let cur: any = applyBuyFill(s, 0, 10, 1000000n, 0)
  cur = advanceDay(cur)
  const revived = JSON.parse(JSON.stringify({ ...cur, buckets: cur.buckets.map((b: any) => ({ ...b, buyPrice: b.buyPrice.toString() })) }))
  for (const b of revived.buckets) b.buyPrice = BigInt(b.buyPrice)
  expect(revived.ages['0']).toBe(1)
  const next = advanceDay(revived)
  expect(next.ages[0]).toBe(2)
  const sold = applySellFill(next, 0, 10, 1000000n, 0, '2026-02-05')
  expect(sold.buckets[0].state).toBe('empty')
  expect(sold.ages[0]).toBeUndefined()
})

describe('nextBuyBucketIndex', () => {
  test('fresh state and progressively filled buckets', () => {
    const s0 = emptyState(3)
    expect(nextBuyBucketIndex(s0)).toBe(0)
    const s1 = applyBuyFill(s0, 0, 10, 1000000n, 0)
    expect(nextBuyBucketIndex(s1)).toBe(1)
    const s2 = applyBuyFill(s1, 1, 10, 1000000n, 0)
    expect(nextBuyBucketIndex(s2)).toBe(2)
    const s3 = applyBuyFill(s2, 2, 10, 1000000n, 0)
    expect(nextBuyBucketIndex(s3)).toBeNull()
  })

  test('skips a closed bucket', () => {
    let s = emptyState(3)
    s = applyBuyFill(s, 0, 10, 1000000n, 0)
    s = applySellFill(s, 0, 10, 1000000n, 0, '2026-01-05')
    // bucket 0 is empty again but closed
    expect(s.buckets[0]!.state).toBe('empty')
    expect(s.closed.some((c) => c.index === 0)).toBe(true)
    expect(nextBuyBucketIndex(s)).toBe(1)
  })

  test('closed bucket in the middle', () => {
    let s = emptyState(3)
    s = applyBuyFill(s, 1, 10, 1000000n, 0)
    s = applySellFill(s, 1, 10, 1000000n, 0, '2026-01-05')
    // buckets 0 and 2 are empty and never used
    expect(nextBuyBucketIndex(s)).toBe(0)
    s = applyBuyFill(s, 0, 10, 1000000n, 0)
    expect(nextBuyBucketIndex(s)).toBe(2)
  })

  test('all closed falls back to the lowest closed index', () => {
    let s = emptyState(2)
    s = applyBuyFill(s, 0, 10, 1000000n, 0)
    s = applySellFill(s, 0, 10, 1000000n, 0, '2026-01-05')
    s = applyBuyFill(s, 1, 10, 1000000n, 0)
    s = applySellFill(s, 1, 10, 1000000n, 0, '2026-01-06')
    expect(s.closed.length).toBe(2)
    expect(nextBuyBucketIndex(s)).toBe(0)
  })

  test('held buckets are ignored even when a closed one is free', () => {
    let s = emptyState(2)
    s = applyBuyFill(s, 0, 10, 1000000n, 0)
    s = applySellFill(s, 0, 10, 1000000n, 0, '2026-01-05')
    s = applyBuyFill(s, 1, 10, 1000000n, 0)
    // bucket 0 is empty but closed; bucket 1 is held. No never-used bucket
    // remains, so the fallback takes the free closed bucket 0; the held
    // bucket 1 does not block the pick. (The plan text said null here, but
    // null is only for an all-held state with no empty bucket at all — see
    // docs/superpowers/specs/2026-11-14-buy-next-bucket-design.md.)
    expect(s.buckets[1]!.state).toBe('held')
    expect(nextBuyBucketIndex(s)).toBe(0)
  })
})

test('partial sell appends a tranche row', () => {
  const s = emptyState(1); s.cashCents = 0
  const b = applyBuyFill(s, 0, 300, 1000000n, 7, '2026-01-02')
  const out = applySellFill(b, 0, 120, 1020000n, 21, '2026-01-09')
  expect(out.closed.length).toBe(1)
  expect(out.closed[0]).toEqual({
    index: 0, shares: 120, buyPrice: 1000000n, soldPrice: 1020000n,
    buyFeeCents: 3, sellFeeCents: 21, openedOn: '2026-01-02', closedOn: '2026-01-09',
  })
  expect(out.buckets[0]!.state).toBe('held')
  expect(out.buckets[0]!.shares).toBe(180)
  expect(out.buckets[0]!.buyPrice).toBe(1000000n)
  expect(out.buckets[0]!.buyFeeCents).toBe(4) // 7 - round(7 * 120 / 300)
})

test('buy fees sum exactly across partial and closing rows', () => {
  const s = emptyState(1); s.cashCents = 0
  const b = applyBuyFill(s, 0, 300, 1000000n, 7, '2026-01-02')
  const p = applySellFill(b, 0, 120, 1020000n, 21, '2026-01-09')
  const out = applySellFill(p, 0, 180, 990000n, 25, '2026-02-01')
  expect(out.closed.length).toBe(2)
  expect(out.closed.reduce((n, c) => n + c.buyFeeCents, 0)).toBe(7)
  expect(out.closed.reduce((n, c) => n + c.sellFeeCents, 0)).toBe(46)
  expect(out.buckets[0]!.state).toBe('empty')
})

test('over-sell guard survives partial rows', () => {
  const s = emptyState(1); s.cashCents = 0
  const b = applyBuyFill(s, 0, 300, 1000000n, 0)
  const p = applySellFill(b, 0, 250, 1020000n, 0)
  expect(() => applySellFill(p, 0, 51, 1020000n, 0)).toThrow() // DomainError too-many-shares
})

function tranche(index: number, openedOn: string, closedOn: string) {
  return { index, shares: 1, buyPrice: 100n, soldPrice: 110n, buyFeeCents: 0, sellFeeCents: 0, openedOn, closedOn }
}

describe('addBuyFill', () => {
  const D = '2026-11-24'
  function held() {
    const s = emptyState(10)
    s.cashCents = 5_000_000
    return applyBuyFill(s, 5, 26, 378500n, 69, D)
  }

  test('merges the 2026-11-24 rungs into one bucket at the weighted average', () => {
    const a = addBuyFill(held(), 5, 26, 371000n, 68)
    const b = addBuyFill(a, 5, 94, 319896n, 210)
    const bk = b.buckets[5]!
    expect(bk.shares).toBe(146)
    expect(bk.buyPrice).toBe(339433n)
    expect(bk.buyFeeCents).toBe(347)
    expect(bk.filledOn).toBe(D)
    expect(bk.state).toBe('held')
    const c = (p: bigint, n: bigint) => Number(roundDiv(p * n, 100n))
    expect(b.cashCents).toBe(
      5_000_000 - (c(378500n, 26n) + 69) - (c(371000n, 26n) + 68) - (c(319896n, 94n) + 210),
    )
  })

  test('refuses an empty bucket with bucket-not-held', () => {
    expect(() => addBuyFill(emptyState(3), 1, 5, 100n, 0)).toThrow(new DomainError('bucket-not-held'))
  })

  test('refuses an unknown bucket and bad shares', () => {
    expect(() => addBuyFill(held(), 99, 5, 100n, 0)).toThrow(new DomainError('bucket-not-found'))
    expect(() => addBuyFill(held(), 5, 0, 100n, 0)).toThrow(new DomainError('invalid-shares'))
  })

  test('keeps the age', () => {
    const s = held()
    s.ages[5] = 3
    expect(addBuyFill(s, 5, 2, 100n, 0).ages[5]).toBe(3)
  })

  test('refuses a force_sell bucket with bucket-not-mergeable', () => {
    const s = held()
    s.buckets[5]!.state = 'force_sell'
    expect(() => addBuyFill(s, 5, 2, 100n, 0)).toThrow(new DomainError('bucket-not-mergeable'))
  })

  test('refuses a partly sold bucket with bucket-not-mergeable', () => {
    const s = applyBuyFill(emptyState(2), 0, 10, 1000000n, 0, D)
    const p = applySellFill(s, 0, 4, 1100000n, 0, D)
    expect(() => addBuyFill(p, 0, 6, 800000n, 0)).toThrow(new DomainError('bucket-not-mergeable'))
  })
})

describe('nextBuyBucketIndex with buyOn', () => {
  const D = '2026-11-24'
  test('skips buckets closed on the buy day', () => {
    const s = emptyState(3)
    s.closed = [tranche(0, 'a', D), tranche(1, 'a', '2026-11-20'), tranche(2, 'a', D)]
    expect(nextBuyBucketIndex(s)).toBe(0)
    expect(nextBuyBucketIndex(s, D)).toBe(1)
    s.closed.push(tranche(1, 'b', D))
    expect(nextBuyBucketIndex(s, D)).toBeNull()
  })
  test('still prefers a never-used bucket', () => {
    const s = emptyState(4)
    s.closed = [tranche(0, 'a', D), tranche(1, 'a', '2026-11-20'), tranche(2, 'a', D)]
    expect(nextBuyBucketIndex(s, D)).toBe(3)
  })
})

describe('isMergeableBucket', () => {
  const D = '2026-11-24'
  test('held is mergeable; empty, force_sell, partly sold are not', () => {
    const s = applyBuyFill(emptyState(4), 0, 10, 1000000n, 0, D)
    expect(isMergeableBucket(s, 0)).toBe(true)
    expect(isMergeableBucket(s, 1)).toBe(false)
    const f = applyBuyFill(emptyState(1), 0, 10, 1000000n, 0, D)
    f.buckets[0]!.state = 'force_sell'
    expect(isMergeableBucket(f, 0)).toBe(false)
    expect(isMergeableBucket(applySellFill(s, 0, 4, 1100000n, 0, D), 0)).toBe(false)
  })
  test('an older closed tranche on the index does not block a later re-buy', () => {
    const s = applyBuyFill(emptyState(1), 0, 10, 1000000n, 0, D)
    s.closed = [tranche(0, '2026-11-01', '2026-11-10')]
    expect(isMergeableBucket(s, 0)).toBe(true)
  })
})

describe('sameDayBuyBucketIndex', () => {
  test('lowest mergeable bucket held on that day', () => {
    let s = emptyState(8)
    s = applyBuyFill(s, 5, 10, 1000000n, 0, '2026-11-24')
    s = applyBuyFill(s, 3, 10, 1000000n, 0, '2026-11-24')
    s = applyBuyFill(s, 1, 10, 1000000n, 0, '2026-11-20')
    expect(sameDayBuyBucketIndex(s, '2026-11-24')).toBe(3)
    expect(sameDayBuyBucketIndex(s, '2026-11-20')).toBe(1)
    expect(sameDayBuyBucketIndex(s, '2026-11-25')).toBeNull()
    const p = applySellFill(s, 3, 4, 1100000n, 0, '2026-11-24')
    expect(sameDayBuyBucketIndex(p, '2026-11-24')).toBe(5)
  })
})
