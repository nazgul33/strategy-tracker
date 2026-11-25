import { describe, test, expect } from 'bun:test'
import { VR_MAX_RUNGS, buyRungs, remainingRungs, sellRungs } from '@st/strategies/value-rebalancing'

const HUGE = 1_000_000_000_000

describe('buy rungs', () => {
  test('176 shares, lot 3, under a 10,509.46 minimum', () => {
    const rungs = buyRungs({ minCents: 1_050_946, openShares: 176, lot: 3, budgetCents: 100_000_000, poolCents: 100_000_000 })
    expect(rungs.slice(0, 4)).toEqual([{ shares: 3, price: 597_100n }, { shares: 3, price: 587_100n }, { shares: 3, price: 577_400n }, { shares: 3, price: 568_000n }])
    expect(rungs).toHaveLength(27)
    expect(rungs.at(-1)!.price).toBe(413_700n)
  })
  test('prices are floored, and the budget and the Pool both cap the side (lot 1)', () => {
    const at = (budgetCents: number, poolCents: number) => buyRungs({ minCents: 1_050_946, openShares: 176, lot: 1, budgetCents, poolCents })
    expect(at(29_521, 38_314).map((r) => r.price)).toEqual([597_100n, 593_700n, 590_400n, 587_100n, 583_800n])
    expect(at(29_520, 38_314)).toHaveLength(4)
    expect(at(1_000_000, 29_520)).toHaveLength(4)
  })
  test('a rung is listed only if the whole lot fits the budget', () => {
    const at = (budgetCents: number) => buyRungs({ minCents: 1_050_946, openShares: 176, lot: 3, budgetCents, poolCents: 100_000_000 })
    expect(at(17_913)).toHaveLength(1)
    expect(at(17_912)).toHaveLength(0)
  })
  test('empty at 0 opening shares and when the Pool or the budget is 0 or negative', () => {
    const base = { minCents: 1_050_946, openShares: 176, lot: 1, budgetCents: HUGE, poolCents: HUGE }
    expect(buyRungs({ ...base, openShares: 0 })).toEqual([])
    expect(buyRungs({ ...base, lot: 0 })).toEqual([])
    expect(buyRungs({ ...base, poolCents: 0 })).toEqual([])
    expect(buyRungs({ ...base, poolCents: -100 })).toEqual([])
    expect(buyRungs({ ...base, budgetCents: 0 })).toEqual([])
    expect(buyRungs({ ...base, budgetCents: -100 })).toEqual([])
  })
  test('never more than 30 rungs', () => {
    expect(buyRungs({ minCents: 10_000_000, openShares: 1000, lot: 1, budgetCents: HUGE, poolCents: HUGE })).toHaveLength(VR_MAX_RUNGS)
  })
  test('stops at a price of 0 cents', () => {
    const rungs = buyRungs({ minCents: 1, openShares: 1, lot: 1, budgetCents: HUGE, poolCents: HUGE })
    expect(rungs.map((r) => r.price)).toEqual([100n])
  })
})

describe('sell rungs', () => {
  test('177 shares, lot 2, under a 10,752.50 maximum', () => {
    const rungs = sellRungs({ maxCents: 1_075_250, openShares: 177, lot: 2 })
    expect(rungs.slice(0, 3)).toEqual([{ shares: 2, price: 607_500n }, { shares: 2, price: 614_500n }, { shares: 2, price: 621_600n }])
    expect(rungs).toHaveLength(22)
    expect(rungs.at(-1)!.price).toBe(796_500n)
  })
  test('never more than 30 rungs, never the last share', () => {
    expect(sellRungs({ maxCents: 10_000_000, openShares: 1000, lot: 1 })).toHaveLength(VR_MAX_RUNGS)
    expect(sellRungs({ maxCents: 1_075_250, openShares: 2, lot: 1 })).toHaveLength(1)
    expect(sellRungs({ maxCents: 1_075_250, openShares: 2, lot: 2 })).toEqual([])
    expect(sellRungs({ maxCents: 1_075_250, openShares: 1, lot: 1 })).toEqual([])
  })
  test('empty at 0 opening shares', () => {
    expect(sellRungs({ maxCents: 1_075_250, openShares: 0, lot: 1 })).toEqual([])
  })
})

describe('owner rounding', () => {
  test('buy prices floor to the cent', () => {
    const at = (minCents: number) => buyRungs({ minCents, openShares: 100, lot: 1, budgetCents: HUGE, poolCents: HUGE })[0]!.price
    expect(at(593_780)).toBe(593_700n)
    expect(at(583_850)).toBe(583_800n)
  })
  test('sell prices ceiling to the cent', () => {
    const at = (maxCents: number) => sellRungs({ maxCents, openShares: 100, lot: 1 })[0]!.price
    expect(at(593_789)).toBe(593_800n)
    expect(at(583_814)).toBe(583_900n)
  })
})

describe('remainingRungs', () => {
  test('what is left of a side after fills', () => {
    const side = [{ shares: 3, price: 30n }, { shares: 3, price: 20n }, { shares: 3, price: 10n }]
    expect(remainingRungs(side, 0)).toEqual(side)
    expect(remainingRungs(side, -2)).toEqual(side)
    expect(remainingRungs(side, 3)).toEqual(side.slice(1))
    expect(remainingRungs(side, 4)).toEqual([{ shares: 2, price: 20n }, { shares: 3, price: 10n }])
    expect(remainingRungs(side, 9)).toEqual([])
    expect(remainingRungs(side, 50)).toEqual([])
  })
})
