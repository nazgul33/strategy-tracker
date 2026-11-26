import { describe, test, expect } from 'bun:test'
import { emptyState } from '@st/core'
import { DEFAULT_VR_SETTINGS } from '@st/strategies/value-rebalancing'
import { buildDashboard, loadDashboard, type DashboardRepos, type DashboardRunInput } from '../src/domain/dashboard'
import { loadVrSummaries } from '../src/domain/vr/runs'
import { NO_SNAPSHOT } from './booking-fakes'
import { makeFakes } from './http-fakes'

const TODAY = '2026-11-26'
const run = (over: Partial<DashboardRunInput>): DashboardRunInput => ({
  id: 1, name: 'r', ticker: 'SOXL', status: 'active', shares: 0, cashCents: 0, waiting: 0, lastClose: null, ...over,
})
const at = (date: string, close: bigint) => ({ date, close })

describe('buildDashboard', () => {
  test('a mean reversion run is valued at the stored close plus its cash', () => {
    const d = buildDashboard({ today: TODAY, mr: [run({ shares: 118, cashCents: 2_010_510, lastClose: at('2026-11-25', 361_800n) })], vr: [] })
    expect(d.groups[0].runs[0]).toMatchObject({
      shares: 118, close: 361_800n, closeDate: '2026-11-25', closeMark: null, stockCents: 426_924, cashCents: 2_010_510, valueCents: 2_437_434,
    })
  })

  test('a VR run is valued the same way', () => {
    const d = buildDashboard({ today: TODAY, mr: [], vr: [run({ shares: 277, cashCents: 1_212_495, lastClose: at('2026-11-25', 714_000n) })] })
    expect(d.groups[1].runs[0]).toMatchObject({ stockCents: 1_977_780, valueCents: 3_190_275 })
  })

  test('the stock value rounds at half a cent', () => {
    const d = buildDashboard({ today: TODAY, mr: [run({ shares: 3, lastClose: at('2026-11-25', 333_350n) })], vr: [] })
    expect(d.groups[0].runs[0]!.stockCents).toBe(10_001)
  })

  test('a group total is the sum of its rows', () => {
    const d = buildDashboard({
      today: TODAY,
      mr: [
        run({ id: 1, shares: 118, cashCents: 2_010_510, lastClose: at('2026-11-25', 361_800n) }),
        run({ id: 2, shares: 95, cashCents: 1_705_299, lastClose: at('2026-11-25', 714_000n) }),
      ],
      vr: [],
    })
    expect(d.groups[0].runs.map((r) => r.valueCents)).toEqual([2_437_434, 2_383_599])
    expect(d.groups[0].totalCents).toBe(4_821_033)
    expect(d.groups[1].totalCents).toBe(0)
  })

  test('shares and no stored close: cash only, marked missing, the group incomplete', () => {
    const d = buildDashboard({ today: TODAY, mr: [run({ shares: 10, cashCents: 50_000, lastClose: null })], vr: [run({ shares: 0, cashCents: 7 })] })
    expect(d.groups[0].runs[0]).toMatchObject({ close: null, closeDate: null, stockCents: null, valueCents: 50_000, closeMark: 'missing' })
    expect(d.groups[0].totalCents).toBe(50_000)
    expect(d.groups[0].incomplete).toBe(true)
    expect(d.groups[1].incomplete).toBe(false)
    expect(d.closeDate).toBeNull()
  })

  test('the page date is the newest close; an earlier row is marked older', () => {
    const d = buildDashboard({
      today: TODAY,
      mr: [run({ id: 1, shares: 1, lastClose: at('2026-11-25', 100_000n) }), run({ id: 2, shares: 1, lastClose: at('2026-11-24', 100_000n) })],
      vr: [],
    })
    expect(d.closeDate).toBe('2026-11-25')
    expect(d.groups[0].runs[0]).toMatchObject({ closeMark: null, closeDate: '2026-11-25' })
    expect(d.groups[0].runs[1]).toMatchObject({ closeMark: 'older', closeDate: '2026-11-24' })
    expect(d.groups[0].olderClose).toBe(true)
  })

  test('with the rows in different groups only the group of the older row is marked', () => {
    const d = buildDashboard({
      today: TODAY,
      mr: [run({ shares: 1, lastClose: at('2026-11-25', 100_000n) })],
      vr: [run({ shares: 1, lastClose: at('2026-11-24', 100_000n) })],
    })
    expect(d.closeDate).toBe('2026-11-25')
    expect(d.groups[0].olderClose).toBe(false)
    expect(d.groups[1].olderClose).toBe(true)
    expect(d.groups[1].runs[0]!.closeMark).toBe('older')
  })

  test('a row without shares uses no close and plays no part in the page date', () => {
    const d = buildDashboard({
      today: TODAY,
      mr: [run({ id: 1, shares: 0, cashCents: 900, lastClose: at('2026-11-27', 999_999n) })],
      vr: [run({ id: 2, shares: 5, lastClose: at('2026-11-25', 100_000n) })],
    })
    expect(d.groups[0].runs[0]).toMatchObject({ close: null, closeDate: null, stockCents: 0, closeMark: null, valueCents: 900 })
    expect(d.closeDate).toBe('2026-11-25')
    expect(d.groups[1].runs[0]!.closeMark).toBeNull()
  })

  test('closed runs are absent and not summed; paused runs are present and summed', () => {
    const lastClose = at('2026-11-25', 100_000n)
    const d = buildDashboard({
      today: TODAY,
      mr: [
        run({ id: 1, status: 'closed', shares: 50, cashCents: 1_000, lastClose }),
        run({ id: 2, status: 'paused', shares: 10, cashCents: 300, lastClose }),
        run({ id: 3, status: 'active', shares: 0, cashCents: 200 }),
      ],
      vr: [run({ id: 4, status: 'closed', shares: 1, cashCents: 5, lastClose })],
    })
    expect(d.groups[0].runs.map((r) => [r.id, r.status])).toEqual([[2, 'paused'], [3, 'active']])
    expect(d.groups[0].totalCents).toBe(10_500)
    expect(d.groups[1].runs).toEqual([])
    expect(d.groups[1].totalCents).toBe(0)
  })

  test('rows come in ascending id order and the inputs are not reordered', () => {
    const mr = [run({ id: 3 }), run({ id: 1 })]
    const d = buildDashboard({ today: TODAY, mr, vr: [] })
    expect(d.groups[0].runs.map((r) => r.id)).toEqual([1, 3])
    expect(mr.map((r) => r.id)).toEqual([3, 1])
  })

  test('with no run both groups are present and empty', () => {
    expect(buildDashboard({ today: TODAY, mr: [], vr: [] })).toEqual({
      today: TODAY,
      closeDate: null,
      groups: [
        { strategy: 'mean-reversion', totalCents: 0, incomplete: false, olderClose: false, runs: [] },
        { strategy: 'value-rebalancing', totalCents: 0, incomplete: false, olderClose: false, runs: [] },
      ],
    })
  })

  test('name, ticker and the waiting count are carried through', () => {
    const d = buildDashboard({ today: TODAY, mr: [run({ id: 7, name: 'Alpha', ticker: 'TQQQ', waiting: 3 })], vr: [] })
    expect(d.groups[0].runs[0]).toMatchObject({ id: 7, name: 'Alpha', ticker: 'TQQQ', waiting: 3 })
  })
})

