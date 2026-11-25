import { describe, test, expect } from 'bun:test'
import { renderVrBuyInstruction, renderVrCycle, renderVrOrders, renderVrStatus, type VrCycleView, type VrRungView } from '../src/vr'

const rungs = (shares: number, prices: bigint[]): VrRungView[] => prices.map((price) => ({ shares, price }))
const BUY = rungs(3, [449000n, 441500n, 434200n])
const SELL = rungs(2, [
  607500n, 614500n, 621600n, 628900n, 636300n, 643900n, 651700n, 659700n, 667900n, 676300n, 684900n,
  693800n, 702800n, 712100n, 721700n, 731500n, 741600n, 752000n, 762600n, 773600n, 784900n, 796500n,
])

const VIEW: VrCycleView = {
  runId: 100001, name: 'Q', ticker: 'TQQQ', seq: 2, startDate: '2026-12-22', endDate: '2027-01-03',
  lastClose: 528000n, lastCloseDate: '2026-12-21', vCents: 935000, bandMinCents: 794750, bandMaxCents: 1075250,
  shares: 177, poolCents: 80000, budgetCents: 40000, depositCents: 25000, vKept: false,
  buy: BUY, sell: SELL, instruction: null,
}

const EN_CYCLE = [
  'Q  TQQQ — VR cycle 2: 2026-12-22 to 2027-01-03',
  'Last close: $52.80 (2026-12-21)',
  'V: $9350.00  Band: $7947.50 – $10752.50',
  'Shares: 177  Pool: $800.00  Buy budget: $400.00',
  'Deposit booked for this cycle: $250.00',
  'Buy 3 rungs, 3 sh each:',
  '$44.90  $44.15  $43.42',
  'Sell 22 rungs, 2 sh each:',
  '$60.75  $61.45  $62.16  $62.89  $63.63',
  '$64.39  $65.17  $65.97  $66.79  $67.63',
  '$68.49  $69.38  $70.28  $71.21  $72.17',
  '$73.15  $74.16  $75.20  $76.26  $77.36',
  '$78.49  $79.65',
].join('\n')

const moneyTokens = (s: string) => s.match(/\$\d[\d.]*/g) ?? []

describe('renderVrCycle', () => {
  test('renders every rung, both share counts and the numbers of the cycle', () => {
    expect(renderVrCycle(VIEW, 'en')).toEqual([EN_CYCLE])
  })

  test('ko differs from en and carries the same dollar amounts', () => {
    const ko = renderVrCycle(VIEW, 'ko').join('\n')
    expect(ko).not.toBe(EN_CYCLE)
    expect(ko.startsWith('Q  TQQQ — VR 2번째 사이클: 2026-12-22 ~ 2027-01-03')).toBe(true)
    expect(moneyTokens(ko)).toEqual(moneyTokens(EN_CYCLE))
  })

  test('a withdrawal, a zero deposit and a kept V', () => {
    expect(renderVrCycle({ ...VIEW, depositCents: -25000 }, 'en')[0]).toContain('Withdrawal booked for this cycle: $250.00')
    const none = renderVrCycle({ ...VIEW, depositCents: 0 }, 'en')[0]!
    expect(none).not.toContain('Deposit')
    expect(none).not.toContain('Withdrawal')
    expect(none).not.toContain('kept')
    expect(renderVrCycle({ ...VIEW, vKept: true }, 'en')[0]).toContain('V kept from the last cycle: the formula gave zero or less.')
  })

  test('the instruction replaces the ladder when the run holds no shares', () => {
    const text = renderVrCycle({ ...VIEW, shares: 0, buy: [], sell: [], instruction: { shares: 100, targetCents: 520943 } }, 'en')[0]!
    expect(text).toContain('No shares held, so this cycle has no ladder.')
    expect(text).toContain('Buy 100 sh (target $5209.43 ÷ last close)')
    expect(text).not.toContain('rungs')
  })

  test('a side without rungs says so; a side with unequal lots lists each rung', () => {
    const none = renderVrCycle({ ...VIEW, buy: [], sell: [] }, 'en')[0]!
    expect(none).toContain('Buy: no rungs (the budget or the Pool is too small).')
    expect(none).toContain('Sell: no rungs (too few shares).')
    const mixed = renderVrCycle({ ...VIEW, buy: [{ shares: 2, price: 449000n }, ...rungs(3, [441500n, 434200n])] }, 'en')[0]!
    expect(mixed).toContain('Buy 3 rungs:\n2 sh @ $44.90\n3 sh @ $44.15\n3 sh @ $43.42\n')
  })

  test('30 + 30 rungs stay within 4000 characters a chunk and lose no price', () => {
    const many = (base: number) => Array.from({ length: 30 }, (_, i) => ({ shares: 1, price: BigInt(base + i * 100) }))
    const buy = many(400000)
    const sell = many(600000)
    const chunks = renderVrCycle({ ...VIEW, buy, sell }, 'en')
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000)
    const joined = chunks.join('\n')
    for (const r of [...buy, ...sell]) expect(joined).toContain('$' + (Number(r.price) / 10000).toFixed(2))
  })

  test('a long message is split at line boundaries into chunks of at most 4000 characters', () => {
    const long = { ...VIEW, name: 'N'.repeat(3800) }
    const chunks = renderVrCycle(long, 'en')
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000)
    expect(chunks.join('\n')).toContain('$79.65')
  })
})

