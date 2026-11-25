import { describe, test, expect } from 'bun:test'
import {
  DEFAULT_VR_SETTINGS, VALUE_REBALANCING, VR_CYCLE_DAYS, VR_MAX_RUNGS, VR_LADDER_COVER_PPM,
  addDays, avgCost, buyBudgetCents, buyInstructionShares, buyLot, cycleDue, evalCents, fillCostCents,
  nextScheduledStart, nextV, sellLot, sharesInCycle, spentInCycleCents, vrBand, vrBooks,
} from '@st/strategies/value-rebalancing'
import type { VrCashMove, VrFill } from '@st/strategies/value-rebalancing'

describe('constants', () => {
  test('pinned values', () => {
    expect(VALUE_REBALANCING).toBe('value-rebalancing')
    expect([VR_CYCLE_DAYS, VR_MAX_RUNGS, VR_LADDER_COVER_PPM]).toEqual([14, 30, 300_000])
    expect(DEFAULT_VR_SETTINGS).toEqual({ g: 10, formula: 'skill', bandPpm: 150_000, spendLimitPpm: 500_000, cycleDepositCents: 0 })
  })
})

describe('next V and band', () => {
  test('basic formula: guide example', () => {
    const s = { ...DEFAULT_VR_SETTINGS, formula: 'basic' as const, cycleDepositCents: 25_000 }
    expect(nextV({ vCents: 900_000, poolCents: 100_000, evalCents: 0, settings: s })).toEqual({ vCents: 935_000, kept: false })
    expect(vrBand(935_000, 150_000)).toEqual({ minCents: 794_750, maxCents: 1_075_250 })
  })
  test('skill formula: exact root', () => {
    const s = { ...DEFAULT_VR_SETTINGS, cycleDepositCents: 13_000 }
    expect(nextV({ vCents: 1_483_755, poolCents: 50, evalCents: 1_587_105, settings: s })).toEqual({ vCents: 1_513_101, kept: false })
  })
  test('skill formula: a negative E - V term lowers V', () => {
    expect(nextV({ vCents: 1_587_105, poolCents: 0, evalCents: 1_483_755, settings: DEFAULT_VR_SETTINGS })).toEqual({ vCents: 1_570_764, kept: false })
  })
  test('skill formula: a term just below a half cent rounds down in magnitude', () => {
    const s = { ...DEFAULT_VR_SETTINGS, g: 2 }
    // true term is -344,410.4999...
    expect(nextV({ vCents: 2_000_000_000, poolCents: 0, evalCents: 2_000_000_000 - 974_140, settings: s })).toEqual({ vCents: 2_000_000_000 - 344_410, kept: false })
  })
  test('skill formula: exact halves round away from zero', () => {
    const s = { ...DEFAULT_VR_SETTINGS, g: 1 }
    expect(nextV({ vCents: 1_000, poolCents: 0, evalCents: 1, settings: s })).toEqual({ vCents: 500, kept: false })
    expect(nextV({ vCents: 1_000, poolCents: 0, evalCents: 1_003, settings: s })).toEqual({ vCents: 1_002, kept: false })
  })
  test('a withdrawal larger than everything else keeps the input V', () => {
    const s = { ...DEFAULT_VR_SETTINGS, cycleDepositCents: -200_000 }
    expect(nextV({ vCents: 100_000, poolCents: 0, evalCents: 0, settings: s })).toEqual({ vCents: 100_000, kept: true })
  })
  test('a non-positive g is rejected', () => {
    expect(() => nextV({ vCents: 100_000, poolCents: 0, evalCents: 0, settings: { ...DEFAULT_VR_SETTINGS, g: 0 } })).toThrow(RangeError)
  })
})

describe('lots', () => {
  test('30 rungs cover a 30% move', () => {
    expect([buyLot(50), buyLot(176), buyLot(1000)]).toEqual([1, 3, 15])
    expect([sellLot(50), sellLot(176), sellLot(177), sellLot(1000)]).toEqual([1, 2, 2, 8])
    expect([buyLot(0), sellLot(0)]).toEqual([1, 1])
  })
})

