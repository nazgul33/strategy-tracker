import { describe, test, expect } from 'bun:test'
import { parseUsd } from '@st/core/money'
import { runBooking, manualFill } from '../src/domain/booking'
import type { OrderStatus } from '../src/domain/repo-types'
import { D, Y, book43, held43, sellSetup, sellAt, orderOf, fillsOf, heldShares } from './sell-fixture'

const permutations = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])))

describe('the share count decides when no exact-price target exists (#52)', () => {
  for (const order of [[10, 20], [20, 10]]) {
    test(`two targets filling at one close book to their own buckets, ${order.join(', ')}`, async () => {
      const { f, deps, rec, runId } = await sellSetup(
        [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 1, shares: 20, buy: '101.00' }],
        [{ idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 1, kind: 'sell_loc', price: '104.00' }],
      )
      for (const n of order) await sellAt(runId, n, '105.00', deps)
      expect(fillsOf(f)).toEqual(order.map((n) => [n, n === 10 ? 0 : 1]))
      expect(orderOf(f, 0, 'sell_loc').status).toBe('filled')
      expect(orderOf(f, 1, 'sell_loc').status).toBe('filled')
      expect((await heldShares(f, runId)).every((n) => n === 0)).toBe(true)
      expect(rec.attributions).toEqual([])
    })
  }

  for (const order of permutations([10, 20, 30])) {
    test(`three targets filling at one close book to their own buckets, ${order.join(', ')}`, async () => {
      const { f, deps, rec, runId } = await sellSetup(
        [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 1, shares: 20, buy: '101.00' }, { idx: 2, shares: 30, buy: '99.00' }],
        [{ idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 1, kind: 'sell_loc', price: '104.00' }, { idx: 2, kind: 'sell_loc', price: '102.00' }],
      )
      for (const n of order) await sellAt(runId, n, '105.00', deps)
      expect(fillsOf(f)).toEqual(order.map((n) => [n, n / 10 - 1]))
      for (const idx of [0, 1, 2]) expect(orderOf(f, idx, 'sell_loc').status).toBe('filled')
      expect(rec.attributions).toEqual([])
    })
  }

  test('a same-close exit sends no notice, but a price-distance pick at the same close does', async () => {
    const { f, deps, rec, runId } = await sellSetup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 1, shares: 10, buy: '101.00' }],
      [{ idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 1, kind: 'sell_loc', price: '104.00' }],
    )
    await sellAt(runId, 10, '105.00', deps)
    expect(fillsOf(f)).toEqual([[10, 1]])
    expect(rec.attributions).toHaveLength(1)
    expect(rec.attributions[0]).toMatchObject({
      attribution: {
        rule: 'price',
        chosen: { bucketIdx: 1, kind: 'sell_loc', distance: parseUsd('1.00') },
        alternatives: [{ bucketIdx: 0, kind: 'sell_loc', limitPrice: parseUsd('103.00'), distance: parseUsd('2.00') }],
      },
    })
  })

  test('the share count outranks price distance across a target and a stop', async () => {
    const { f, deps, rec, runId } = await sellSetup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 9, shares: 4, buy: '88.00' }],
      book43(),
    )
    await sellAt(runId, 4, '96.50', deps)
    expect(fillsOf(f)).toEqual([[4, 9]])
    expect(orderOf(f, 9, 'sell_loc').status).toBe('filled')
    expect(orderOf(f, 0, 'sell_loc').status).toBe('open')
    expect(orderOf(f, 0, 'stop_sell').status).toBe('open')
    expect(rec.attributions).toEqual([])
  })

  test('on a shared exact-price target the leg sized like the fill wins', async () => {
    const { f, deps, rec, runId } = await sellSetup(
      [{ idx: 0, shares: 20, buy: '100.00' }, { idx: 1, shares: 10, buy: '100.00' }],
      [{ idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 1, kind: 'sell_loc', price: '103.00' }],
    )
    await sellAt(runId, 10, '103.00', deps)
    expect(fillsOf(f)).toEqual([[10, 1]])
    expect(orderOf(f, 1, 'sell_loc').status).toBe('filled')
    expect(orderOf(f, 0, 'sell_loc').status).toBe('open')
    expect(rec.attributions).toHaveLength(1)
    expect(rec.attributions[0]).toMatchObject({
      attribution: { rule: 'price', chosen: { bucketIdx: 1, kind: 'sell_loc', distance: 0n }, alternatives: [{ bucketIdx: 0, kind: 'sell_loc', distance: 0n }] },
    })
  })
})

