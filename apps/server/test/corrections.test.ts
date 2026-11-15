import { describe, expect, test } from 'bun:test'
import { DomainError, emptyState, parseUsd, type ISODate } from '@st/core'
import { manualFill, type BookingDeps } from '../src/domain/booking'
import { applyCorrection, dismissCorrection, listOpenCorrections } from '../src/domain/corrections'
import { deleteFill, rebookFill } from '../src/domain/recompute'
import { fakeRepos } from './booking.test'

const TODAY: ISODate = '2026-11-15'
type F = ReturnType<typeof fakeRepos>

const adjustRows = (f: F) => f._stores.ledger.filter((l: any) => l.kind === 'adjust')
const fillById = (f: F, id: number) => f._stores.fills.find((x: any) => x.id === id)
const statusOf = (f: F, id: number) => f._stores.corrections.find((c) => c.id === id)!.status

async function kindOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (e) {
    if (e instanceof DomainError) return e.kind
    throw e
  }
  throw new Error('expected a DomainError, but the call resolved')
}

// Run with a buy 44 @ 60.00 (bucket 0) and a manual sell 44 @ 66.03 fee 2.03.
async function setup() {
  const f = fakeRepos()
  const deps: BookingDeps = { repos: f.repos as any, today: TODAY }
  const runId = await f.repos.runRepo.create({
    strategyKey: 'mean-reversion', ticker: 'SOXL', name: 'r', poolCents: 1_000_000, costPpm: 0,
    initialRunState: { buckets: emptyState(10).buckets, cashCents: 1_000_000, closed: [], ages: {} },
  })
  await manualFill(runId, { side: 'buy', shares: 44, price: '60.00', fee: '0.00', filledOn: '2026-11-10' }, deps)
  await manualFill(runId, { side: 'sell', shares: 44, price: '66.03', fee: '2.03', filledOn: '2026-11-11' }, deps)
  const buy = f._stores.fills.find((x: any) => x.side === 'buy')!
  const sell = f._stores.fills.find((x: any) => x.side === 'sell')!
  const propose = (target: any, proposedPrice: string, proposedFee: number | null) =>
    f.repos.correctionRepo.insert({
      runId, fillId: target.id, captureId: null, side: target.side, ticker: target.ticker,
      bookedShares: target.shares, bookedFilledOn: target.filledOn, bookedPrice: target.price, bookedFee: target.fee,
      proposedPrice: parseUsd(proposedPrice), proposedFee,
    })
  return { f, deps, runId, buy, sell, propose }
}

