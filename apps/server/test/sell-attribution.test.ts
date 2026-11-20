import { describe, test, expect, spyOn } from 'bun:test'
import { emptyState, applyBuyFill, type ISODate } from '@st/core'
import { parseUsd } from '@st/core/money'
import { manualFill, runBooking, confirmPendingFill, type FillBookingDeps } from '../src/domain/booking'
import { withRunLock } from '../src/domain/run-lock'
import { fakeRepos, recordingNotifier } from './booking-fakes'

const D: ISODate = '2026-11-12'
type Held = { idx: number; shares: number; buy: string }
type Ord = { idx: number; kind: 'sell_loc' | 'stop_sell' | 'market_sell'; price: string }

async function setup(held: Held[], ords: Ord[], notifyOverride?: (base: ReturnType<typeof recordingNotifier>['notify']) => FillBookingDeps['notify']) {
  const f = fakeRepos()
  const rec = recordingNotifier()
  const deps: FillBookingDeps = { repos: f.repos as any, today: D, notify: notifyOverride ? notifyOverride(rec.notify) : rec.notify }
  let s = emptyState(10)
  for (const h of held) s = applyBuyFill(s, h.idx, h.shares, parseUsd(h.buy), 0, '2026-11-01')
  const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'attr', poolCents: 1000000, costPpm: 0, initialRunState: { buckets: s.buckets, cashCents: s.cashCents, closed: s.closed, ages: s.ages } })
  await f.repos.orderRepo.insertMany(ords.map((o) => ({
    runId, tradeDate: D, kind: o.kind, bucketIdx: o.idx,
    limitPrice: o.kind === 'market_sell' ? 0n : parseUsd(o.price), shares: 10, status: 'open',
  })))
  return { f, deps, rec, runId }
}
const sell = (runId: number, shares: number, price: string, deps: FillBookingDeps) =>
  manualFill(runId, { side: 'sell', shares, price, filledOn: D }, deps)
const order = (f: ReturnType<typeof fakeRepos>, idx: number, kind: string) =>
  f._stores.orders.find((o: any) => o.bucketIdx === idx && o.kind === kind)
const lastFill = (f: ReturnType<typeof fakeRepos>) => f._stores.fills[f._stores.fills.length - 1]

