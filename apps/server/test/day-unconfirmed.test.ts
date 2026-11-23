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
// Run 1: two orders left unresolved on 11-05 (+ one filled that day, one stale from 11-04: neither counts).
const seed = (f: Fakes, status: OrderStatus) => f.repos.orderRepo.insertMany([
  order(1, '2026-11-04', 'stale'), order(1, '2026-11-05', status, 1), order(1, '2026-11-05', status, 2), order(1, '2026-11-05', 'filled', 3),
])
const LINE = '⚠️ 2 unconfirmed orders from 2026-11-05'
const digestFor = (sent: string[], ticker: string) => sent.find((s) => s.includes(ticker) && !s.startsWith('ℹ️'))

describe('the unconfirmed orders line', () => {
  test('a normal morning reports the previous trading day\'s unresolved orders per run', async () => {
    const { f, deps, sent } = await setup()
    await seed(f, 'open')
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(digestFor(sent, 'TSLA')).toContain(LINE)
    expect(digestFor(sent, 'AAPL')).not.toContain('unconfirmed')
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
      expect(sent.filter((s) => s.includes('unconfirmed'))).toHaveLength(1)
    } finally {
      errors.mockRestore()
      logs.mockRestore()
    }
  })

  test('a failing stale roll still reports orders that are already stale', async () => {
    const { f, deps, sent } = await setup()
    await seed(f, 'stale')
    f.repos.orderRepo.listOpenBefore = async () => { throw new Error('db-down') }
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(digestFor(sent, 'TSLA')).toContain(LINE)
      expect(errors).toHaveBeenCalledWith('stale roll failed:', 'Error: db-down')
    } finally {
      errors.mockRestore()
    }
  })
})
