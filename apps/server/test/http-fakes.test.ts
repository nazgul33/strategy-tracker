import { describe, test, expect } from 'bun:test'
import { makeFakes } from './http-fakes'

const input = { ticker: 'AAPL', fromDate: '2026-03-02', toDate: '2026-03-06', poolCents: 1000, costPpm: 30, buyGapPpm: 0, sellGapPpm: 0, cutLossPpm: 0, paramsJson: '{}' }
const day = (simRunId: number, tradeDate: string) => ({ simRunId, tradeDate, planJson: '{}', stateJson: '{}', eventsJson: '[]' })

describe('http fakes mirror the real repos', () => {
  test('simRepo never reuses an id after deleteRun', async () => {
    const { repos } = makeFakes()
    const sim = repos.simRepo as any
    const a = await sim.insertRun(input)
    const b = await sim.insertRun(input)
    const c = await sim.insertRun(input)
    expect([a, b, c]).toEqual([1, 2, 3])
    expect(await sim.deleteRun(b)).toBe(true)
    const d = await sim.insertRun(input)
    expect(d).toBe(4)
    expect((await sim.listRuns()).map((r: any) => r.id)).toEqual([1, 3, 4])
    expect(await sim.getRun(3)).toMatchObject({ id: 3 })
    expect(await sim.deleteRun(3)).toBe(true)
    expect((await sim.listRuns()).map((r: any) => r.id)).toEqual([1, 4])
    expect(await sim.getRun(b)).toBeNull()
  })

  test('simRepo never reuses a day id after replaceDays shrinks the set', async () => {
    const { repos, simDays } = makeFakes()
    const sim = repos.simRepo as any
    const id = await sim.insertRun(input)
    await sim.replaceDays(id, [day(id, '2026-03-02'), day(id, '2026-03-03'), day(id, '2026-03-04')])
    await sim.replaceDays(id, [day(id, '2026-03-05')])
    await sim.insertDays([day(id, '2026-03-06')])
    const ids = simDays.map((d: any) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([4, 5])
  })

  test('price and coverage fakes key tickers canonically, like the real repos', async () => {
    const { repos } = makeFakes()
    const ph = repos.priceHistoryRepo as any
    const cov = (repos as any).barCoverageRepo
    await ph.upsertBars([{ ticker: ' aapl ', tradeDate: '2026-03-02', open: 1n, high: 2n, low: 1n, close: 2n }])
    await ph.upsertBars([{ ticker: 'AAPL', tradeDate: '2026-03-02', open: 5n, high: 9n, low: 4n, close: 8n }])
    expect(await ph.listBars('aapl', '2026-03-01', '2026-03-31')).toEqual([{ tradeDate: '2026-03-02', open: 5n, high: 9n, low: 4n, close: 8n }])
    expect((await ph.listForTicker('Aapl')).length).toBe(1)

    await cov.add('aapl', '2026-01-01', '2026-01-31')
    await cov.add('AAPL', '2026-02-01', '2026-02-28')
    expect(await cov.list('Aapl')).toEqual([{ fromDate: '2026-01-01', toDate: '2026-02-28' }])
  })

  test('barCoverage fake rejects an inverted range and stores nothing', async () => {
    const { repos, coverage } = makeFakes()
    const cov = (repos as any).barCoverageRepo
    await expect(cov.add('AAPL', '2026-02-01', '2026-01-01')).rejects.toThrow()
    expect(coverage).toEqual([])
    await cov.add('AAPL', '2026-02-01', '2026-02-01') // single day is valid
    expect(await cov.list('AAPL')).toEqual([{ fromDate: '2026-02-01', toDate: '2026-02-01' }])
  })
})
