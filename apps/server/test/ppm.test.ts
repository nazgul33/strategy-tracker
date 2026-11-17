import { describe, test, expect } from 'bun:test'
import { MAX_PPM, MAX_CUT_LOSS_PPM, isValidPpm, isValidCostPpm, isValidCutLossPpm } from '../src/domain/ppm'

describe('ppm validators', () => {
  // The cost validator feeds feeCents directly, so an unbounded value is a money
  // bug: 10_000_000 ppm is 1000 % per side. 100 % (MAX_PPM) is the same ceiling
  // isValidPpm and the DEFAULT_COST_PERCENT env variable already enforce.
  test('isValidCostPpm accepts up to 100 % and rejects beyond it', () => {
    expect(isValidCostPpm(0)).toBe(true)
    expect(isValidCostPpm(700)).toBe(true)
    expect(isValidCostPpm(MAX_PPM)).toBe(true)
    expect(isValidCostPpm(MAX_PPM + 10)).toBe(false)
    expect(isValidCostPpm(10_000_000)).toBe(false)
    expect(isValidCostPpm(-10)).toBe(false)
  })

  test('isValidCostPpm still requires a whole multiple of 10 ppm', () => {
    expect(isValidCostPpm(705)).toBe(false)
    expect(isValidCostPpm(70.0)).toBe(true)
    expect(isValidCostPpm(70.5)).toBe(false)
    expect(isValidCostPpm('700')).toBe(false)
    expect(isValidCostPpm(null)).toBe(false)
  })

  test('the gap and cut-loss validators keep their own bounds', () => {
    expect(isValidPpm(MAX_PPM)).toBe(true)
    expect(isValidPpm(MAX_PPM + 1)).toBe(false)
    expect(isValidCutLossPpm(MAX_CUT_LOSS_PPM)).toBe(true)
    expect(isValidCutLossPpm(MAX_CUT_LOSS_PPM + 1_000)).toBe(false)
  })
})
