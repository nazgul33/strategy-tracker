import { describe, test, expect } from 'bun:test'
import { DEFAULT_VR_SETTINGS, avgCost, vrBooks } from '@st/strategies/value-rebalancing'
import type { VrCashMoveRow, VrCycleRow, VrFillRow, VrRunRow } from '../src/domain/vr/repo-types'
import { buildVrDetail, buildVrSummary, cashView, fillView, lastCloseOf, toEngineFill } from '../src/domain/vr/view'
import { FAKE_CREATED_AT } from './booking-fakes'

const run: VrRunRow = {
  id: 1, strategyKey: 'value-rebalancing', ticker: 'TQQQ', name: 'vr', costPpm: 700, status: 'active', createdAt: FAKE_CREATED_AT,
  ...DEFAULT_VR_SETTINGS, initialVCents: 500_000,
}
const cycle: VrCycleRow = {
  id: 1, runId: 1, seq: 1, scheduledStart: '2026-11-03', startDate: '2026-11-03', vCents: 935_000, bandMinCents: 794_750, bandMaxCents: 1_075_250,
  openShares: 176, openPoolCents: 100_000, buyBudgetCents: 50_000, buyLot: 3, sellLot: 2, prevClose: 500_000n, evalCents: null, poolBeforeCents: null,
  g: 10, formula: 'skill', depositCents: 0, vKept: false, createdAt: FAKE_CREATED_AT,
}
const open: VrCashMoveRow = { id: 1, runId: 1, kind: 'open', amountCents: 1_000_000, movedOn: '2026-10-29', note: null, cycleId: null, createdAt: FAKE_CREATED_AT }
let nextId = 1
const fill = (side: 'buy' | 'sell', shares: number, price: bigint, fee: number, filledOn: string): VrFillRow =>
  ({ id: nextId++, runId: 1, side, shares, price, fee, filledOn, source: 'manual', createdAt: FAKE_CREATED_AT })
const earlier = () => fill('buy', 176, 511_300n, 112, '2026-10-30')
const inCycleBuy = (shares = 3, fee = 9) => fill('buy', shares, 451_500n, fee, '2026-11-04')
const lastClose = { date: '2026-11-09', close: 460_000n }
const today = '2026-11-10'
const detail = (fills: VrFillRow[], over: Partial<Parameters<typeof buildVrDetail>[0]> = {}) =>
  buildVrDetail({ run, fills, moves: [open], cycle, lastClose, today, ...over })

describe('buildVrDetail', () => {
  test('the page sketch: books, budget, ladder and value', () => {
    const d = detail([earlier(), inCycleBuy()])
    expect(d.books.shares).toBe(179)
    expect(d.books.poolCents).toBe(86_446)
    expect(d.books.netInvestedCents).toBe(1_000_000)
    expect(d.budgetLeftCents).toBe(36_455)
    expect(d.ladder.buyTotal).toBe(3)
    expect(d.ladder.buy).toEqual([{ shares: 3, price: 443_900n }, { shares: 3, price: 436_600n }])
    expect(d.ladder.sellTotal).toBe(22)
    expect(d.ladder.sell.length).toBe(22)
    expect(d.ladder.sell.slice(0, 2)).toEqual([{ shares: 2, price: 611_000n }, { shares: 2, price: 618_000n }])
    expect(d.books.evalCents).toBe(823_400)
    expect(d.books.valueCents).toBe(909_846)
    expect(d.books.profitCents).toBe(-90_154)
    expect(d.buyInstruction).toBeNull()
    expect(d.lastClose).toEqual(lastClose)
    expect(d.today).toBe(today)
  })

  test('avgCost comes from the same fills through the engine', () => {
    const fills = [earlier(), inCycleBuy()]
    const d = detail(fills)
    expect(d.books.avgCost).toBe(avgCost(vrBooks(fills.map(toEngineFill), [open])))
    expect(typeof d.books.avgCost).toBe('bigint')
  })

  test('the cycle carries its window and no row internals', () => {
    const c = detail([earlier()]).cycle!
    expect(c.endDate).toBe('2026-11-16')
    expect(c.nextStart).toBe('2026-11-17')
    expect(c.prevClose).toBe(500_000n)
    expect(Object.keys(c)).not.toContain('runId')
    expect(Object.keys(c)).not.toContain('createdAt')
  })

  test('the run view carries the settings and nothing of the row internals', () => {
    const r = detail([earlier()]).run
    expect(r).toEqual({
      id: 1, name: 'vr', ticker: 'TQQQ', status: 'active', costPpm: 700, createdAt: FAKE_CREATED_AT, initialVCents: 500_000,
      settings: { g: 10, formula: 'skill', bandPpm: 150_000, spendLimitPpm: 500_000, cycleDepositCents: 0 },
    })
  })

  test('an in-cycle buy of 4 shares eats into the second rung', () => {
    const d = detail([earlier(), inCycleBuy(4)])
    expect(d.ladder.buy).toEqual([{ shares: 2, price: 443_900n }, { shares: 3, price: 436_600n }])
    expect(d.ladder.buyTotal).toBe(3)
  })

  test('an in-cycle sell of 3 shares trims the sell side and leaves the buy side alone', () => {
    const d = detail([earlier(), inCycleBuy(), fill('sell', 3, 611_000n, 0, '2026-11-05')])
    expect(d.ladder.sell.slice(0, 2)).toEqual([{ shares: 1, price: 618_000n }, { shares: 2, price: 625_200n }])
    expect(d.ladder.sell.length).toBe(21)
    expect(d.ladder.sellTotal).toBe(22)
    expect(d.ladder.buy).toEqual([{ shares: 3, price: 443_900n }, { shares: 3, price: 436_600n }])
  })

  test('without a last close nothing is valued and nothing throws', () => {
    const d = detail([earlier(), inCycleBuy()], { lastClose: null })
    expect(d.lastClose).toBeNull()
    expect(d.books.evalCents).toBeNull()
    expect(d.books.valueCents).toBeNull()
    expect(d.books.profitCents).toBeNull()
    expect(d.buyInstruction).toBeNull()
    expect(d.books.shares).toBe(179)
    expect(detail([], { lastClose: null }).buyInstruction).toBeNull()
  })

  test('a cycle that opened with no shares and no holdings shows the buy instruction, not a ladder', () => {
    const d = detail([], { cycle: { ...cycle, openShares: 0 } })
    expect(d.ladder).toEqual({ buy: [], sell: [], buyTotal: 0, sellTotal: 0 })
    expect(d.buyInstruction).toEqual({ shares: 203, targetCents: 935_000 })
  })

  test('selling every share hides the ladder even though the cycle opened with shares', () => {
    const d = detail([earlier(), fill('sell', 176, 480_000n, 0, '2026-11-05')])
    expect(d.books.shares).toBe(0)
    expect(d.ladder).toEqual({ buy: [], sell: [], buyTotal: 0, sellTotal: 0 })
    expect(d.buyInstruction).toEqual({ shares: 203, targetCents: 935_000 })
  })

  test('before cycle 1 the buy target is the initial V and there is no cycle or budget', () => {
    const d = detail([], { cycle: null })
    expect(d.cycle).toBeNull()
    expect(d.budgetLeftCents).toBeNull()
    expect(d.buyInstruction).toEqual({ shares: 108, targetCents: 500_000 })
    expect(d.ladder).toEqual({ buy: [], sell: [], buyTotal: 0, sellTotal: 0 })
  })

  test('the budget left never goes below zero', () => {
    const d = detail([earlier(), fill('buy', 20, 451_500n, 0, '2026-11-04')])
    expect(d.budgetLeftCents).toBe(0)
  })

  test('a negative Pool is reported as it is', () => {
    const d = detail([fill('buy', 30, 460_000n, 0, '2026-10-30')], { moves: [{ ...open, amountCents: 100_000 }] })
    expect(d.books.poolCents).toBe(-38_000)
  })
})

