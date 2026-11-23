import { describe, test, expect, spyOn } from 'bun:test'
import { emptyState } from '@st/core'
import { DEFAULT_MR_PARAMS } from '@st/strategies'
import type { DayDeps } from '../src/pipeline/day'
import { runMorningPipeline } from '../src/pipeline/day'
import { makeRepos } from './day-fakes'

describe('day pipeline', () => {
  const WARN_EN = (id: number, tk: string) => `Market data error — run #${id} ${tk}: last close unavailable or stale. Today's orders for this run could not be computed.`

  test('(d) data-error', async () => {
    const f = makeRepos()
    await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'TSLA', name: 'T', poolCents: 1000000, costPpm: 30, initialRunState: emptyState(10) })
    const sends: string[] = []
    const deps: DayDeps = {
      today: () => '2026-11-06',
      fetchLastClose: async () => ({ date: '2026-11-04', close: 3402300n }),
      crossCheck: async () => ({ agree: true }),
      send: async (_c, t) => { sends.push(t) },
      allowedChatIds: ['c1'],
      repos: f.repos,
      params: () => DEFAULT_MR_PARAMS,
      digestLang: 'en',
    }
    const r = await runMorningPipeline(deps)
    expect(r).toBe('data-error')
    expect(sends.length).toBe(1)
    expect(sends[0]).toContain('Market data error')
    expect(f.orders.length).toBe(0)
    expect(sends).toEqual([WARN_EN(1, 'TSLA')])
    expect(f.notifications.map((n) => ({ runId: n.runId, chatId: n.chatId, text: n.text }))).toEqual([
      { runId: 1, chatId: 'c1', text: WARN_EN(1, 'TSLA') },
    ])
  })

  test('(d2) data-error on one run does not silence the other runs', async () => {
    const f = makeRepos()
    await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'BADA', name: 'A', poolCents: 1000000, costPpm: 30, initialRunState: emptyState(10) })
    const st = emptyState(10)
    st.cashCents = 1000000
    const okId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'B', poolCents: 1000000, costPpm: 30, initialRunState: st })
    const sends: string[] = []
    const deps: DayDeps = {
      today: () => '2026-11-06',
      fetchLastClose: async (tk: string) => {
        if (tk === 'BADA') throw new Error('yahoo down')
        return { date: '2026-11-05', close: 3402300n }
      },
      crossCheck: async () => ({ agree: true }),
      send: async (_c, t) => { sends.push(t) },
      allowedChatIds: ['c1'],
      repos: f.repos,
      params: () => DEFAULT_MR_PARAMS,
      digestLang: 'en',
    }
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await runMorningPipeline(deps)
      expect(r).toBe('sent')
      expect(err).toHaveBeenCalledWith('last close fetch failed:', 'BADA', 'Error: yahoo down')
    } finally {
      err.mockRestore()
    }
    const badId = f.runs.find((x) => x.ticker === 'BADA')!.id
    expect(f.orders.filter((o) => o.runId === badId).length).toBe(0)
    expect(f.orders.filter((o) => o.runId === okId).length).toBeGreaterThan(0)
    expect(sends.filter((s) => s.includes('Market data error'))).toHaveLength(1)
    expect(sends.length).toBeGreaterThan(1)
    const warnings = sends.filter((s) => s.includes('Market data error'))
    expect(warnings).toEqual([WARN_EN(badId, 'BADA')])
    expect(f.notifications.filter((n) => n.text.includes('Market data error')).map((n) => n.runId)).toEqual([badId])
  })

  test('(d3) every failed run gets its own named warning in every chat', async () => {
    const f = makeRepos()
    await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'BADA', name: 'A', poolCents: 1000000, costPpm: 30, initialRunState: emptyState(10) })
    await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'STAL', name: 'S', poolCents: 1000000, costPpm: 30, initialRunState: emptyState(10) })
    const st = emptyState(10)
    st.cashCents = 1000000
    await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'B', poolCents: 1000000, costPpm: 30, initialRunState: st })
    const sent: { chatId: string; text: string }[] = []
    const deps: DayDeps = {
      today: () => '2026-11-06',
      fetchLastClose: async (tk: string) => {
        if (tk === 'BADA') throw new Error('yahoo down')
        if (tk === 'STAL') return { date: '2026-11-04', close: 3402300n }
        return { date: '2026-11-05', close: 3402300n }
      },
      crossCheck: async () => ({ agree: true }),
      send: async (chatId, text) => { sent.push({ chatId, text }) },
      allowedChatIds: ['c1', 'c2'],
      repos: f.repos,
      params: () => DEFAULT_MR_PARAMS,
      digestLang: 'en',
    }
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await runMorningPipeline(deps)
      expect(r).toBe('sent')
      expect(err).toHaveBeenCalledWith('last close fetch failed:', 'BADA', 'Error: yahoo down')
    } finally {
      err.mockRestore()
    }
    const warns = sent.filter((s) => s.text.includes('Market data error'))
    expect(warns).toEqual([
      { chatId: 'c1', text: WARN_EN(1, 'BADA') },
      { chatId: 'c2', text: WARN_EN(1, 'BADA') },
      { chatId: 'c1', text: WARN_EN(2, 'STAL') },
      { chatId: 'c2', text: WARN_EN(2, 'STAL') },
    ])
    expect(f.notifications.filter((n) => n.text.includes('Market data error')).map((n) => ({ runId: n.runId, chatId: n.chatId, text: n.text }))).toEqual(
      warns.map((w, i) => ({ runId: i < 2 ? 1 : 2, chatId: w.chatId, text: w.text })),
    )
    expect(sent.some((s) => s.text.includes('AAPL') && !s.text.includes('Market data error'))).toBe(true)
  })

  test('(d5) data-error with no Telegram chat records a web-only row', async () => {
    const f = makeRepos()
    await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'TSLA', name: 'T', poolCents: 1000000, costPpm: 30, initialRunState: emptyState(10) })
    const sends: string[] = []
    const deps: DayDeps = {
      today: () => '2026-11-06',
      fetchLastClose: async () => ({ date: '2026-11-04', close: 3402300n }),
      crossCheck: async () => ({ agree: true }),
      send: async (_c, t) => { sends.push(t) },
      allowedChatIds: [],
      repos: f.repos,
      params: () => DEFAULT_MR_PARAMS,
      digestLang: 'en',
    }
    const r = await runMorningPipeline(deps)
    expect(r).toBe('data-error')
    expect(sends).toEqual([])
    expect(f.notifications.map((n) => ({ runId: n.runId, chatId: n.chatId, text: n.text }))).toEqual([
      { runId: 1, chatId: 'web', text: WARN_EN(1, 'TSLA') },
    ])
  })

  test('(d4) data-error warning in Korean', async () => {
    const f = makeRepos()
    await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'TSLA', name: 'T', poolCents: 1000000, costPpm: 30, initialRunState: emptyState(10) })
    const sends: string[] = []
    const deps: DayDeps = {
      today: () => '2026-11-06',
      fetchLastClose: async () => ({ date: '2026-11-04', close: 3402300n }),
      crossCheck: async () => ({ agree: true }),
      send: async (_c, t) => { sends.push(t) },
      allowedChatIds: ['c1'],
      repos: f.repos,
      params: () => DEFAULT_MR_PARAMS,
      digestLang: 'ko',
    }
    await runMorningPipeline(deps)
    expect(sends).toEqual(['시세 데이터 오류 — 런 #1 TSLA: 최근 종가를 가져올 수 없습니다. 오늘 런의 주문을 계산할 수 없습니다.'])
  })
})
