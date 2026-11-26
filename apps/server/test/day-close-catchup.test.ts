import { describe, test, expect, spyOn } from 'bun:test'
import { emptyState } from '@st/core'
import { DEFAULT_VR_SETTINGS } from '@st/strategies/value-rebalancing'
import { runMorningPipeline } from '../src/pipeline/day'
import { setup } from './vr-day-fixture'

type S = Awaited<ReturnType<typeof setup>>
type Status = 'paused' | 'closed'

const PREV = '2026-11-23'

async function mrRun(s: S, ticker: string, name: string, status: Status) {
  const id = await s.f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name, poolCents: 1_000_000, costPpm: 30, initialRunState: emptyState(10) })
  await s.f.repos.runRepo.updateStatus(id, status)
}

async function vrRun(s: S, ticker: string, name: string, status: Status) {
  const id = await s.f.repos.vrRunRepo.create({
    ...DEFAULT_VR_SETTINGS, ticker, name, costPpm: 0, initialVCents: 500_000, openingCashCents: 1_000_000, openedOn: '2026-11-20',
  })
  await s.f.repos.vrRunRepo.updateStatus(id, status)
}

interface Opts { today?: string; cc?: boolean; latest?: 'store' | 'throws' | 'absent'; extra?: (s: S) => Promise<void> }

// Active runs TSLA (MR) and TQQQ (VR); the extra runs are created last so every other run keeps its id.
async function morning(o: Opts = {}) {
  const s = await setup(
    { today: () => o.today ?? '2026-11-24', crossCheck: async () => ({ agree: o.cc ?? true }) },
    { mr: 'TSLA', vr: 'TQQQ', close: { date: PREV, close: 520_000n } },
  )
  s.deps.persistClose = async (tk, d, c) => {
    s.persisted.push([tk, d, c])
    await s.f.repos.priceHistoryRepo.upsertMany([{ ticker: tk, tradeDate: d, close: c }])
  }
  s.deps.fetchLastClose = async (tk) => {
    s.fetched.push(tk)
    if (tk === 'BAD') throw new Error('boom')
    return { date: PREV, close: 520_000n }
  }
  if (o.latest === 'throws') s.deps.latestStoredCloseDate = async () => { throw new Error('db') }
  else if (o.latest !== 'absent') {
    s.deps.latestStoredCloseDate = async (tk) => (await s.f.repos.priceHistoryRepo.listForTicker(tk)).at(-1)?.tradeDate ?? null
  }
  await o.extra?.(s)
  const result = await runMorningPipeline(s.deps)
  return { s, result }
}

const count = (s: S, tk: string) => s.fetched.filter((t) => t === tk).length
const stored = (s: S, tk: string) => s.persisted.filter(([t]) => t === tk)

