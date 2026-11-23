import { describe, test, expect } from 'bun:test'
import { parseUsd } from '@st/core/money'
import { confirmPendingFill, manualFill } from '../src/domain/booking'
import { NO_SNAPSHOT } from './booking-fakes'
import { D, book43, held1, held43, pair, sellSetup, orderOf, fillsOf, heldShares, lastFill, type Fakes } from './sell-fixture'

const STOP = '매도/STOP(시장가)'

const pendingSell = (f: Fakes, runId: number, over: Record<string, unknown> = {}) =>
  f.repos.pendingRepo.insert({
    runId, captureId: null, bucketIdx: null, side: 'sell', ticker: 'AAPL', shares: 10, price: parseUsd('96.50'), fee: null,
    filledOn: D, status: 'pending', ...NO_SNAPSHOT, ...over,
  })

describe('a pending sell is attributed by its screenshot order type', () => {
  test('a typed pending sell books by its type', async () => {
    const { f, deps, rec, runId } = await sellSetup(held43, book43())
    const pid = await pendingSell(f, runId, { detectedOrderType: STOP })
    await confirmPendingFill(pid, null, deps)
    expect(lastFill(f)).toMatchObject({ bucketIdx: 0, side: 'sell', shares: 10 })
    expect(orderOf(f, 0, 'stop_sell').status).toBe('filled')
    expect(orderOf(f, 0, 'sell_loc')).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(orderOf(f, 9, 'sell_loc').status).toBe('open')
    expect(orderOf(f, 9, 'stop_sell').status).toBe('open')
    expect(rec.attributions).toEqual([])
  })

  test('the same row without an order type needs a choice', async () => {
    const { f, deps, runId } = await sellSetup(held43, book43())
    const pid = await pendingSell(f, runId)
    const before = { held: await heldShares(f, runId), statuses: f._stores.orders.map((o) => o.status) }
    await expect(confirmPendingFill(pid, null, deps)).rejects.toMatchObject({ kind: 'choose-bucket' })
    expect(f._stores.pending.find((p) => p.id === pid)!.status).toBe('pending')
    expect(f._stores.fills).toHaveLength(0)
    expect(f._stores.ledger).toHaveLength(0)
    expect(await heldShares(f, runId)).toEqual(before.held)
    expect(f._stores.orders.map((o) => o.status)).toEqual(before.statuses)

    await confirmPendingFill(pid, { bucketIdx: 0 }, deps)
    expect(fillsOf(f)).toEqual([[10, 0]])
    expect(f._stores.pending.find((p) => p.id === pid)!.status).toBe('confirmed')
  })

  test('an ordered-shares pick sends the notice', async () => {
    const { f, deps, rec, runId } = await sellSetup(
      [{ idx: 0, shares: 4, buy: '100.00' }, { idx: 1, shares: 4, buy: '100.00' }],
      [{ idx: 0, kind: 'stop_sell', price: '97.00', shares: 10 }, { idx: 1, kind: 'stop_sell', price: '97.00', shares: 4 }],
    )
    const pid = await pendingSell(f, runId, { shares: 4, detectedOrderType: STOP, detectedOrderedShares: 10 })
    await confirmPendingFill(pid, null, deps)
    expect(fillsOf(f)).toEqual([[4, 0]])
    expect(rec.attributions).toHaveLength(1)
    expect(rec.attributions[0]!.attribution).toMatchObject({ rule: 'ordered-shares', chosen: { bucketIdx: 0 }, alternatives: [{ bucketIdx: 1 }] })
  })

  test('quantity and price edited before confirm still use the screenshot\'s order type', async () => {
    const { f, deps, runId } = await sellSetup(held43, book43())
    const pid = await pendingSell(f, runId, { detectedOrderType: STOP })
    await confirmPendingFill(pid, { shares: 5, price: '96.40' }, deps)
    expect(fillsOf(f)).toEqual([[5, 0]])
    expect((await heldShares(f, runId))[0]).toBe(5)
  })

  test('a row confirmed as a buy ignores the order type', async () => {
    const { f, deps, rec, runId } = await sellSetup(held43, book43())
    const pid = await pendingSell(f, runId, { detectedOrderType: STOP })
    await confirmPendingFill(pid, { side: 'buy' }, deps)
    expect(lastFill(f)).toMatchObject({ side: 'buy', bucketIdx: 1 })
    expect(f._stores.orders.every((o) => o.status === 'open')).toBe(true)
    expect(rec.attributions).toEqual([])
  })
})

describe('a typed sell with no order of its kind', () => {
  test('a market sell on a bucket holding only a target and a stop needs a choice, then cancels both and flips neither', async () => {
    const { f, deps, rec, runId } = await sellSetup(held1, pair)
    const pid = await pendingSell(f, runId, { price: parseUsd('104.00'), detectedOrderType: '매도/보통(시장가)' })
    await expect(confirmPendingFill(pid, null, deps)).rejects.toMatchObject({ kind: 'choose-bucket' })

    await confirmPendingFill(pid, { bucketIdx: 1 }, deps)
    expect(fillsOf(f)).toEqual([[10, 1]])
    for (const kind of ['sell_loc', 'stop_sell']) {
      expect(orderOf(f, 1, kind)).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    }
    expect(f._stores.orders.some((o) => o.status === 'filled')).toBe(false)
    expect(rec.siblings.map((s) => s.order.kind).sort()).toEqual(['sell_loc', 'stop_sell'])
  })
})

describe('a manual sell among several possible buckets', () => {
  test('a manual sell among two possible buckets is refused', async () => {
    const { f, deps, runId } = await sellSetup(held43, book43())
    await expect(manualFill(runId, { side: 'sell', shares: 10, price: '96.50', filledOn: D }, deps)).rejects.toMatchObject({ kind: 'choose-bucket' })
    expect(f._stores.fills).toHaveLength(0)
    expect(f._stores.ledger).toHaveLength(0)
    expect(await heldShares(f, runId)).toEqual([10, 0, 0, 0, 0, 0, 0, 0, 0, 10])

    await manualFill(runId, { side: 'sell', shares: 10, price: '96.50', filledOn: D, bucketIdx: 9 }, deps)
    expect(fillsOf(f)).toEqual([[10, 9]])
  })
})