const held43: Held[] = [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 9, shares: 10, buy: '88.00' }]
const book43: Ord[] = [
  { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
  { idx: 9, kind: 'sell_loc', price: '91.00' }, { idx: 9, kind: 'stop_sell', price: '85.40' },
]
const pair: Ord[] = [{ idx: 1, kind: 'sell_loc', price: '103.00' }, { idx: 1, kind: 'stop_sell', price: '97.00' }]
const held1: Held[] = [{ idx: 1, shares: 10, buy: '100.00' }]

describe('sell attribution to the nearest order price', () => {
  test('a stop fill below another bucket\'s target books to the nearest leg (issue #43)', async () => {
    const { f, deps, rec, runId } = await setup(held43, book43)
    await sell(runId, 10, '96.50', deps)
    expect(lastFill(f).bucketIdx).toBe(0)
    expect(order(f, 0, 'stop_sell').status).toBe('filled')
    expect(order(f, 0, 'sell_loc')).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(order(f, 9, 'sell_loc').status).toBe('open')
    expect(order(f, 9, 'stop_sell').status).toBe('open')
    expect(rec.attributions).toHaveLength(1)
    expect(rec.attributions[0]).toMatchObject({
      runId,
      attribution: {
        shares: 10,
        price: parseUsd('96.50'),
        chosen: { orderId: order(f, 0, 'stop_sell').id, bucketIdx: 0, kind: 'stop_sell', limitPrice: parseUsd('97.00'), distance: parseUsd('0.50') },
        alternatives: [{ orderId: order(f, 9, 'sell_loc').id, bucketIdx: 9, kind: 'sell_loc', limitPrice: parseUsd('91.00'), distance: parseUsd('5.50') }],
      },
    })
    expect(rec.attributions[0]!.attribution.alternatives).toHaveLength(1)
    expect(rec.siblings.map((s) => s.order.id)).toEqual([order(f, 0, 'sell_loc').id])
  })

  test('equidistant target and stop resolve to the target', async () => {
    const { f, deps, rec, runId } = await setup(held43, book43)
    await sell(runId, 10, '94.00', deps)
    expect(order(f, 9, 'sell_loc').status).toBe('filled')
    const a = rec.attributions[0]!.attribution
    expect(a.chosen).toMatchObject({ bucketIdx: 9, kind: 'sell_loc', distance: parseUsd('3.00') })
    expect(a.alternatives).toHaveLength(1)
    expect(a.alternatives[0]).toMatchObject({ bucketIdx: 0, kind: 'stop_sell', distance: parseUsd('3.00') })
  })

  test('a target near the fill beats a loose stop on another bucket', async () => {
    const { f, deps, rec, runId } = await setup(held43, book43)
    await sell(runId, 10, '91.50', deps)
    expect(lastFill(f).bucketIdx).toBe(9)
    const a = rec.attributions[0]!.attribution
    expect(a.chosen).toMatchObject({ bucketIdx: 9, distance: parseUsd('0.50') })
    expect(a.alternatives).toHaveLength(1)
    expect(a.alternatives[0]).toMatchObject({ bucketIdx: 0, kind: 'stop_sell', distance: parseUsd('5.50') })
  })

  test('an unambiguous fill sends no attribution notice', async () => {
    const { rec, deps, runId } = await setup(held1, pair)
    await sell(runId, 10, '96.50', deps)
    expect(rec.attributions).toEqual([])
    expect(rec.siblings).toHaveLength(1)
  })

  test('two other admissible buckets are listed nearest first, whatever the insertion order', async () => {
    const { f, deps, rec, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 1, shares: 10, buy: '90.00' }, { idx: 2, shares: 10, buy: '105.00' }],
      [
        { idx: 2, kind: 'sell_loc', price: '108.00' }, { idx: 2, kind: 'stop_sell', price: '102.00' },
        { idx: 1, kind: 'sell_loc', price: '92.00' }, { idx: 1, kind: 'stop_sell', price: '87.00' },
        { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
      ],
    )
    await sell(runId, 10, '96.50', deps)
    expect(lastFill(f).bucketIdx).toBe(0)
    expect(order(f, 0, 'stop_sell').status).toBe('filled')
    expect(rec.attributions).toHaveLength(1)
    const a = rec.attributions[0]!.attribution
    expect(a.chosen).toMatchObject({ bucketIdx: 0, kind: 'stop_sell', limitPrice: parseUsd('97.00'), distance: parseUsd('0.50') })
    expect(a.alternatives).toHaveLength(2)
    expect(a.alternatives).toMatchObject([
      { bucketIdx: 1, kind: 'sell_loc', limitPrice: parseUsd('92.00'), distance: parseUsd('4.50') },
      { bucketIdx: 2, kind: 'stop_sell', limitPrice: parseUsd('102.00'), distance: parseUsd('5.50') },
    ])
  })

  test('a bucket whose legs do not fit the price is not an alternative', async () => {
    // Bucket 0 needs >= 103.00 for its target and <= 97.00 for its stop, so a 100.00 print is not admissible there.
    const { f, deps, rec, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 1, shares: 10, buy: '96.00' }, { idx: 2, shares: 10, buy: '110.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
        { idx: 1, kind: 'sell_loc', price: '99.00' }, { idx: 1, kind: 'stop_sell', price: '93.00' },
        { idx: 2, kind: 'sell_loc', price: '113.00' }, { idx: 2, kind: 'stop_sell', price: '106.00' },
      ],
    )
    await sell(runId, 10, '100.00', deps)
    expect(order(f, 1, 'sell_loc').status).toBe('filled')
    const a = rec.attributions[0]!.attribution
    expect(a.chosen).toMatchObject({ bucketIdx: 1, kind: 'sell_loc' })
    expect(a.alternatives).toHaveLength(1)
    expect(a.alternatives[0]).toMatchObject({ bucketIdx: 2, kind: 'stop_sell', distance: parseUsd('6.00') })
  })

  test('an exact target hit still reports another admissible bucket', async () => {
    const { f, deps, rec, runId } = await setup(held43, book43)
    await sell(runId, 10, '91.00', deps)
    expect(order(f, 9, 'sell_loc').status).toBe('filled')
    const a = rec.attributions[0]!.attribution
    expect(a.chosen).toMatchObject({ bucketIdx: 9, kind: 'sell_loc', distance: 0n })
    expect(a.alternatives).toHaveLength(1)
    expect(a.alternatives[0]).toMatchObject({ bucketIdx: 0, kind: 'stop_sell', limitPrice: parseUsd('97.00'), distance: parseUsd('6.00') })
  })

  // Pins the existing rung 1c tie-break (#48 gap): passes before the attribution change.
  test('market_sell ties resolve to the lowest bucket regardless of insertion order', async () => {
    const { f, deps, rec, runId } = await setup(
      [{ idx: 2, shares: 10, buy: '100.00' }, { idx: 5, shares: 10, buy: '100.00' }, { idx: 7, shares: 10, buy: '100.00' }],
      [{ idx: 7, kind: 'market_sell', price: '0' }, { idx: 5, kind: 'market_sell', price: '0' }, { idx: 2, kind: 'market_sell', price: '0' }],
    )
    await sell(runId, 10, '50.00', deps)
    expect(lastFill(f).bucketIdx).toBe(2)
    expect(rec.attributions).toEqual([])
  })
})

describe('delivery of the attribution notice', () => {
  test('a failing attribution notice still lets the sibling notices through', async () => {
    const { f, deps, rec, runId } = await setup(held43, book43, (base) => ({ ...base, sellAttributed: async () => { throw new Error('telegram-down') } }))
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await sell(runId, 10, '96.50', deps)
      expect(f._stores.fills).toHaveLength(1)
      expect(rec.siblings).toHaveLength(1)
      expect(errors).toHaveBeenCalledTimes(1)
    } finally { errors.mockRestore() }
  })

  test('the attribution notice runs after the run lock is released', async () => {
    let seen = 'never called'
    // withRunLock is not reentrant: a probe queued from inside the lock can only wait, so it loses the race.
    const { deps, runId } = await setup(held43, book43, (base) => ({
      ...base,
      sellAttributed: async (rid) => {
        seen = await Promise.race([withRunLock(rid, async () => 'free'), new Promise<string>((r) => setTimeout(() => r('held'), 100))])
      },
    }))
    await runBooking({ runId, side: 'sell', shares: 10, priceStr: '96.50', feeCents: null, filledOn: D, pendingId: null, source: 'manual' }, deps)
    expect(seen).toBe('free')
  })

  test('confirming a pending sell sends the attribution notice too', async () => {
    const { f, deps, rec, runId } = await setup(held43, book43)
    const pid = await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'sell', ticker: 'AAPL', shares: 10, price: parseUsd('96.50'), fee: null, filledOn: D, status: 'pending' })
    await confirmPendingFill(pid, null, deps)
    expect(lastFill(f).bucketIdx).toBe(0)
    expect(rec.attributions).toHaveLength(1)
    expect(rec.attributions[0]!.runId).toBe(runId)
    expect(rec.attributions[0]!.attribution.chosen).toMatchObject({ bucketIdx: 0, kind: 'stop_sell' })
    expect(rec.siblings).toHaveLength(1)
  })
})
