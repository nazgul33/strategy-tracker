import { describe, test, expect, spyOn } from 'bun:test'
import { deleteFill } from '../src/domain/recompute'
import { manualFill } from '../src/domain/booking'
import { D, Y, orderOf } from './sell-fixture'
import { heldRun } from './legs-fixture'

const BUYS = [
  { shares: 10, price: '100.00', filledOn: '2026-11-10' },
  { shares: 5, price: '90.00', filledOn: '2026-11-01' },
] as const

describe('deleteFill retires the legs of a bucket whose buy it removes', () => {
  test('deleting a bucket\'s buy cancels its legs with reason other and tells the operator', async () => {
    const { f, deps, rec, runId } = await heldRun([...BUYS], [
      { idx: 0, kind: 'sell_loc', price: '103.00' },
      { idx: 0, kind: 'stop_sell', price: '97.00' },
      { idx: 0, kind: 'sell_loc', price: '104.00', tradeDate: Y, status: 'stale' },
      { idx: 0, kind: 'sell_loc', price: '105.00', tradeDate: '2026-11-05', status: 'stale' },
      { idx: 1, kind: 'sell_loc', price: '95.00' },
    ])
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-10', kind: 'buy_loc', bucketIdx: 0, limitPrice: 1000000n, shares: 10, status: 'filled' }])
    const buyId = f._stores.fills.find((x) => x.bucketIdx === 0)!.id
    const open = [orderOf(f, 0, 'sell_loc'), orderOf(f, 0, 'stop_sell')]
    const filledBefore = f._stores.orders.filter((o) => o.status === 'filled').map((o) => o.id)

    await deleteFill(runId, buyId, deps)

    for (const o of open) expect(o).toMatchObject({ status: 'cancelled', cancelReason: 'other' })
    expect(rec.orphans.map((x) => x.order.id)).toEqual(open.map((o) => o.id))
    expect(orderOf(f, 0, 'sell_loc', Y)).toMatchObject({ status: 'cancelled', cancelReason: 'other' })
    expect(orderOf(f, 0, 'sell_loc', '2026-11-05').status).toBe('stale')
    expect(orderOf(f, 0, 'buy_loc', '2026-11-10').status).toBe('filled')
    expect(f._stores.orders.find((o) => o.bucketIdx === 1)!.status).toBe('open')
    expect(rec.siblings).toEqual([])
    expect(f._stores.orders.filter((o) => o.status === 'filled').map((o) => o.id)).toEqual(filledBefore)
  })

  test('deleting a second lot\'s buy does not read the earlier lot\'s sell', async () => {
    // every bucket held, so the rebuy after bucket 0's sell has nowhere else to land
    const allHeld = Array.from({ length: 10 }, () => ({ shares: 10, price: '100.00', filledOn: '2026-11-01' }) as const)
    const { f, deps, rec, runId } = await heldRun(allHeld, [])
    await manualFill(runId, { side: 'sell', shares: 10, price: '103.00', filledOn: '2026-11-05', bucketIdx: 0 }, deps)
    await manualFill(runId, { side: 'buy', shares: 8, price: '100.00', filledOn: '2026-11-10' }, deps)
    expect(f._stores.fills.at(-1)).toMatchObject({ side: 'buy', bucketIdx: 0 })
    await f.repos.orderRepo.insertMany([
      { runId, tradeDate: D, kind: 'sell_loc', bucketIdx: 0, limitPrice: 1030000n, shares: 8, status: 'open' },
      { runId, tradeDate: D, kind: 'stop_sell', bucketIdx: 0, limitPrice: 970000n, shares: 8, status: 'open' },
    ])
    const buyId = Math.max(...f._stores.fills.map((x) => x.id))

    await deleteFill(runId, buyId, deps)

    for (const o of f._stores.orders) expect(o).toMatchObject({ status: 'cancelled', cancelReason: 'other' })
    expect(rec.orphans).toHaveLength(2)
    expect(rec.siblings).toEqual([])
  })

  test('a notifier that throws does not fail the delete', async () => {
    const { f, deps, runId } = await heldRun([...BUYS], [{ idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' }])
    deps.notify.buyRemoved = async () => { throw new Error('telegram-down') }
    const buyId = f._stores.fills.find((x) => x.bucketIdx === 0)!.id
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await deleteFill(runId, buyId, deps)
      expect(orderOf(f, 0, 'sell_loc').status).toBe('cancelled')
      expect(orderOf(f, 0, 'stop_sell').status).toBe('cancelled')
      expect(errors).toHaveBeenCalled()
    } finally { errors.mockRestore() }
  })
})
