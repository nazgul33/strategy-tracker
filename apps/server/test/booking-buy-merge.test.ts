import { describe, test, expect } from 'bun:test'
import { emptyState, applyBuyFill, type ISODate, type RunState } from '@st/core'
import { parseUsd } from '@st/core/money'
import { manualFill, confirmPendingFill, type FillBookingDeps } from '../src/domain/booking'
import { fakeRepos, silentNotifier, NO_SNAPSHOT } from './booking-fakes'

const T: ISODate = '2026-11-24'
const OLD: ISODate = '2026-11-20'
const TODAY: ISODate = '2026-11-25'

const closedTranche = (index: number, openedOn: ISODate, closedOn: ISODate) =>
  ({ index, shares: 5, buyPrice: parseUsd('50.00'), soldPrice: parseUsd('55.00'), buyFeeCents: 0, sellFeeCents: 0, openedOn, closedOn })

// A 10-bucket run (costPpm 0) holding `held` (idx, shares, filledOn), with an optional state tweak.
async function setup(held: Array<[number, number, ISODate]>, tweak?: (s: RunState) => void) {
  const f = fakeRepos()
  const deps: FillBookingDeps = { repos: f.repos, today: TODAY, notify: silentNotifier }
  let s = emptyState(10)
  for (const [idx, shares, on] of held) s = applyBuyFill(s, idx, shares, parseUsd('50.00'), 0, on)
  tweak?.(s)
  const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'merge', poolCents: 10_000_000, costPpm: 0, initialRunState: { buckets: s.buckets, cashCents: s.cashCents, closed: s.closed, ages: s.ages } })
  const pend = (shares: number, price = '50.00', on: ISODate = T) =>
    f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares, price: parseUsd(price), fee: null, filledOn: on, status: 'pending', ...NO_SNAPSHOT })
  const state = () => f.repos.bucketRepo.loadState(runId)
  const status = (id: number) => f._stores.pending.find((p: any) => p.id === id)!.status
  return { f, deps, runId, pend, state, status }
}
const five = (): Array<[number, number, ISODate]> => [0, 1, 2, 3, 4].map((i): [number, number, ISODate] => [i, 10, OLD])

describe('automatic buy bucket', () => {
  test('confirming the three 2026-11-24 buys on Automatic books all into bucket 5', async () => {
    const s = await setup(five())
    await s.f.repos.orderRepo.insertMany([{ runId: s.runId, tradeDate: T, kind: 'buy_loc', bucketIdx: 5, limitPrice: parseUsd('50.00'), shares: 146, status: 'open' }])
    for (const n of [50, 60, 36]) await confirmPendingFill(await s.pend(n), null, s.deps)
    expect(s.f._stores.fills).toHaveLength(3)
    expect(s.f._stores.fills.map((x: any) => x.bucketIdx)).toEqual([5, 5, 5])
    const st = await s.state()
    expect(st.buckets[5]).toMatchObject({ state: 'held', shares: 146, filledOn: T })
    expect(st.buckets[6]!.state).toBe('empty')
    expect(st.buckets[7]!.state).toBe('empty')
    expect(s.f._stores.orders.find((o: any) => o.kind === 'buy_loc')!.status).toBe('filled')
  })

  test('a chosen bucketIdx on a buy adds to that held bucket', async () => {
    const s = await setup([[2, 10, OLD]], (st) => { st.ages[2] = 3 })
    expect((await s.state()).ages[2]).toBe(3)
    const id = await s.pend(5)
    await confirmPendingFill(id, { bucketIdx: 2 }, s.deps)
    const st = await s.state()
    expect(st.buckets[2]).toMatchObject({ state: 'held', shares: 15, filledOn: OLD })
    expect(st.ages[2]).toBe(3)
    expect(s.f._stores.fills[0]).toMatchObject({ bucketIdx: 2, side: 'buy', shares: 5 })
    expect(s.status(id)).toBe('confirmed')
  })

  test('a chosen empty bucket on a buy is bucket-not-held and the row stays pending', async () => {
    const s = await setup([[2, 10, OLD]])
    const id = await s.pend(5)
    await expect(confirmPendingFill(id, { bucketIdx: 3 }, s.deps)).rejects.toMatchObject({ kind: 'bucket-not-held' })
    expect(s.status(id)).toBe('pending')
    expect(s.f._stores.fills).toEqual([])
  })

  test('a chosen bucketIdx past the last bucket on a buy is bucket-not-found and the row stays pending', async () => {
    const s = await setup([[2, 10, OLD]])
    const id = await s.pend(5)
    await expect(confirmPendingFill(id, { bucketIdx: 10 }, s.deps)).rejects.toMatchObject({ kind: 'bucket-not-found' })
    expect(s.status(id)).toBe('pending')
    expect(s.f._stores.fills).toEqual([])
  })

  test('a chosen force_sell or partly sold bucket on a buy is bucket-not-mergeable and the row stays pending', async () => {
    const s = await setup([[1, 10, OLD], [2, 10, OLD]], (st) => {
      st.buckets[1]!.state = 'force_sell'
      st.closed.push(closedTranche(2, OLD, T))
    })
    for (const idx of [1, 2]) {
      const id = await s.pend(5)
      await expect(confirmPendingFill(id, { bucketIdx: idx }, s.deps)).rejects.toMatchObject({ kind: 'bucket-not-mergeable' })
      expect(s.status(id)).toBe('pending')
    }
    expect(s.f._stores.fills).toEqual([])
  })

  test('Automatic skips a partly sold same-day bucket and books the next empty bucket', async () => {
    const s = await setup([[0, 10, T]], (st) => { st.closed.push(closedTranche(0, T, T)) })
    await confirmPendingFill(await s.pend(5), null, s.deps)
    expect(s.f._stores.fills[0]).toMatchObject({ bucketIdx: 1 })
    expect((await s.state()).buckets[0]!.shares).toBe(10)
  })

  test('a buy never lands in a bucket emptied by a sell on the same date', async () => {
    const hold = [0, 1, 2, 3, 5, 6, 7, 9].map((i): [number, number, ISODate] => [i, 10, OLD])
    const s = await setup(hold, (st) => { st.closed.push(closedTranche(4, OLD, T), closedTranche(8, OLD, OLD)) })
    await confirmPendingFill(await s.pend(5), null, s.deps)
    expect(s.f._stores.fills[0]).toMatchObject({ bucketIdx: 8 })

    const only4 = await setup([0, 1, 2, 3, 5, 6, 7, 8, 9].map((i): [number, number, ISODate] => [i, 10, OLD]), (st) => { st.closed.push(closedTranche(4, OLD, T)) })
    const id = await only4.pend(5)
    await expect(confirmPendingFill(id, null, only4.deps)).rejects.toThrow('no-empty-bucket')
    expect(only4.status(id)).toBe('pending')
  })

  test('Automatic does not merge into a bucket bought on an earlier day', async () => {
    const s = await setup([[1, 10, OLD]])
    await confirmPendingFill(await s.pend(5), null, s.deps)
    expect(s.f._stores.fills[0]).toMatchObject({ bucketIdx: 0 })
    expect((await s.state()).buckets[1]!.shares).toBe(10)
  })

  test('a manual buy fill on Automatic merges into the same-day bucket', async () => {
    const s = await setup([[3, 10, T]])
    await manualFill(s.runId, { side: 'buy', shares: 4, price: '50.00', filledOn: T }, s.deps)
    expect(s.f._stores.fills[0]).toMatchObject({ bucketIdx: 3, shares: 4 })
    expect((await s.state()).buckets[3]!.shares).toBe(14)
  })
})
