import { describe, test, expect, beforeAll } from 'bun:test'
import { getDb, applyMigrations } from '../src/db/client'
import { getRepos } from '../src/db/repos'

const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip

describeIf('simRepo.rewriteDraft', () => {
  let repos: any
  beforeAll(async () => {
    const db = await getDb(process.env.TEST_DATABASE_URL!)
    await applyMigrations(db)
    repos = getRepos(db)
  })

  const config = (over: Record<string, unknown> = {}) => ({
    fromDate: '2026-03-02', toDate: '2026-03-06', poolCents: 1_000_000, costPpm: 30,
    buyGapPpm: 0, sellGapPpm: 0, cutLossPpm: 0, paramsJson: '{}', ...over,
  })
  const day = (simRunId: number, tradeDate: string, planJson = '{}') => ({ simRunId, tradeDate, planJson, stateJson: '{}', eventsJson: '[]' })
  const seed = async () => {
    const id: number = await repos.simRepo.insertRun({ ticker: 'RW' + Date.now(), ...config() })
    await repos.simRepo.insertDays([day(id, '2026-03-02'), day(id, '2026-03-03')])
    return id
  }
  const snapshot = async (id: number) => ({ run: await repos.simRepo.getRun(id), days: await repos.simRepo.listDays(id) })

  test('writes the config and replaces the day set together', async () => {
    const id = await seed()
    const other = await seed()
    const next = config({ fromDate: '2026-04-01', toDate: '2026-04-30', poolCents: 2_000_000, costPpm: 50, buyGapPpm: 10_000, sellGapPpm: 20_000, cutLossPpm: 300_000, paramsJson: '{"bucketCount":5}' })
    expect(await repos.simRepo.rewriteDraft(id, next, [day(id, '2026-04-01'), day(id, '2026-04-02'), day(id, '2026-04-03')])).toBe(true)
    const after = await snapshot(id)
    expect(after.run).toMatchObject({ id, ...next, draft: true })
    expect(after.days.map((d: any) => d.tradeDate)).toEqual(['2026-04-01', '2026-04-02', '2026-04-03'])
    expect((await repos.simRepo.listDays(other)).length).toBe(2)
  })

  test('re-applying an identical config still counts as a write', async () => {
    const id = await seed()
    expect(await repos.simRepo.rewriteDraft(id, config(), [day(id, '2026-03-09')])).toBe(true)
    expect((await repos.simRepo.listDays(id)).map((d: any) => d.tradeDate)).toEqual(['2026-03-09'])
  })

  test('a failing day insert leaves the old config and the old days intact', async () => {
    const id = await seed()
    const before = await snapshot(id)
    const bad = { ...day(id, '2026-04-02'), planJson: null as any } // plan_json is NOT NULL
    await expect(repos.simRepo.rewriteDraft(id, config({ poolCents: 5_000_000, cutLossPpm: 100_000 }), [day(id, '2026-04-01'), bad])).rejects.toBeDefined()
    expect(await snapshot(id)).toEqual(before)
  })

  test('a run finalized before the write is not overwritten', async () => {
    const id = await seed()
    expect(await repos.simRepo.finalize(id)).toBe(true)
    const before = await snapshot(id)
    expect(await repos.simRepo.rewriteDraft(id, config({ poolCents: 5_000_000 }), [day(id, '2026-04-01')])).toBe(false)
    expect(await snapshot(id)).toEqual(before)
  })

  test('an unknown run is not written', async () => {
    expect(await repos.simRepo.rewriteDraft(999_999_999, config(), [])).toBe(false)
  })
})
