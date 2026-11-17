import { describe, test, expect, beforeAll } from 'bun:test'
import { MarketDataError, type OHLCBar } from '@st/market-data'
import { getDb, applyMigrations } from '../src/db/client'
import { getRepos } from '../src/db/repos'
import { makeCachedBarReader } from '../src/market/bars'

const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip

describeIf('cached bar reader on the real repos', () => {
  let repos: any
  beforeAll(async () => {
    const db = await getDb(process.env.TEST_DATABASE_URL!)
    await applyMigrations(db)
    repos = getRepos(db)
  })

  const week = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']
  const mk = (date: string): OHLCBar => ({ date, open: 10_000n, high: 12_000n, low: 9_000n, close: 11_000n })

  test('a second read over the same range makes zero upstream calls; today is never stored', async () => {
    const ticker = 'BR' + Date.now()
    const ranges: [string, string][] = []
    const upstream = async (_t: string, from: string, to: string) => {
      ranges.push([from, to])
      const out = week.filter((d) => d >= from && d <= to).map(mk)
      if (out.length === 0) throw new MarketDataError('no-data')
      return out
    }
    const read = makeCachedBarReader({ upstream, repos, today: () => '2026-01-09' })

    const first = await read(ticker, '2026-01-05', '2026-01-09')
    expect(first.map((b) => b.date)).toEqual(week)
    expect(ranges).toEqual([['2026-01-05', '2026-01-08'], ['2026-01-09', '2026-01-09']])

    ranges.length = 0
    const second = await read(ticker.toLowerCase(), '2026-01-05', '2026-01-08')
    expect(ranges).toEqual([])
    expect(second).toEqual(week.slice(0, 4).map(mk))

    expect(await repos.barCoverageRepo.list(ticker)).toEqual([{ fromDate: '2026-01-05', toDate: '2026-01-08' }])
    const rows = await repos.priceHistoryRepo.listForTicker(ticker)
    expect(rows.map((r: any) => r.tradeDate)).toEqual(week.slice(0, 4))
  })
})