describe('entry views', () => {
  test('beforeCycle is true only for entries dated before the cycle start', () => {
    const f = (filledOn: string) => fill('buy', 1, 100_000n, 0, filledOn)
    expect(fillView(f('2026-11-02'), cycle).beforeCycle).toBe(true)
    expect(fillView(f('2026-11-03'), cycle).beforeCycle).toBe(false)
    expect(fillView(f('2026-11-04'), cycle).beforeCycle).toBe(false)
    expect(fillView(f('2026-11-02'), null).beforeCycle).toBe(false)
    const m = (movedOn: string): VrCashMoveRow => ({ ...open, movedOn })
    expect(cashView(m('2026-11-02'), cycle).beforeCycle).toBe(true)
    expect(cashView(m('2026-11-03'), cycle).beforeCycle).toBe(false)
    expect(cashView(m('2026-11-02'), null).beforeCycle).toBe(false)
  })

  test('views carry the wire fields only', () => {
    expect(Object.keys(fillView(fill('buy', 1, 100_000n, 2, '2026-11-04'), cycle)).sort()).toEqual(
      ['beforeCycle', 'createdAt', 'fee', 'filledOn', 'id', 'price', 'shares', 'side', 'source'])
    expect(Object.keys(cashView(open, cycle)).sort()).toEqual(['amountCents', 'beforeCycle', 'createdAt', 'cycleId', 'id', 'kind', 'movedOn', 'note'])
  })
})

describe('lastCloseOf and buildVrSummary', () => {
  test('the newest row is the last close', () => {
    expect(lastCloseOf([])).toBeNull()
    expect(lastCloseOf([{ tradeDate: '2026-11-06', close: 1n }, { tradeDate: '2026-11-09', close: 2n }])).toEqual({ date: '2026-11-09', close: 2n })
  })

  test('a summary carries shares, Pool, V and value', () => {
    const s = buildVrSummary({ run, fills: [earlier(), inCycleBuy()], moves: [open], cycle, lastClose })
    expect(s).toMatchObject({ id: 1, ticker: 'TQQQ', shares: 179, poolCents: 86_446, vCents: 935_000, valueCents: 909_846 })
    expect(Object.keys(s)).not.toContain('strategyKey')
  })

  test('before cycle 1 the summary has no V; without a close it has no value', () => {
    const s = buildVrSummary({ run, fills: [], moves: [open], cycle: null, lastClose: null })
    expect(s).toMatchObject({ shares: 0, poolCents: 1_000_000, vCents: null, valueCents: null })
  })
})
