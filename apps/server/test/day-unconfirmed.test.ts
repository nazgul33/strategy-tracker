import { describe, test, expect, spyOn } from 'bun:test'
import { emptyState } from '@st/core'
import { DEFAULT_MR_PARAMS } from '@st/strategies'
import { runMorningPipeline, type DayDeps } from '../src/pipeline/day'
import type { NewOrder, OrderStatus } from '../src/domain/repo-types'
import { makeFakes } from './http-fakes'

// Two runs (1 TSLA, 2 AAPL), today 2026-11-06, previous trading day 2026-11-05. Each run
// is empty, so a planned run gets exactly one buy order; a digest is a single message.
async function setup() {
  const f = makeFakes()
  for (const ticker of ['TSLA', 'AAPL']) {
    const st = emptyState(10)
    st.cashCents = 1000000
    await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: ticker[0]!, poolCents: 1000000, costPpm: 30, initialRunState: st })
  }
  const sent: string[] = []
  const deps: DayDeps = {
    today: () => '2026-11-06',
    fetchLastClose: async () => ({ date: '2026-11-05', close: 3402300n }),
    crossCheck: async () => ({ agree: true }),
    send: async (_chatId, text) => { sent.push(text) },
    allowedChatIds: ['c1'],
    repos: f.repos,
    params: () => DEFAULT_MR_PARAMS,
    digestLang: 'en',
  }
  return { f, deps, sent }
}
type Fakes = ReturnType<typeof makeFakes>
const order = (runId: number, tradeDate: string, status: OrderStatus, bucketIdx = 0): NewOrder =>
  ({ runId, tradeDate, kind: 'buy_loc', bucketIdx, limitPrice: 100n, shares: 1, status })
// Run 1: two orders left unresolved on 11-05 (+ one filled that day, one stale from 11-04 already named in an earlier digest: neither counts).
const seed = async (f: Fakes, status: OrderStatus) => {
  await f.repos.orderRepo.insertMany([
    order(1, '2026-11-04', 'stale'), order(1, '2026-11-05', status, 1), order(1, '2026-11-05', status, 2), order(1, '2026-11-05', 'filled', 3),
  ])
  await f.repos.orderRepo.markReported([1])
}
// Monday 2026-11-09: the previous trading day is Friday 2026-11-06. Each run's 11-06 buy order is still open, so it rolls stale.
const nextMorning = (deps: DayDeps, sent: string[]) => {
  deps.today = () => '2026-11-09'
  deps.fetchLastClose = async () => ({ date: '2026-11-06', close: 3402300n })
  sent.length = 0
}
const reported = (f: Fakes) => f.orders.map((o) => o.reportedAt !== null)
// Makes run 1's plan write fail; returns a function that undoes it.
function failRun1(f: Fakes) {
  const real = f.repos.bucketRepo.saveStateWithOrders
  f.repos.bucketRepo.saveStateWithOrders = async (runId, state, orders) => {
    if (runId === 1) throw new Error('db-down')
    await real(runId, state, orders)
  }
  return () => { f.repos.bucketRepo.saveStateWithOrders = real }
}
const LINE = '⚠️ Unconfirmed orders from 2026-11-05: 2'
const digestFor = (sent: string[], ticker: string) => sent.find((s) => s.includes(ticker) && !s.startsWith('ℹ️'))
const unconfirmedLines = (digest: string | undefined) => (digest ?? '').split('\n').filter((l) => l.startsWith('⚠️ ') && /unconfirmed|미확인/i.test(l))

