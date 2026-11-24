import { describe, test, expect } from 'bun:test'
import { manualFill } from '../src/domain/booking'
import type { OrderStatus } from '../src/domain/repo-types'
import { D, Y, book43, held43, sellSetup, sellTyped, orderOf, fillsOf, heldShares } from './sell-fixture'
import { ev } from './sell-attribute-fixture'

const STOP = ev('stop')
const TARGET = ev('target')
const TARGET_103 = ev('target', '103.00')

describe('stale legs on the fill day (#53)', () => {
  const lateFixture = () => sellSetup(held43, [...book43(Y, 'stale'), ...book43(D, 'open')])

  test('a late fill after the morning roll books to the leg that took it and pulls only that bucket\'s legs for today', async () => {
    const { f, deps, rec, runId } = await lateFixture()
    await sellTyped(runId, 10, '91.20', deps, TARGET, Y)
    expect(fillsOf(f)).toEqual([[10, 9]])
    expect(orderOf(f, 9, 'sell_loc', Y).status).toBe('filled')
    expect(orderOf(f, 9, 'stop_sell', Y)).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(orderOf(f, 0, 'sell_loc', Y).status).toBe('stale')
    expect(orderOf(f, 0, 'stop_sell', Y).status).toBe('stale')
    expect(orderOf(f, 9, 'sell_loc')).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(orderOf(f, 9, 'stop_sell')).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(orderOf(f, 0, 'sell_loc').status).toBe('open')
    expect(orderOf(f, 0, 'stop_sell').status).toBe('open')
    expect(rec.siblings.map((s) => s.order.id)).toEqual([orderOf(f, 9, 'sell_loc').id, orderOf(f, 9, 'stop_sell').id])
    expect(rec.attributions).toEqual([])
  })

  test('the sibling stale leg is cancelled silently, so a rebuy of the bucket cannot let it absorb a second late fill', async () => {
    const held = Array.from({ length: 10 }, (_, idx) => ({ idx, shares: 10, buy: '88.00' }))
    const { f, deps, rec, runId } = await sellSetup(held, [
      { idx: 9, kind: 'sell_loc', price: '91.00', tradeDate: Y, status: 'stale' },
      { idx: 9, kind: 'stop_sell', price: '85.40', tradeDate: Y, status: 'stale' },
      { idx: 8, kind: 'stop_sell', price: '85.50', tradeDate: Y, status: 'stale' },
    ])
    await sellTyped(runId, 10, '91.20', deps, TARGET, Y)
    expect(fillsOf(f)).toEqual([[10, 9]])
    expect(orderOf(f, 9, 'stop_sell', Y)).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(rec.siblings).toEqual([])
    await manualFill(runId, { side: 'buy', price: '88.00', shares: 10, filledOn: D }, deps)
    expect((await heldShares(f, runId))[9]).toBe(10)
    await sellTyped(runId, 10, '85.00', deps, STOP, Y)
    expect(fillsOf(f)).toEqual([[10, 9], [10, 8]])
    expect(orderOf(f, 8, 'stop_sell', Y).status).toBe('filled')
    expect(orderOf(f, 9, 'stop_sell', Y).status).toBe('cancelled')
    expect(rec.attributions).toEqual([])
  })

  test('a partial late fill leaves the stale leg stale and cancels nothing', async () => {
    const { f, deps, rec, runId } = await lateFixture()
    const before = f._stores.orders.map((o: any) => o.status)
    await sellTyped(runId, 4, '91.20', deps, TARGET, Y)
    expect((await heldShares(f, runId))[9]).toBe(6)
    expect(f._stores.orders.map((o: any) => o.status)).toEqual(before)
    expect(rec.siblings).toEqual([])
  })

  test('a stale target on a bucket emptied since is not a candidate', async () => {
    const { f, deps, runId } = await sellSetup(
      [{ idx: 1, shares: 10, buy: '96.00' }],
      [{ idx: 0, kind: 'sell_loc', price: '103.00', status: 'stale', tradeDate: Y }, { idx: 1, kind: 'sell_loc', price: '99.00', status: 'stale', tradeDate: Y }],
    )
    await sellTyped(runId, 5, '103.00', deps, ev('target', '103.00'), Y)
    expect(fillsOf(f)).toEqual([[5, 1]])
    expect((await heldShares(f, runId))[1]).toBe(5)
    expect(f._stores.orders.map((o: any) => o.status)).toEqual(['stale', 'stale'])
  })

  test('a target whose bucket cannot cover the fill is not a candidate, stale or open', async () => {
    const held = [{ idx: 0, shares: 5, buy: '100.00' }, { idx: 1, shares: 15, buy: '90.00' }]
    const orders = (status: OrderStatus, tradeDate: typeof D) => [
      { idx: 0, kind: 'sell_loc' as const, price: '103.00', status, tradeDate },
      { idx: 1, kind: 'sell_loc' as const, price: '92.00', shares: 10, status, tradeDate },
    ]
    const stale = await sellSetup(held, orders('stale', Y))
    await sellTyped(stale.runId, 12, '103.00', stale.deps, TARGET_103, Y)
    expect(fillsOf(stale.f)).toEqual([[12, 1]])

    const open = await sellSetup(held, orders('open', D))
    await sellTyped(open.runId, 12, '103.00', open.deps, TARGET_103, D)
    expect(fillsOf(open.f)).toEqual([[12, 1]])
  })
})

