import { describe, test, expect } from 'bun:test'
import { emptyState } from '@st/core'
import { DEFAULT_MR_PARAMS } from '@st/strategies'
import type { DayDeps } from '../src/pipeline/day'
import { runMorningPipeline, runReminder } from '../src/pipeline/day'
import { makeRepos } from './day-fakes'

describe('day pipeline', () => {
  test('(a) sat -> weekend', async () => {
    const f = makeRepos()
    const sends: string[] = []
    const deps: DayDeps = {
      today: () => '2026-11-07',
      fetchLastClose: async () => ({ date: '2026-11-06', close: 100n }),
      crossCheck: async () => ({ agree: true }),
      send: async (_c, t) => { sends.push(t) },
      allowedChatIds: ['c1'],
      repos: f.repos,
      params: () => DEFAULT_MR_PARAMS,
      digestLang: 'en',
    }
    const r = await runMorningPipeline(deps)
    expect(r).toBe('weekend')
    expect(sends.length).toBe(0)
  })

  test('(b) holiday -> closed (en + ko)', async () => {
    // en
    {
      const f = makeRepos()
      const sends: string[] = []
      const deps: DayDeps = {
        today: () => '2026-11-26',
        fetchLastClose: async () => ({ date: '2026-11-25', close: 100n }),
        crossCheck: async () => ({ agree: true }),
        send: async (_c, t) => { sends.push(t) },
        allowedChatIds: ['c1'],
        repos: f.repos,
        params: () => DEFAULT_MR_PARAMS,
        digestLang: 'en',
      }
      const r = await runMorningPipeline(deps)
      expect(r).toBe('closed')
      expect(sends.length).toBe(1)
      expect(sends[0]).toContain('Market closed')
      expect(sends[0]).toContain('Thanksgiving')
    }
    // ko
    {
      const f = makeRepos()
      const sends: string[] = []
      const deps: DayDeps = {
        today: () => '2026-11-26',
        fetchLastClose: async () => ({ date: '2026-11-25', close: 100n }),
        crossCheck: async () => ({ agree: true }),
        send: async (_c, t) => { sends.push(t) },
        allowedChatIds: ['c1'],
        repos: f.repos,
        params: () => DEFAULT_MR_PARAMS,
        digestLang: 'ko',
      }
      const r = await runMorningPipeline(deps)
      expect(r).toBe('closed')
      expect(sends[0]).toContain('시장 휴장')
      expect(sends[0]).toContain('추수감사절')
    }
  })

  test('(c) normal day', async () => {
    const f = makeRepos()
    // run 1: held bucket at index 1 so buy_loc lands on bucket 0
    const st1 = emptyState(10)
    st1.buckets[1] = { index: 1, state: 'held', shares: 10, buyPrice: 3402300n, buyFeeCents: 0, filledOn: '2026-11-03' }
    st1.ages[1] = 3
    st1.cashCents = 1000000
    const runId1 = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'TSLA', name: 'T', poolCents: 1000000, costPpm: 30, initialRunState: st1 })
    const st2 = emptyState(10)
    st2.buckets[1] = { index: 1, state: 'held', shares: 10, buyPrice: 3402300n, buyFeeCents: 0, filledOn: '2026-11-03' }
    st2.ages[1] = 3
    st2.cashCents = 1000000
    await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'A', poolCents: 1000000, costPpm: 30, initialRunState: st2 })

    const sends: string[] = []
    const deps: DayDeps = {
      today: () => '2026-11-06',
      fetchLastClose: async () => ({ date: '2026-11-05', close: 3402300n }),
      crossCheck: async () => ({ agree: true }),
      send: async (_c, t) => { sends.push(t) },
      allowedChatIds: ['c1'],
      repos: f.repos,
      params: () => DEFAULT_MR_PARAMS,
      digestLang: 'en',
    }
    const beforeState = await f.repos.bucketRepo.loadState(runId1)
    const r = await runMorningPipeline(deps)
    expect(r).toBe('sent')
    const afterState = await f.repos.bucketRepo.loadState(runId1)
    expect(afterState.ages[1]).toBe(beforeState.ages[1] + 1)
    expect(afterState.ages[1]).toBe(4)

    // persisted order rows (buy_loc)
    const buyOrders = f.orders.filter((o) => o.kind === 'buy_loc')
    expect(buyOrders.length).toBe(2)
    for (const o of buyOrders) {
      expect(o.bucketIdx).toBe(0)
      expect(o.limitPrice).toBe(3402200n)
      expect(o.shares).toBe(2)
      expect(o.status).toBe('open')
      expect(o.tradeDate).toBe('2026-11-06')
    }
    // sends: 2 digests
    expect(sends.length).toBe(2)
    expect(sends.some((s) => s.includes('T  TSLA'))).toBe(true)
    expect(sends.some((s) => s.includes('A  AAPL'))).toBe(true)
    // notifications: 2 rows (runId per run, chat c1)
    expect(f.notifications.length).toBe(2)
    expect(f.notifications.every((n) => n.chatId === 'c1')).toBe(true)
  })

  test('(e) conflict', async () => {
    const f = makeRepos()
    await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'TSLA', name: 'T', poolCents: 1000000, costPpm: 30, initialRunState: emptyState(10) })
    const sends: string[] = []
    const deps: DayDeps = {
      today: () => '2026-11-06',
      fetchLastClose: async () => ({ date: '2026-11-05', close: 3402300n }),
      crossCheck: async () => ({ agree: false }),
      send: async (_c, t) => { sends.push(t) },
      allowedChatIds: ['c1'],
      repos: f.repos,
      params: () => DEFAULT_MR_PARAMS,
      digestLang: 'en',
    }
    const r = await runMorningPipeline(deps)
    expect(r).toBe('conflict')
    expect(sends.length).toBe(1)
    expect(sends[0]).toContain('Calendar conflict')
  })

  test('(f) unconfirmed warning line', async () => {
    const f = makeRepos()
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'TSLA', name: 'T', poolCents: 1000000, costPpm: 30, initialRunState: emptyState(10) })
    // yesterday's unresolved order
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-05', kind: 'buy_loc', bucketIdx: 0, limitPrice: 100n, shares: 1, status: 'open' }])
    // older order
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-03', kind: 'buy_loc', bucketIdx: 0, limitPrice: 100n, shares: 1, status: 'open' }])
    const sends: string[] = []
    const deps: DayDeps = {
      today: () => '2026-11-06',
      fetchLastClose: async () => ({ date: '2026-11-05', close: 3402300n }),
      crossCheck: async () => ({ agree: true }),
      send: async (_c, t) => { sends.push(t) },
      allowedChatIds: ['c1'],
      repos: f.repos,
      params: () => DEFAULT_MR_PARAMS,
      digestLang: 'en',
    }
    const r = await runMorningPipeline(deps)
    expect(r).toBe('sent')
    const digest = sends.find((s) => /unconfirmed/i.test(s))!
    const lines = digest.split('\n').filter((l) => /unconfirmed/i.test(l))
    expect(lines).toEqual(['⚠️ Unconfirmed orders from 2026-11-03: 1', '⚠️ Unconfirmed orders from 2026-11-05: 1'])
    // seeded orders now stale
    const staleCount = f.orders.filter((o) => o.status === 'stale').length
    expect(staleCount).toBe(2)
  })

  test('(g) reminder', async () => {
    const f = makeRepos()
    const sends: string[] = []
    const deps: DayDeps = {
      today: () => '2026-11-06',
      fetchLastClose: async () => ({ date: '2026-11-05', close: 3402300n }),
      crossCheck: async () => ({ agree: true }),
      send: async (_c, t) => { sends.push(t) },
      allowedChatIds: ['c1'],
      repos: f.repos,
      params: () => DEFAULT_MR_PARAMS,
      digestLang: 'en',
    }
    await runReminder(deps)
    expect(sends.length).toBe(1)
    expect(f.notifications.length).toBe(1)
    expect(f.notifications[0].runId).toBeNull()
    // holiday
    const f2 = makeRepos()
    const sends2: string[] = []
    const deps2: DayDeps = { ...deps, today: () => '2026-11-26', repos: f2.repos, send: async (_c, t) => { sends2.push(t) } }
    await runReminder(deps2)
    expect(sends2.length).toBe(0)
    expect(f2.notifications.length).toBe(0)
  })
})
