import { describe, test, expect, beforeAll } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { getDb, applyMigrations } from '../src/db/client'
import type { Db } from '../src/db/db-type'
import { getRepos } from '../src/db/repos'
import type { NewOrder, OrderStatus } from '../src/domain/repo-types'

const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip

describeIf('db migration 0010', () => {
  let repos: ReturnType<typeof getRepos>
  let db: Db
  beforeAll(async () => {
    db = await getDb(process.env.TEST_DATABASE_URL!)
    await applyMigrations(db)
    repos = getRepos(db)
  })

  // The driver returns [rows, fields] for a SELECT.
  const rowsOf = async <T>(q: string) => ((await db.execute(sql.raw(q))) as unknown as [T[], unknown])[0]
  const order = (runId: number, status: OrderStatus, bucketIdx: number): NewOrder =>
    ({ runId, tradeDate: '2026-02-10', kind: 'buy_loc', bucketIdx, limitPrice: 100n, shares: 1, status })

  test('sim_days is indexed on (sim_run_id, trade_date) and the single-column index is gone', async () => {
    const idx = await rowsOf<{ Key_name: string; Seq_in_index: number; Column_name: string }>('SHOW INDEX FROM sim_days')
    const cols = (name: string) => idx.filter((r) => r.Key_name === name).sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index)).map((r) => r.Column_name)
    expect(cols('sim_days_sim_run_trade_idx')).toEqual(['sim_run_id', 'trade_date'])
    expect(cols('sim_days_sim_run_idx')).toEqual([])
  })

  // Careful: the backfill is an unscoped UPDATE, so replaying it stamps every stale order in the
  // shared test database. Safe because bun runs test files one after another and every test
  // creates the rows it asserts on. Keep this the last test in the file.
  test('a new order has no reported_at; the backfill stamps stale orders only', async () => {
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'MG', name: `mg-${Date.now()}`, poolCents: 1000, costPpm: 10 })
    await repos.orderRepo.insertMany([order(runId, 'stale', 0), order(runId, 'open', 1), order(runId, 'filled', 2), order(runId, 'cancelled', 3)])
    const flags = async () => (await rowsOf<{ reported: number }>(`SELECT reported_at IS NOT NULL AS reported FROM orders WHERE run_id = ${runId} ORDER BY bucket_idx`)).map((r) => Number(r.reported))
    expect(await flags()).toEqual([0, 0, 0, 0])
    const migrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url))
    const [file] = [...new Bun.Glob('0010_*.sql').scanSync({ cwd: migrationsDir })].sort()
    const backfill = (await Bun.file(migrationsDir + file).text()).split('--> statement-breakpoint').map((c) => c.trim()).find((c) => /UPDATE\s+`orders`\s+SET\s+`reported_at`/.test(c))
    expect(backfill).toBeDefined()
    await db.execute(sql.raw(backfill!))
    expect(await flags()).toEqual([1, 0, 0, 0])
  })
})