describe('a partial fill keeps its order open (#54)', () => {
  test('two partials of one stop both book to its bucket', async () => {
    const { f, deps, rec, runId } = await sellSetup(held43, book43())
    await sellTyped(runId, 4, '96.50', deps, STOP)
    expect(orderOf(f, 0, 'stop_sell').status).toBe('open')
    expect(orderOf(f, 0, 'sell_loc').status).toBe('open')
    expect(rec.siblings).toEqual([])
    await sellTyped(runId, 6, '96.50', deps, STOP)
    expect(fillsOf(f)).toEqual([[4, 0], [6, 0]])
    expect(orderOf(f, 0, 'stop_sell').status).toBe('filled')
    expect(orderOf(f, 0, 'sell_loc')).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(orderOf(f, 9, 'sell_loc').status).toBe('open')
    expect(orderOf(f, 9, 'stop_sell').status).toBe('open')
    expect((await heldShares(f, runId))[9]).toBe(10)
    expect(rec.attributions).toEqual([])
  })

  test('two partials of one stop notify each time when another bucket\'s stop also fits', async () => {
    const { f, deps, rec, runId } = await sellSetup(held43, [
      { idx: 0, kind: 'stop_sell', price: '97.00' }, { idx: 9, kind: 'stop_sell', price: '98.00' },
    ])
    await sellTyped(runId, 4, '96.50', deps, STOP)
    await sellTyped(runId, 6, '96.50', deps, STOP)
    expect(fillsOf(f)).toEqual([[4, 0], [6, 0]])
    expect(orderOf(f, 0, 'stop_sell').status).toBe('filled')
    expect(orderOf(f, 9, 'stop_sell').status).toBe('open')
    expect(rec.attributions).toHaveLength(2)
    for (const a of rec.attributions) expect(a.attribution.chosen).toMatchObject({ bucketIdx: 0, kind: 'stop_sell' })
    expect(rec.attributions.map((a) => a.attribution.rule)).toEqual(['price', 'shares'])
  })

  test('three partials of one stop', async () => {
    const { f, deps, runId } = await sellSetup(held43, book43())
    await sellTyped(runId, 3, '96.50', deps, STOP)
    await sellTyped(runId, 3, '96.50', deps, STOP)
    expect(orderOf(f, 0, 'stop_sell').status).toBe('open')
    await sellTyped(runId, 4, '96.50', deps, STOP)
    expect(fillsOf(f)).toEqual([[3, 0], [3, 0], [4, 0]])
    expect(orderOf(f, 0, 'stop_sell').status).toBe('filled')
  })

  test('three partials of one target', async () => {
    const { f, deps, rec, runId } = await sellSetup(held43, book43())
    await sellTyped(runId, 3, '103.50', deps, TARGET_103)
    await sellTyped(runId, 3, '103.50', deps, TARGET_103)
    expect(orderOf(f, 0, 'sell_loc').status).toBe('open')
    expect(orderOf(f, 0, 'stop_sell').status).toBe('open')
    await sellTyped(runId, 4, '103.50', deps, TARGET_103)
    expect(fillsOf(f)).toEqual([[3, 0], [3, 0], [4, 0]])
    expect(orderOf(f, 0, 'sell_loc').status).toBe('filled')
    expect(orderOf(f, 0, 'stop_sell').status).toBe('cancelled')
    expect(rec.attributions).toEqual([])
  })

  test('two buckets sharing a target price take partials in bucket order', async () => {
    const { f, deps, runId } = await sellSetup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 1, shares: 10, buy: '100.00' }],
      [0, 1].flatMap((idx) => [{ idx, kind: 'sell_loc' as const, price: '103.00' }, { idx, kind: 'stop_sell' as const, price: '97.00' }]),
    )
    for (const n of [4, 6, 10]) await sellTyped(runId, n, '103.20', deps, TARGET_103)
    expect(fillsOf(f)).toEqual([[4, 0], [6, 0], [10, 1]])
    expect(orderOf(f, 0, 'sell_loc').status).toBe('filled')
    expect(orderOf(f, 1, 'sell_loc').status).toBe('filled')
    expect(orderOf(f, 0, 'stop_sell').status).toBe('cancelled')
    expect(orderOf(f, 1, 'stop_sell').status).toBe('cancelled')
  })

  test('after a partial, a same-price fill too big for what is left goes to the other bucket at that price', async () => {
    const { f, deps, runId } = await sellSetup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 1, shares: 12, buy: '100.00' }],
      [{ idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 1, kind: 'sell_loc', price: '103.00' }],
    )
    await sellTyped(runId, 4, '103.00', deps, TARGET_103)
    await sellTyped(runId, 10, '103.00', deps, TARGET_103)
    expect(fillsOf(f)).toEqual([[4, 0], [10, 1]])
    expect(orderOf(f, 0, 'sell_loc').status).toBe('open')
    expect(orderOf(f, 1, 'sell_loc').status).toBe('open')
    expect((await heldShares(f, runId)).slice(0, 2)).toEqual([6, 2])
  })
})
