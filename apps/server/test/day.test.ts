import { describe, test, expect, spyOn } from 'bun:test'
import { emptyState, type RunState } from '@st/core'
import { DEFAULT_MR_PARAMS } from '@st/strategies'
import { dayInfo } from '@st/calendar'
import type { DayDeps } from '../src/pipeline/day'
import { runMorningPipeline, runReminder } from '../src/pipeline/day'
import { recalcRunState } from '../src/domain/recompute'
import { withRunLock } from '../src/domain/run-lock'
import type { DayRepoSurface, NewNotification, NewOrder, NewRun, NotificationRow, OrderRecord, OrderStatus, RunRow, RunStatus } from '../src/domain/repo-types'
import { fakeCorrectionRepo } from './fake-corrections'
import { fakeRunRow, rehydrate, serializeState, FAKE_CREATED_AT } from './booking-fakes'
import type { Expect, IsNever, ArityMismatches } from './type-assert'

function makeRepos() {
  const runs: RunRow[] = []
  const orders: OrderRecord[] = []
  const notifications: NotificationRow[] = []
  let orderSeq = 1
  const runRepo = {
    async list() { return runs },
    async get(id: number) { return runs.find((r) => r.id === id) ?? null },
    async create(input: NewRun) { const id = runs.length + 1; runs.push(fakeRunRow(id, input)); return id },
    async updateStatus(id: number, s: RunStatus) { const r = runs.find((x) => x.id === id); if (r) r.status = s },
  }
  const bucketRepo = {
    async loadState(runId: number) { return rehydrate(JSON.parse(runs.find((x) => x.id === runId)!.stateJson)) },
    async saveState(runId: number, state: RunState) { runs.find((x) => x.id === runId)!.stateJson = serializeState(state) },
    // calls through the repo objects: the run-lock tests patch their methods
    async saveStateWithOrders(runId: number, state: RunState, os: NewOrder[]) {
      await orderRepo.insertMany(os)
      await bucketRepo.saveState(runId, state)
    },
  }
  const orderRepo = {
    async insertMany(os: NewOrder[]) { for (const o of os) orders.push({ id: orderSeq++, ...o, skipReason: null, cancelReason: null, reportedAt: null }) },
    async listForDate(d: string) { return orders.filter((o) => o.tradeDate === d) },
    async listForRun(runId: number, d?: string) { return orders.filter((o) => o.runId === runId && (d === undefined || o.tradeDate === d)) },
    async listForRunFrom(runId: number, fromDate: string) { return orders.filter((o) => o.runId === runId && o.tradeDate >= fromDate).sort((a, b) => a.id - b.id) },
    async get(id: number) { return orders.find((x) => x.id === id) ?? null },
    async markStale(d: string) { let c = 0; for (const o of orders) if (o.status === 'open' && o.tradeDate < d) { o.status = 'stale'; c++ } return c },
    async setStatus(id: number, s: OrderStatus, _cancelReason?: string) { const o = orders.find((x) => x.id === id); if (o) o.status = s },
    async listOpenBefore(d: string) { return orders.filter((o) => o.status === 'open' && o.tradeDate < d) },
    async listUnreportedStale(runId: number) { return orders.filter((o) => o.runId === runId && o.status === 'stale' && o.reportedAt === null).sort((a, b) => a.id - b.id) },
    async markReported(ids: number[]) { for (const o of orders) if (ids.includes(o.id)) o.reportedAt = FAKE_CREATED_AT },
  }
  const notificationRepo = {
    async insert(n: NewNotification) { notifications.push({ id: notifications.length + 1, sentAt: FAKE_CREATED_AT, ...n }) },
  }
  const repos = {
    runRepo, bucketRepo, orderRepo, notificationRepo, correctionRepo: fakeCorrectionRepo().repo,
    fillRepo: { insert: async (_fill) => {}, async listForRun(_runId) { return [] } },
    pendingRepo: { insert: async (_p) => 1, listPending: async () => [], hasLiveForCapture: async (_captureId) => false, hasConfirmedForCapture: async (_captureId) => false, decide: async (_id, _status, _edited) => false },
    captureRepo: { findByHash: async (_runId, _hash) => null, setStatus: async (_id, _status) => {}, insert: async (_c) => ({ inserted: true, id: 1 }) },
    captureImageRepo: { insertIgnore: async (_row) => true, getBytes: async (_captureId) => null, isKept: async (_captureId) => false, setKeep: async (_captureId) => {}, deleteFor: async (_captureId) => {}, discard: async (_captureId) => {}, listKept: async (_limit) => [] },
    visionReviewRepo: { insertIgnore: async (_row) => {}, listForCaptures: async (_captureIds) => [], deleteFor: async (_captureId) => {} },
    ledgerRepo: { insert: async (_l) => {}, listForRun: async (_runId) => [] },
  } satisfies DayRepoSurface
  return { repos, runs, orders, notifications }
}

type _day = Expect<IsNever<ArityMismatches<ReturnType<typeof makeRepos>['repos'], DayRepoSurface>>>

describe('day pipeline', () => {
  const WARN_EN = (id: number, tk: string) => `Market data error — run #${id} ${tk}: last close unavailable or stale. Today's orders for this run could not be computed.`

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
    expect(sends.some((s) => s.includes('unconfirmed orders from 2026-11-03'))).toBe(true)
    // count 2
    expect(sends.some((s) => s.includes('⚠️ 2 unconfirmed'))).toBe(true)
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