describe('stale legs on the fill day (#53)', () => {
  const lateFixture = () => sellSetup(held43, [...book43(Y, 'stale'), ...book43(D, 'open')])

  test('a late fill after the morning roll books to the leg that took it and pulls only that bucket\'s legs for today', async () => {
    const { f, deps, rec, runId } = await lateFixture()
    await sellAt(runId, 10, '91.20', deps, Y)
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
    expect(rec.attributions).toHaveLength(1)
    expect(rec.attributions[0]!.attribution).toMatchObject({
      rule: 'price',
      chosen: { bucketIdx: 9, kind: 'sell_loc', distance: parseUsd('0.20') },
      alternatives: [{ bucketIdx: 0, kind: 'stop_sell', limitPrice: parseUsd('97.00'), distance: parseUsd('5.80') }],
    })
  })

  test('the sibling stale leg is cancelled silently, so a rebuy of the bucket cannot let it absorb a second late fill', async () => {
    const held = Array.from({ length: 10 }, (_, idx) => ({ idx, shares: 10, buy: '88.00' }))
    const { f, deps, rec, runId } = await sellSetup(held, [
      { idx: 9, kind: 'sell_loc', price: '91.00', tradeDate: Y, status: 'stale' },
      { idx: 9, kind: 'stop_sell', price: '85.40', tradeDate: Y, status: 'stale' },
      { idx: 8, kind: 'stop_sell', price: '85.50', tradeDate: Y, status: 'stale' },
    ])
    await sellAt(runId, 10, '91.20', deps, Y)
    expect(fillsOf(f)).toEqual([[10, 9]])
    expect(orderOf(f, 9, 'stop_sell', Y)).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(rec.siblings).toEqual([])
    await manualFill(runId, { side: 'buy', price: '88.00', shares: 10, filledOn: D }, deps)
    expect((await heldShares(f, runId))[9]).toBe(10)
    await sellAt(runId, 10, '85.00', deps, Y)
    expect(fillsOf(f)).toEqual([[10, 9], [10, 8]])
    expect(orderOf(f, 8, 'stop_sell', Y).status).toBe('filled')
    expect(orderOf(f, 9, 'stop_sell', Y).status).toBe('cancelled')
    expect(rec.attributions).toEqual([])
  })

  test('a partial late fill leaves the stale leg stale and cancels nothing', async () => {
    const { f, deps, rec, runId } = await lateFixture()
    const before = f._stores.orders.map((o: any) => o.status)
    await sellAt(runId, 4, '91.20', deps, Y)
    expect((await heldShares(f, runId))[9]).toBe(6)
    expect(f._stores.orders.map((o: any) => o.status)).toEqual(before)
    expect(rec.siblings).toEqual([])
  })

  test('a stale exact-price target on a bucket emptied since is not read without the gate', async () => {
    const { f, deps, runId } = await sellSetup(
      [{ idx: 1, shares: 10, buy: '96.00' }],
      [{ idx: 0, kind: 'sell_loc', price: '103.00', status: 'stale', tradeDate: Y }, { idx: 1, kind: 'sell_loc', price: '99.00', status: 'stale', tradeDate: Y }],
    )
    await sellAt(runId, 5, '103.00', deps, Y)
    expect(fillsOf(f)).toEqual([[5, 1]])
    expect((await heldShares(f, runId))[1]).toBe(5)
    expect(f._stores.orders.map((o: any) => o.status)).toEqual(['stale', 'stale'])
  })

  test('a stale exact-price target that cannot cover the fill is skipped, where an open one fails loudly', async () => {
    const held = [{ idx: 0, shares: 5, buy: '100.00' }, { idx: 1, shares: 15, buy: '90.00' }]
    const orders = (status: OrderStatus, tradeDate: typeof D) => [
      { idx: 0, kind: 'sell_loc' as const, price: '103.00', status, tradeDate },
      { idx: 1, kind: 'sell_loc' as const, price: '92.00', shares: 10, status, tradeDate },
    ]
    const stale = await sellSetup(held, orders('stale', Y))
    await sellAt(stale.runId, 12, '103.00', stale.deps, Y)
    expect(fillsOf(stale.f)).toEqual([[12, 1]])

    const open = await sellSetup(held, orders('open', D))
    await expect(sellAt(open.runId, 12, '103.00', open.deps, D)).rejects.toMatchObject({ kind: 'too-many-shares' })
    expect(open.f._stores.fills).toHaveLength(0)
  })
})

