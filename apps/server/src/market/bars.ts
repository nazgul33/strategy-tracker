import { addDays, dayInfo, prevTradingDay, type ISODate } from '@st/calendar'
import { MarketDataError, type OHLCBar } from '@st/market-data'
import type { BarRow } from '../db/repos-bars'

export interface BarCacheRepos {
  priceHistoryRepo: {
    upsertBars(rows: BarRow[]): Promise<number>
    listBars(ticker: string, from: string, to: string): Promise<Omit<BarRow, 'ticker'>[]>
  }
  barCoverageRepo: {
    list(ticker: string): Promise<{ fromDate: string; toDate: string }[]>
    add(ticker: string, from: string, to: string): Promise<void>
  }
}

type Range = [from: ISODate, to: ISODate]

// Outside the committed NYSE years dayInfo is weekends-only, so an uncovered
// holiday there still counts as a trading day. It is then fetched, upstream has
// nothing for it, and the gap would never be covered — so the reader swallows a
// per-gap 'no-data' (see below) and the cost is one wasted fetch, once.
function isOpen(d: ISODate): boolean {
  return dayInfo(d).open
}

function firstOpen(from: ISODate, to: ISODate): ISODate | null {
  for (let d = from; d <= to; d = addDays(d, 1)) if (isOpen(d)) return d
  return null
}

function lastOpen(from: ISODate, to: ISODate): ISODate | null {
  for (let d = to; d >= from; d = addDays(d, -1)) if (isOpen(d)) return d
  return null
}

// [from, to] minus the covered ranges, ascending. Coverage says what was
// fetched; row presence cannot (holidays and pre-IPO dates never have a row).
function uncovered(from: ISODate, to: ISODate, covered: { fromDate: string; toDate: string }[]): Range[] {
  const gaps: Range[] = []
  let cursor = from
  for (const c of [...covered].sort((a, b) => (a.fromDate < b.fromDate ? -1 : 1))) {
    if (cursor > to) break
    if (c.toDate < cursor) continue
    if (c.fromDate > to) break
    if (c.fromDate > cursor) gaps.push([cursor, addDays(c.fromDate, -1)])
    cursor = addDays(c.toDate, 1)
  }
  if (cursor <= to) gaps.push([cursor, to])
  return gaps
}

// [from, to] cut at calendar-year boundaries, ascending, each piece inclusive.
function splitByYear(from: ISODate, to: ISODate): Range[] {
  const pieces: Range[] = []
  let start = from
  while (start.slice(0, 4) < to.slice(0, 4)) {
    pieces.push([start, `${start.slice(0, 4)}-12-31`])
    start = `${Number(start.slice(0, 4)) + 1}-01-01`
  }
  pieces.push([start, to])
  return pieces
}

function inRange(bars: OHLCBar[], from: ISODate, to: ISODate): OHLCBar[] {
  const byDate = new Map<string, OHLCBar>()
  for (const b of bars) if (b.date >= from && b.date <= to && !byDate.has(b.date)) byDate.set(b.date, b)
  return [...byDate.values()]
}

// Read-through cache of finished daily sessions. Everything after the last
// completed trading day (today included) goes to the provider on every call and
// is neither stored nor marked covered, so a half-formed bar is never frozen.
export function makeCachedBarReader(deps: {
  upstream: (ticker: string, from: string, to: string) => Promise<OHLCBar[]>
  repos: BarCacheRepos
  today: () => ISODate
}): (ticker: string, from: string, to: string) => Promise<OHLCBar[]> {
  const { upstream, repos } = deps
  return async (ticker, from, to) => {
    if (from > to) return []
    const lastFinished = prevTradingDay(deps.today())
    const horizon = to < lastFinished ? to : lastFinished

    // A gap upstream has no data for (a holiday the calendar table does not know,
    // a pre-IPO stretch) is covered too, so the range stops failing on every retry.
    // Its coverage is written only once the assembled answer is non-empty: a range
    // with no data anywhere stays visibly broken instead of silently returning [].
    // Gaps go upstream one calendar year at a time, so one no-data answer covers at
    // most a year, and each such empty cover is logged because it can hide real bars.
    let noData: MarketDataError | null = null
    const emptyGaps: Range[] = []

    if (from <= horizon) {
      const covered = await repos.barCoverageRepo.list(ticker)
      for (const [gFrom, gTo] of uncovered(from, horizon, covered).flatMap(([a, b]) => splitByYear(a, b))) {
        // Weekend/holiday edges never hold data: ask only for the trading span,
        // and skip the call entirely (upstream throws 'no-data') when there is none.
        const first = firstOpen(gFrom, gTo)
        const last = lastOpen(gFrom, gTo)
        if (first !== null && last !== null) {
          try {
            const bars = inRange(await upstream(ticker, first, last), gFrom, gTo)
            await repos.priceHistoryRepo.upsertBars(bars.map((b) => ({
              ticker, tradeDate: b.date, open: b.open, high: b.high, low: b.low, close: b.close,
            })))
          } catch (e) {
            if (!(e instanceof MarketDataError && e.kind === 'no-data')) throw e
            noData = e
            emptyGaps.push([gFrom, gTo])
            continue
          }
        }
        await repos.barCoverageRepo.add(ticker, gFrom, gTo)
      }
    }

    const cached: OHLCBar[] = from <= horizon
      ? (await repos.priceHistoryRepo.listBars(ticker, from, horizon)).map((r) => ({
          date: r.tradeDate, open: r.open, high: r.high, low: r.low, close: r.close,
        }))
      : []

    const tailFrom = from > addDays(horizon, 1) ? from : addDays(horizon, 1)
    let tail: OHLCBar[] = []
    if (tailFrom <= to && firstOpen(tailFrom, to) !== null) {
      try {
        tail = inRange(await upstream(ticker, tailFrom, to), tailFrom, to)
      } catch (e) {
        // No data for an unfinished or not-yet-open session is normal (pre-open,
        // holiday); only a transport/provider failure is a real error here. No data
        // anywhere in the range is judged once, below.
        if (!(e instanceof MarketDataError && e.kind === 'no-data')) throw e
        noData = e
      }
    }

    const out = [...cached, ...tail].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    if (noData !== null && out.length === 0) throw noData
    for (const [gFrom, gTo] of emptyGaps) {
      await repos.barCoverageRepo.add(ticker, gFrom, gTo)
      console.warn(`[bars] ${ticker} ${gFrom}..${gTo}: provider returned no data; recorded as covered. If bars exist there, delete this ticker's bar_coverage rows to refetch.`)
    }
    return out
  }
}
