import { describe, test, expect, beforeEach } from 'bun:test'
import { isTradingDay } from '@st/calendar'
import { MarketDataError, type OHLCBar } from '@st/market-data'
import { makeCachedBarReader } from '../src/market/bars'
import { makeFakes } from './http-fakes'

function day(date: string, n = 1): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function mkBar(date: string): OHLCBar {
  const n = BigInt(date.slice(5, 7)) * 100n + BigInt(date.slice(8))
  return { date, open: n * 10_000n, high: (n + 2n) * 10_000n, low: (n - 1n) * 10_000n, close: (n + 1n) * 10_000n }
}

// Counting fake provider: returns a bar for every NYSE trading day in range, except `missing`.
// Throws MarketDataError('no-data') on an empty answer, like the real fetchDailyBars.
function makeUpstream() {
  const state = {
    ranges: [] as [string, string][],
    tickers: [] as string[],
    missing: new Set<string>(),
    failFrom: null as string | null,
    shuffle: false,
    get calls() { return state.ranges.length },
    reset() { state.ranges = []; state.tickers = [] },
  }
  const fn = async (ticker: string, from: string, to: string): Promise<OHLCBar[]> => {
    state.ranges.push([from, to])
    state.tickers.push(ticker)
    if (state.failFrom !== null && from >= state.failFrom) throw new MarketDataError('http')
    const out: OHLCBar[] = []
    for (let d = from; d <= to; d = day(d)) if (isTradingDay(d) && !state.missing.has(d)) out.push(mkBar(d))
    if (state.shuffle) out.reverse().push(...out.slice(0, 2))
    if (out.length === 0) throw new MarketDataError('no-data')
    return out
  }
  return Object.assign(fn, { state })
}

