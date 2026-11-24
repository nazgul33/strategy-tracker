import { describe, test, expect, beforeAll } from 'bun:test'
import { emptyState, type RunState } from '@st/core'
import { getDb, applyMigrations } from '../src/db/client'
import { getRepos } from '../src/db/repos'
import type { NewOrder } from '../src/domain/repo-types'

const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip

describeIf('db day plan write', () => {
  let repos: ReturnType<typeof getRepos>
  beforeAll(async () => {
    const db = await getDb(process.env.TEST_DATABASE_URL!)
    await applyMigrations(db)
    repos = getRepos(db)
  })

  const order = (runId: number): NewOrder => ({ runId, tradeDate: '2026-02-10', kind: 'buy_loc', bucketIdx: 0, limitPrice: 100n, shares: 1, status: 'open' })
  const newRun = () => repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'DP', name: `dp-${Date.now()}`, poolCents: 1000, costPpm: 10 })

  test('saveStateWithOrders stores the orders and the state together', async () => {
    const runId = await newRun()
    const state: RunState = { ...emptyState(2), cashCents: 900 }
    await repos.bucketRepo.saveStateWithOrders(runId, state, [order(runId)])
    expect(await repos.orderRepo.listForRun(runId, '2026-02-10')).toHaveLength(1)
    expect((await repos.bucketRepo.loadState(runId)).cashCents).toBe(900)
  })

  test('a failing state write rolls the orders back', async () => {
    const runId = await newRun()
    // shares: null violates NOT NULL on mr_buckets.shares, after the order insert and the state_json update
    const bad = { ...emptyState(1), cashCents: 900 } as RunState
    bad.buckets[0] = { index: 0, state: 'held', shares: null as unknown as number, buyPrice: 100n, buyFeeCents: 0, filledOn: '2026-02-09' }
    await expect(repos.bucketRepo.saveStateWithOrders(runId, bad, [order(runId)])).rejects.toThrow()
    expect(await repos.orderRepo.listForRun(runId, '2026-02-10')).toEqual([])
    expect((await repos.bucketRepo.loadState(runId)).cashCents).toBe(1000)
  })

  test('a failing order insert leaves no orders and the state unchanged', async () => {
    const runId = await newRun()
    // shares: null violates NOT NULL on mr_orders.shares; the valid first row must not survive either
    const bad = { ...order(runId), bucketIdx: 1, shares: null as unknown as number }
    await expect(repos.bucketRepo.saveStateWithOrders(runId, { ...emptyState(2), cashCents: 900 }, [order(runId), bad])).rejects.toThrow()
    expect(await repos.orderRepo.listForRun(runId, '2026-02-10')).toEqual([])
    expect((await repos.bucketRepo.loadState(runId)).cashCents).toBe(1000)
  })
})
