import { describe, test, expect } from 'bun:test'
import { emptyState, type RunState } from '@st/core'
import { DEFAULT_MR_PARAMS } from '@st/strategies'
import type { DayDeps } from '../src/pipeline/day'
import { runMorningPipeline } from '../src/pipeline/day'
import { recalcRunState } from '../src/domain/recompute'
import { withRunLock } from '../src/domain/run-lock'
import type { NewOrder } from '../src/domain/repo-types'
import { makeRepos } from './day-fakes'

describe('day pipeline run lock', () => {
  async function setup() {
    const f = makeRepos()
    const st = emptyState(10)
    st.buckets[1] = { index: 1, state: 'held', shares: 10, buyPrice: 3402300n, buyFeeCents: 0, filledOn: '2026-11-03' }
    st.ages[1] = 3
    st.cashCents = 1000000
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'TSLA', name: 'T', poolCents: 1000000, costPpm: 30, initialRunState: st })
    const deps: DayDeps = {
      today: () => '2026-11-06',
      fetchLastClose: async () => ({ date: '2026-11-05', close: 3402300n }),
      crossCheck: async () => ({ agree: true }),
      send: async () => {},
      allowedChatIds: ['c1'],
      repos: f.repos,
      params: () => DEFAULT_MR_PARAMS,
      digestLang: 'en',
    }
    return { f, runId, deps }
  }
  const tick = () => new Promise<void>((r) => setTimeout(r, 5))
  const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((r) => { resolve = r })
    return { promise, resolve }
  }

  test('morning span waits for a held run lock', async () => {
    const { f, runId, deps } = await setup()
    const gate = deferred()
    const holder = withRunLock(runId, () => gate.promise)
    let settled = false
    const morning = runMorningPipeline(deps).finally(() => { settled = true })
    try {
      await tick()
      expect(settled).toBe(false)
      expect(f.orders.length).toBe(0)
      expect((await f.repos.bucketRepo.loadState(runId)).ages[1]).toBe(3)
    } finally {
      gate.resolve()
    }
    await holder
    expect(await morning).toBe('sent')
    expect(f.orders.length).toBeGreaterThan(0)
    expect((await f.repos.bucketRepo.loadState(runId)).ages[1]).toBe(4)
  })

  test('a recalc cannot interleave with the morning load→save span', async () => {
    const { f, runId, deps } = await setup()
    const log: string[] = []
    const gate = deferred()
    const entered = deferred()
    const { bucketRepo, orderRepo } = f.repos
    const loadState = bucketRepo.loadState.bind(bucketRepo)
    const saveState = bucketRepo.saveState.bind(bucketRepo)
    const insertMany = orderRepo.insertMany.bind(orderRepo)
    bucketRepo.loadState = async (id: number) => { log.push('load'); return loadState(id) }
    bucketRepo.saveState = async (id: number, s: RunState) => { log.push('save'); await saveState(id, s) }
    orderRepo.insertMany = async (rows: NewOrder[]) => { entered.resolve(); await gate.promise; await insertMany(rows) }

    const morning = runMorningPipeline(deps)
    let recalc: Promise<unknown> | undefined
    try {
      await entered.promise
      recalc = recalcRunState(runId, { repos: f.repos, today: '2026-11-06' })
      await tick()
      // the morning span holds the lock between its load and its save
      expect(log).toEqual(['load'])
    } finally {
      gate.resolve()
    }
    await Promise.all([morning, recalc])
    expect(log).toEqual(['load', 'save', 'load', 'save'])
  })
})
