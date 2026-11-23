import { describe, test, expect } from 'bun:test'
import { emptyState, applyBuyFill, type ISODate } from '@st/core'
import { parseUsd } from '@st/core/money'
import { runBooking, type OrderRow } from '../src/domain/booking'
import { matchSellOrder } from '../src/domain/sell-match'
import { setup, sell, order, lastFill, bookInput } from './booking-sell-fixture'

describe('sell matching with target and stop legs', () => {
  test('exact target match still wins', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 1, shares: 10, buy: '90.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
        { idx: 1, kind: 'sell_loc', price: '92.00' }, { idx: 1, kind: 'stop_sell', price: '87.00' },
      ],
    )
    await sell(runId, 10, '103.00', deps)
    expect(lastFill(f).bucketIdx).toBe(0)
    expect(order(f, 0, 'sell_loc').status).toBe('filled')
    expect(order(f, 1, 'sell_loc').status).toBe('open')
  })

  test('an exact target match with impossible shares fails loudly instead of landing elsewhere', async () => {
    // Bucket 0 holds 10 but its target prints 103.00 for 15 shares: the only honest
    // answer is a 422 the operator resolves, never a silent booking into bucket 1
    // (whose 92.00 target also qualifies at 103.00) plus a cancel of bucket 1's legs.
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 1, shares: 15, buy: '90.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
        { idx: 1, kind: 'sell_loc', price: '92.00' }, { idx: 1, kind: 'stop_sell', price: '87.00' },
      ],
    )
    await expect(runBooking(bookInput(runId, 15, '103.00'), deps)).rejects.toMatchObject({ kind: 'too-many-shares' })
    expect(f._stores.fills).toHaveLength(0)
    expect(f._stores.orders.every((o: any) => o.status === 'open')).toBe(true)
    const st = await f.repos.bucketRepo.loadState(runId)
    expect(st.buckets.map((b: any) => b.shares)).toEqual([10, 15, ...Array(8).fill(0)])
  })

  test('a target fill above its limit books to the nearest leg, not a loose stop', async () => {
    // bucket 0: buy 100.00, stop trigger 97.00; bucket 9: buy 90.00, target limit 91.00. 91.50 is also <= 97.00.
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 9, shares: 10, buy: '90.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
        { idx: 9, kind: 'sell_loc', price: '91.00' }, { idx: 9, kind: 'stop_sell', price: '87.00' },
      ],
    )
    await sell(runId, 10, '91.50', deps)
    expect(lastFill(f).bucketIdx).toBe(9)
    expect(order(f, 9, 'sell_loc').status).toBe('filled')
    expect(order(f, 0, 'stop_sell').status).toBe('open')
    expect(order(f, 0, 'sell_loc').status).toBe('open')
  })

  test('with several targets at or below the fill price, the highest limit wins', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '80.00' }, { idx: 1, shares: 10, buy: '90.00' }, { idx: 2, shares: 10, buy: '95.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '82.00' },
        { idx: 1, kind: 'sell_loc', price: '92.00' },
        { idx: 2, kind: 'sell_loc', price: '97.00' },
      ],
    )
    await sell(runId, 10, '93.00', deps)
    expect(lastFill(f).bucketIdx).toBe(1)
  })

  test('a fill that no bucket target reaches matches no target', async () => {
    // 94.00 is below bucket 1's 103.00 target limit, so it is not a target fill; it is at or under the 95.00 stop trigger, so the stop takes it.
    const { f, deps, runId } = await setup(
      [{ idx: 1, shares: 10, buy: '100.00' }],
      [{ idx: 1, kind: 'sell_loc', price: '103.00' }, { idx: 1, kind: 'stop_sell', price: '95.00' }],
    )
    await sell(runId, 10, '94.00', deps)
    expect(order(f, 1, 'stop_sell').status).toBe('filled')
    expect(order(f, 1, 'sell_loc').status).toBe('cancelled')
  })

  test('a stop fill books to the closest trigger at or above it', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 3, shares: 10, buy: '96.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
        { idx: 3, kind: 'sell_loc', price: '99.00' }, { idx: 3, kind: 'stop_sell', price: '93.00' },
      ],
    )
    await sell(runId, 10, '92.50', deps)
    expect(lastFill(f).bucketIdx).toBe(3)
    expect(order(f, 3, 'stop_sell').status).toBe('filled')
    expect(order(f, 0, 'stop_sell').status).toBe('open')
  })

  test('identical triggers resolve to the lowest bucket index', async () => {
    // Inserted high bucket first so insertion order cannot be what decides it.
    const { f, deps, runId } = await setup(
      [{ idx: 2, shares: 10, buy: '100.00' }, { idx: 5, shares: 10, buy: '100.00' }, { idx: 7, shares: 10, buy: '100.00' }],
      [
        { idx: 7, kind: 'stop_sell', price: '97.00' },
        { idx: 5, kind: 'stop_sell', price: '97.00' },
        { idx: 2, kind: 'stop_sell', price: '97.00' },
      ],
    )
    await sell(runId, 10, '96.00', deps)
    expect(lastFill(f).bucketIdx).toBe(2)
    expect(order(f, 2, 'stop_sell').status).toBe('filled')
    expect(order(f, 5, 'stop_sell').status).toBe('open')
  })

  test('identical target limits resolve to the lowest bucket index', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 4, shares: 10, buy: '90.00' }, { idx: 6, shares: 10, buy: '90.00' }],
      [{ idx: 6, kind: 'sell_loc', price: '92.00' }, { idx: 4, kind: 'sell_loc', price: '92.00' }],
    )
    await sell(runId, 10, '92.50', deps)
    expect(lastFill(f).bucketIdx).toBe(4)
  })

  test('a stale stop dated on the fill day matches like an open one', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 3, shares: 10, buy: '96.00' }],
      [{ idx: 3, kind: 'stop_sell', price: '93.00', status: 'stale' }],
    )
    await sell(runId, 10, '92.50', deps)
    expect(lastFill(f).bucketIdx).toBe(3)
    expect(order(f, 3, 'stop_sell').status).toBe('filled')
  })

  test('orders of another run or another trade date never match', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 3, shares: 10, buy: '96.00' }],
      [
        { idx: 3, kind: 'stop_sell', price: '93.00', runId: 999 },
        { idx: 3, kind: 'sell_loc', price: '92.00', tradeDate: '2026-11-11' },
      ],
    )
    await sell(runId, 10, '92.50', deps)
    expect(lastFill(f).bucketIdx).toBe(0)
    expect(f._stores.orders.every((o: any) => o.status === 'open')).toBe(true)
  })

  test('a candidate whose bucket holds fewer shares than the fill is skipped', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 1, shares: 5, buy: '100.00' }, { idx: 2, shares: 10, buy: '100.00' }],
      [{ idx: 1, kind: 'stop_sell', price: '97.00', shares: 5 }, { idx: 2, kind: 'stop_sell', price: '97.00' }],
    )
    await sell(runId, 10, '96.00', deps)
    expect(lastFill(f).bucketIdx).toBe(2)
  })

  test('market_sell still matches at any price', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 2, shares: 10, buy: '100.00' }],
      [{ idx: 2, kind: 'market_sell', price: '0' }],
    )
    await sell(runId, 10, '50.00', deps)
    expect(lastFill(f).bucketIdx).toBe(2)
    expect(order(f, 2, 'market_sell').status).toBe('filled')
  })

  test('a target nearer the fill outranks a looser stop', async () => {
    // Bucket 0's stop trigger (105.00) is looser than bucket 1's target (92.00); a 93.00 fill must be read as the target.
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '110.00' }, { idx: 1, shares: 10, buy: '90.00' }],
      [{ idx: 0, kind: 'stop_sell', price: '105.00' }, { idx: 1, kind: 'sell_loc', price: '92.00' }],
    )
    await sell(runId, 10, '93.00', deps)
    expect(lastFill(f).bucketIdx).toBe(1)
  })
})

