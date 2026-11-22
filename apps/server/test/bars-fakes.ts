// Shared fakes for the cached bar reader suites (bars.test.ts and bars-chunking.test.ts).
import { isTradingDay } from '@st/calendar'
import { MarketDataError, type OHLCBar } from '@st/market-data'

export function day(date: string, n = 1): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function mkBar(date: string): OHLCBar {
  const n = BigInt(date.slice(5, 7)) * 100n + BigInt(date.slice(8))
  return { date, open: n * 10_000n, high: (n + 2n) * 10_000n, low: (n - 1n) * 10_000n, close: (n + 1n) * 10_000n }
}

// Counting fake provider: returns a bar for every NYSE trading day in range, except `missing`.
// Throws MarketDataError('no-data') on an empty answer, like the real fetchDailyBars.
export function makeUpstream() {
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
