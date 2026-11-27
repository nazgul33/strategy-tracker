import { describe, test, expect, beforeAll } from 'bun:test'
import { emptyState, type RunState } from '@st/core'
import { getDb, applyMigrations } from '../src/db/client'
import { getRepos } from '../src/db/repos'

const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip

describeIf('db pool and state write', () => {
  let repos: ReturnType<typeof getRepos>
  beforeAll(async () => {
    const db = await getDb(process.env.TEST_DATABASE_URL!)
    await applyMigrations(db)
    repos = getRepos(db)
  })

  const newRun = () => repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'PE', name: `pe-${Date.now()}`, poolCents: 1000, costPpm: 10 })

  test('saveStateWithPool stores the pool and the state together', async () => {
    const runId = await newRun()
    const state: RunState = { ...emptyState(2), cashCents: 1500 }
    await repos.bucketRepo.saveStateWithPool(runId, state, 1500)
    expect((await repos.runRepo.get(runId))!.poolCents).toBe(1500)
    expect((await repos.bucketRepo.loadState(runId)).cashCents).toBe(1500)
  })

  test('a failing state write rolls the pool back', async () => {
    const runId = await newRun()
    // shares: null violates NOT NULL on mr_buckets.shares, after the pool update and the state_json update
    const bad = { ...emptyState(1), cashCents: 1500 } as RunState
    bad.buckets[0] = { index: 0, state: 'held', shares: null as unknown as number, buyPrice: 100n, buyFeeCents: 0, filledOn: '2026-02-09' }
    await expect(repos.bucketRepo.saveStateWithPool(runId, bad, 1500)).rejects.toThrow()
    expect((await repos.runRepo.get(runId))!.poolCents).toBe(1000)
    expect((await repos.bucketRepo.loadState(runId)).cashCents).toBe(1000)
  })
})
