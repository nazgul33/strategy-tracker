import { describe, test, expect, beforeAll } from 'bun:test'
import { getDb, applyMigrations } from '../src/db/client'
import { getRepos } from '../src/db/repos'
import { getBarRepos, deadlockBackoffMs, isDeadlock } from '../src/db/repos-bars'

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

describe('barCoverageRepo.add retry policy', () => {
  function stubbed(failures: unknown[]) {
    let calls = 0
    const delays: number[] = []
    const db = {
      transaction: async () => {
        calls += 1
        if (calls <= failures.length) throw failures[calls - 1]
      },
    }
    const repo = getBarRepos(db as any, { sleep: async (ms: number) => { delays.push(ms) }, random: () => 0 }).barCoverageRepo
    return { repo, calls: () => calls, delays }
  }

  test('add retries a deadlock and succeeds on the fifth attempt', async () => {
    const s = stubbed(Array.from({ length: 4 }, () => ({ errno: 1213 })))
    await expect(s.repo.add('AAPL', '2026-01-05', '2026-01-08')).resolves.toBeUndefined()
    expect(s.calls()).toBe(5)
    expect(s.delays).toEqual([5, 10, 20, 40])
  })

  test('add gives up after five deadlocks', async () => {
    const err = { cause: { code: 'ER_LOCK_DEADLOCK' } }
    const s = stubbed(Array.from({ length: 10 }, () => err))
    await expect(s.repo.add('AAPL', '2026-01-05', '2026-01-08')).rejects.toBe(err)
    expect(s.calls()).toBe(5)
    expect(s.delays).toEqual([5, 10, 20, 40])
  })

  test('add does not retry any other error', async () => {
    const err = new Error('boom')
    const s = stubbed([err, err, err])
    await expect(s.repo.add('AAPL', '2026-01-05', '2026-01-08')).rejects.toBe(err)
    expect(s.calls()).toBe(1)
    expect(s.delays).toEqual([])
  })

  test('the backoff doubles per attempt with up to 4 ms of jitter', () => {
    expect([1, 2, 3, 4].map((a) => deadlockBackoffMs(a, () => 0))).toEqual([5, 10, 20, 40])
    expect(deadlockBackoffMs(1, () => 0.999)).toBe(9)
  })
})

describe('isDeadlock', () => {
  test('recognises the driver error directly and wrapped in cause', () => {
    expect(isDeadlock({ errno: 1213 })).toBe(true)
    expect(isDeadlock({ cause: { code: 'ER_LOCK_DEADLOCK' } })).toBe(true)
    expect(isDeadlock(new Error('x'))).toBe(false)
  })
})
