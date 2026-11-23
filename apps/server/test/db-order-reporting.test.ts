import { describe, test, expect, beforeAll } from 'bun:test'
import { getDb, applyMigrations } from '../src/db/client'
import { getRepos } from '../src/db/repos'
import type { NewOrder, OrderStatus } from '../src/domain/repo-types'

const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip

describeIf('db order reporting', () => {
  let repos: ReturnType<typeof getRepos>
  beforeAll(async () => {
    const db = await getDb(process.env.TEST_DATABASE_URL!)
    await applyMigrations(db)
    repos = getRepos(db)
  })

  let seq = 0
  const newRun = () => repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'OR', name: `or-${Date.now()}-${seq++}`, poolCents: 1000, costPpm: 10 })
  const order = (runId: number, tradeDate: string, status: OrderStatus, bucketIdx: number): NewOrder =>
    ({ runId, tradeDate, kind: 'buy_loc', bucketIdx, limitPrice: 100n, shares: 1, status })
  const unreported = async (runId: number) => (await repos.orderRepo.listUnreportedStale(runId)).map((o) => [o.bucketIdx, o.tradeDate])

  test("listUnreportedStale returns only this run's stale orders, lowest id first", async () => {
    const a = await newRun()
    const b = await newRun()
    await repos.orderRepo.insertMany([
      order(a, '2026-02-09', 'stale', 0), order(a, '2026-02-10', 'stale', 1), order(a, '2026-02-10', 'open', 2),
      order(a, '2026-02-10', 'filled', 3), order(a, '2026-02-10', 'cancelled', 4),
      order(b, '2026-02-10', 'stale', 9),
    ])
    expect(await unreported(a)).toEqual([[0, '2026-02-09'], [1, '2026-02-10']])
    expect(await unreported(b)).toEqual([[9, '2026-02-10']])
    const [first] = await repos.orderRepo.listUnreportedStale(a)
    expect(first.reportedAt).toBeNull()
    expect(first.limitPrice).toBe(100n)
  })

  test('markReported stamps the orders and takes them out of the list', async () => {
    const runId = await newRun()
    await repos.orderRepo.insertMany([order(runId, '2026-02-10', 'stale', 0), order(runId, '2026-02-10', 'stale', 1)])
    const [first, second] = await repos.orderRepo.listUnreportedStale(runId)
    await repos.orderRepo.markReported([first.id])
    expect(await unreported(runId)).toEqual([[1, '2026-02-10']])
    expect(typeof (await repos.orderRepo.get(first.id))!.reportedAt).toBe('string')
    expect((await repos.orderRepo.get(second.id))!.reportedAt).toBeNull()
  })

  test('markReported with an empty list writes nothing', async () => {
    const runId = await newRun()
    await repos.orderRepo.insertMany([order(runId, '2026-02-10', 'stale', 0)])
    await repos.orderRepo.markReported([])
    expect(await unreported(runId)).toHaveLength(1)
  })

  test('an open order is not listed until it turns stale, and drops out again when it is filled', async () => {
    const runId = await newRun()
    await repos.orderRepo.insertMany([order(runId, '2026-02-10', 'open', 0)])
    const [{ id }] = await repos.orderRepo.listForRun(runId)
    expect(await unreported(runId)).toEqual([])
    await repos.orderRepo.setStatus(id, 'stale')
    expect(await unreported(runId)).toEqual([[0, '2026-02-10']])
    await repos.orderRepo.setStatus(id, 'filled')
    expect(await unreported(runId)).toEqual([])
  })
})