describe('makeCachedBarReader', () => {
  let f: ReturnType<typeof makeFakes>
  let up: ReturnType<typeof makeUpstream>
  let today: string
  let read: (ticker: string, from: string, to: string) => Promise<OHLCBar[]>

  beforeEach(() => {
    f = makeFakes()
    up = makeUpstream()
    today = '2026-06-01'
    read = makeCachedBarReader({ upstream: up, repos: f.repos as any, today: () => today })
  })

  test('a fully covered range makes no upstream call', async () => {
    const first = await read('AAPL', '2026-01-05', '2026-01-09')
    expect(first.length).toBe(5)
    const before = up.state.calls
    expect(before).toBeGreaterThan(0)
    const second = await read('AAPL', '2026-01-05', '2026-01-09')
    expect(up.state.calls).toBe(before)
    expect(second).toEqual(first)
  })

  test('a repeated read serves full OHLC bars as bigint myriadths', async () => {
    await read('AAPL', '2026-01-05', '2026-01-09')
    const again = await read('AAPL', '2026-01-05', '2026-01-09')
    expect(again[0]).toEqual(mkBar('2026-01-05'))
    expect(typeof again[0].open).toBe('bigint')
  })

  test('a partially covered range fetches only the gap', async () => {
    await read('AAPL', '2026-01-05', '2026-01-09')
    up.state.reset()
    const bars = await read('AAPL', '2026-01-05', '2026-01-16')
    expect(up.state.ranges).toEqual([['2026-01-12', '2026-01-16']])
    expect(bars.map((b) => b.date)).toEqual([
      '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09',
      '2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15', '2026-01-16',
    ])
  })

  test('two disjoint covered ranges do not imply the middle', async () => {
    await read('AAPL', '2026-01-05', '2026-01-09')
    await read('AAPL', '2026-02-02', '2026-02-06')
    up.state.reset()
    const bars = await read('AAPL', '2026-01-05', '2026-02-06')
    expect(up.state.ranges).toEqual([['2026-01-12', '2026-01-30']])
    expect(bars.length).toBe(5 + 14 + 5) // Jan 12-30 has 15 weekdays minus MLK day
    expect(bars.some((b) => b.date === '2026-01-20')).toBe(true)
  })

  test('a date the provider omitted is not re-queried', async () => {
    up.state.missing.add('2026-01-07')
    const first = await read('AAPL', '2026-01-05', '2026-01-09')
    expect(first.map((b) => b.date)).not.toContain('2026-01-07')
    up.state.reset()
    const second = await read('AAPL', '2026-01-05', '2026-01-09')
    expect(up.state.calls).toBe(0)
    expect(second.map((b) => b.date)).not.toContain('2026-01-07')
  })

  test('an NYSE holiday inside a covered range is not re-queried', async () => {
    const first = await read('AAPL', '2026-01-12', '2026-01-23') // includes MLK day 2026-01-19
    expect(first.map((b) => b.date)).not.toContain('2026-01-19')
    up.state.reset()
    await read('AAPL', '2026-01-12', '2026-01-23')
    expect(up.state.calls).toBe(0)
  })

  test('adjacent fetched weeks leave the weekend between them readable without upstream', async () => {
    await read('AAPL', '2026-01-05', '2026-01-09')
    await read('AAPL', '2026-01-12', '2026-01-16')
    up.state.reset()
    const bars = await read('AAPL', '2026-01-05', '2026-01-18')
    expect(up.state.calls).toBe(0)
    expect(bars.length).toBe(10)
  })

  test('a gap of only weekend days is recorded as covered without calling upstream', async () => {
    await read('AAPL', '2026-01-05', '2026-01-09')
    up.state.reset()
    const bars = await read('AAPL', '2026-01-10', '2026-01-11') // Saturday and Sunday
    expect(up.state.calls).toBe(0)
    expect(bars).toEqual([])
    expect(await f.repos.barCoverageRepo.list('AAPL')).toEqual([{ fromDate: '2026-01-05', toDate: '2026-01-11' }])
  })

  test('a range ending today refetches the tail and never caches it', async () => {
    today = '2026-01-09'
    const first = await read('AAPL', '2026-01-05', '2026-01-09')
    expect(first.map((b) => b.date)).toContain('2026-01-09')
    expect(up.state.ranges).toEqual([['2026-01-05', '2026-01-08'], ['2026-01-09', '2026-01-09']])
    up.state.reset()
    const second = await read('AAPL', '2026-01-05', '2026-01-09')
    expect(up.state.ranges).toEqual([['2026-01-09', '2026-01-09']])
    expect(second.map((b) => b.date)).toContain('2026-01-09')
    expect(await f.repos.barCoverageRepo.list('AAPL')).toEqual([{ fromDate: '2026-01-05', toDate: '2026-01-08' }])
    expect(f.priceHistory.some((r) => r.tradeDate === '2026-01-09')).toBe(false)
  })

  test('a range entirely at or after today is fetched live and leaves no trace', async () => {
    today = '2026-01-09'
    const bars = await read('AAPL', '2026-01-09', '2026-01-12')
    expect(bars.map((b) => b.date)).toEqual(['2026-01-09', '2026-01-12'])
    expect(up.state.ranges).toEqual([['2026-01-09', '2026-01-12']])
    expect(f.priceHistory.length).toBe(0)
    expect(f.coverage.length).toBe(0)
  })

  test('a tail the provider has no data for returns the cached bars instead of failing', async () => {
    today = '2026-01-09'
    await read('AAPL', '2026-01-05', '2026-01-08') // cache everything before today
    up.state.reset()
    up.state.missing.add('2026-01-09') // pre-open: provider answers no-data for today
    const bars = await read('AAPL', '2026-01-05', '2026-01-09')
    expect(up.state.ranges).toEqual([['2026-01-09', '2026-01-09']]) // the tail was really attempted
    expect(bars.map((b) => b.date)).toEqual(['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'])
  })

  test('a no-data tail with no cached portion at all propagates instead of returning nothing', async () => {
    today = '2026-01-09'
    up.state.missing = new Set(['2026-01-09', '2026-01-12'])
    let err: unknown
    await read('AAPL', '2026-01-09', '2026-01-12').catch((e) => { err = e })
    expect(err).toBeInstanceOf(MarketDataError)
    expect((err as MarketDataError).kind).toBe('no-data')
    expect(up.state.ranges).toEqual([['2026-01-09', '2026-01-12']])
    expect(f.priceHistory.length).toBe(0)
    expect(f.coverage.length).toBe(0)
  })

  test('a tail failing with an http error still propagates', async () => {
    today = '2026-01-09'
    await read('AAPL', '2026-01-05', '2026-01-08')
    up.state.failFrom = '2026-01-09'
    await expect(read('AAPL', '2026-01-05', '2026-01-09')).rejects.toMatchObject({ kind: 'http' })
  })

  test('a no-data answer for a historical gap still propagates even when a tail exists', async () => {
    today = '2026-01-09'
    up.state.missing = new Set(['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'])
    await expect(read('AAPL', '2026-01-05', '2026-01-09')).rejects.toMatchObject({ kind: 'no-data' })
    expect(f.coverage.length).toBe(0)
  })

  test('a tail with no trading day makes no upstream call', async () => {
    today = '2026-01-10' // Saturday
    await read('AAPL', '2026-01-05', '2026-01-09')
    up.state.reset()
    const bars = await read('AAPL', '2026-01-05', '2026-01-10')
    expect(up.state.calls).toBe(0)
    expect(bars.length).toBe(5)
  })

  test('upstream bars outside the requested gap are never cached', async () => {
    today = '2026-01-09'
    const stray = async (t: string, from: string, to: string) => [...(await up(t, from, to)), mkBar('2026-01-09'), mkBar('2026-01-02')]
    const r = makeCachedBarReader({ upstream: stray, repos: f.repos as any, today: () => today })
    await r('AAPL', '2026-01-05', '2026-01-08')
    expect(f.priceHistory.map((x) => x.tradeDate).sort()).toEqual(['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'])
  })

  test('bars come back ascending and deduplicated', async () => {
    up.state.shuffle = true
    today = '2026-01-14'
    const bars = await read('AAPL', '2026-01-05', '2026-01-14') // tail 01-14 is also shuffled and duplicated
    const dates = bars.map((b) => b.date)
    expect(dates).toEqual([...new Set(dates)].sort())
    expect(dates.length).toBe(8)
  })

  test('an upstream error keeps the coverage already committed', async () => {
    await read('AAPL', '2026-02-02', '2026-02-27')
    up.state.failFrom = '2026-02-28'
    await expect(read('AAPL', '2026-01-05', '2026-03-31')).rejects.toBeInstanceOf(MarketDataError)
    expect(await f.repos.barCoverageRepo.list('AAPL')).toEqual([{ fromDate: '2026-01-05', toDate: '2026-02-27' }])
    expect(f.priceHistory.some((r) => r.tradeDate === '2026-01-05')).toBe(true)
    // the next attempt resumes: only the failed gap is asked again
    up.state.failFrom = null
    up.state.reset()
    await read('AAPL', '2026-01-05', '2026-03-31')
    expect(up.state.ranges).toEqual([['2026-03-02', '2026-03-31']])
  })

  test('a no-data answer from upstream propagates and is not marked covered', async () => {
    up.state.missing = new Set(['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'])
    let err: unknown
    await read('AAPL', '2026-01-05', '2026-01-09').catch((e) => { err = e })
    expect(err).toBeInstanceOf(MarketDataError)
    expect((err as MarketDataError).kind).toBe('no-data')
    expect(f.coverage.length).toBe(0)
  })

  test('tickers are normalized — aapl and AAPL share one cache', async () => {
    await read('aapl', '2026-01-05', '2026-01-09')
    up.state.reset()
    const bars = await read(' AAPL ', '2026-01-05', '2026-01-09')
    expect(up.state.calls).toBe(0)
    expect(bars.length).toBe(5)
    expect(new Set(f.priceHistory.map((r) => r.ticker))).toEqual(new Set(['AAPL']))
  })

  test('a legacy close-only row does not mask the day: the bar is fetched and upgraded', async () => {
    await f.repos.priceHistoryRepo.upsertMany([{ ticker: 'AAPL', tradeDate: '2026-01-06', close: 1n }])
    const bars = await read('AAPL', '2026-01-05', '2026-01-09')
    expect(bars.find((b) => b.date === '2026-01-06')).toEqual(mkBar('2026-01-06'))
  })

  test('an inverted range returns nothing and makes no call', async () => {
    expect(await read('AAPL', '2026-01-09', '2026-01-05')).toEqual([])
    expect(up.state.calls).toBe(0)
  })
})
