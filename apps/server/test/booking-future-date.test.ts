import { describe, expect, test } from 'bun:test'
import { applyBuyFill, parseUsd, type ISODate } from '@st/core'
import { confirmPendingFill, manualFill, seedRun } from '../src/domain/booking'
import { applyCorrection } from '../src/domain/corrections'
import { rebookFill } from '../src/domain/recompute'
import { NO_SNAPSHOT } from './booking-fakes'
import { D, held1, lastFill, sellSetup, type Fakes } from './sell-fixture'

const T: ISODate = '2026-11-13'
const REFUSED = { kind: 'fill-date-in-future' }

const snapshot = async (f: Fakes, runId: number) => structuredClone({
  fills: f._stores.fills, ledger: f._stores.ledger, orders: f._stores.orders, pending: f._stores.pending,
  state: await f.repos.bucketRepo.loadState(runId),
})

async function plantFutureBuy(f: Fakes, runId: number) {
  const state = await f.repos.bucketRepo.loadState(runId)
  const next = applyBuyFill(state, 0, 10, parseUsd('100.00'), 0, T)
  next.ages[0] = 0
  await f.repos.bucketRepo.saveState(runId, next)
  await f.repos.fillRepo.insert({ runId, bucketIdx: 0, side: 'buy', ticker: 'AAPL', shares: 10, price: parseUsd('100.00'), fee: 0, filledOn: T, source: 'seed' })
  return f._stores.fills[0]!.id
}

describe('booking refuses a fill dated after today (#96)', () => {
  test('a manual buy dated after today is refused', async () => {
    const { f, deps, runId } = await sellSetup([], [])
    const before = await snapshot(f, runId)
    await expect(manualFill(runId, { side: 'buy', shares: 10, price: '100.00', filledOn: T }, deps)).rejects.toMatchObject(REFUSED)
    expect(await snapshot(f, runId)).toEqual(before)
  })

  test('a manual sell dated after today is refused', async () => {
    const { f, deps, runId } = await sellSetup(held1, [])
    const before = await snapshot(f, runId)
    await expect(manualFill(runId, { side: 'sell', shares: 10, price: '96.50', filledOn: T }, deps)).rejects.toMatchObject(REFUSED)
    expect(await snapshot(f, runId)).toEqual(before)
  })

  test('a fill dated today books', async () => {
    const { f, deps, runId } = await sellSetup([], [])
    await manualFill(runId, { side: 'buy', shares: 10, price: '100.00', filledOn: D }, deps)
    expect(lastFill(f)).toMatchObject({ side: 'buy', filledOn: D })
  })

  test('a pending row with a future date cannot be confirmed', async () => {
    const { f, deps, runId } = await sellSetup([], [])
    const id = await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 10, price: parseUsd('100.00'), fee: null, filledOn: T, status: 'pending', ...NO_SNAPSHOT })
    const before = await snapshot(f, runId)
    await expect(confirmPendingFill(id, null, deps)).rejects.toMatchObject(REFUSED)
    expect(await snapshot(f, runId)).toEqual(before)
    expect(f._stores.pending[0]!.status).toBe('pending')

    await confirmPendingFill(id, { filledOn: D }, deps)
    expect(f._stores.pending[0]).toMatchObject({ status: 'confirmed', filledOn: D })
    expect(lastFill(f)).toMatchObject({ side: 'buy', filledOn: D })
  })

  test('an edit that moves a fill to a future date is refused', async () => {
    const { f, deps, runId } = await sellSetup([], [])
    await manualFill(runId, { side: 'buy', shares: 10, price: '100.00', filledOn: D }, deps)
    const before = await snapshot(f, runId)
    await expect(rebookFill(runId, { fillId: lastFill(f).id, shares: 10, priceStr: '100.00', feeCents: 0, filledOn: T }, deps)).rejects.toMatchObject(REFUSED)
    expect(await snapshot(f, runId)).toEqual(before)
  })

  test('a fill already stored with a future date can be corrected and re-dated', async () => {
    const { f, deps, runId } = await sellSetup([], [])
    const fillId = await plantFutureBuy(f, runId)

    await rebookFill(runId, { fillId, shares: 10, priceStr: '101.00', feeCents: 0, filledOn: T }, deps)
    expect(lastFill(f)).toMatchObject({ price: parseUsd('101.00'), filledOn: T })

    await rebookFill(runId, { fillId, shares: 10, priceStr: '101.00', feeCents: 0, filledOn: D }, deps)
    expect(lastFill(f).filledOn).toBe(D)
  })

  test('a correction applies to a fill stored with a future date', async () => {
    const { f, deps, runId } = await sellSetup([], [])
    const fillId = await plantFutureBuy(f, runId)
    const fill = f._stores.fills[0]!
    const id = await f.repos.correctionRepo.insert({
      runId, fillId, captureId: null, side: 'buy', ticker: 'AAPL',
      bookedShares: fill.shares, bookedFilledOn: fill.filledOn, bookedPrice: fill.price, bookedFee: fill.fee,
      proposedPrice: parseUsd('99.00'), proposedFee: null,
    })
    await applyCorrection(id, deps)
    expect(lastFill(f)).toMatchObject({ price: parseUsd('99.00'), filledOn: T })
  })

  test('seeding refuses a future date', async () => {
    const { f, deps, runId } = await sellSetup([], [])
    const before = await snapshot(f, runId)
    const seed = { cashCents: 500_000, buckets: [{ shares: 10, buyPrice: '100.00', filledOn: D }, { shares: 5, buyPrice: '90.00', filledOn: T }] }
    await expect(seedRun(runId, seed, deps)).rejects.toMatchObject(REFUSED)
    expect(await snapshot(f, runId)).toEqual(before)
  })
})
