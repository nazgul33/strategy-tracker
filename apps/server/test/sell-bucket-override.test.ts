import { describe, test, expect } from 'bun:test'
import { parseUsd } from '@st/core/money'
import { manualFill, confirmPendingFill, type FillBookingDeps } from '../src/domain/booking'
import { sellSetup, orderOf, heldShares, held43, book43, held1, pair, D, Y } from './sell-fixture'
import { NO_SNAPSHOT } from './booking-fakes'

type Setup = Awaited<ReturnType<typeof sellSetup>>
const forced = (s: Setup, shares: number, price: string, bucketIdx: number | null, filledOn = D) =>
  manualFill(s.runId, { side: 'sell', shares, price, filledOn, bucketIdx }, s.deps)
const lastFill = (f: Setup['f']) => f._stores.fills[f._stores.fills.length - 1]
const statuses = (f: Setup['f']) => f._stores.orders.map((o: any) => o.status)

async function expectUntouched(s: Setup, held: number[]) {
  expect(s.f._stores.fills).toEqual([])
  expect(s.f._stores.ledger).toEqual([])
  expect(statuses(s.f).every((x: string) => x === 'open')).toBe(true)
  expect(await heldShares(s.f, s.runId)).toEqual(held)
}

describe('an operator-chosen bucket on a sell', () => {
  test('a forced bucket books there and flips the leg that fits the price', async () => {
    const s = await sellSetup(held43, book43())
    await forced(s, 10, '96.50', 9)
    expect(lastFill(s.f).bucketIdx).toBe(9)
    expect(orderOf(s.f, 9, 'sell_loc')!.status).toBe('filled')
    expect(orderOf(s.f, 9, 'stop_sell')).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(orderOf(s.f, 0, 'sell_loc')!.status).toBe('open')
    expect(orderOf(s.f, 0, 'stop_sell')!.status).toBe('open')
    expect(s.rec.attributions).toEqual([])
    expect(s.rec.siblings.map((x) => x.order.id)).toEqual([orderOf(s.f, 9, 'stop_sell')!.id])
  })

  test('a forced bucket with no leg that fits the price flips nothing and still cancels its legs when emptied', async () => {
    const s = await sellSetup(held43, book43())
    await forced(s, 10, '88.00', 9)
    expect(lastFill(s.f).bucketIdx).toBe(9)
    expect(orderOf(s.f, 9, 'sell_loc')).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(orderOf(s.f, 9, 'stop_sell')).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(s.rec.siblings.map((x) => x.order.id)).toEqual([orderOf(s.f, 9, 'sell_loc')!.id, orderOf(s.f, 9, 'stop_sell')!.id])
    expect(s.rec.attributions).toEqual([])
  })

  test('a forced partial fill leaves the fitting leg open and cancels nothing', async () => {
    const s = await sellSetup(held43, book43())
    await forced(s, 4, '96.50', 9)
    expect((await heldShares(s.f, s.runId))[9]).toBe(6)
    expect(statuses(s.f)).toEqual(['open', 'open', 'open', 'open'])
    expect(s.rec.siblings).toEqual([])
  })

  test('within a forced bucket the leg whose size matches the fill wins', async () => {
    const s = await sellSetup([{ idx: 0, shares: 10, buy: '90.00' }], [
      { idx: 0, kind: 'sell_loc', price: '95.00', shares: 7 }, { idx: 0, kind: 'market_sell', shares: 10 },
    ])
    await forced(s, 10, '99.00', 0)
    expect(orderOf(s.f, 0, 'market_sell')!.status).toBe('filled')
    expect(orderOf(s.f, 0, 'sell_loc')!.status).toBe('cancelled')
  })

  test('a forced late fill flips the stale leg of its day', async () => {
    const s = await sellSetup(held43, [...book43(Y, 'stale'), ...book43(D, 'open')])
    await forced(s, 10, '91.20', 9, Y)
    expect(orderOf(s.f, 9, 'sell_loc', Y)!.status).toBe('filled')
    expect(orderOf(s.f, 9, 'sell_loc', D)!.status).toBe('cancelled')
    expect(orderOf(s.f, 9, 'stop_sell', D)!.status).toBe('cancelled')
    expect(orderOf(s.f, 0, 'sell_loc', D)!.status).toBe('open')
    expect(orderOf(s.f, 0, 'stop_sell', D)!.status).toBe('open')
  })

  test('a forced bucket that is not held, too small or out of range books nothing', async () => {
    const s = await sellSetup(held43, book43())
    await expect(forced(s, 10, '96.50', 4)).rejects.toMatchObject({ kind: 'bucket-not-held' })
    await expect(forced(s, 11, '96.50', 0)).rejects.toMatchObject({ kind: 'too-many-shares' })
    await expect(forced(s, 10, '96.50', 10)).rejects.toMatchObject({ kind: 'bucket-not-found' })
    await expectUntouched(s, [10, 0, 0, 0, 0, 0, 0, 0, 0, 10])
  })

  test('a bucketIdx that is not a non-negative integer is invalid-bucket on a sell and on a buy', async () => {
    const s = await sellSetup(held43, book43())
    for (const bad of [1.5, -1, '9' as any]) await expect(forced(s, 10, '96.50', bad)).rejects.toThrow('invalid-bucket')
    await expect(manualFill(s.runId, { side: 'buy', shares: 5, price: '50.00', filledOn: D, bucketIdx: -1 }, s.deps)).rejects.toThrow('invalid-bucket')
    await expectUntouched(s, [10, 0, 0, 0, 0, 0, 0, 0, 0, 10])
  })

  test('a buy with a bucketIdx on an empty bucket is bucket-not-held', async () => {
    const s = await sellSetup(held43, book43())
    await expect(manualFill(s.runId, { side: 'buy', shares: 5, price: '50.00', filledOn: D, bucketIdx: 4 }, s.deps)).rejects.toMatchObject({ kind: 'bucket-not-held' })
    await expectUntouched(s, [10, 0, 0, 0, 0, 0, 0, 0, 0, 10])
  })

  test('bucketIdx null is automatic: it books when one bucket is possible and asks when two are', async () => {
    const one = await sellSetup(held1, pair)
    await forced(one, 10, '96.50', null)
    expect(lastFill(one.f).bucketIdx).toBe(1)
    expect(one.rec.attributions).toEqual([])

    const two = await sellSetup(held43, book43())
    await expect(forced(two, 10, '96.50', null)).rejects.toMatchObject({ kind: 'choose-bucket' })
    await expectUntouched(two, [10, 0, 0, 0, 0, 0, 0, 0, 0, 10])
  })
})

