import { test, expect } from 'bun:test'
import { emptyState, applyBuyFill, applySellFill, advanceDay } from '../src/fills'
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
  expect(out.closed.length).toBe(0)
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
  const cb = out.closed[0]!
  expect(cb.openedOn).toBe('2026-01-02')
  expect(cb.closedOn).toBe('2026-02-05')
  expect(cb.buyFeeCents).toBe(20)
  expect(cb.sellFeeCents).toBe(21)
  const realized = Number(roundDiv((cb.soldPrice - cb.buyPrice) * BigInt(cb.shares), 100n)) - cb.buyFeeCents - cb.sellFeeCents
  expect(realized).toBe(35959)
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
