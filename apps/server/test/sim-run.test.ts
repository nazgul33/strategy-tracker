import { describe, test, expect } from 'bun:test'
import { parseUsd } from '@st/core/money'
import { runSim, type SimDayRow, type SimRepoSurface, type SimRunRow } from '../src/sim/sim'
import { bars, gapBars } from './sim-fixture'

describe('runSim', () => {
  function makeRepos() {
    const runs: SimRunRow[] = []
    const days: SimDayRow[] = []
    let runSeq = 1
    let daySeq = 1
    const simRepo = {
      async insertRun(input) { const id = runSeq++; runs.push({ id, draft: true, createdAt: '', ...input }); return id },
      async insertDays(rows) { for (const r of rows) days.push({ id: daySeq++, ...r }) },
      async listRuns() { return [...runs].sort((a, b) => b.id - a.id) },
      async getRun(id: number) { return runs.find((r) => r.id === id) ?? null },
      async listDays(id: number) { return days.filter((d) => d.simRunId === id) },
    } satisfies Pick<SimRepoSurface, 'insertRun' | 'insertDays' | 'listRuns' | 'getRun' | 'listDays'>
    return { simRepo, runs, days }
  }

  test('case 6: persists 1 run + N days, strings not corrupted', async () => {
    const f = makeRepos()
    const fetchDailyBars = async () => bars
    const res = await runSim({ ticker: 'TSLA', from: '2026-11-01', to: '2026-11-03', poolCents: 1000000, costPpm: 30 }, { fetchDailyBars, repos: f.simRepo })
    expect(res.dayCount).toBe(2)
    expect(f.runs.length).toBe(1)
    expect(f.days.length).toBe(2)
    for (const d of f.days) {
      expect(typeof d.planJson).toBe('string')
      expect(d.planJson).not.toContain('e+')
      const parsed = JSON.parse(d.planJson)
      // limitPrice should be string if present
      if (parsed.orders?.length) expect(typeof parsed.orders[0].limitPrice).toBe('string')
    }
  })

  test('case 7: 1 bar -> not-enough-bars, no run inserted', async () => {
    const f = makeRepos()
    const fetchDailyBars = async () => [bars[0]!]
    try {
      await runSim({ ticker: 'TSLA', from: '2026-11-01', to: '2026-11-01', poolCents: 1000000, costPpm: 30 }, { fetchDailyBars, repos: f.simRepo })
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.kind).toBe('not-enough-bars')
    }
    expect(f.runs.length).toBe(0)
  })

  test('case 8: invalid params key -> invalid-params, no rows', async () => {
    const f = makeRepos()
    const fetchDailyBars = async () => bars
    try {
      await runSim({ ticker: 'TSLA', from: '2026-11-01', to: '2026-11-03', poolCents: 1000000, costPpm: 30, params: { tick: '1' } as any }, { fetchDailyBars, repos: f.simRepo })
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.kind).toBe('invalid-params')
    }
    expect(f.runs.length).toBe(0)
  })

  test('simulation honours buy and sell gaps', async () => {
    const f = makeRepos()
    const res = await runSim({ ticker: 'TSLA', from: '2026-12-01', to: '2026-12-03', poolCents: 1000000, costPpm: 30, buyGapPpm: 10_000, sellGapPpm: 20_000 }, { fetchDailyBars: async () => gapBars, repos: f.simRepo })
    expect(res.dayCount).toBe(2)
    // day1 buy plan price = buyLimit(100.00, 10_000) = 99.00 — the tell vs the legacy 99.99
    const plan1 = JSON.parse(f.days[0]!.planJson)
    expect(plan1.orders.find((o: any) => o.kind === 'buy_loc').limitPrice).toBe(parseUsd('99').toString())
    const ev1 = JSON.parse(f.days[0]!.eventsJson)
    expect(ev1[0]).toMatchObject({ type: 'fill', side: 'buy', price: '990000' }) // open 99.50 above limit → fills at limit
    // day2 sell plan price = sellLimit(99.00, 30, 10, 20_000) = 100.98 truncated, not the legacy sellTarget
    const plan2 = JSON.parse(f.days[1]!.planJson)
    expect(plan2.orders.find((o: any) => o.kind === 'sell_loc').limitPrice).toBe('1009800')
    const ev2 = JSON.parse(f.days[1]!.eventsJson)
    const sell = ev2.find((e: any) => e.side === 'sell')
    expect(sell.price).toBe('1009800') // fills at the gap target, and the sim ends flat — the final sell is this one
  })

  test('sim gaps default to 0 and are persisted on the sim run row', async () => {
    const f = makeRepos()
    await runSim({ ticker: 'TSLA', from: '2026-12-01', to: '2026-12-03', poolCents: 1000000, costPpm: 30 }, { fetchDailyBars: async () => gapBars, repos: f.simRepo })
    expect(f.runs[0].buyGapPpm).toBe(0)
    expect(f.runs[0].sellGapPpm).toBe(0)
    // gaps unset → legacy prices: lastClose − 100 myriadths
    expect(JSON.parse(f.days[0]!.planJson).orders.find((o: any) => o.kind === 'buy_loc').limitPrice).toBe('999900')
    const f2 = makeRepos()
    await runSim({ ticker: 'TSLA', from: '2026-12-01', to: '2026-12-03', poolCents: 1000000, costPpm: 30, buyGapPpm: 10_000, sellGapPpm: 20_000 }, { fetchDailyBars: async () => gapBars, repos: f2.simRepo })
    expect(f2.runs[0].buyGapPpm).toBe(10_000)
    expect(f2.runs[0].sellGapPpm).toBe(20_000)
  })

  test('cutLossPpm is persisted on the sim run and defaults to 0', async () => {
    const f = makeRepos()
    await runSim({ ticker: 'TSLA', from: '2026-12-01', to: '2026-12-03', poolCents: 1000000, costPpm: 30, cutLossPpm: 35_000 }, { fetchDailyBars: async () => gapBars, repos: f.simRepo })
    expect(f.runs[0].cutLossPpm).toBe(35_000)
    const f2 = makeRepos()
    await runSim({ ticker: 'TSLA', from: '2026-12-01', to: '2026-12-03', poolCents: 1000000, costPpm: 30 }, { fetchDailyBars: async () => gapBars, repos: f2.simRepo })
    expect(f2.runs[0].cutLossPpm).toBe(0)
  })

  test('runSim plans stops from the input cutLossPpm', async () => {
    const f = makeRepos()
    // day 1 buys bucket 0 at 99.00 (gapBars, buy gap 1%); day 2 plans a stop at floorCents(990000 * 0.965) = 955300
    await runSim({ ticker: 'TSLA', from: '2026-12-01', to: '2026-12-03', poolCents: 1000000, costPpm: 30, buyGapPpm: 10_000, sellGapPpm: 20_000, cutLossPpm: 35_000 }, { fetchDailyBars: async () => gapBars, repos: f.simRepo })
    const stop = JSON.parse(f.days[1]!.planJson).orders.find((o: any) => o.kind === 'stop_sell')
    expect(stop.limitPrice).toBe('955300')
  })

  test.each([35_001, -1_000, 600_000, 1_500.5])('runSim rejects cutLossPpm %p', async (v) => {
    const f = makeRepos()
    await expect(runSim({ ticker: 'TSLA', from: '2026-12-01', to: '2026-12-03', poolCents: 1000000, costPpm: 30, cutLossPpm: v }, { fetchDailyBars: async () => gapBars, repos: f.simRepo })).rejects.toMatchObject({ kind: 'invalid-params' })
    expect(f.runs.length).toBe(0)
  })
})