describe('an operator-chosen bucket on a pending confirm', () => {
  const pendingSell = (s: Setup, side: 'buy' | 'sell' = 'sell') =>
    s.f.repos.pendingRepo.insert({ runId: s.runId, captureId: null, bucketIdx: null, side, ticker: 'AAPL', shares: 10, price: parseUsd('96.50'), fee: null, filledOn: D, status: 'pending', ...NO_SNAPSHOT })

  test('a confirm override bucketIdx books the pending sell to that bucket', async () => {
    const s = await sellSetup(held43, book43())
    const pid = await pendingSell(s)
    await confirmPendingFill(pid, { bucketIdx: 9 }, s.deps as FillBookingDeps)
    expect(lastFill(s.f).bucketIdx).toBe(9)
    expect(s.f._stores.pending.find((p: any) => p.id === pid)).toMatchObject({ status: 'confirmed', bucketIdx: 9 })
    expect(s.rec.attributions).toEqual([])
  })

  test('a confirm that turns the row into a buy with a bucketIdx adds it to that held bucket', async () => {
    const s = await sellSetup(held43, book43())
    const pid = await pendingSell(s)
    await confirmPendingFill(pid, { side: 'buy', bucketIdx: 9 }, s.deps)
    expect(lastFill(s.f)).toMatchObject({ side: 'buy', bucketIdx: 9 })
    expect((await heldShares(s.f, s.runId))[9]).toBe(20)
    expect(s.f._stores.pending.find((p: any) => p.id === pid)).toMatchObject({ status: 'confirmed', bucketIdx: 9 })
  })

  test('a confirm that turns the row into a buy with a malformed bucketIdx is invalid-bucket and leaves the row pending', async () => {
    const s = await sellSetup(held43, book43())
    const pid = await pendingSell(s)
    await expect(confirmPendingFill(pid, { side: 'buy', bucketIdx: -1 }, s.deps)).rejects.toThrow('invalid-bucket')
    expect(s.f._stores.pending.find((p: any) => p.id === pid)!.status).toBe('pending')
    expect(s.f._stores.fills).toEqual([])
  })
})