describe('applyCorrection', () => {
  test('apply: patches only the target sell', async () => {
    const { f, deps, runId, sell, propose } = await setup()
    const id = await propose(sell, '64.07', 203)
    const before = f._stores.fills.length
    const cashBefore = (await f.repos.bucketRepo.loadState(runId)).cashCents
    const adjustsBefore = adjustRows(f).length

    const out = await applyCorrection(id, deps)

    expect(f._stores.fills.length).toBe(before)
    const patched = fillById(f, sell.id)
    expect(patched.price).toBe(parseUsd('64.07'))
    expect(patched.fee).toBe(203)
    expect(patched.side).toBe('sell')
    expect(statusOf(f, id)).toBe('applied')
    const adjusts = adjustRows(f).slice(adjustsBefore)
    expect(adjusts.length).toBe(1)
    expect(JSON.parse(adjusts[0].ref)).toMatchObject({ fillId: sell.id, reason: 'capture-correction', correctionId: id })
    const cashAfter = (await f.repos.bucketRepo.loadState(runId)).cashCents
    expect(out.deltaCents).toBe(-8624)
    expect(cashAfter - cashBefore).toBe(-8624)
  })

  test('apply twice -> correction-not-open', async () => {
    const { f, deps, sell, propose } = await setup()
    const id = await propose(sell, '64.07', 203)
    await applyCorrection(id, deps)
    const priceAfterFirst = fillById(f, sell.id).price
    expect(await kindOf(() => applyCorrection(id, deps))).toBe('correction-not-open')
    expect(fillById(f, sell.id).price).toBe(priceAfterFirst)
    expect(adjustRows(f).length).toBe(1)
  })

  test('concurrent applies rebook once', async () => {
    const { f, deps, sell, propose } = await setup()
    const id = await propose(sell, '64.07', 203)
    const res = await Promise.allSettled([applyCorrection(id, deps), applyCorrection(id, deps)])
    expect(res.filter((r) => r.status === 'fulfilled').length).toBe(1)
    const rejected = res.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(rejected.length).toBe(1)
    expect(rejected[0]!.reason).toBeInstanceOf(DomainError)
    expect((rejected[0]!.reason as DomainError).kind).toBe('correction-not-open')
    expect(adjustRows(f).length).toBe(1)
  })

  test('apply: stale after hand edit', async () => {
    const { f, deps, runId, sell, propose } = await setup()
    const id = await propose(sell, '64.07', 203)
    await rebookFill(runId, { fillId: sell.id, shares: 44, priceStr: '65.00', feeCents: 203 }, deps)
    const adjustsBefore = adjustRows(f).length
    expect(await kindOf(() => applyCorrection(id, deps))).toBe('correction-stale')
    expect(statusOf(f, id)).toBe('open')
    expect(adjustRows(f).length).toBe(adjustsBefore)
    expect(fillById(f, sell.id).price).toBe(parseUsd('65.00'))
  })

  test('apply: stale after delete', async () => {
    const { f, deps, runId, sell, propose } = await setup()
    const id = await propose(sell, '64.07', 203)
    await deleteFill(runId, sell.id, deps)
    expect(await kindOf(() => applyCorrection(id, deps))).toBe('correction-stale')
    expect(statusOf(f, id)).toBe('open')
    const listed = await listOpenCorrections(deps)
    expect(listed.length).toBe(1)
    expect(listed[0]!.id).toBe(id)
    expect(listed[0]!.stale).toBe(true)
  })

  test('apply: sibling correction goes stale', async () => {
    const { f, deps, sell, propose } = await setup()
    const first = await propose(sell, '64.07', 203)
    const second = await propose(sell, '64.70', 203)
    expect((await listOpenCorrections(deps)).map((c) => c.stale)).toEqual([false, false])
    await applyCorrection(first, deps)
    const listed = await listOpenCorrections(deps)
    expect(listed.map((c) => [c.id, c.stale])).toEqual([[second, true]])
    expect(await kindOf(() => applyCorrection(second, deps))).toBe('correction-stale')
    expect(statusOf(f, second)).toBe('open')
  })

  test('apply: no proposed fee keeps booked fee', async () => {
    const { f, deps, sell, propose } = await setup()
    const id = await propose(sell, '64.07', null)
    await applyCorrection(id, deps)
    expect(fillById(f, sell.id).fee).toBe(203)
    expect(fillById(f, sell.id).price).toBe(parseUsd('64.07'))
  })

  test('apply: buy fill correction', async () => {
    const { f, deps, runId, buy, propose } = await setup()
    const id = await propose(buy, '59.50', null)
    const out = await applyCorrection(id, deps)
    expect(fillById(f, buy.id).price).toBe(parseUsd('59.50'))
    expect(statusOf(f, id)).toBe('applied')
    // buy 44 cheaper by 0.50 each -> cash up 22.00
    expect(out.deltaCents).toBe(2200)
    const state = await f.repos.bucketRepo.loadState(runId)
    expect(state.cashCents).toBe(1_000_000 - 261_800 + 290_532 - 203) // pool - buy + sell - sell fee
    expect(state.buckets[0]!.state).not.toBe('held')
  })

  test('apply: unknown id -> correction-not-found', async () => {
    const { deps } = await setup()
    expect(await kindOf(() => applyCorrection(999, deps))).toBe('correction-not-found')
  })
})

describe('dismissCorrection', () => {
  test('dismiss: leaves the fill untouched', async () => {
    const { f, deps, sell, propose } = await setup()
    const id = await propose(sell, '64.07', 203)
    const snapshot = { ...fillById(f, sell.id) }
    const adjustsBefore = adjustRows(f).length
    await dismissCorrection(id, deps)
    expect(statusOf(f, id)).toBe('dismissed')
    expect(fillById(f, sell.id)).toEqual(snapshot)
    expect(adjustRows(f).length).toBe(adjustsBefore)
    expect(await kindOf(() => dismissCorrection(id, deps))).toBe('correction-not-open')
    expect(await kindOf(() => dismissCorrection(999, deps))).toBe('correction-not-found')
  })

  test('dismiss: a stale correction can still be dismissed', async () => {
    const { f, deps, runId, sell, propose } = await setup()
    const id = await propose(sell, '64.07', 203)
    await deleteFill(runId, sell.id, deps)
    await dismissCorrection(id, deps)
    expect(statusOf(f, id)).toBe('dismissed')
    expect(await listOpenCorrections(deps)).toEqual([])
  })
})
