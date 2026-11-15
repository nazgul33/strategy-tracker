import { describe, test, expect } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, loginAs } from './http-fakes'

describe('http price-history', async () => {
  // weekday-only calendar the backfill loop walks through, given today=2026-11-10
  const ALL_BARS = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09']

  test('serves collected bars sorted, close as string; 404 for unknown run', async () => {
    const f = makeFakes()
    f.runs.push({ id: 1, ticker: 'AAPL', name: 'r1', status: 'active' } as any)
    await f.repos.priceHistoryRepo.upsertMany([
      { ticker: 'AAPL', tradeDate: '2026-11-09', close: 5000n },
      { ticker: 'AAPL', tradeDate: '2026-11-05', close: 4800n },
    ])
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const res = await app.request('/api/runs/1/price-history', { headers: auth })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.start).toBe('2026-11-05')
    expect(body.bars.map((b: any) => b.tradeDate)).toEqual(['2026-11-05', '2026-11-09'])
    expect(body.bars[0].close).toBe('4800')
    const miss = await app.request('/api/runs/99/price-history', { headers: auth })
    expect(miss.status).toBe(404)
  })

  test('?start backfills once from Yahoo, persists, and second call reuses DB', async () => {
    const f = makeFakes()
    f.runs.push({ id: 1, ticker: 'AAPL', name: 'r1', status: 'active' } as any)
    const calls: [string, string][] = []
    const deps = makeDeps(f)
    deps.fetchDailyBars = async (_ticker: string, from: string, to: string) => {
      calls.push([from, to])
      return ALL_BARS.filter((d) => d >= from && d <= to).map((d) => ({ tradeDate: d, close: BigInt(d.slice(8)) * 100n }))
    }
    const app = createApp(deps)
    const auth = await loginAs(app)

    const res = await app.request('/api/runs/1/price-history?start=2026-11-02', { headers: auth })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual(['2026-11-02', '2026-11-09']) // to = prev trading day of today
    expect(body.bars.length).toBe(6)
    expect(body.start).toBe('2026-11-02')
    expect(f.priceHistory.length).toBe(6) // persisted for reuse

    calls.length = 0
    const res2 = await app.request('/api/runs/1/price-history?start=2026-11-02', { headers: auth })
    expect((await res2.json()).bars.length).toBe(6)
    expect(calls.length).toBe(0) // collected history is never refetched
  })
})
