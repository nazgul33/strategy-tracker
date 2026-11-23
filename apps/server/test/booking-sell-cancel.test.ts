import { describe, test, expect } from 'bun:test'
import { runBooking } from '../src/domain/booking'
import { D, setup, sell, order, lastFill, bookInput, pair, held1 } from './booking-sell-fixture'

describe('sell matching with target and stop legs', () => {
  test('a bucket-emptying stop fill cancels the sibling sell_loc', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }],
      [{ idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' }],
    )
    const { cancelledIds } = await runBooking(bookInput(runId, 10, '96.50'), deps)
    const sibling = order(f, 0, 'sell_loc')
    expect(sibling.status).toBe('cancelled')
    expect(sibling.cancelReason).toBe('broker-filled')
    expect(cancelledIds).toEqual([sibling.id])
    expect(order(f, 0, 'stop_sell').status).toBe('filled')
    expect(order(f, 0, 'stop_sell').cancelReason).toBeNull()
  })

  test('a bucket-emptying target fill cancels the sibling stop_sell', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }],
      [{ idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' }],
    )
    const { cancelledIds } = await runBooking(bookInput(runId, 10, '103.00'), deps)
    const sibling = order(f, 0, 'stop_sell')
    expect(sibling.status).toBe('cancelled')
    expect(sibling.cancelReason).toBe('broker-filled')
    expect(cancelledIds).toEqual([sibling.id])
    expect(order(f, 0, 'sell_loc').status).toBe('filled')
  })

  test('a bucket-emptying market_sell fill cancels nothing when no other leg is open', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }],
      [{ idx: 0, kind: 'market_sell', price: '0' }],
    )
    const { cancelledIds } = await runBooking(bookInput(runId, 10, '99.00'), deps)
    expect(cancelledIds).toEqual([])
    expect(order(f, 0, 'market_sell').status).toBe('filled')
  })

  test('the sibling cancel only touches the filled bucket, its own trade date and open orders', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 1, shares: 10, buy: '100.00' }],
      [
        { idx: 0, kind: 'stop_sell', price: '97.00' },
        { idx: 0, kind: 'sell_loc', price: '103.00', status: 'stale', tradeDate: '2026-11-11' },
        // Same bucket, same trade date, but already filled: not open, so left alone.
        { idx: 0, kind: 'sell_loc', price: '103.00', status: 'filled' },
        { idx: 1, kind: 'sell_loc', price: '103.00' },
        { idx: 1, kind: 'stop_sell', price: '97.00' },
      ],
    )
    expect((await runBooking(bookInput(runId, 10, '96.00'), deps)).cancelledIds).toEqual([])
    expect(f._stores.orders.filter((o: any) => o.status === 'cancelled')).toEqual([])
    const filledLeg = f._stores.orders.find((o) => o.bucketIdx === 0 && o.kind === 'sell_loc' && o.tradeDate === D)!
    expect(filledLeg.status).toBe('filled')
    expect(filledLeg.cancelReason).toBeNull()
    expect(order(f, 1, 'sell_loc').status).toBe('open')
    expect(order(f, 1, 'stop_sell').status).toBe('open')
  })

  test('a partial stop fill cancels nothing and leaves its own order open', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }],
      [{ idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' }],
    )
    const { cancelledIds } = await runBooking(bookInput(runId, 4, '96.50'), deps)
    expect(cancelledIds).toEqual([])
    const sibling = order(f, 0, 'sell_loc')
    expect(sibling.status).toBe('open')
    expect(sibling.cancelReason).toBeNull()
    expect(order(f, 0, 'stop_sell').status).toBe('open')
    const st = await f.repos.bucketRepo.loadState(runId)
    expect(st.buckets[0]!.shares).toBe(6)
    expect(st.buckets[0]!.state).toBe('held')
  })

  test('a sell between every trigger and every limit reaches the old fallback', async () => {
    // Buckets 4 and 6 carry live pairs (97/103); 100.00 is neither <= a trigger nor >= a limit.
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 4, shares: 10, buy: '100.00' }, { idx: 6, shares: 10, buy: '100.00' }],
      [
        { idx: 4, kind: 'sell_loc', price: '103.00' }, { idx: 4, kind: 'stop_sell', price: '97.00' },
        { idx: 6, kind: 'sell_loc', price: '103.00' }, { idx: 6, kind: 'stop_sell', price: '97.00' },
      ],
    )
    const { cancelledIds } = await runBooking(bookInput(runId, 10, '100.00'), deps)
    expect(lastFill(f).bucketIdx).toBe(0)
    expect(cancelledIds).toEqual([])
    expect(f._stores.orders.every((o: any) => o.status === 'open')).toBe(true)
  })

  test('a fallback fill that empties its bucket cancels every open sell leg of that bucket', async () => {
    // 100.00 sits in the gap (97 < 100 < 103): nothing matches, the guess lands on bucket 0 and empties it.
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 4, shares: 10, buy: '100.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
        { idx: 4, kind: 'sell_loc', price: '103.00' }, { idx: 4, kind: 'stop_sell', price: '97.00' },
      ],
    )
    const { cancelledIds } = await runBooking(bookInput(runId, 10, '100.00'), deps)
    expect(lastFill(f).bucketIdx).toBe(0)
    const legs = [order(f, 0, 'sell_loc'), order(f, 0, 'stop_sell')]
    expect(cancelledIds).toEqual(legs.map((o: any) => o.id))
    for (const o of legs) { expect(o.status).toBe('cancelled'); expect(o.cancelReason).toBe('broker-filled') }
    expect(order(f, 4, 'sell_loc').status).toBe('open')
    expect(order(f, 4, 'stop_sell').status).toBe('open')
  })

  test('a partial fallback fill cancels nothing', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }],
      [{ idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' }],
    )
    expect((await runBooking(bookInput(runId, 4, '100.00'), deps)).cancelledIds).toEqual([])
    expect(f._stores.orders.map((o: any) => o.status)).toEqual(['open', 'open'])
  })

  test('a matched fill that empties its bucket also cancels every other open leg, not just one', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
        { idx: 0, kind: 'market_sell', price: '0' },
      ],
    )
    const { cancelledIds } = await runBooking(bookInput(runId, 10, '103.00'), deps)
    expect(order(f, 0, 'sell_loc').status).toBe('filled')
    expect(cancelledIds).toEqual([order(f, 0, 'stop_sell').id, order(f, 0, 'market_sell').id])
    expect(f._stores.orders.filter((o: any) => o.status === 'cancelled').length).toBe(2)
  })

  test('a failed fill insert cancels nothing and leaves the matched order open', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }],
      [{ idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' }],
    )
    f.repos.fillRepo.insert = async () => { throw new Error('db-exploded') }
    await expect(sell(runId, 10, '96.50', deps)).rejects.toThrow('db-exploded')
    expect(f._stores.orders.map((o: any) => o.status)).toEqual(['open', 'open'])
  })

  test('a sell reads only the orders from its fill date onwards', async () => {
    const { f, deps, runId } = await setup(held1, [...pair, { idx: 1, kind: 'sell_loc', price: '103.00', tradeDate: '2026-11-11' }])
    const calls: [number, string][] = []
    const returned: any[] = []
    const orderRepo = f.repos.orderRepo
    f.repos.orderRepo = {
      ...orderRepo,
      listForRun: async () => { throw new Error('unbounded-read') },
      listForRunFrom: async (id: number, fromDate: string) => { calls.push([id, fromDate]); const rows = await orderRepo.listForRunFrom(id, fromDate); returned.push(...rows); return rows },
    }
    await sell(runId, 10, '96.50', deps)
    expect(calls).toEqual([[runId, D]])
    expect(returned.length).toBeGreaterThan(0)
    expect(returned.every((o: any) => o.tradeDate >= D)).toBe(true)
    expect(f._stores.orders.find((o: any) => o.tradeDate === '2026-11-11')!.status).toBe('open')
    expect(lastFill(f).bucketIdx).toBe(1)
  })
})
