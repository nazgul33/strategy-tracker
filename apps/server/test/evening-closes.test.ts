import { describe, test, expect, spyOn } from 'bun:test'
import { emptyState } from '@st/core'
import { DEFAULT_VR_SETTINGS } from '@st/strategies/value-rebalancing'
import { fetchClose } from '../src/pipeline/close'
import { runMorningPipeline } from '../src/pipeline/day'
import { runEveningCloses } from '../src/pipeline/evening-closes'
import { setup } from './vr-day-fixture'

type S = Awaited<ReturnType<typeof setup>>
type Status = 'active' | 'paused' | 'closed'

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

interface Opts {
  today?: string
  at?: string
  answers?: Record<string, string | 'throw'>
  wire?: 'both' | 'no-latest' | 'no-persist'
  extra?: (s: S) => Promise<void>
}

// Active runs TSLA (MR) and TQQQ (VR); the extra runs are created last so every other run keeps its id.
async function setupEvening(o: Opts = {}) {
  const today = o.today ?? '2026-11-24'
  const s = await setup({ today: () => today, now: () => new Date(o.at ?? `${today}T22:00:00Z`) }, { mr: 'TSLA', vr: 'TQQQ' })
  s.deps.persistClose = async (tk, d, c) => {
    s.persisted.push([tk, d, c])
    await s.f.repos.priceHistoryRepo.upsertMany([{ ticker: tk, tradeDate: d, close: c }])
  }
  s.deps.latestStoredCloseDate = async (tk) => (await s.f.repos.priceHistoryRepo.listForTicker(tk)).at(-1)?.tradeDate ?? null
  s.deps.fetchLastClose = async (tk) => {
    s.fetched.push(tk)
    const a = o.answers?.[tk] ?? today
    if (a === 'throw') throw new Error('boom')
    return { date: a, close: 520_000n }
  }
  await o.extra?.(s)
  if (o.wire === 'no-latest') delete s.deps.latestStoredCloseDate
  if (o.wire === 'no-persist') delete s.deps.persistClose
  return s
}

async function evening(o: Opts = {}) {
  const s = await setupEvening(o)
  return { s, result: await runEveningCloses(s.deps) }
}

