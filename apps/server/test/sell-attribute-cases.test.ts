import { beforeEach, describe, expect, test } from 'bun:test'
import type { RunState } from '@st/core'
import { attributeSell } from '../src/domain/sell-attribute'
import type { OrderRow } from '../src/domain/sell-match'
import { alts, ev, ord, resetOrderIds, sell, stateOf, throwsKind, Y } from './sell-attribute-fixture'

beforeEach(resetOrderIds)

const T = 'sell_loc', S = 'stop_sell'
const two = (a = 10, b = 10): RunState => stateOf([{ idx: 0, shares: a }, { idx: 1, shares: b }])
const targets = (): OrderRow[] => [ord(0, T, '60.00', 10), ord(1, T, '62.00', 10)]
const stops = (): OrderRow[] => [ord(0, S, '97.00', 10), ord(1, S, '99.00', 10)]

describe('attributeSell: the steps of case B', () => {
  test('20: step 1 keeps the target nearest the order price, and says so when the distance is not 0', () => {
    const orders = targets()
    const pick = attributeSell(orders, two(), sell(10, '63.00', ev('target', '61.80')))
    expect([pick.bucketIdx, pick.orderId]).toEqual([1, orders[1]!.id])
    expect(pick.attribution).toMatchObject({ rule: 'order-price' })
    expect(alts(pick)).toEqual([orders[0]!.id])
  })

  test('21: distance 0 on two buckets is not quiet and the shares decide', () => {
    const orders = [ord(0, T, '60.00', 10), ord(1, T, '60.00', 12)]
    const pick = attributeSell(orders, two(10, 12), sell(10, '63.00', ev('target', '60.00')))
    expect([pick.bucketIdx, pick.orderId]).toEqual([0, orders[0]!.id])
    expect(pick.attribution).toMatchObject({ rule: 'shares' })
    expect(alts(pick)).toEqual([orders[1]!.id])
  })

  test('22: an order price of 0 skips step 1 and the fill price decides', () => {
    const orders = targets()
    const pick = attributeSell(orders, two(), sell(10, '63.00', ev('target', '0.0000')))
    expect([pick.bucketIdx, pick.orderId]).toEqual([1, orders[1]!.id])
    expect(pick.attribution).toMatchObject({ rule: 'price' })
  })

  test('23: a stop never uses step 1; the fill price picks the nearest trigger', () => {
    const orders = stops()
    const pick = attributeSell(orders, two(), sell(10, '96.50', ev('stop')))
    expect([pick.bucketIdx, pick.orderId]).toEqual([0, orders[0]!.id])
    expect(pick.attribution).toMatchObject({ rule: 'price' })
    expect(alts(pick)).toEqual([orders[1]!.id])
  })

  test('24: ordered shares that match no candidate skip step 2', () => {
    const orders = stops()
    const pick = attributeSell(orders, two(), sell(10, '96.50', ev('stop', undefined, 7)))
    expect([pick.bucketIdx, pick.orderId]).toEqual([0, orders[0]!.id])
    expect(pick.attribution).toMatchObject({ rule: 'price' })
  })

  test('25: on a tie the bucket bought earlier is the older one', () => {
    const orders = [ord(0, S, '97.00', 10), ord(1, S, '97.00', 10)]
    const state = stateOf([{ idx: 0, shares: 10, boughtOn: '2026-11-03' }, { idx: 1, shares: 10, boughtOn: '2026-11-01' }])
    const pick = attributeSell(orders, state, sell(10, '96.50', ev('stop')))
    expect([pick.bucketIdx, pick.orderId]).toEqual([1, orders[1]!.id])
    expect(pick.attribution).toMatchObject({ rule: 'older' })
    expect(alts(pick)).toEqual([orders[0]!.id])
  })

  test('26: on the same buy date the lower bucket index is the older one', () => {
    const orders = [ord(0, S, '97.00', 10), ord(1, S, '97.00', 10)]
    const pick = attributeSell(orders, two(), sell(10, '96.50', ev('stop')))
    expect([pick.bucketIdx, pick.orderId]).toEqual([0, orders[0]!.id])
    expect(pick.attribution).toMatchObject({ rule: 'older' })
  })
})

describe('attributeSell: the pool and the gates', () => {
  const quietOnOne = (orders: OrderRow[]): void => {
    const pick = attributeSell(orders, two(), sell(10, '96.50', ev('stop')))
    expect([pick.bucketIdx, pick.orderId, pick.attribution]).toEqual([1, orders[1]!.id, null])
  }

  test('27: an order of another day is not in the pool', () => {
    quietOnOne([ord(0, S, '97.00', 10, { tradeDate: Y }), ord(1, S, '99.00', 10)])
  })

  test('28: a cancelled or a filled order is not in the pool', () => {
    for (const status of ['cancelled', 'filled']) quietOnOne([ord(0, S, '97.00', 10, { status }), ord(1, S, '99.00', 10)])
  })

  test('29: a stale order is a candidate', () => {
    const orders = [ord(0, S, '97.00', 10, { status: 'stale' }), ord(1, S, '99.00', 10)]
    const pick = attributeSell(orders, two(), sell(10, '96.50', ev('stop')))
    expect([pick.bucketIdx, pick.orderId]).toEqual([0, orders[0]!.id])
    expect(pick.attribution).toMatchObject({ rule: 'price' })
  })

  test('30: a bucket that does not cover the fill is not a candidate', () => {
    const orders = stops()
    const pick = attributeSell(orders, two(6, 10), sell(10, '96.50', ev('stop')))
    expect([pick.bucketIdx, pick.orderId, pick.attribution]).toEqual([1, orders[1]!.id, null])
  })

  test('31: an order that does not fit the price is not a candidate', () => {
    const orders = [ord(0, S, '97.00', 10), ord(1, S, '95.00', 10)]
    const pick = attributeSell(orders, two(), sell(10, '96.50', ev('stop')))
    expect([pick.bucketIdx, pick.orderId, pick.attribution]).toEqual([0, orders[0]!.id, null])
  })

  test('32: another run\'s orders are not in the pool, so two holders need a choice', () => {
    const orders = [ord(0, S, '97.00', 10, { runId: 2 }), ord(1, S, '99.00', 10, { runId: 2 })]
    throwsKind(() => attributeSell(orders, two(), sell(10, '96.50', ev('stop'))), 'choose-bucket')
  })
})