describe('the unconfirmed orders line', () => {
  test('a normal morning reports the previous trading day\'s unresolved orders per run', async () => {
    const { f, deps, sent } = await setup()
    await seed(f, 'open')
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(digestFor(sent, 'TSLA')).toContain(LINE)
    expect(digestFor(sent, 'AAPL')).not.toMatch(/unconfirmed/i)
    expect(f.orders.filter((o) => o.status === 'stale').map((o) => o.id)).toEqual([1, 2, 3])
  })

  test('a run planned on a retry still carries the line, and the healthy run is skipped', async () => {
    const { f, deps, sent } = await setup()
    await seed(f, 'open')
    const real = f.repos.bucketRepo.saveStateWithOrders
    f.repos.bucketRepo.saveStateWithOrders = async (runId, state, orders) => {
      if (runId === 1) throw new Error('db-down')
      await real(runId, state, orders)
    }
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const logs = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runMorningPipeline(deps)
      f.repos.bucketRepo.saveStateWithOrders = real
      sent.length = 0
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(digestFor(sent, 'TSLA')).toContain(LINE)
      expect(sent.some((s) => s.startsWith('ℹ️ Run #2 AAPL'))).toBe(true)
      expect(sent.filter((s) => /unconfirmed/i.test(s))).toHaveLength(1)
    } finally {
      errors.mockRestore()
      logs.mockRestore()
    }
  })

  test('a failing stale roll still reports orders that are already stale', async () => {
    const { f, deps, sent } = await setup()
    await seed(f, 'stale')
    f.repos.orderRepo.markStale = async () => { throw new Error('db-down') }
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(digestFor(sent, 'TSLA')).toContain(LINE)
      expect(errors).toHaveBeenCalledWith('stale roll failed:', 'Error: db-down')
    } finally {
      errors.mockRestore()
    }
  })

  test('orders named in a recorded digest are marked and not named again the next morning', async () => {
    const { f, deps, sent } = await setup()
    await seed(f, 'open')
    await runMorningPipeline(deps)
    expect(reported(f).slice(0, 4)).toEqual([true, true, true, false])
    nextMorning(deps, sent)
    await runMorningPipeline(deps)
    expect(digestFor(sent, 'TSLA')).toContain('⚠️ Unconfirmed orders from 2026-11-06: 1')
    expect(digestFor(sent, 'TSLA')).not.toContain('2026-11-05')
    expect(digestFor(sent, 'AAPL')).toContain('⚠️ Unconfirmed orders from 2026-11-06: 1')
  })

  test('after an earlier failed roll and a failed run, the retry names every unreported order (#91)', async () => {
    const { f, deps, sent } = await setup()
    await f.repos.orderRepo.insertMany([order(1, '2026-11-04', 'open'), order(1, '2026-11-05', 'open', 1), order(1, '2026-11-05', 'open', 2)])
    const undo = failRun1(f)
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const logs = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runMorningPipeline(deps)
      undo()
      expect(f.orders.slice(0, 3).map((o) => [o.status, o.reportedAt])).toEqual([['stale', null], ['stale', null], ['stale', null]])
      sent.length = 0
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(unconfirmedLines(digestFor(sent, 'TSLA'))).toEqual(['⚠️ Unconfirmed orders from 2026-11-04: 1', '⚠️ Unconfirmed orders from 2026-11-05: 2'])
      expect(reported(f).slice(0, 3)).toEqual([true, true, true])
    } finally {
      errors.mockRestore()
      logs.mockRestore()
    }
  })

  test('several dates give one line each, oldest first', async () => {
    const { f, deps, sent } = await setup()
    await f.repos.orderRepo.insertMany([
      order(1, '2026-11-05', 'open', 0), order(1, '2026-11-05', 'open', 1), order(1, '2026-11-03', 'open', 2), order(1, '2026-11-04', 'open', 3),
    ])
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(unconfirmedLines(digestFor(sent, 'TSLA'))).toEqual([
      '⚠️ Unconfirmed orders from 2026-11-03: 1', '⚠️ Unconfirmed orders from 2026-11-04: 1', '⚠️ Unconfirmed orders from 2026-11-05: 2',
    ])
    expect(reported(f).slice(0, 4)).toEqual([true, true, true, true])
  })

  test('the Korean digest renders one line per date', async () => {
    const { f, deps, sent } = await setup()
    deps.digestLang = 'ko'
    await f.repos.orderRepo.insertMany([order(1, '2026-11-05', 'open', 0), order(1, '2026-11-04', 'open', 1), order(1, '2026-11-05', 'open', 2)])
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(unconfirmedLines(digestFor(sent, 'TSLA'))).toEqual(['⚠️ 2026-11-04 미확인 주문 1건', '⚠️ 2026-11-05 미확인 주문 2건'])
  })

  test('with no Telegram chat the web row counts: the orders are marked', async () => {
    const { f, deps } = await setup()
    deps.allowedChatIds = []
    await seed(f, 'open')
    await runMorningPipeline(deps)
    expect(f.notifications.find((n) => n.runId === 1)!.chatId).toBe('web')
    expect(reported(f).slice(1, 3)).toEqual([true, true])
  })

  test('a digest every chat refused is still recorded: the orders are marked', async () => {
    const { f, deps } = await setup()
    deps.send = async () => { throw new Error('telegram-down') }
    await seed(f, 'open')
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(reported(f).slice(1, 3)).toEqual([true, true])
    } finally {
      errors.mockRestore()
    }
  })

  test('a digest that could not be recorded leaves the orders unreported; they are named again the next morning', async () => {
    const { f, deps, sent } = await setup()
    await seed(f, 'open')
    const insert = f.repos.notificationRepo.insert
    f.repos.notificationRepo.insert = async () => { throw new Error('db-down') }
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(reported(f).slice(1, 3)).toEqual([false, false])
      f.repos.notificationRepo.insert = insert
      nextMorning(deps, sent)
      await runMorningPipeline(deps)
      expect(unconfirmedLines(digestFor(sent, 'TSLA'))).toEqual(['⚠️ Unconfirmed orders from 2026-11-05: 2', '⚠️ Unconfirmed orders from 2026-11-06: 1'])
    } finally {
      f.repos.notificationRepo.insert = insert
      errors.mockRestore()
    }
  })

  test('a failed mark is logged, the run still completes, and the orders are named again the next morning', async () => {
    const { f, deps, sent } = await setup()
    await seed(f, 'open')
    const mark = f.repos.orderRepo.markReported
    f.repos.orderRepo.markReported = async () => { throw new Error('db-down') }
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(errors).toHaveBeenCalledWith('mark reported failed:', { runId: 1, ticker: 'TSLA' }, 'Error: db-down')
      expect(sent.some((s) => s.startsWith('Morning pipeline error'))).toBe(false)
      expect(f.orders.filter((o) => o.tradeDate === '2026-11-06')).toHaveLength(2)
      expect(reported(f).slice(1, 3)).toEqual([false, false])
      f.repos.orderRepo.markReported = mark
      nextMorning(deps, sent)
      await runMorningPipeline(deps)
      expect(unconfirmedLines(digestFor(sent, 'TSLA'))).toEqual(['⚠️ Unconfirmed orders from 2026-11-05: 2', '⚠️ Unconfirmed orders from 2026-11-06: 1'])
    } finally {
      f.repos.orderRepo.markReported = mark
      errors.mockRestore()
    }
  })

  test('a run with nothing unconfirmed writes no mark', async () => {
    const { f, deps } = await setup()
    const calls: number[][] = []
    const mark = f.repos.orderRepo.markReported
    f.repos.orderRepo.markReported = async (ids) => { calls.push(ids); await mark(ids) }
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(calls).toEqual([])
  })
})