describe('a partial fill keeps its order open (#54)', () => {
  test('two partials of one stop both book to its bucket', async () => {
    const { f, deps, rec, runId } = await sellSetup(held43, book43())
    await sellAt(runId, 4, '96.50', deps)
    expect(orderOf(f, 0, 'stop_sell').status).toBe('open')
    expect(orderOf(f, 0, 'sell_loc').status).toBe('open')
    expect(rec.siblings).toEqual([])
    await sellAt(runId, 6, '96.50', deps)
    expect(fillsOf(f)).toEqual([[4, 0], [6, 0]])
    expect(orderOf(f, 0, 'stop_sell').status).toBe('filled')
    expect(orderOf(f, 0, 'sell_loc')).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(orderOf(f, 9, 'sell_loc').status).toBe('open')
    expect(orderOf(f, 9, 'stop_sell').status).toBe('open')
    expect((await heldShares(f, runId))[9]).toBe(10)
    expect(rec.attributions).toHaveLength(2)
    for (const a of rec.attributions) expect(a.attribution.chosen).toMatchObject({ bucketIdx: 0, kind: 'stop_sell' })
  })

  test('three partials of one stop', async () => {
    const { f, deps, runId } = await sellSetup(held43, book43())
    await sellAt(runId, 3, '96.50', deps)
    await sellAt(runId, 3, '96.50', deps)
    expect(orderOf(f, 0, 'stop_sell').status).toBe('open')
    await sellAt(runId, 4, '96.50', deps)
    expect(fillsOf(f)).toEqual([[3, 0], [3, 0], [4, 0]])
    expect(orderOf(f, 0, 'stop_sell').status).toBe('filled')
  })

  test('three partials of one target', async () => {
    const { f, deps, runId } = await sellSetup(held43, book43())
    await sellAt(runId, 3, '103.50', deps)
    await sellAt(runId, 3, '103.50', deps)
    expect(orderOf(f, 0, 'sell_loc').status).toBe('open')
    expect(orderOf(f, 0, 'stop_sell').status).toBe('open')
    await sellAt(runId, 4, '103.50', deps)
    expect(fillsOf(f)).toEqual([[3, 0], [3, 0], [4, 0]])
    expect(orderOf(f, 0, 'sell_loc').status).toBe('filled')
    expect(orderOf(f, 0, 'stop_sell').status).toBe('cancelled')
  })

  test('two buckets sharing a target price take partials in bucket order', async () => {
    const { f, deps, runId } = await sellSetup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 1, shares: 10, buy: '100.00' }],
      [0, 1].flatMap((idx) => [{ idx, kind: 'sell_loc' as const, price: '103.00' }, { idx, kind: 'stop_sell' as const, price: '97.00' }]),
    )
    for (const n of [4, 6, 10]) await sellAt(runId, n, '103.20', deps)
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
    await sellAt(runId, 4, '103.00', deps)
    await sellAt(runId, 10, '103.00', deps)
    expect(fillsOf(f)).toEqual([[4, 0], [10, 1]])
    expect(orderOf(f, 0, 'sell_loc').status).toBe('open')
    expect(orderOf(f, 1, 'sell_loc').status).toBe('open')
    expect((await heldShares(f, runId)).slice(0, 2)).toEqual([6, 2])
  })

  test('a partially filled exact-price target still fails loudly when no bucket at that price can cover the fill', async () => {
    const { f, deps, runId } = await sellSetup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 1, shares: 15, buy: '90.00' }],
      [{ idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 1, kind: 'sell_loc', price: '92.00', shares: 10 }],
    )
    await sellAt(runId, 4, '103.00', deps)
    expect(fillsOf(f)).toEqual([[4, 0]])
    await expect(runBooking({ runId, side: 'sell', shares: 8, priceStr: '103.00', feeCents: null, filledOn: D, pendingId: null, source: 'manual' }, deps)).rejects.toMatchObject({ kind: 'too-many-shares' })
    expect(fillsOf(f)).toEqual([[4, 0]])
  })
})
