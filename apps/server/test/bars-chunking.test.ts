import { describe, test, expect, beforeEach, spyOn } from 'bun:test'
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

function makeUpstream() {
  const state = {
    ranges: [] as [string, string][],
    missing: new Set<string>(),
    failFrom: null as string | null,
    reset() { state.ranges = [] },
  }
  const fn = async (_ticker: string, from: string, to: string): Promise<OHLCBar[]> => {
    state.ranges.push([from, to])
    if (state.failFrom !== null && from >= state.failFrom) throw new MarketDataError('http')
    const out: OHLCBar[] = []
    for (let d = from; d <= to; d = day(d)) if (isTradingDay(d) && !state.missing.has(d)) out.push(mkBar(d))
    if (out.length === 0) throw new MarketDataError('no-data')
    return out
  }
  return Object.assign(fn, { state })
}

describe('makeCachedBarReader gap chunking', () => {
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

  test('a multi-year gap goes upstream one calendar year at a time', async () => {
    await read('AAPL', '2024-06-03', '2026-03-31')
    expect(up.state.ranges).toEqual([['2024-06-03', '2024-12-31'], ['2025-01-02', '2025-12-31'], ['2026-01-02', '2026-03-31']])
    expect(await f.repos.barCoverageRepo.list('AAPL')).toEqual([{ fromDate: '2024-06-03', toDate: '2026-03-31' }])
  })

  test('a failing year keeps the years before it, and the retry asks only for the rest', async () => {
    up.state.failFrom = '2025-01-01'
    await expect(read('AAPL', '2024-06-03', '2026-03-31')).rejects.toMatchObject({ kind: 'http' })
    expect(await f.repos.barCoverageRepo.list('AAPL')).toEqual([{ fromDate: '2024-06-03', toDate: '2024-12-31' }])
    up.state.failFrom = null
    up.state.reset()
    await read('AAPL', '2024-06-03', '2026-03-31')
    expect(up.state.ranges).toEqual([['2025-01-02', '2025-12-31'], ['2026-01-02', '2026-03-31']])
  })

  test('a gap covered as empty after no-data is logged with the ticker and the range', async () => {
    today = '2026-01-09'
    up.state.missing = new Set(['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'])
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await read('AAPL', '2026-01-05', '2026-01-09')
      expect(warn).toHaveBeenCalledTimes(1)
      const text = String(warn.mock.calls[0]!.join(' '))
      expect(text).toContain('AAPL')
      expect(text).toContain('2026-01-05..2026-01-08')
      expect(text).toContain('bar_coverage')
    } finally { warn.mockRestore() }
  })

  test("a year before the ticker's first bar is covered as empty and the later years are still fetched", async () => {
    const missing = new Set<string>()
    for (let d = '2024-01-01'; d <= '2024-12-31'; d = day(d)) missing.add(d)
    up.state.missing = missing
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const bars = await read('AAPL', '2024-06-03', '2026-03-31')
      expect(bars.length).toBeGreaterThan(0)
      expect(bars.every((b) => b.date >= '2025-01-01')).toBe(true)
      expect(up.state.ranges).toEqual([['2024-06-03', '2024-12-31'], ['2025-01-02', '2025-12-31'], ['2026-01-02', '2026-03-31']])
      expect(await f.repos.barCoverageRepo.list('AAPL')).toEqual([{ fromDate: '2024-06-03', toDate: '2026-03-31' }])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]!.join(' '))).toContain('2024-06-03..2024-12-31')
    } finally { warn.mockRestore() }
  })

  test('a chunk that ends on a closed day is trimmed, and a chunk with no open day makes no upstream call', async () => {
    today = '2027-02-01'
    await read('AAPL', '2026-12-28', '2027-01-01')
    expect(up.state.ranges).toEqual([['2026-12-28', '2026-12-31']])
  })
})