describe('books', () => {
  const moves: VrCashMove[] = [
    { kind: 'open', amountCents: 1_000_000, movedOn: '2026-12-07' },
    { kind: 'deposit', amountCents: 25_000, movedOn: '2026-12-21' },
    { kind: 'withdraw', amountCents: -10_000, movedOn: '2026-12-22' },
    { kind: 'adjust', amountCents: 1_234, movedOn: '2026-12-23' },
  ]
  const fills: VrFill[] = [
    { side: 'buy', shares: 10, price: 460_000n, feeCents: 100, filledOn: '2026-12-08' },
    { side: 'buy', shares: 5, price: 451_234n, feeCents: 50, filledOn: '2026-12-22' },
    { side: 'sell', shares: 3, price: 500_000n, feeCents: 30, filledOn: '2026-12-24' },
  ]
  test('vrBooks: buys, sells, fees and all four cash kinds', () => {
    const books = vrBooks(fills, moves)
    expect(books).toEqual({ shares: 12, poolCents: 962_492, buyCostCents: 68_562, sellProceedsCents: 15_000, feesCents: 180, netInvestedCents: 1_015_000 })
    expect(avgCost(books)).toBe(446_350n)
  })
  test('adjust changes the Pool but not netInvestedCents', () => {
    const without = vrBooks(fills, moves.filter((m) => m.kind !== 'adjust'))
    const withAdj = vrBooks(fills, moves)
    expect(withAdj.poolCents - without.poolCents).toBe(1_234)
    expect(withAdj.netInvestedCents).toBe(without.netInvestedCents)
  })
  test('avgCost is null at 0 shares and can be negative', () => {
    expect(avgCost(vrBooks([], moves))).toBeNull()
    const f: VrFill[] = [
      { side: 'buy', shares: 10, price: 100_000n, feeCents: 0, filledOn: '2026-12-08' },
      { side: 'sell', shares: 9, price: 300_000n, feeCents: 0, filledOn: '2026-12-09' },
    ]
    expect(avgCost(vrBooks(f, moves))).toBe(-1_700_000n)   // (10,000 - 27,000) cents on 1 share = -$170.00
  })
  test('fillCostCents and evalCents round to the nearest cent', () => {
    expect(fillCostCents({ shares: 5, price: 451_234n })).toBe(22_562)
    expect(evalCents(12, 460_000n)).toBe(55_200)
  })
  test('buyBudgetCents', () => {
    expect(buyBudgetCents(100_000, 500_000)).toBe(50_000)
    expect(buyBudgetCents(-5, 500_000)).toBe(0)
    expect(buyBudgetCents(0, 500_000)).toBe(0)
  })
  test('spentInCycleCents counts only buys on or after the start and ignores fees', () => {
    expect(spentInCycleCents(fills, '2026-12-22')).toBe(22_562)
    expect(spentInCycleCents(fills, '2026-12-08')).toBe(46_000 + 22_562)
    expect(spentInCycleCents(fills, '2026-12-23')).toBe(0)
  })
  test('sharesInCycle counts only the given side and only fills on or after the start', () => {
    expect(sharesInCycle(fills, '2026-12-08', 'buy')).toBe(15)
    expect(sharesInCycle(fills, '2026-12-09', 'buy')).toBe(5)
    expect(sharesInCycle(fills, '2026-12-08', 'sell')).toBe(3)
    expect(sharesInCycle(fills, '2026-12-25', 'sell')).toBe(0)
  })
  test('buyInstructionShares', () => {
    expect(buyInstructionShares(500_000, 460_000n)).toBe(108)
    expect(buyInstructionShares(500_000, 0n)).toBe(0)
  })
})

describe('schedule', () => {
  test('cycleDue', () => {
    expect(cycleDue('2026-12-07', '2026-12-20')).toBe(false)
    expect(cycleDue('2026-12-07', '2026-12-21')).toBe(true)
  })
  test('nextScheduledStart keeps the anchor unless 28 days late', () => {
    expect(nextScheduledStart('2026-12-07', '2026-12-22')).toBe('2026-12-21')
    expect(nextScheduledStart('2026-12-07', '2027-01-03')).toBe('2026-12-21')
    expect(nextScheduledStart('2026-12-07', '2027-01-04')).toBe('2027-01-04')
    expect(nextScheduledStart('2026-12-07', '2027-01-10')).toBe('2027-01-10')
  })
  test('addDays across a month end, a year end and a leap day', () => {
    expect(addDays('2026-12-25', 14)).toBe('2027-01-08')
    expect(addDays('2026-01-25', 14)).toBe('2026-02-08')
    expect(addDays('2028-02-22', 14)).toBe('2028-03-07')
  })
})
