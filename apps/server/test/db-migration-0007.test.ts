import { describe, test, expect, beforeAll, spyOn } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { sql, type SQL } from 'drizzle-orm'
import { getDb, applyMigrations } from '../src/db/client'
import type { Db } from '../src/db/db-type'
import { getRepos } from '../src/db/repos'

const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip

describeIf('db integration', () => {
  let db: Db
  let repos: ReturnType<typeof getRepos>
  beforeAll(async () => {
    db = await getDb(process.env.TEST_DATABASE_URL!)
    await applyMigrations(db)
    repos = getRepos(db)
  })

  // The driver returns [rows, fields] for a SELECT; drizzle types raw execute as the write header.
  async function selectRows<T>(q: SQL): Promise<T[]> {
    const [rows] = (await db.execute(q)) as unknown as [T[], unknown]
    return rows
  }

  describe('migration 0007: cut-loss, sim drafts, OHLC cache', () => {
    const simInput = (over: Record<string, unknown> = {}) => ({
      ticker: 'SD' + Date.now(), fromDate: '2026-03-02', toDate: '2026-03-06', poolCents: 1_000_000, costPpm: 30,
      buyGapPpm: 0, sellGapPpm: 0, cutLossPpm: 0, paramsJson: '{}', ...over,
    })
    const dayRow = (simRunId: number, tradeDate: string) => ({ simRunId, tradeDate, planJson: '{}', stateJson: '{}', eventsJson: '[]' })
    const find = async (id: number) => (await repos.simRepo.listRuns()).find((r) => r.id === id)!

    test('runRepo: cutLossPpm defaults to 0, create stores it, updateOrderShaping replaces updateGaps', async () => {
      const uniq = Date.now()
      const plain = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'CL' + uniq, name: 'cl-plain-' + uniq, poolCents: 1000, costPpm: 10 })
      expect((await repos.runRepo.get(plain))!.cutLossPpm).toBe(0)
      const withCut = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'CL' + uniq, name: 'cl-cut-' + uniq, poolCents: 1000, costPpm: 10, cutLossPpm: 150_000 })
      expect((await repos.runRepo.get(withCut))!.cutLossPpm).toBe(150_000)

      await repos.runRepo.updateOrderShaping(plain, { buyGapPpm: 10_000, sellGapPpm: 20_000, cutLossPpm: 250_000 })
      expect(await repos.runRepo.get(plain)).toMatchObject({ buyGapPpm: 10_000, sellGapPpm: 20_000, cutLossPpm: 250_000 })
      expect(await repos.runRepo.get(withCut)).toMatchObject({ buyGapPpm: 0, sellGapPpm: 0, cutLossPpm: 150_000 })
      expect((repos.runRepo as Record<string, unknown>).updateGaps).toBeUndefined()
    })

    test('stop_sell is a storable order kind', async () => {
      const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'SS' + Date.now(), name: 'stop-' + Date.now(), poolCents: 1000, costPpm: 10 })
      await repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-12', kind: 'stop_sell', bucketIdx: 0, limitPrice: 900000n, shares: 3, status: 'open' }])
      const [row] = await repos.orderRepo.listForRun(runId)
      expect(row.kind).toBe('stop_sell')
      expect(row.limitPrice).toBe(900000n)
    })

    test('pre-existing sim runs are not drafts after migration', async () => {
      // A row as it existed before 0007, then replay the migration's backfill chunk.
      // The chunk's presence is also asserted without a database in
      // migration-sql.test.ts; here it is really executed.
      //
      // Careful: that chunk is an unscoped `UPDATE sim_runs SET draft = 0`, so it
      // clears the draft flag on every row in the shared test database. That is safe
      // only because bun runs test files sequentially and this describe block is the
      // last one in this file — keep it last, and keep any new draft assertion after
      // this test creating its own rows.
      const id = await repos.simRepo.insertRun(simInput())
      await db.execute(sql.raw(`UPDATE sim_runs SET draft = 1 WHERE id = ${id}`))
      const migrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url))
      const [file] = [...new Bun.Glob('0007_*.sql').scanSync({ cwd: migrationsDir })].sort()
      expect(file).toBeDefined()
      const text = await Bun.file(migrationsDir + file).text()
      const backfill = text.split('--> statement-breakpoint').map((c) => c.trim()).find((c) => /UPDATE\s+`sim_runs`\s+SET\s+`draft`\s*=\s*0/.test(c))
      expect(backfill).toBeDefined()
      await db.execute(sql.raw(backfill!))
      expect((await find(id)).draft).toBe(false)
    })

    test('insertRun creates a draft carrying cutLossPpm', async () => {
      const id = await repos.simRepo.insertRun(simInput({ cutLossPpm: 100_000 }))
      const row = await find(id)
      expect(row.draft).toBe(true)
      expect(row.cutLossPpm).toBe(100_000)
      expect((await repos.simRepo.getRun(id))!.draft).toBe(true)
    })

    test('finalize is once-only', async () => {
      const id = await repos.simRepo.insertRun(simInput())
      expect(await repos.simRepo.finalize(id)).toBe(true)
      expect((await find(id)).draft).toBe(false)
      expect(await repos.simRepo.finalize(id)).toBe(false)
      expect(await repos.simRepo.finalize(999_999_999)).toBe(false)
    })

    test('deleteRun refuses a finalized run and removes a draft with its days', async () => {
      const saved = await repos.simRepo.insertRun(simInput())
      await repos.simRepo.insertDays([dayRow(saved, '2026-03-02')])
      await repos.simRepo.finalize(saved)
      expect(await repos.simRepo.deleteRun(saved)).toBe(false)
      expect(await repos.simRepo.getRun(saved)).not.toBeNull()
      expect((await repos.simRepo.listDays(saved)).length).toBe(1)

      const draft = await repos.simRepo.insertRun(simInput())
      await repos.simRepo.insertDays([dayRow(draft, '2026-03-02'), dayRow(draft, '2026-03-03')])
      expect(await repos.simRepo.deleteRun(draft)).toBe(true)
      expect(await repos.simRepo.getRun(draft)).toBeNull()
      expect(await repos.simRepo.listDays(draft)).toEqual([])
      expect(await repos.simRepo.deleteRun(draft)).toBe(false)
    })

    test('sweepDrafts deletes old drafts only, never a finalized run', async () => {
      const oldDraft = await repos.simRepo.insertRun(simInput())
      const oldSaved = await repos.simRepo.insertRun(simInput())
      await repos.simRepo.finalize(oldSaved)
      await repos.simRepo.insertDays([dayRow(oldDraft, '2026-03-02'), dayRow(oldSaved, '2026-03-02')])
      await db.execute(sql.raw(`UPDATE sim_runs SET created_at = '2020-01-01 00:00:00' WHERE id IN (${oldDraft}, ${oldSaved})`))
      const freshDraft = await repos.simRepo.insertRun(simInput())

      // the deleted ids must be recoverable from the log, not just their count
      const logs: string[] = []
      const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logs.push(args.join(' ')))
      let swept: number
      try {
        swept = await repos.simRepo.sweepDrafts(new Date('2021-01-01T00:00:00Z'))
      } finally { log.mockRestore() }
      expect(logs.join('\n')).toContain(`swept draft sim run ids`)
      expect(logs.some((l) => l.includes(String(oldDraft)))).toBe(true)
      expect(swept).toBeGreaterThanOrEqual(1)
      expect(await repos.simRepo.getRun(oldDraft)).toBeNull()
      expect(await repos.simRepo.listDays(oldDraft)).toEqual([])
      expect(await repos.simRepo.getRun(oldSaved)).not.toBeNull()
      expect((await repos.simRepo.listDays(oldSaved)).length).toBe(1)
      expect(await repos.simRepo.getRun(freshDraft)).not.toBeNull()
    })

    test('upsertBars overwrites in place and listBars skips legacy close-only rows', async () => {
      const ticker = 'OB' + Date.now()
      await repos.priceHistoryRepo.upsertMany([{ ticker, tradeDate: '2026-03-02', close: 100n }])
      expect(await repos.priceHistoryRepo.upsertBars([{ ticker, tradeDate: '2026-03-03', open: 1n, high: 2n, low: 1n, close: 2n }])).toBe(1)
      expect(await repos.priceHistoryRepo.upsertBars([])).toBe(0)
      const bars = await repos.priceHistoryRepo.listBars(ticker, '2026-03-01', '2026-03-31')
      expect(bars.map((b) => b.tradeDate)).toEqual(['2026-03-03'])

      // full bar over the legacy close-only day upgrades it; revised day overwrites in place
      await repos.priceHistoryRepo.upsertBars([
        { ticker: ticker.toLowerCase(), tradeDate: '2026-03-02', open: 90n, high: 110n, low: 80n, close: 100n },
        { ticker, tradeDate: '2026-03-03', open: 5n, high: 9n, low: 4n, close: 8n },
      ])
      const after = await repos.priceHistoryRepo.listBars(ticker, '2026-03-01', '2026-03-31')
      expect(after).toEqual([
        { tradeDate: '2026-03-02', open: 90n, high: 110n, low: 80n, close: 100n },
        { tradeDate: '2026-03-03', open: 5n, high: 9n, low: 4n, close: 8n },
      ])
      expect(typeof after[0].open).toBe('bigint')
      // range bounds are inclusive and exclude outside days
      expect((await repos.priceHistoryRepo.listBars(ticker, '2026-03-03', '2026-03-03')).map((b) => b.tradeDate)).toEqual(['2026-03-03'])
      expect(await repos.priceHistoryRepo.listBars(ticker, '2026-04-01', '2026-04-30')).toEqual([])
      // listForTicker still serves every row, legacy included
      expect((await repos.priceHistoryRepo.listForTicker(ticker)).length).toBe(2)
    })

    test('barCoverage merges adjacent ranges', async () => {
      const ticker = 'BC' + Date.now()
      await repos.barCoverageRepo.add(ticker, '2026-01-01', '2026-01-31')
      await repos.barCoverageRepo.add(ticker, '2026-02-01', '2026-02-28')
      expect(await repos.barCoverageRepo.list(ticker)).toEqual([{ fromDate: '2026-01-01', toDate: '2026-02-28' }])
    })

    test('barCoverage rejects an inverted range and stores nothing', async () => {
      const ticker = 'BI' + Date.now()
      await expect(repos.barCoverageRepo.add(ticker, '2026-02-01', '2026-01-01')).rejects.toThrow(/inverted|from/i)
      expect(await repos.barCoverageRepo.list(ticker)).toEqual([])
      // a rejected add leaves existing coverage untouched
      await repos.barCoverageRepo.add(ticker, '2026-01-01', '2026-01-10')
      await expect(repos.barCoverageRepo.add(ticker, '2026-01-20', '2026-01-05')).rejects.toThrow()
      expect(await repos.barCoverageRepo.list(ticker)).toEqual([{ fromDate: '2026-01-01', toDate: '2026-01-10' }])
      // a single-day range (from === to) is valid
      await repos.barCoverageRepo.add(ticker, '2026-03-01', '2026-03-01')
      expect((await repos.barCoverageRepo.list(ticker)).length).toBe(2)
    })

    test('barCoverage merges overlaps, bridges several ranges, keeps disjoint ones apart', async () => {
      const ticker = 'BD' + Date.now()
      expect(await repos.barCoverageRepo.list(ticker)).toEqual([])
      await repos.barCoverageRepo.add(ticker, '2026-01-01', '2026-01-10')
      await repos.barCoverageRepo.add(ticker, '2026-03-01', '2026-03-10')
      await repos.barCoverageRepo.add(ticker, '2026-05-01', '2026-05-10')
      // a two-day gap (Jan 11-12 missing) is not adjacent
      await repos.barCoverageRepo.add(ticker, '2026-01-13', '2026-01-15')
      expect(await repos.barCoverageRepo.list(ticker)).toEqual([
        { fromDate: '2026-01-01', toDate: '2026-01-10' },
        { fromDate: '2026-01-13', toDate: '2026-01-15' },
        { fromDate: '2026-03-01', toDate: '2026-03-10' },
        { fromDate: '2026-05-01', toDate: '2026-05-10' },
      ])
      // Jan 12 touches Jan 13 (consecutive calendar days) but Jan 11 is still missing; a contained range is a no-op
      await repos.barCoverageRepo.add(ticker, '2026-01-12', '2026-01-12')
      await repos.barCoverageRepo.add(ticker, '2026-01-02', '2026-01-03')
      expect((await repos.barCoverageRepo.list(ticker)).slice(0, 2)).toEqual([
        { fromDate: '2026-01-01', toDate: '2026-01-10' },
        { fromDate: '2026-01-12', toDate: '2026-01-15' },
      ])
      // a range spanning two stored ranges swallows both
      await repos.barCoverageRepo.add(ticker, '2026-01-05', '2026-03-05')
      expect(await repos.barCoverageRepo.list(ticker)).toEqual([
        { fromDate: '2026-01-01', toDate: '2026-03-10' },
        { fromDate: '2026-05-01', toDate: '2026-05-10' },
      ])
      // tickers are normalized and isolated
      expect(await repos.barCoverageRepo.list(ticker.toLowerCase())).toHaveLength(2)
      expect(await repos.barCoverageRepo.list('ZZ' + Date.now())).toEqual([])
    })
  })
})
