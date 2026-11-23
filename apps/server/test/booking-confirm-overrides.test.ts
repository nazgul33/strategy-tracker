import { describe, test, expect } from 'bun:test'
import { emptyState, applyBuyFill, type ISODate } from '@st/core'
import { parseUsd, feeCents } from '@st/core/money'
import { confirmPendingFill, type FillBookingDeps, type OrderRow } from '../src/domain/booking'
import { fakeRepos, silentNotifier, NO_SNAPSHOT } from './booking-fakes'

describe('confirmPendingFill side and fee overrides', () => {
  const D: ISODate = '2026-11-12'

  async function setup(held: Array<{ idx: number; shares: number; buy: string }>, pend: { side?: 'buy' | 'sell'; shares?: number; price?: string; fee?: number | null } = {}, costPpm = 100) {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: D, notify: silentNotifier }
    let s = emptyState(10)
    for (const h of held) s = applyBuyFill(s, h.idx, h.shares, parseUsd(h.buy), 0, '2026-11-01')
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'ov', poolCents: 1_000_000, costPpm, initialRunState: { buckets: s.buckets, cashCents: s.cashCents, closed: s.closed, ages: s.ages } })
    const pid = await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: pend.side ?? 'buy', ticker: 'AAPL', shares: pend.shares ?? 10, price: parseUsd(pend.price ?? '10.00'), fee: pend.fee ?? null, filledOn: D, status: 'pending', ...NO_SNAPSHOT })
    return { f, deps, runId, pid }
  }

  test('confirming with side: "sell" books a sell against a held bucket', async () => {
    const { f, deps, runId, pid } = await setup([{ idx: 0, shares: 10, buy: '10.00' }])
    await confirmPendingFill(pid, { side: 'sell' }, deps)
    expect(f._stores.fills).toHaveLength(1)
    expect(f._stores.fills[0]).toMatchObject({ side: 'sell', bucketIdx: 0, shares: 10 })
    expect((await f.repos.bucketRepo.loadState(runId)).buckets[0]!.state).toBe('empty')
    expect(f._stores.ledger[0]!.kind).toBe('sell')
  })

  test('a side override to sell with no held bucket throws no-bucket-for-sell and leaves the row pending', async () => {
    const { f, deps, pid } = await setup([])
    await expect(confirmPendingFill(pid, { side: 'sell' }, deps)).rejects.toMatchObject({ kind: 'no-bucket-for-sell' })
    expect(f._stores.pending[0]!.status).toBe('pending')
    expect(f._stores.pending[0]!.side).toBe('buy')
    expect(f._stores.fills).toHaveLength(0)
  })

  test('a sell override that empties a bucket still cancels and notifies the sibling order', async () => {
    const { f, deps, runId, pid } = await setup([{ idx: 1, shares: 10, buy: '100.00' }], { price: '96.50' })
    await f.repos.orderRepo.insertMany([
      { runId, tradeDate: D, kind: 'sell_loc', bucketIdx: 1, limitPrice: parseUsd('103.00'), shares: 10, status: 'open' },
      { runId, tradeDate: D, kind: 'stop_sell', bucketIdx: 1, limitPrice: parseUsd('97.00'), shares: 10, status: 'open' },
    ])
    const notified: Array<{ runId: number; order: OrderRow }> = []
    const d: FillBookingDeps = { ...deps, notify: { ...silentNotifier, siblingCancelled: async (rid, o) => { notified.push({ runId: rid, order: { ...o } }) } } }
    await confirmPendingFill(pid, { side: 'sell' }, d)
    const target = f._stores.orders.find((o) => o.kind === 'sell_loc')!
    expect(f._stores.orders.find((o) => o.kind === 'stop_sell')!.status).toBe('filled')
    expect(target).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(notified.map((n) => n.order.id)).toEqual([target.id])
    expect(notified[0]!.runId).toBe(runId)
  })

  test('side joins the edited patch written to the pending row on confirm', async () => {
    const { f, deps, pid } = await setup([{ idx: 0, shares: 10, buy: '10.00' }])
    await confirmPendingFill(pid, { side: 'sell' }, deps)
    expect(f._stores.pending[0]).toMatchObject({ status: 'confirmed', side: 'sell' })
  })

  test('no side override keeps the pending side', async () => {
    const { f, deps, pid } = await setup([], { side: 'buy' })
    await confirmPendingFill(pid, { shares: 4 }, deps)
    expect(f._stores.fills[0]).toMatchObject({ side: 'buy', shares: 4 })
    expect(f._stores.pending[0]!.side).toBe('buy')
  })

  test('feeCents: null recomputes the fee from the run cost ppm', async () => {
    const { f, deps, pid } = await setup([], { fee: 999, shares: 5 }, 2500)
    await confirmPendingFill(pid, { price: '20.00', feeCents: null }, deps)
    const expected = feeCents(parseUsd('20.00'), 5, 2500)
    expect(expected).not.toBe(999)
    expect(f._stores.fills[0]!.fee).toBe(expected)
    expect(f._stores.pending[0]!.fee).toBe(expected)
  })

  test('feeCents: 0 books a zero fee', async () => {
    const { f, deps, pid } = await setup([], { fee: 999 }, 2500)
    await confirmPendingFill(pid, { feeCents: 0 }, deps)
    expect(f._stores.fills[0]!.fee).toBe(0)
  })

  test('feeCents: a positive integer overrides the pending fee', async () => {
    const { f, deps, pid } = await setup([], { fee: 999 })
    await confirmPendingFill(pid, { feeCents: 17 }, deps)
    expect(f._stores.fills[0]!.fee).toBe(17)
  })

  test('an invalid side override throws invalid-side and books nothing', async () => {
    for (const side of ['SELL', '', 'hold', 1, null]) {
      const { f, deps, pid } = await setup([{ idx: 0, shares: 10, buy: '10.00' }])
      await expect(confirmPendingFill(pid, { side: side as any }, deps)).rejects.toThrow('invalid-side')
      expect(f._stores.fills).toHaveLength(0)
      expect(f._stores.pending[0]!.status).toBe('pending')
    }
  })

  test('an invalid fee override throws invalid-fee and books nothing', async () => {
    for (const fee of [-1, 1.5, NaN, '5', Infinity]) {
      const { f, deps, pid } = await setup([])
      await expect(confirmPendingFill(pid, { feeCents: fee as any }, deps)).rejects.toThrow('invalid-fee')
      expect(f._stores.fills).toHaveLength(0)
      expect(f._stores.pending[0]!.status).toBe('pending')
    }
  })
})