describe('matchSellOrder', () => {
  const state = (() => {
    let s = emptyState(4)
    s = applyBuyFill(s, 1, 10, parseUsd('100.00'), 0, '2026-11-01')
    return s
  })()
  const o = (over: Partial<OrderRow>): OrderRow => ({ id: 1, runId: 1, tradeDate: '2026-11-12', kind: 'sell_loc', bucketIdx: 1, limitPrice: parseUsd('103.00'), shares: 10, status: 'open', ...over })
  const input = { runId: 1, filledOn: '2026-11-12' as ISODate, shares: 10, price: parseUsd('103.00') }

  test('returns null for an empty bucket, a wrong run, a wrong date and a filled or cancelled status', () => {
    // 100.00 is under the 103.00 fill price, so this is a price-distance candidate and the gate applies.
    expect(matchSellOrder([o({ bucketIdx: 0, limitPrice: parseUsd('100.00') })], state, input)).toBeNull()
    expect(matchSellOrder([o({ runId: 2 })], state, input)).toBeNull()
    expect(matchSellOrder([o({ tradeDate: '2026-11-11' })], state, input)).toBeNull()
    expect(matchSellOrder([o({ status: 'filled' })], state, input)).toBeNull()
    expect(matchSellOrder([o({ status: 'cancelled' })], state, input)).toBeNull()
  })

  test('returns a stale order dated on the fill day, never a filled or cancelled one', () => {
    expect(matchSellOrder([o({ status: 'stale' })], state, input)?.order.id).toBe(1)
    expect(matchSellOrder([o({ status: 'filled' })], state, input)).toBeNull()
    expect(matchSellOrder([o({ status: 'cancelled' })], state, input)).toBeNull()
  })

  test('returns the order on the happy path and ignores buy_loc', () => {
    expect(matchSellOrder([o({ kind: 'buy_loc' })], state, input)).toBeNull()
    expect(matchSellOrder([o({})], state, input)?.order.id).toBe(1)
  })

  // The exact-price rung alone ignores the shares/emptiness gate: the booking must fail loudly
  // rather than attribute an exact-price print to some other bucket.
  test('an exact-price target is returned even when its bucket cannot cover the fill', () => {
    expect(matchSellOrder([o({ bucketIdx: 0 })], state, input)?.order.bucketIdx).toBe(0)
    expect(matchSellOrder([o({ bucketIdx: 0, status: 'stale' })], state, input)).toBeNull()
    expect(matchSellOrder([o({})], state, { ...input, shares: 99 })?.order.id).toBe(1)
    // the gate still applies to every other rung
    expect(matchSellOrder([o({ kind: 'stop_sell', limitPrice: parseUsd('110.00') })], state, { ...input, shares: 99 })).toBeNull()
  })
})
