import { describe, test, expect, spyOn } from 'bun:test'
import { parseUsd } from '@st/core/money'
import { confirmPendingFill } from '../src/domain/booking'
import { withRunLock } from '../src/domain/run-lock'
import { NO_SNAPSHOT } from './booking-fakes'
import { ev } from './sell-attribute-fixture'
import { D, book43, held43, orderOf, lastFill, sellSetup, sellTyped, type Held, type Ord } from './sell-fixture'

const STOP = ev('stop')
const STOP_TYPE = '매도/STOP(시장가)'

// Two held buckets, each with a target and a stop; a 10-share stop fill at 96.50 fits both stops, bucket 0's the nearer.
const twoStops: Held[] = [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 1, shares: 10, buy: '100.00' }]
const twoStopsBook: Ord[] = [
  { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
  { idx: 1, kind: 'sell_loc', price: '105.00' }, { idx: 1, kind: 'stop_sell', price: '99.00' },
]

describe('sell attribution to the order of the screenshot\'s type', () => {
  test('a stop fill below another bucket\'s target books to the stop and is quiet (issue #43)', async () => {
    const { f, deps, rec, runId } = await sellSetup(held43, book43())
    await sellTyped(runId, 10, '96.50', deps, STOP)
    expect(lastFill(f).bucketIdx).toBe(0)
    expect(orderOf(f, 0, 'stop_sell').status).toBe('filled')
    expect(orderOf(f, 0, 'sell_loc')).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(orderOf(f, 9, 'sell_loc').status).toBe('open')
    expect(orderOf(f, 9, 'stop_sell').status).toBe('open')
    expect(rec.attributions).toEqual([])
    expect(rec.siblings.map((s) => s.order.id)).toEqual([orderOf(f, 0, 'sell_loc').id])
  })

  test('two stops possible: the nearest trigger wins and the alternatives are listed nearest first, whatever the insertion order', async () => {
    const { f, deps, rec, runId } = await sellSetup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 1, shares: 10, buy: '100.00' }, { idx: 2, shares: 10, buy: '100.00' }],
      [{ idx: 2, kind: 'stop_sell', price: '102.00' }, { idx: 1, kind: 'stop_sell', price: '99.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' }],
    )
    await sellTyped(runId, 10, '96.50', deps, STOP)
    expect(lastFill(f).bucketIdx).toBe(0)
    expect(orderOf(f, 0, 'stop_sell').status).toBe('filled')
    expect(orderOf(f, 1, 'stop_sell').status).toBe('open')
    expect(rec.attributions).toHaveLength(1)
    expect(rec.attributions[0]).toMatchObject({
      runId,
      attribution: {
        shares: 10,
        price: parseUsd('96.50'),
        rule: 'price',
        chosen: { orderId: orderOf(f, 0, 'stop_sell').id, bucketIdx: 0, kind: 'stop_sell', limitPrice: parseUsd('97.00'), distance: parseUsd('0.50') },
      },
    })
    expect(rec.attributions[0]!.attribution.alternatives).toMatchObject([
      { bucketIdx: 1, kind: 'stop_sell', limitPrice: parseUsd('99.00'), distance: parseUsd('2.50') },
      { bucketIdx: 2, kind: 'stop_sell', limitPrice: parseUsd('102.00'), distance: parseUsd('5.50') },
    ])
  })

  test('a market sell among two forced-sell buckets books to the one holding exactly the fill and notifies', async () => {
    const { f, deps, rec, runId } = await sellSetup(
      [{ idx: 2, shares: 12, buy: '100.00' }, { idx: 5, shares: 10, buy: '100.00' }],
      [{ idx: 5, kind: 'market_sell' }, { idx: 2, kind: 'market_sell' }],
    )
    await sellTyped(runId, 10, '50.00', deps, ev('market'))
    expect(lastFill(f).bucketIdx).toBe(5)
    expect(orderOf(f, 5, 'market_sell').status).toBe('filled')
    expect(orderOf(f, 2, 'market_sell').status).toBe('open')
    expect(rec.attributions).toHaveLength(1)
    expect(rec.attributions[0]!.attribution).toMatchObject({
      rule: 'shares',
      chosen: { bucketIdx: 5, kind: 'market_sell' },
      alternatives: [{ bucketIdx: 2, kind: 'market_sell' }],
    })
  })
})

describe('delivery of the attribution notice', () => {
  test('a failing attribution notice still lets the sibling notices through', async () => {
    const { f, deps, rec, runId } = await sellSetup(twoStops, twoStopsBook, (base) => ({ ...base, sellAttributed: async () => { throw new Error('telegram-down') } }))
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await sellTyped(runId, 10, '96.50', deps, STOP)
      expect(f._stores.fills).toHaveLength(1)
      expect(rec.siblings).toHaveLength(1)
      expect(errors).toHaveBeenCalledTimes(1)
    } finally { errors.mockRestore() }
  })

  test('the attribution notice runs after the run lock is released', async () => {
    let seen = 'never called'
    // withRunLock is not reentrant: a probe queued from inside the lock can only wait, so it loses the race.
    const { deps, runId } = await sellSetup(twoStops, twoStopsBook, (base) => ({
      ...base,
      sellAttributed: async (rid) => {
        seen = await Promise.race([withRunLock(rid, async () => 'free'), new Promise<string>((r) => setTimeout(() => r('held'), 100))])
      },
    }))
    await sellTyped(runId, 10, '96.50', deps, STOP)
    expect(seen).toBe('free')
  })

  test('confirming a pending sell sends the attribution notice too', async () => {
    const { f, deps, rec, runId } = await sellSetup(twoStops, twoStopsBook)
    const pid = await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'sell', ticker: 'AAPL', shares: 10, price: parseUsd('96.50'), fee: null, filledOn: D, status: 'pending', ...NO_SNAPSHOT, detectedOrderType: STOP_TYPE })
    await confirmPendingFill(pid, null, deps)
    expect(lastFill(f).bucketIdx).toBe(0)
    expect(rec.attributions).toHaveLength(1)
    expect(rec.attributions[0]!.runId).toBe(runId)
    expect(rec.attributions[0]!.attribution.chosen).toMatchObject({ bucketIdx: 0, kind: 'stop_sell' })
    expect(rec.siblings).toHaveLength(1)
  })

  test('confirming a pending sell sends the attribution notice after the run lock is released', async () => {
    let seen = 'never called'
    const { f, deps, runId } = await sellSetup(twoStops, twoStopsBook, (base) => ({
      ...base,
      sellAttributed: async (rid) => {
        seen = await Promise.race([withRunLock(rid, async () => 'free'), new Promise<string>((r) => setTimeout(() => r('held'), 100))])
      },
    }))
    const pid = await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'sell', ticker: 'AAPL', shares: 10, price: parseUsd('96.50'), fee: null, filledOn: D, status: 'pending', ...NO_SNAPSHOT, detectedOrderType: STOP_TYPE })
    await confirmPendingFill(pid, null, deps)
    expect(seen).toBe('free')
  })
})
