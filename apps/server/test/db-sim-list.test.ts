import { describe, test, expect, beforeAll, spyOn } from 'bun:test'
import { sql } from 'drizzle-orm'
import { getDb, applyMigrations } from '../src/db/client'
import { getRepos } from '../src/db/repos'

const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip

describeIf('simRepo.listRuns / sweepDrafts', () => {
  let db: any
  let repos: any
  beforeAll(async () => {
    db = await getDb(process.env.TEST_DATABASE_URL!)
    await applyMigrations(db)
    repos = getRepos(db)
  })

  const config = (over: Record<string, unknown> = {}) => ({
    fromDate: '2026-03-02', toDate: '2026-03-06', poolCents: 1_000_000, costPpm: 30,
    buyGapPpm: 0, sellGapPpm: 0, cutLossPpm: 0, paramsJson: '{}', ...over,
  })
  const day = (simRunId: number, tradeDate: string, planJson = '{}') => ({ simRunId, tradeDate, planJson, stateJson: '{}', eventsJson: '[]' })
  const input = () => ({ ticker: 'SL' + Date.now(), ...config() })

  test('listRuns is newest first', async () => {
    const a = await repos.simRepo.insertRun(input())
    const b = await repos.simRepo.insertRun(input())
    const ids = (await repos.simRepo.listRuns()).map((r: any) => r.id)
    expect(ids.indexOf(b)).toBeLessThan(ids.indexOf(a))
    expect(ids).toEqual([...ids].sort((x, y) => y - x))
  })

  test('sweepDrafts returns the number of runs it deleted, with their days gone', async () => {
    const x = await repos.simRepo.insertRun(input())
    const y = await repos.simRepo.insertRun(input())
    await repos.simRepo.insertDays([day(x, '2026-03-02'), day(y, '2026-03-02'), day(y, '2026-03-03')])
    await db.execute(sql.raw(`UPDATE sim_runs SET created_at = '2001-01-01 00:00:00' WHERE id IN (${x}, ${y})`))
    const log = spyOn(console, 'log').mockImplementation(() => {})
    let swept: number
    try {
      swept = await repos.simRepo.sweepDrafts(new Date('2002-01-01T00:00:00Z'))
      const line = log.mock.calls.map((c) => c.join(' ')).find((l) => l.includes('[simRepo]')) ?? ''
      expect(line).toContain(String(x))
      expect(line).toContain(String(y))
    } finally { log.mockRestore() }
    // >= 2: st_test is shared, and a crashed earlier run may have left 2001-dated drafts behind
    expect(swept).toBeGreaterThanOrEqual(2)
    expect(await repos.simRepo.getRun(x)).toBeNull()
    expect(await repos.simRepo.getRun(y)).toBeNull()
    expect(await repos.simRepo.listDays(x)).toEqual([])
    expect(await repos.simRepo.listDays(y)).toEqual([])
  })

  test('sweepDrafts returns 0 when no draft is old enough', async () => {
    expect(await repos.simRepo.sweepDrafts(new Date(0))).toBe(0)
  })
})