const count = (s: S, tk: string) => s.fetched.filter((t) => t === tk).length
const snap = (s: S) =>
  JSON.stringify([s.f.runs, [...s.f.states], s.f.orders, s.f.vr.runs, s.f.vr.cycles, s.f.vr.fills, s.f.vr.cash, s.f.vr.pending, s.f.notifications], (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
const quiet = () => spyOn(console, 'error').mockImplementation(() => {})

describe('the evening close job', () => {
  test('active and paused runs of both strategies get today\'s close stored, invisibly', async () => {
    const s = await setupEvening({ extra: async (s) => { await mrRun(s, 'SOXL', 'P1', 'paused'); await vrRun(s, 'NVDA', 'P2', 'paused') } })
    const before = snap(s)
    expect(await runEveningCloses(s.deps)).toEqual({ stored: 4, behind: 0 })
    expect([...s.persisted].sort()).toEqual(
      [['NVDA', '2026-11-24', 520_000n], ['SOXL', '2026-11-24', 520_000n], ['TQQQ', '2026-11-24', 520_000n], ['TSLA', '2026-11-24', 520_000n]],
    )
    expect(s.sent).toEqual([])
    expect(s.f.orders).toEqual([])
    expect(s.f.vr.cycles).toEqual([])
    expect(snap(s)).toBe(before)
  })

  test('two runs on one ticker are fetched once; a closed run is never fetched', async () => {
    const { s } = await evening({
      extra: async (s) => {
        await mrRun(s, 'SOXL', 'P1', 'paused'); await vrRun(s, 'SOXL', 'P2', 'paused')
        await mrRun(s, 'CLSD', 'C1', 'closed'); await vrRun(s, 'CLSV', 'C2', 'closed')
      },
    })
    expect(count(s, 'SOXL')).toBe(1)
    expect(s.persisted.filter(([t]) => t === 'SOXL')).toHaveLength(1)
    expect(count(s, 'CLSD')).toBe(0)
    expect(count(s, 'CLSV')).toBe(0)
  })

  test('a ticker already stored for today is not fetched', async () => {
    const { s, result } = await evening({
      extra: async (s) => { await s.f.repos.priceHistoryRepo.upsertMany([{ ticker: 'TSLA', tradeDate: '2026-11-24', close: 510_000n }]) },
    })
    expect(count(s, 'TSLA')).toBe(0)
    expect(count(s, 'TQQQ')).toBe(1)
    expect(result).toEqual({ stored: 1, behind: 0 })
  })

  test('a source that still answers yesterday stores nothing for that ticker, is logged once, and the others are stored', async () => {
    const err = quiet()
    try {
      const { s, result } = await evening({ answers: { TQQQ: '2026-11-23' } })
      expect(s.persisted.filter(([t]) => t === 'TQQQ')).toEqual([])
      expect(err.mock.calls.filter((c) => c.includes('TQQQ'))).toEqual([['evening closes stored nothing:', 'TQQQ']])
      expect(result).toEqual({ stored: 1, behind: 1 })
      expect(s.persisted).toEqual([['TSLA', '2026-11-24', 520_000n]])
    } finally {
      err.mockRestore()
    }
  })

  test('a throwing source is logged, the others are stored and nothing is thrown', async () => {
    const err = quiet()
    try {
      const { s, result } = await evening({ answers: { BAD: 'throw' }, extra: async (s) => { await mrRun(s, 'BAD', 'P3', 'paused') } })
      expect(result).toEqual({ stored: 2, behind: 1 })
      expect(err.mock.calls).toEqual([['last close fetch failed:', 'BAD', 'Error: boom'], ['evening closes stored nothing:', 'BAD']])
      expect(s.persisted.map(([t]) => t).sort()).toEqual(['TQQQ', 'TSLA'])
    } finally {
      err.mockRestore()
    }
  })

  test('a close that could not be persisted is counted as behind, not stored, and logged once by the job', async () => {
    const err = quiet()
    try {
      const s = await setupEvening()
      const persist = s.deps.persistClose!
      s.deps.persistClose = async (tk, d, c) => { if (tk === 'TQQQ') throw new Error('disk full'); await persist(tk, d, c) }
      expect(await runEveningCloses(s.deps)).toEqual({ stored: 1, behind: 1 })
      expect(err.mock.calls.filter((c) => String(c[0]).startsWith('evening closes'))).toEqual([['evening closes stored nothing:', 'TQQQ']])
      expect(err).toHaveBeenCalledWith('price history persist failed:', 'TQQQ', 'Error: disk full')
      expect(s.persisted).toEqual([['TSLA', '2026-11-24', 520_000n]])
    } finally {
      err.mockRestore()
    }
  })

  test('a second run on the same evening after a clean first run fetches nothing', async () => {
    const s = await setupEvening()
    expect(await runEveningCloses(s.deps)).toEqual({ stored: 2, behind: 0 })
    s.fetched.length = 0
    expect(await runEveningCloses(s.deps)).toEqual({ stored: 0, behind: 0 })
    expect(s.fetched).toEqual([])
  })

  test('a second run after a first run that could not store one ticker fetches only that ticker', async () => {
    const err = quiet()
    try {
      const s = await setupEvening({ answers: { TQQQ: '2026-11-23' } })
      expect(await runEveningCloses(s.deps)).toEqual({ stored: 1, behind: 1 })
      s.fetched.length = 0
      s.deps.fetchLastClose = async (tk) => { s.fetched.push(tk); return { date: '2026-11-24', close: 530_000n } }
      expect(await runEveningCloses(s.deps)).toEqual({ stored: 1, behind: 0 })
      expect(s.fetched).toEqual(['TQQQ'])
      expect(s.persisted.map(([t]) => t).sort()).toEqual(['TQQQ', 'TSLA'])
    } finally {
      err.mockRestore()
    }
  })

  test('with an injected clock the New York date and time come from that one instant', async () => {
    const s = await setupEvening({ today: '2026-11-24' })
    s.deps.today = () => '2026-11-25'
    expect(await runEveningCloses(s.deps)).toEqual({ stored: 2, behind: 0 })
    expect(s.persisted.map(([, d]) => d)).toEqual(['2026-11-24', '2026-11-24'])
  })

  test('a failing stored-date read is logged and never thrown', async () => {
    const err = quiet()
    try {
      const s = await setupEvening()
      s.deps.latestStoredCloseDate = async () => { throw new Error('db') }
      expect(await runEveningCloses(s.deps)).toEqual({ stored: 0, behind: 2 })
      expect(err).toHaveBeenCalledWith('evening closes failed:', 'TSLA', 'Error: db')
      expect(s.fetched).toEqual([])
    } finally {
      err.mockRestore()
    }
  })

  test('a failing run list is logged and never thrown', async () => {
    const err = quiet()
    try {
      const s = await setupEvening({ extra: async (s) => { s.f.repos.runRepo.list = async () => { throw new Error('mr list down') } } })
      expect(await runEveningCloses(s.deps)).toEqual({ stored: 1, behind: 0 })
      expect(count(s, 'TQQQ')).toBe(1)
      expect(err).toHaveBeenCalledWith('evening closes: run list failed:', 'MR', 'Error: mr list down')
    } finally {
      err.mockRestore()
    }
  })

  test('a closed day and a Saturday are closed: no fetch', async () => {
    for (const today of ['2026-11-26', '2026-11-28']) {
      const { s, result } = await evening({ today })
      expect(result).toBe('closed')
      expect(s.fetched).toEqual([])
      expect(s.persisted).toEqual([])
    }
  })

  test('the half day stores closes dated that day', async () => {
    const { s, result } = await evening({ today: '2026-11-27' })
    expect(result).toEqual({ stored: 2, behind: 0 })
    expect(s.persisted.map(([, d]) => d)).toEqual(['2026-11-27', '2026-11-27'])
  })

  test('before 16:30 New York nothing is fetched or stored; from 16:30 it runs', async () => {
    for (const at of ['2026-11-24T20:00:00Z', '2026-11-24T21:29:00Z']) {
      const { s, result } = await evening({ at })
      expect(result).toBe('too-early')
      expect(s.fetched).toEqual([])
      expect(s.persisted).toEqual([])
    }
    const { s, result } = await evening({ at: '2026-11-24T21:30:00Z' })
    expect(result).toEqual({ stored: 2, behind: 0 })
    expect(s.persisted).toHaveLength(2)
  })

  test('just after midnight New York it is too early, even though the date is a trading day', async () => {
    const { s, result } = await evening({ today: '2026-11-25', at: '2026-11-25T05:00:00Z' })
    expect(result).toBe('too-early')
    expect(s.fetched).toEqual([])
  })

  test('without latestStoredCloseDate or without persistClose nothing is fetched', async () => {
    for (const wire of ['no-latest', 'no-persist'] as const) {
      const { s, result } = await evening({ wire })
      expect(result).toEqual({ stored: 0, behind: 0 })
      expect(s.fetched).toEqual([])
    }
  })

  test('the next morning is as it would be without the evening job, and the catch-up fetches nothing for paused tickers', async () => {
    const paused = async (s: S) => { await mrRun(s, 'SOXL', 'P1', 'paused'); await vrRun(s, 'NVDA', 'P2', 'paused') }
    const morning = async (s: S) => {
      s.deps.today = () => '2026-11-25'
      s.deps.now = () => new Date('2026-11-25T12:30:00Z')
      s.deps.crossCheck = async () => ({ agree: true })
      s.deps.fetchLastClose = async (tk) => { s.fetched.push(tk); return { date: '2026-11-24', close: 521_000n } }
      s.fetched.length = 0
      return runMorningPipeline(s.deps)
    }
    const a = await setupEvening({ extra: paused })
    expect(await runEveningCloses(a.deps)).toEqual({ stored: 4, behind: 0 })
    const resultA = await morning(a)
    const b = await setupEvening({ extra: paused })
    const resultB = await morning(b)

    expect(resultA).toBe(resultB)
    expect(a.sent).toEqual(b.sent)
    expect(count(a, 'SOXL')).toBe(0)
    expect(count(a, 'NVDA')).toBe(0)
    const last = async (s: S, tk: string) => (await s.f.repos.priceHistoryRepo.listForTicker(tk)).filter((r) => r.tradeDate === '2026-11-24').map((r) => r.close)
    expect(await last(a, 'TSLA')).toEqual([521_000n])
    expect(await last(a, 'TQQQ')).toEqual([521_000n])
    expect(await last(a, 'SOXL')).toEqual([520_000n])
  })
})

describe('fetchClose with an expected date', () => {
  const deps = async (date: string) => {
    const s = await setup({ fetchLastClose: async () => ({ date, close: 530_000n }) }, { vr: null })
    return s
  }

  test('a close dated the expected date is stored and returned', async () => {
    const s = await deps('2026-11-24')
    expect(await fetchClose(s.deps, 'X', '2026-11-24', '2026-11-24')).toEqual({ close: 530_000n, closeDate: '2026-11-24' })
    expect(s.persisted).toEqual([['X', '2026-11-24', 530_000n]])
  })

  test('a close dated otherwise is not stored and returns null', async () => {
    const s = await deps('2026-11-23')
    expect(await fetchClose(s.deps, 'X', '2026-11-24', '2026-11-24')).toBeNull()
    expect(s.persisted).toEqual([])
  })

  test('without the argument the previous trading day is expected, as before', async () => {
    const s = await deps('2026-11-23')
    expect(await fetchClose(s.deps, 'X', '2026-11-24')).toEqual({ close: 530_000n, closeDate: '2026-11-23' })
    expect(s.persisted).toEqual([['X', '2026-11-23', 530_000n]])
    const t = await deps('2026-11-24')
    expect(await fetchClose(t.deps, 'X', '2026-11-24')).toBeNull()
  })
})
