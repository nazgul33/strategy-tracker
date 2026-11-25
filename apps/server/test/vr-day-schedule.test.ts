import { describe, test, expect } from 'bun:test'
import { DEFAULT_MR_PARAMS } from '@st/strategies'
import { DEFAULT_VR_SETTINGS } from '@st/strategies/value-rebalancing'
import { runMorningPipeline, type DayDeps } from '../src/pipeline/day'
import type { NewVrCycle } from '../src/domain/vr/repo-types'
import { makeFakes } from './http-fakes'

// Cycle 1 is scheduled 2026-12-07 and the run holds 100 shares.
async function setup(over: Partial<DayDeps> = {}, start = '2026-12-07') {
  const f = makeFakes()
  const vrId = await f.repos.vrRunRepo.create({
    ...DEFAULT_VR_SETTINGS, ticker: 'TQQQ', name: 'Q', costPpm: 0, initialVCents: 500_000, openingCashCents: 1_000_000, openedOn: '2026-11-20',
  })
  const cycle: NewVrCycle = {
    runId: vrId, seq: 1, scheduledStart: start, startDate: start, vCents: 500_000, bandMinCents: 425_000, bandMaxCents: 575_000,
    openShares: 100, openPoolCents: 500_000, buyBudgetCents: 250_000, buyLot: 2, sellLot: 1,
    prevClose: null, evalCents: null, poolBeforeCents: null, g: 10, formula: 'skill', depositCents: 0, vKept: false, openFillId: 0,
  }
  await f.repos.vrCycleRepo.open(cycle, null)
  await f.repos.vrFillRepo.insert({ runId: vrId, side: 'buy', shares: 100, price: 500_000n, fee: 0, filledOn: '2026-12-04', source: 'manual' })
  const sent: string[] = []
  const fetched: string[] = []
  let today = '2026-12-22'
  let close = { date: '2026-12-21', close: 520_000n }
  const deps: DayDeps = {
    today: () => today,
    fetchLastClose: async (tk) => { fetched.push(tk); return close },
    crossCheck: async () => ({ agree: true }),
    send: async (_c, text) => { sent.push(text) },
    allowedChatIds: ['c1'],
    repos: f.repos,
    params: () => DEFAULT_MR_PARAMS,
    digestLang: 'en',
    ...over,
  }
  return { f, deps, sent, fetched, vrId, setDay: (d: string, c: string) => { today = d; close = { date: c, close: 520_000n } } }
}

describe('VR cycle schedule', () => {
  test('a late first run keeps the schedule: cycle 2 starts on the run day, scheduled for the missed Monday', async () => {
    const { f, deps } = await setup()
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(f.vr.cycles).toHaveLength(2)
    expect(f.vr.cycles[1]).toMatchObject({ seq: 2, startDate: '2026-12-22', scheduledStart: '2026-12-21' })
  })

  test('Review Focus 5: a paused run is skipped, and once active again it opens exactly one cycle', async () => {
    const { f, deps, sent, fetched, vrId, setDay } = await setup()
    await f.repos.vrRunRepo.updateStatus(vrId, 'paused')
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(fetched).toEqual([])
    expect(sent).toEqual([])
    expect(f.notifications).toEqual([])
    expect(f.vr.cycles).toHaveLength(1)

    await f.repos.vrRunRepo.updateStatus(vrId, 'active')
    setDay('2027-01-04', '2026-12-31')
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(f.vr.cycles).toHaveLength(2)
    expect(f.vr.cycles[1]).toMatchObject({ seq: 2, scheduledStart: '2027-01-04', startDate: '2027-01-04' })

    await runMorningPipeline(deps)
    expect(f.vr.cycles).toHaveLength(2)
  })

  test('a start that falls on a market holiday opens on the next trading day and keeps the anchor', async () => {
    const { f, deps, sent, vrId, setDay } = await setup({}, '2026-12-11')

    setDay('2026-12-25', '2026-12-24')
    expect(await runMorningPipeline(deps)).toBe('closed')
    expect(f.vr.cycles).toHaveLength(1)

    setDay('2026-12-28', '2026-12-24')
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(f.vr.cycles).toHaveLength(2)
    expect(f.vr.cycles[1]).toMatchObject({ runId: vrId, seq: 2, startDate: '2026-12-28', scheduledStart: '2026-12-25' })

    sent.length = 0
    setDay('2027-01-07', '2027-01-06')
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(f.vr.cycles).toHaveLength(2)
    expect(sent).toEqual([])

    setDay('2027-01-08', '2027-01-07')
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(f.vr.cycles).toHaveLength(3)
    expect(f.vr.cycles[2]).toMatchObject({ seq: 3, startDate: '2027-01-08', scheduledStart: '2027-01-08' })
  })

  test('a closed run is skipped too', async () => {
    const { f, deps, fetched, vrId } = await setup()
    await f.repos.vrRunRepo.updateStatus(vrId, 'closed')
    await runMorningPipeline(deps)
    expect(fetched).toEqual([])
    expect(f.vr.cycles).toHaveLength(1)
  })
})
