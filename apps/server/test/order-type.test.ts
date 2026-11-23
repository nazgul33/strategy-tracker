import { describe, expect, test } from 'bun:test'
import { classifyOrderType, evidenceOf, kindOfType, NO_EVIDENCE, type SellOrderType } from '../src/domain/order-type'

describe('classifyOrderType', () => {
  test.each<[string | null | undefined, SellOrderType]>([
    ['매도/STOP(시장가)', 'stop'],
    ['매도/STOP(지정가)', 'stop'],
    ['매도/stop(시장가)', 'stop'],
    ['매도/LOC', 'target'],
    ['매도/보통(지정가)', 'target'],
    ['매도 보통', 'target'],
    [' 매도 / loc ', 'target'],
    ['매도/보통(시장가)', 'market'],
    ['매도(시장가)', 'market'],
    ['매도 시장가', 'market'],
    ['정정(매도)', 'unknown'],
    ['매도', 'unknown'],
    ['매도 LOO', 'unknown'],
    ['매수/LOC', 'unknown'],
    ['매수/보통(시장가)', 'unknown'],
    ['', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ])('%p is %s', (text, type) => {
    expect(classifyOrderType(text)).toBe(type)
  })
})

describe('kindOfType', () => {
  test('maps a type to the order kind it is matched against', () => {
    expect(kindOfType('target')).toBe('sell_loc')
    expect(kindOfType('stop')).toBe('stop_sell')
    expect(kindOfType('market')).toBe('market_sell')
    expect(kindOfType('unknown')).toBeNull()
  })
})

describe('evidenceOf', () => {
  test('classifies the stored text and carries the price and quantity', () => {
    expect(evidenceOf({ detectedOrderType: '매도/LOC', detectedOrderPrice: 650000n, detectedOrderedShares: 44 })).toEqual({ type: 'target', orderPrice: 650000n, orderedShares: 44 })
  })

  test('a row with no order columns carries no evidence', () => {
    expect(evidenceOf({})).toEqual(NO_EVIDENCE)
    expect(NO_EVIDENCE).toEqual({ type: 'unknown', orderPrice: null, orderedShares: null })
  })
})
