import { eq, and, gte, lte, isNotNull, inArray, sql } from 'drizzle-orm'
import * as s from './schema'

// Tickers arrive from many places (DB rows, client query params, Yahoo bars);
// price_history keys must be canonical or the cache would fragment.
export function normTicker(t: unknown): string {
  return String(t).trim().toUpperCase().slice(0, 16)
}

const DAY_MS = 86_400_000

function dayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS)
}

export type BarRow = { ticker: string; tradeDate: string; open: bigint; high: bigint; low: bigint; close: bigint }

export function getBarRepos(db: any) {
  const priceHistoryRepo = {
    // Idempotent by (ticker, tradeDate): refetching a day overwrites its close.
    async upsertMany(rows: { ticker: string; tradeDate: string; close: bigint }[]): Promise<number> {
      if (!rows.length) return 0
      await db.insert(s.priceHistory).values(
        rows.map((r) => ({ ticker: normTicker(r.ticker), tradeDate: r.tradeDate, close: r.close })),
      ).onDuplicateKeyUpdate({ set: { close: sql`values(${s.priceHistory.close})` } })
      return rows.length
    },
    // Full OHLC rows; also upgrades a legacy close-only row in place.
    async upsertBars(rows: BarRow[]): Promise<number> {
      if (!rows.length) return 0
      await db.insert(s.priceHistory).values(
        rows.map((r) => ({ ticker: normTicker(r.ticker), tradeDate: r.tradeDate, open: r.open, high: r.high, low: r.low, close: r.close })),
      ).onDuplicateKeyUpdate({
        set: {
          open: sql`values(${s.priceHistory.open})`,
          high: sql`values(${s.priceHistory.high})`,
          low: sql`values(${s.priceHistory.low})`,
          close: sql`values(${s.priceHistory.close})`,
        },
      })
      return rows.length
    },
    async listForTicker(ticker: string, from?: string) {
      const where = from
        ? and(eq(s.priceHistory.ticker, normTicker(ticker)), gte(s.priceHistory.tradeDate, from))
        : eq(s.priceHistory.ticker, normTicker(ticker))
      return db.select().from(s.priceHistory).where(where).orderBy(s.priceHistory.tradeDate)
    },
    // Inclusive range, ascending; legacy close-only rows (null open/high/low) are skipped.
    async listBars(ticker: string, from: string, to: string): Promise<Omit<BarRow, 'ticker'>[]> {
      const rows = await db.select().from(s.priceHistory).where(and(
        eq(s.priceHistory.ticker, normTicker(ticker)),
        gte(s.priceHistory.tradeDate, from), lte(s.priceHistory.tradeDate, to),
        isNotNull(s.priceHistory.open), isNotNull(s.priceHistory.high), isNotNull(s.priceHistory.low),
      )).orderBy(s.priceHistory.tradeDate)
      return rows.map((r: any) => ({ tradeDate: r.tradeDate, open: r.open, high: r.high, low: r.low, close: r.close }))
    },
  }

  const barCoverageRepo = {
    async list(ticker: string): Promise<{ fromDate: string; toDate: string }[]> {
      const rows = await db.select().from(s.barCoverage).where(eq(s.barCoverage.ticker, normTicker(ticker))).orderBy(s.barCoverage.fromDate)
      return rows.map((r: any) => ({ fromDate: r.fromDate, toDate: r.toDate }))
    },
    // Keeps the ticker's ranges merged: every stored range that overlaps or
    // touches [fromDate, toDate] (adjacent calendar days) is replaced by the union.
    // An inverted range is a caller bug and would persist a bogus coverage claim
    // that silently suppresses future fetches, so it throws instead.
    async add(ticker: string, fromDate: string, toDate: string): Promise<void> {
      if (fromDate > toDate) throw new Error(`bar coverage: inverted range ${fromDate}..${toDate} (from is after to)`)
      const t = normTicker(ticker)
      await db.transaction(async (tx: any) => {
        const rows: { id: number; fromDate: string; toDate: string }[] =
          await tx.select().from(s.barCoverage).where(eq(s.barCoverage.ticker, t))
        let from = fromDate
        let to = toDate
        const absorbed: number[] = []
        for (const r of rows) {
          // Test against the ORIGINAL [fromDate, toDate], not the widening from/to.
          // This is only correct because stored ranges are kept pairwise
          // non-overlapping and non-adjacent (every add merges its neighbours): a
          // stored range that touches the widened union must already touch the
          // original bounds, or it would have been merged into a range we absorb.
          // Testing against the widened bounds would be order-dependent.
          if (dayNumber(r.fromDate) <= dayNumber(toDate) + 1 && dayNumber(r.toDate) >= dayNumber(fromDate) - 1) {
            absorbed.push(r.id)
            if (r.fromDate < from) from = r.fromDate
            if (r.toDate > to) to = r.toDate
          }
        }
        if (absorbed.length) await tx.delete(s.barCoverage).where(inArray(s.barCoverage.id, absorbed))
        await tx.insert(s.barCoverage).values({ ticker: t, fromDate: from, toDate: to })
      })
    },
  }

  return { priceHistoryRepo, barCoverageRepo }
}