describe('loadDashboard', () => {
  const heldState = () => {
    const st = emptyState(10)
    const held = { index: 0, state: 'held' as const, shares: 100, buyPrice: 361_800n, buyFeeCents: 0, filledOn: '2026-11-03' }
    st.buckets[0] = held
    st.buckets[1] = { ...held, index: 1, state: 'force_sell', shares: 18 }
    st.cashCents = 2_010_510
    return st
  }
  const mrInput = (name: string, initialRunState = heldState(), ticker = 'SOXL') =>
    ({ strategyKey: 'mean-reversion', ticker, name, poolCents: 1_000_000, costPpm: 0, initialRunState })
  const vrInput = (name: string, ticker = 'TQQQ') =>
    ({ ...DEFAULT_VR_SETTINGS, ticker, name, costPpm: 0, initialVCents: 500_000, openingCashCents: 1_000_000, openedOn: '2026-11-01' })
  const pend = (runId: number) =>
    ({ runId, captureId: null, bucketIdx: null, side: 'buy' as const, ticker: 'SOXL', shares: 5, price: 100_000n, fee: null, filledOn: '2026-11-06', status: 'pending' as const, ...NO_SNAPSHOT })

  test('the fakes fit DashboardRepos', () => {
    const r: DashboardRepos = makeFakes().repos
    expect(r).toBeDefined()
  })

  test('mean reversion: shares of the non-empty buckets, the state cash, and the pending rows of the run', async () => {
    const f = makeFakes()
    const a = await f.repos.runRepo.create(mrInput('A'))
    const b = await f.repos.runRepo.create(mrInput('B'))
    await f.repos.pendingRepo.insert(pend(a))
    await f.repos.pendingRepo.insert(pend(a))
    const decided = await f.repos.pendingRepo.insert(pend(a))
    await f.repos.pendingRepo.decide(decided, 'rejected', { side: 'buy', shares: 5, price: 100_000n, fee: 0, filledOn: '2026-11-06', bucketIdx: 0 })
    await f.repos.pendingRepo.insert(pend(b))
    await f.repos.priceHistoryRepo.upsertMany([{ ticker: 'SOXL', tradeDate: '2026-11-25', close: 361_800n }])
    const d = await loadDashboard({ repos: f.repos, today: TODAY })
    expect(d.groups[0].runs).toHaveLength(2)
    expect(d.groups[0].runs[0]).toMatchObject({ id: a, shares: 118, cashCents: 2_010_510, waiting: 2, stockCents: 426_924, valueCents: 2_437_434, close: 361_800n })
    expect(d.groups[0].runs[1]).toMatchObject({ id: b, waiting: 1 })
    expect(d.groups[1].runs).toEqual([])
  })

  test('a VR row carries the books and the value of the VR summary', async () => {
    const f = makeFakes()
    const id = await f.repos.vrRunRepo.create(vrInput('Q'))
    await f.repos.vrFillRepo.insert({ runId: id, side: 'buy', shares: 100, price: 450_000n, fee: 30, filledOn: '2026-11-04', source: 'manual' })
    await f.repos.vrFillRepo.insert({ runId: id, side: 'sell', shares: 20, price: 480_000n, fee: 10, filledOn: '2026-11-06', source: 'manual' })
    await f.repos.vrCashRepo.insert({ runId: id, kind: 'deposit', amountCents: 50_000, movedOn: '2026-11-05', note: null, cycleId: null })
    await f.repos.vrPendingRepo.insertMany([{ runId: id, captureId: 1, side: 'buy', shares: 1, price: 500_000n, fee: null, filledOn: '2026-11-06', dateRead: true, dupPrice: null, orderPrice: null }])
    await f.repos.priceHistoryRepo.upsertMany([
      { ticker: 'TQQQ', tradeDate: '2026-11-09', close: 460_000n }, { ticker: 'TQQQ', tradeDate: '2026-11-10', close: 470_000n },
    ])
    const summary = (await loadVrSummaries({ repos: f.repos, today: TODAY }))[0]!
    const row = (await loadDashboard({ repos: f.repos, today: TODAY })).groups[1].runs[0]!
    expect(summary.shares).toBe(80)
    expect(row).toMatchObject({ id, shares: summary.shares, cashCents: summary.poolCents, valueCents: summary.valueCents, waiting: 1, close: 470_000n, closeDate: '2026-11-10' })
  })

  test('a VR run with opening cash only and no stored close is worth its Pool and is not marked', async () => {
    const f = makeFakes()
    const id = await f.repos.vrRunRepo.create(vrInput('New', 'NOPE'))
    const summary = (await loadVrSummaries({ repos: f.repos, today: TODAY }))[0]!
    expect(summary.valueCents).toBeNull()
    const d = await loadDashboard({ repos: f.repos, today: TODAY })
    expect(d.groups[1].runs[0]).toMatchObject({ id, shares: 0, stockCents: 0, valueCents: 1_000_000, closeMark: null, close: null, closeDate: null })
    expect(d.groups[1].incomplete).toBe(false)
    expect(d.closeDate).toBeNull()
  })

  test('paused runs are loaded and closed runs are not', async () => {
    const f = makeFakes()
    const paused = await f.repos.runRepo.create(mrInput('P'))
    const closed = await f.repos.runRepo.create(mrInput('C'))
    await f.repos.runRepo.updateStatus(paused, 'paused')
    await f.repos.runRepo.updateStatus(closed, 'closed')
    const vp = await f.repos.vrRunRepo.create(vrInput('VP'))
    const vc = await f.repos.vrRunRepo.create(vrInput('VC'))
    await f.repos.vrRunRepo.updateStatus(vp, 'paused')
    await f.repos.vrRunRepo.updateStatus(vc, 'closed')
    const d = await loadDashboard({ repos: f.repos, today: TODAY })
    expect(d.groups[0].runs.map((r) => [r.id, r.status])).toEqual([[paused, 'paused']])
    expect(d.groups[1].runs.map((r) => [r.id, r.status])).toEqual([[vp, 'paused']])
  })

  test('the closes of a ticker are read once however many runs use it', async () => {
    const f = makeFakes()
    await f.repos.runRepo.create(mrInput('A', heldState(), 'TQQQ'))
    await f.repos.runRepo.create(mrInput('B', heldState(), 'TQQQ'))
    await f.repos.vrRunRepo.create(vrInput('Q', 'TQQQ'))
    await f.repos.vrRunRepo.create(vrInput('S', 'SOXL'))
    const calls: string[] = []
    const repos = {
      ...f.repos,
      priceHistoryRepo: { listForTicker: async (t: string) => { calls.push(t); return f.repos.priceHistoryRepo.listForTicker(t) } },
    }
    await loadDashboard({ repos, today: TODAY })
    expect(calls.filter((t) => t === 'TQQQ')).toHaveLength(1)
    expect(calls.filter((t) => t === 'SOXL')).toHaveLength(1)
  })
})