describe('the morning close catch-up', () => {
  test('a paused MR run and a paused VR run get their last close stored', async () => {
    const { s } = await morning({ extra: async (s) => { await mrRun(s, 'SOXL', 'P1', 'paused'); await vrRun(s, 'NVDA', 'P2', 'paused') } })
    expect(count(s, 'SOXL')).toBe(1)
    expect(s.persisted).toContainEqual(['SOXL', PREV, 520_000n])
    expect(count(s, 'NVDA')).toBe(1)
    expect(s.persisted).toContainEqual(['NVDA', PREV, 520_000n])
  })

  test('a ticker the active runs just stored is not fetched a second time', async () => {
    const { s } = await morning()
    expect(count(s, 'TSLA')).toBe(1)
    expect(count(s, 'TQQQ')).toBe(1)
    expect(stored(s, 'TSLA')).toHaveLength(1)
    expect(stored(s, 'TQQQ')).toHaveLength(1)
  })

  test('an active run skipped as already planned today is caught up', async () => {
    const { s } = await morning({
      extra: async (s) => {
        await s.f.repos.orderRepo.insertMany([{ runId: 1, tradeDate: '2026-11-24', kind: 'buy_loc', bucketIdx: 0, limitPrice: 100_000n, shares: 1, status: 'open' }])
        await s.f.repos.priceHistoryRepo.upsertMany([{ ticker: 'TSLA', tradeDate: '2026-11-20', close: 500_000n }])
      },
    })
    expect(count(s, 'TSLA')).toBe(1)
    expect(s.persisted).toContainEqual(['TSLA', PREV, 520_000n])
  })

  test('two paused runs on one ticker are fetched once', async () => {
    const { s } = await morning({ extra: async (s) => { await mrRun(s, 'SOXL', 'P1', 'paused'); await vrRun(s, 'SOXL', 'P2', 'paused') } })
    expect(count(s, 'SOXL')).toBe(1)
    expect(stored(s, 'SOXL')).toHaveLength(1)
  })

  test('a closed run is never fetched', async () => {
    const { s } = await morning({ extra: async (s) => { await mrRun(s, 'CLSD', 'C1', 'closed'); await vrRun(s, 'CLSV', 'C2', 'closed') } })
    expect(count(s, 'CLSD')).toBe(0)
    expect(count(s, 'CLSV')).toBe(0)
  })

  test('a failing fetch for a paused ticker changes neither the result nor the messages, and the other ticker is stored', async () => {
    const withPaused = async (s: S) => { await vrRun(s, 'NVDA', 'P2', 'paused') }
    const base = await morning({ extra: withPaused })
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const bad = await morning({ extra: async (s) => { await withPaused(s); await mrRun(s, 'BAD', 'P3', 'paused') } })
      expect(bad.result).toBe(base.result)
      expect(bad.result).toBe('sent')
      expect(bad.s.sent).toEqual(base.s.sent)
      expect(err).toHaveBeenCalledWith('last close fetch failed:', 'BAD', 'Error: boom')
      expect(bad.s.persisted).toContainEqual(['NVDA', PREV, 520_000n])
      expect(count(bad.s, 'BAD')).toBe(1)
    } finally {
      err.mockRestore()
    }
  })

  test('a failing stored-date read is logged and changes nothing else', async () => {
    const paused = async (s: S) => { await mrRun(s, 'SOXL', 'P1', 'paused') }
    const without = await morning({ latest: 'absent', extra: paused })
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const thrown = await morning({ latest: 'throws', extra: paused })
      expect(thrown.result).toBe(without.result)
      expect(thrown.s.sent).toEqual(without.s.sent)
      expect(err).toHaveBeenCalledWith('close catch-up failed:', 'SOXL', 'Error: db')
      expect(count(thrown.s, 'SOXL')).toBe(0)
      expect(thrown.s.fetched).toEqual(without.s.fetched)
    } finally {
      err.mockRestore()
    }
  })

  test('a failing VR run list still lets the MR tickers be caught up', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { s, result } = await morning({
        extra: async (s) => {
          await mrRun(s, 'SOXL', 'P1', 'paused')
          s.f.repos.vrRunRepo.list = async () => { throw new Error('vr list down') }
        },
      })
      expect(result).toBe('sent')
      expect(count(s, 'SOXL')).toBe(1)
      expect(s.persisted).toContainEqual(['SOXL', PREV, 520_000n])
    } finally {
      err.mockRestore()
    }
  })

  test('nothing is fetched on a closed day', async () => {
    const { s, result } = await morning({ today: '2026-11-26', extra: async (s) => { await mrRun(s, 'SOXL', 'P1', 'paused') } })
    expect(result).toBe('closed')
    expect(count(s, 'SOXL')).toBe(0)
    expect(s.fetched).toEqual([])
  })

  test('nothing is fetched on a weekend', async () => {
    const { s, result } = await morning({ today: '2026-11-28', extra: async (s) => { await mrRun(s, 'SOXL', 'P1', 'paused') } })
    expect(result).toBe('weekend')
    expect(s.fetched).toEqual([])
  })

  test('nothing is fetched when the calendar cross-check conflicts', async () => {
    const { s, result } = await morning({ cc: false, extra: async (s) => { await mrRun(s, 'SOXL', 'P1', 'paused') } })
    expect(result).toBe('conflict')
    expect(count(s, 'SOXL')).toBe(0)
    expect(s.fetched).toEqual([])
  })

  test('without latestStoredCloseDate nothing is fetched for a paused ticker', async () => {
    const { s } = await morning({ latest: 'absent', extra: async (s) => { await mrRun(s, 'SOXL', 'P1', 'paused') } })
    expect(count(s, 'SOXL')).toBe(0)
    expect(stored(s, 'SOXL')).toEqual([])
  })

  test('with latestStoredCloseDate but no persistClose nothing is fetched for a paused ticker', async () => {
    const { s } = await morning({
      extra: async (s) => { await mrRun(s, 'SOXL', 'P1', 'paused'); delete s.deps.persistClose },
    })
    expect(count(s, 'SOXL')).toBe(0)
  })

  test('a ticker already stored for the previous trading day is not fetched', async () => {
    const { s } = await morning({
      extra: async (s) => {
        await mrRun(s, 'SOXL', 'P1', 'paused')
        await s.f.repos.priceHistoryRepo.upsertMany([{ ticker: 'SOXL', tradeDate: PREV, close: 510_000n }])
      },
    })
    expect(count(s, 'SOXL')).toBe(0)
  })
})
