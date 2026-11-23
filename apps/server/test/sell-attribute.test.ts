import { beforeEach, describe, expect, test } from 'bun:test'
import type { RunState } from '@st/core'
import { classifyOrderType, NO_EVIDENCE, type OrderEvidence } from '../src/domain/order-type'
import { attributeSell, sellNeedsChoice } from '../src/domain/sell-attribute'
import type { OrderRow } from '../src/domain/sell-match'
import { alts, ev, ord, resetOrderIds, sell, stateOf, throwsKind } from './sell-attribute-fixture'

beforeEach(resetOrderIds)

const T = 'sell_loc', S = 'stop_sell', M = 'market_sell'
const held1 = (): RunState => stateOf([{ idx: 1, shares: 10 }])
const pair1 = (): OrderRow[] => [ord(1, T, '103.00', 10), ord(1, S, '97.00', 10)]
const book43 = (): OrderRow[] => [ord(0, T, '103.00', 10), ord(0, S, '97.00', 10), ord(9, T, '91.00', 10), ord(9, S, '85.40', 10)]
const held43 = (): RunState => stateOf([{ idx: 0, shares: 10 }, { idx: 9, shares: 10 }])

describe('attributeSell: spec examples', () => {
  const partly = (): [OrderRow[], RunState] => [[ord(0, S, '97.00', 10), ord(1, S, '97.00', 4)], stateOf([{ idx: 0, shares: 4 }, { idx: 1, shares: 4 }])]

  test('1: #74, the partly filled leg wins on the ordered shares, with a notice', () => {
    const [orders, state] = partly()
    const pick = attributeSell(orders, state, sell(4, '96.50', ev('stop', undefined, 10)))
    expect(pick.bucketIdx).toBe(0)
    expect(pick.orderId).toBe(orders[0]!.id)
    expect(pick.attribution).toMatchObject({ rule: 'ordered-shares', chosen: { orderId: orders[0]!.id, bucketIdx: 0 } })
    expect(alts(pick)).toEqual([orders[1]!.id])
  })

  test('2: the same fill from the date-range view (no type) is the operator\'s choice', () => {
    const [orders, state] = partly()
    throwsKind(() => attributeSell(orders, state, sell(4, '96.50')), 'choose-bucket')
  })

  test('3: a bucket holding exactly the fill wins on remaining shares', () => {
    const orders = [ord(0, S, '97.00', 12), ord(1, S, '99.00', 10)]
    const pick = attributeSell(orders, stateOf([{ idx: 0, shares: 12 }, { idx: 1, shares: 10 }]), sell(10, '96.50', ev('stop')))
    expect(pick.bucketIdx).toBe(1)
    expect(pick.orderId).toBe(orders[1]!.id)
    expect(pick.attribution).toMatchObject({ rule: 'shares' })
    expect(alts(pick)).toEqual([orders[0]!.id])
  })

  test('4: two targets at one close each go to their own bucket, quietly', () => {
    const orders = [ord(0, T, '60.00', 10), ord(1, T, '62.00', 12)]
    const state = stateOf([{ idx: 0, shares: 10 }, { idx: 1, shares: 12 }])
    const a = attributeSell(orders, state, sell(10, '63.00', ev('target', '60.00')))
    expect([a.bucketIdx, a.orderId, a.attribution]).toEqual([0, orders[0]!.id, null])
    const b = attributeSell(orders, state, sell(12, '63.00', ev('target', '62.00')))
    expect([b.bucketIdx, b.orderId, b.attribution]).toEqual([1, orders[1]!.id, null])
  })

  test('5: #43, a stop fill is not matched to another bucket\'s target', () => {
    const orders = book43()
    const pick = attributeSell(orders, held43(), sell(10, '96.50', ev('stop')))
    expect([pick.bucketIdx, pick.orderId, pick.attribution]).toEqual([0, orders[1]!.id, null])
  })

  test('6: a stop fill above every trigger with two holders is the operator\'s choice', () => {
    throwsKind(() => attributeSell(book43(), held43(), sell(10, '98.00', ev('stop'))), 'choose-bucket')
  })

  test('7: an unknown-type sell on the one held bucket books its fitting target, quietly', () => {
    const orders = pair1()
    const pick = attributeSell(orders, held1(), sell(10, '104.00'))
    expect([pick.bucketIdx, pick.orderId, pick.attribution]).toEqual([1, orders[0]!.id, null])
  })

  test('8: an unknown-type sell fitting no order books the one holder with no order', () => {
    const pick = attributeSell(pair1(), held1(), sell(10, '100.00'))
    expect([pick.bucketIdx, pick.orderId, pick.attribution]).toEqual([1, null, null])
  })

  test('9: a correction (정정) with two fitting buckets is the operator\'s choice', () => {
    const evidence: OrderEvidence = { ...NO_EVIDENCE, type: classifyOrderType('정정(매도)') }
    throwsKind(() => attributeSell(book43(), held43(), sell(10, '96.50', evidence)), 'choose-bucket')
  })

  describe('market sell', () => {
    test('10: the forced-sell bucket with a market order takes it, quietly', () => {
      const orders = [ord(0, T, '103.00', 10), ord(0, S, '97.00', 10), ord(1, T, '103.00', 10), ord(1, S, '97.00', 10), ord(2, M, null, 7)]
      const state = stateOf([{ idx: 0, shares: 10 }, { idx: 1, shares: 10 }, { idx: 2, shares: 7, forced: true }])
      const pick = attributeSell(orders, state, sell(7, '50.00', ev('market')))
      expect([pick.bucketIdx, pick.orderId, pick.attribution]).toEqual([2, orders[4]!.id, null])
    })

    test('11: two forced-sell buckets, the one holding exactly the fill wins, with a notice', () => {
      const orders = [ord(2, M, null, 7), ord(3, M, null, 5)]
      const state = stateOf([{ idx: 2, shares: 7, forced: true }, { idx: 3, shares: 5, forced: true }])
      const pick = attributeSell(orders, state, sell(5, '50.00', ev('market')))
      expect(pick.bucketIdx).toBe(3)
      expect(pick.orderId).toBe(orders[1]!.id)
      expect(pick.attribution).toMatchObject({ rule: 'shares', chosen: { orderId: orders[1]!.id, kind: 'market_sell' } })
      expect(alts(pick)).toEqual([orders[0]!.id])
    })

    test('12: no forced-sell bucket is the operator\'s choice even with one holder', () => {
      throwsKind(() => attributeSell(pair1(), held1(), sell(10, '50.00', ev('market'))), 'choose-bucket')
    })
  })

  test('13: no bucket holds enough shares', () => {
    for (const evidence of [ev('market'), ev('target'), undefined]) {
      throwsKind(() => attributeSell(pair1(), held1(), sell(99, '50.00', evidence)), 'no-bucket-for-sell')
    }
  })

  test('14: a typed target that does not fit goes to the one holder and flips its target', () => {
    const orders = pair1()
    const pick = attributeSell(orders, held1(), sell(10, '100.00', ev('target')))
    expect([pick.bucketIdx, pick.orderId, pick.attribution]).toEqual([1, orders[0]!.id, null])
  })

  test('15: a typed target that fits nothing with two holders is the operator\'s choice', () => {
    const orders = [ord(0, T, '103.00', 10), ord(1, T, '103.00', 10)]
    throwsKind(() => attributeSell(orders, stateOf([{ idx: 0, shares: 10 }, { idx: 1, shares: 10 }]), sell(10, '100.00', ev('target'))), 'choose-bucket')
  })

  describe('operator-chosen bucket', () => {
    test('16: a typed fill flips the bucket\'s order of that kind although the price does not fit', () => {
      const orders = pair1()
      const pick = attributeSell(orders, held1(), sell(10, '98.00', ev('stop'), 1))
      expect([pick.bucketIdx, pick.orderId, pick.attribution]).toEqual([1, orders[1]!.id, null])
    })

    test('17: an untyped fill that fits no order flips none', () => {
      const pick = attributeSell(pair1(), held1(), sell(10, '98.00', undefined, 1))
      expect([pick.bucketIdx, pick.orderId, pick.attribution]).toEqual([1, null, null])
    })

    test('18: of two stops, the one sized like the ordered shares flips', () => {
      const orders = [ord(1, S, '97.00', 10), ord(1, S, '97.00', 6)]
      const pick = attributeSell(orders, held1(), sell(6, '98.00', ev('stop', undefined, 6), 1))
      expect([pick.bucketIdx, pick.orderId, pick.attribution]).toEqual([1, orders[1]!.id, null])
    })

    test('19: a typed fill with no order of its kind in the bucket flips nothing', () => {
      const market = attributeSell(pair1(), held1(), sell(10, '104.00', ev('market'), 1))
      expect([market.bucketIdx, market.orderId, market.attribution]).toEqual([1, null, null])
      const orders = [ord(1, T, '103.00', 10)]
      const stop = attributeSell(orders, held1(), sell(10, '104.00', ev('stop'), 1))
      expect([stop.bucketIdx, stop.orderId, stop.attribution]).toEqual([1, null, null])
    })

    test('20: an untyped fill still takes the target that fits by price', () => {
      const orders = pair1()
      const pick = attributeSell(orders, held1(), sell(10, '104.00', undefined, 1))
      expect([pick.bucketIdx, pick.orderId, pick.attribution]).toEqual([1, orders[0]!.id, null])
    })
  })
})

describe('sellNeedsChoice', () => {
  const orders = (): [OrderRow[], RunState] => [[ord(0, S, '97.00', 10), ord(1, S, '97.00', 4)], stateOf([{ idx: 0, shares: 4 }, { idx: 1, shares: 4 }])]

  test('is true only when the sell would throw choose-bucket', () => {
    const [o, s] = orders()
    expect(sellNeedsChoice(o, s, sell(4, '96.50'))).toBe(true)
  })

  test('is false when the ordered shares decide, when a single bucket fits and when no bucket can take the fill', () => {
    const [o, s] = orders()
    expect(sellNeedsChoice(o, s, sell(4, '96.50', ev('stop', undefined, 10)))).toBe(false)
    expect(sellNeedsChoice(pair1(), held1(), sell(10, '104.00'))).toBe(false)
    expect(sellNeedsChoice(pair1(), held1(), sell(99, '50.00', ev('market')))).toBe(false)
  })

  test('is false when the operator already gave a bucket', () => {
    const [o, s] = orders()
    expect(sellNeedsChoice(o, s, sell(4, '96.50', undefined, 0))).toBe(false)
  })
})
