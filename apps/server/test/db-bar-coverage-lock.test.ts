import { describe, test, expect, beforeAll } from 'bun:test'
import { getDb, applyMigrations } from '../src/db/client'
import { getRepos } from '../src/db/repos'
import { isDeadlock } from '../src/db/repos-bars'

const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip

describeIf('barCoverageRepo.add under concurrent writers', () => {
  let repos: any
  beforeAll(async () => {
    const db = await getDb(process.env.TEST_DATABASE_URL!)
    await applyMigrations(db)
    repos = getRepos(db)
  })

  test('concurrent adds on a fresh ticker leave one merged row', async () => {
    const ticker = 'LK' + Date.now()
    const days = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08']
    const results = await Promise.allSettled(days.map((d) => repos.barCoverageRepo.add(ticker, '2026-01-05', d)))
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
    expect(await repos.barCoverageRepo.list(ticker)).toEqual([{ fromDate: '2026-01-05', toDate: '2026-01-08' }])
  })

  test('concurrent adds touching a stored range all merge into it', async () => {
    const ticker = 'LM' + Date.now()
    await repos.barCoverageRepo.add(ticker, '2026-02-01', '2026-02-10')
    const results = await Promise.allSettled(Array.from({ length: 4 }, (_, i) =>
      repos.barCoverageRepo.add(ticker, `2026-02-${String(11 + i).padStart(2, '0')}`, `2026-02-${String(11 + i).padStart(2, '0')}`)))
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
    expect(await repos.barCoverageRepo.list(ticker)).toEqual([{ fromDate: '2026-02-01', toDate: '2026-02-14' }])
  })
})

describe('isDeadlock', () => {
  test('recognises the driver error directly and wrapped in cause', () => {
    expect(isDeadlock({ errno: 1213 })).toBe(true)
    expect(isDeadlock({ cause: { code: 'ER_LOCK_DEADLOCK' } })).toBe(true)
    expect(isDeadlock(new Error('x'))).toBe(false)
  })
})
