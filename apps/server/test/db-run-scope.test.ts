import { describe, test, expect, beforeAll } from 'bun:test'
import { sql, type SQL } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { getDb, applyMigrations } from '../src/db/client'
import { getRepos } from '../src/db/repos'
import { getMrRunRepos } from '../src/db/repos-mr-runs'
import * as schema from '../src/db/schema'

const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip

describeIf('db integration: run scope', () => {
  let db: Awaited<ReturnType<typeof getDb>>
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

  test('a strategy_runs row without an mr_runs row is invisible to runRepo', async () => {
    const uniq = Date.now()
    const mrId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'SC' + uniq, name: 'scope-mr-' + uniq, poolCents: 1000, costPpm: 10 })
    const [res] = await db.execute(sql`INSERT INTO strategy_runs (strategy_key, ticker, name, cost_ppm) VALUES ('value-rebalancing', 'TQQQ', ${'scope-vr-' + uniq}, 10)`) as unknown as [{ insertId: number }, unknown]
    const otherId = res.insertId
    try {
      expect(await repos.runRepo.get(otherId)).toBeNull()
      expect((await repos.runRepo.getMany([mrId, otherId])).map((r) => r.id)).toEqual([mrId])
      expect((await repos.runRepo.list()).some((r) => r.id === otherId)).toBe(false)
    } finally {
      await db.execute(sql`DELETE FROM strategy_runs WHERE id = ${otherId}`)
    }
  })

  test('MR status writes skip a run without an mr_runs row', async () => {
    const uniq = Date.now()
    const mrId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'SS' + uniq, name: 'scope-st-mr-' + uniq, poolCents: 1000, costPpm: 10 })
    const [res] = await db.execute(sql`INSERT INTO strategy_runs (strategy_key, ticker, name, cost_ppm) VALUES ('value-rebalancing', 'TQQQ', ${'scope-st-vr-' + uniq}, 10)`) as unknown as [{ insertId: number }, unknown]
    const otherId = res.insertId
    try {
      await repos.runRepo.updateStatus(otherId, 'paused')
      expect(await repos.runRepo.updateStatusMany([mrId, otherId], ['active'], 'paused')).toBe(1)
      expect(await selectRows(sql`SELECT status FROM strategy_runs WHERE id = ${otherId}`)).toEqual([{ status: 'active' }])
      expect((await repos.runRepo.get(mrId))!.status).toBe('paused')
    } finally {
      await db.execute(sql`DELETE FROM strategy_runs WHERE id = ${otherId}`)
    }
  })

  test('list returns runs in ascending id order', async () => {
    const ids = (await repos.runRepo.list()).map((r) => r.id)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))

    // InnoDB returns id order even without ORDER BY, so also pin the SQL that is sent.
    const queries: string[] = []
    const logged = drizzle(db.$client, { schema, mode: 'default', logger: { logQuery: (q) => { queries.push(q) } } })
    await getMrRunRepos(logged).runRepo.list()
    expect(queries.some((q) => /order by `strategy_runs`.`id`/i.test(q))).toBe(true)
  })

  test('create writes both tables; pool and order shaping land in mr_runs; a run row keeps every field', async () => {
    const uniq = Date.now()
    const id = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'SW' + uniq, name: 'scope-w-' + uniq, poolCents: 5000, costPpm: 33, buyGapPpm: 1, sellGapPpm: 2, cutLossPpm: 3 })
    await repos.runRepo.updatePool(id, 7000)
    await repos.runRepo.updateOrderShaping(id, { buyGapPpm: 11, sellGapPpm: 12, cutLossPpm: 13 })
    expect(await selectRows(sql`SELECT pool_cents, buy_gap_ppm, sell_gap_ppm, cut_loss_ppm FROM mr_runs WHERE run_id = ${id}`))
      .toEqual([{ pool_cents: 7000, buy_gap_ppm: 11, sell_gap_ppm: 12, cut_loss_ppm: 13 }])
    const row = (await repos.runRepo.get(id))!
    expect(Object.keys(row).sort()).toEqual(['buyGapPpm', 'costPpm', 'createdAt', 'cutLossPpm', 'id', 'name', 'poolCents', 'sellGapPpm', 'stateJson', 'status', 'strategyKey', 'ticker'])
    expect(row).toMatchObject({ id, strategyKey: 'mean-reversion', poolCents: 7000, costPpm: 33, buyGapPpm: 11, sellGapPpm: 12, cutLossPpm: 13, status: 'active' })
  })
})