describe('the small VR messages', () => {
  test('renderVrBuyInstruction', () => {
    const v = { runId: 100001, name: 'Q', ticker: 'TQQQ', shares: 100, targetCents: 500000, lastClose: 500000n, lastCloseDate: '2026-12-04' }
    expect(renderVrBuyInstruction(v, 'en')).toBe('Q  TQQQ — VR buy instruction\nLast close: $50.00 (2026-12-04)\nBuy 100 sh (target $5000.00 ÷ last close). Order type is your choice.')
    expect(renderVrBuyInstruction(v, 'ko')).toContain('$5000.00')
  })

  test('a target below the price of one share says so instead of "buy 0 shares"', () => {
    const v = { runId: 100001, name: 'Q', ticker: 'TQQQ', shares: 0, targetCents: 4000, lastClose: 500000n, lastCloseDate: '2026-12-04' }
    expect(renderVrBuyInstruction(v, 'en')).toBe(
      'Q  TQQQ — VR buy instruction\nLast close: $50.00 (2026-12-04)\nThe target ($40.00) is less than the price of one share at the last close ($50.00), so there is nothing to buy yet.')
    const ko = renderVrBuyInstruction(v, 'ko')
    expect(ko).not.toContain('0주')
    expect(moneyTokens(ko)).toEqual(['$50.00', '$40.00', '$50.00'])
    const cycle = renderVrCycle({ ...VIEW, shares: 0, buy: [], sell: [], lastClose: 500000n, instruction: { shares: 0, targetCents: 4000 } }, 'en')[0]!
    expect(cycle).toContain('The target ($40.00) is less than the price of one share at the last close ($50.00)')
    expect(cycle).not.toContain('Buy 0 sh')
  })

  test('renderVrStatus with and without a cycle', () => {
    const base = { runId: 100001, ticker: 'TQQQ', shares: 177, poolCents: 80000, vCents: 935000, bandMinCents: 794750, bandMaxCents: 1075250 }
    expect(renderVrStatus(base, 'en')).toBe('VR run #100001 TQQQ\nShares: 177  Pool: $800.00\nV: $9350.00  Band: $7947.50 – $10752.50')
    expect(renderVrStatus({ ...base, shares: 0, poolCents: 1000000, vCents: null, bandMinCents: null, bandMaxCents: null }, 'en'))
      .toBe('VR run #100001 TQQQ\nShares: 0  Pool: $10000.00\nNo cycle yet')
    expect(renderVrStatus({ ...base, poolCents: -1234 }, 'en')).toContain('Pool: -$12.34')
    expect(renderVrStatus(base, 'ko')).toContain('VR 런 #100001 TQQQ')
  })

  test('renderVrOrders, uniform and mixed, and an empty side is left out', () => {
    const rows = EN_CYCLE.split('\n').slice(5)
    expect(renderVrOrders({ runId: 100001, ticker: 'TQQQ', buy: BUY, sell: SELL }, 'en'))
      .toBe(['VR run #100001 TQQQ', ...rows].join('\n'))
    expect(renderVrOrders({ runId: 100001, ticker: 'TQQQ', buy: [{ shares: 2, price: 449000n }, ...rungs(3, [441500n, 434200n])], sell: [] }, 'en'))
      .toBe('VR run #100001 TQQQ\nBuy 3 rungs:\n2 sh @ $44.90\n3 sh @ $44.15\n3 sh @ $43.42')
  })
})
