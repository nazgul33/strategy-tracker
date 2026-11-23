import { describe, expect, test } from 'bun:test'
import { emptyState, parseUsd, type ISODate } from '@st/core'
import { manualFill, seedRun, type FillBookingDeps } from '../src/domain/booking'
import { applyCorrection } from '../src/domain/corrections'
import { deleteFill, rebookFill, recalcRunState } from '../src/domain/recompute'
import { withRunLock } from '../src/domain/run-lock'
import { fakeRepos, silentNotifier } from './booking-fakes'

const TODAY: ISODate = '2026-11-15'
type F = ReturnType<typeof fakeRepos>

const tick = () => new Promise<void>((r) => setTimeout(r, 5))

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((r) => { release = r })
  return { promise, release }
}

async function setup() {
  const f = fakeRepos()
  const deps: FillBookingDeps = { repos: f.repos, today: TODAY, notify: silentNotifier }
  const runId = await f.repos.runRepo.create({
    strategyKey: 'mean-reversion', ticker: 'SPY', name: 'r', poolCents: 1_000_000, costPpm: 0,
    initialRunState: { buckets: emptyState(10).buckets, cashCents: 1_000_000, closed: [], ages: {} },
  })
  await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '0.00', filledOn: '2026-11-10' }, deps)
  return { f, deps, runId }
}

// Holds the run lock until `release()`, then asserts the writer neither
// finished nor wrote anything while the lock was held, and does afterwards.
async function expectWaitsForLock(runId: number, f: F, start: () => Promise<unknown>) {
  const gate = deferred()
  const holder = withRunLock(runId, () => gate.promise)
  const stateBefore = JSON.stringify(await f.repos.bucketRepo.loadState(runId), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  const ledgerBefore = f._stores.ledger.length
  const fillsBefore = f._stores.fills.length

  let settled = false
  const writer = start().finally(() => { settled = true })
  try {
    await tick()
    expect(settled).toBe(false)
    expect(f._stores.ledger.length).toBe(ledgerBefore)
    expect(f._stores.fills.length).toBe(fillsBefore)
    expect(JSON.stringify(await f.repos.bucketRepo.loadState(runId), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(stateBefore)
  } finally {
    // the lock map is process-global: never leave it held for later tests
    gate.release()
  }
  await holder
  await writer
  expect(settled).toBe(true)
}

describe('run-state writers hold the per-run lock', () => {
  test('rebookFill waits for a held lock, then rebooks', async () => {
    const { f, deps, runId } = await setup()
    await expectWaitsForLock(runId, f, () => rebookFill(runId, { fillId: 1, shares: 10, priceStr: '11.00', feeCents: 0 }, deps))
    expect(f._stores.fills.find((x: any) => x.id === 1)!.price).toBe(parseUsd('11.00'))
  })

  test('deleteFill waits for a held lock, then deletes', async () => {
    const { f, deps, runId } = await setup()
    await expectWaitsForLock(runId, f, () => deleteFill(runId, 1, deps))
    expect(f._stores.fills.length).toBe(0)
  })

  test('recalcRunState waits for a held lock, then repairs drift', async () => {
    const { f, deps, runId } = await setup()
    const drifted = await f.repos.bucketRepo.loadState(runId)
    drifted.cashCents += 777
    await f.repos.bucketRepo.saveState(runId, drifted)
    await expectWaitsForLock(runId, f, () => recalcRunState(runId, deps))
    expect(f._stores.ledger.filter((l: any) => l.kind === 'adjust').length).toBe(1)
  })

  test('seedRun waits for a held lock, then seeds', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: TODAY, notify: silentNotifier }
    const runId = await f.repos.runRepo.create({
      strategyKey: 'mean-reversion', ticker: 'SPY', name: 'r', poolCents: 1_000_000, costPpm: 0,
      initialRunState: { buckets: emptyState(10).buckets, cashCents: 1_000_000, closed: [], ages: {} },
    })
    await expectWaitsForLock(runId, f, () => seedRun(runId, { cashCents: 500, buckets: [{ shares: 5, buyPrice: '10.00', filledOn: '2026-11-03' }] }, deps))
    expect(f._stores.fills.length).toBe(1)
    expect((await f.repos.bucketRepo.loadState(runId)).cashCents).toBe(500)
  })

  test('recalc cannot interleave with a booking that is mid-write', async () => {
    const { f, deps, runId } = await setup()
    const drifted = await f.repos.bucketRepo.loadState(runId)
    drifted.cashCents += 777
    await f.repos.bucketRepo.saveState(runId, drifted)

    const log: string[] = []
    const gate = deferred()
    const bucketRepo = f.repos.bucketRepo
    const loadState = bucketRepo.loadState.bind(bucketRepo)
    const saveState = bucketRepo.saveState.bind(bucketRepo)
    const entered = deferred()
    let saves = 0
    bucketRepo.loadState = async (id: number) => { log.push('load'); return loadState(id) }
    bucketRepo.saveState = async (id: number, s: any) => {
      log.push('save-start')
      if (saves++ === 0) { entered.release(); await gate.promise }
      await saveState(id, s)
      log.push('save-end')
    }

    const booking = manualFill(runId, { side: 'buy', shares: 5, price: '10.00', fee: '0.00', filledOn: '2026-11-11' }, deps)
    let recalc: Promise<unknown> | undefined
    try {
      await entered.promise
      recalc = recalcRunState(runId, deps)
      await tick()
      // the recalc has not even loaded state while the booking sits inside saveState
      expect(log).toEqual(['load', 'save-start'])
    } finally {
      gate.release()
    }
    await Promise.all([booking, recalc])
    expect(log).toEqual(['load', 'save-start', 'save-end', 'load', 'save-start', 'save-end'])
    const res = await recalcRunState(runId, deps)
    expect(res.deltaCents).toBe(0)
  })

  test('applyCorrection (rebooks inside its own lock) completes without deadlock', async () => {
    const { f, deps, runId } = await setup()
    const fill = f._stores.fills[0]!
    const id = await f.repos.correctionRepo.insert({
      runId, fillId: fill.id, captureId: null, side: fill.side, ticker: fill.ticker,
      bookedShares: fill.shares, bookedFilledOn: fill.filledOn, bookedPrice: fill.price, bookedFee: fill.fee,
      proposedPrice: parseUsd('10.50'), proposedFee: 0,
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), 1000) })
    const out = await Promise.race([applyCorrection(id, deps), timeout]).finally(() => clearTimeout(timer))
    expect(out).not.toBe('timeout')
    expect(f._stores.fills.find((x: any) => x.id === fill.id)!.price).toBe(parseUsd('10.50'))
  })
})
