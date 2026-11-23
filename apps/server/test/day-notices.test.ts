import { describe, test, expect, spyOn } from 'bun:test'
import { emptyState } from '@st/core'
import { DEFAULT_MR_PARAMS } from '@st/strategies'
import { runDecemberNudge, runMorningPipeline, runReminder, type DayDeps } from '../src/pipeline/day'
import { makeFakes } from './http-fakes'

// Runs get ids 1, 2, ... and names 'T', 'A', so a digest's first line is 'T  TSLA' / 'A  AAPL'.
async function setup(over: Partial<DayDeps> = {}, tickers: string[] = ['TSLA', 'AAPL']) {
  const f = makeFakes()
  for (const ticker of tickers) {
    const st = emptyState(10)
    st.cashCents = 1000000
    await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: ticker[0]!, poolCents: 1000000, costPpm: 30, initialRunState: st })
  }
  const sent: { chatId: string; text: string }[] = []
  const deps: DayDeps = {
    today: () => '2026-11-06',
    fetchLastClose: async () => ({ date: '2026-11-05', close: 3402300n }),
    crossCheck: async () => ({ agree: true }),
    send: async (chatId, text) => { sent.push({ chatId, text }) },
    allowedChatIds: ['c1', 'c2'],
    repos: f.repos,
    params: () => DEFAULT_MR_PARAMS,
    digestLang: 'en',
    ...over,
  }
  return { f, deps, sent }
}
const head = (text: string) => text.split('\n')[0]
const rowsOf = (f: ReturnType<typeof makeFakes>) => f.notifications.map((n) => ({ runId: n.runId, chatId: n.chatId, text: n.text }))
const CONFLICT = 'Calendar conflict — local and remote calendars disagree. No orders today, please check manually'
const WARN = (id: number, tk: string) => `Market data error — run #${id} ${tk}: last close unavailable or stale. Today's orders for this run could not be computed.`

describe('pipeline notices survive a failing chat or insert', () => {
  test('a chat whose send fails does not hide the other chat or the next run', async () => {
    const sent: { chatId: string; text: string }[] = []
    const { f, deps } = await setup({
      send: async (chatId, text) => {
        if (chatId === 'c1') throw new Error('telegram-down')
        sent.push({ chatId, text })
      },
    })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(sent.map((s) => [s.chatId, head(s.text)])).toEqual([['c2', 'T  TSLA'], ['c2', 'A  AAPL']])
      expect(f.notifications.map((n) => [n.runId, n.chatId])).toEqual([[1, 'c1'], [1, 'c2'], [2, 'c1'], [2, 'c2']])
      expect(errors).toHaveBeenCalledWith('notice failed:', 'digest', { runId: 1, chatId: 'c1' }, 'Error: telegram-down')
    } finally {
      errors.mockRestore()
    }
  })

  test('a notification insert failing for one run does not stop the next run', async () => {
    const { f, deps, sent } = await setup()
    const orig = f.repos.notificationRepo.insert.bind(f.repos.notificationRepo)
    f.repos.notificationRepo.insert = async (n) => {
      if (n.runId === 1) throw new Error('db-down')
      return orig(n)
    }
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(new Set(f.orders.map((o) => o.runId))).toEqual(new Set([1, 2]))
      expect(sent.filter((s) => s.chatId === 'c1').map((s) => head(s.text))).toEqual(['T  TSLA', 'A  AAPL'])
      expect(f.notifications.map((n) => n.runId)).toEqual([2, 2])
    } finally {
      errors.mockRestore()
    }
  })

  test('a data-error warning that cannot be sent does not stop the next run', async () => {
    const { f, deps } = await setup({
      fetchLastClose: async (ticker) => ({ date: ticker === 'TSLA' ? '2026-11-04' : '2026-11-05', close: 3402300n }),
      send: async (_chatId, text) => {
        if (text.includes('Market data error')) throw new Error('telegram-down')
      },
    })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(f.orders.length > 0).toBe(true)
      expect(f.orders.every((o) => o.runId === 2)).toBe(true)
      expect(rowsOf(f).slice(0, 2)).toEqual([
        { runId: 1, chatId: 'c1', text: WARN(1, 'TSLA') },
        { runId: 1, chatId: 'c2', text: WARN(1, 'TSLA') },
      ])
    } finally {
      errors.mockRestore()
    }
  })

  test('a closed-day notice that no chat accepts still returns closed', async () => {
    const { f, deps } = await setup({
      today: () => '2026-11-26',
      send: async () => { throw new Error('telegram-down') },
    })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('closed')
      expect(rowsOf(f).map((r) => [r.chatId, r.text])).toEqual([
        ['c1', 'Market closed (Thanksgiving)'],
        ['c2', 'Market closed (Thanksgiving)'],
      ])
    } finally {
      errors.mockRestore()
    }
  })

  test('reminder and December nudge carry on past a failing chat', async () => {
    const sent: { chatId: string; text: string }[] = []
    const { f, deps } = await setup({
      send: async (chatId, text) => {
        if (chatId === 'c1') throw new Error('telegram-down')
        sent.push({ chatId, text })
      },
    })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await runReminder(deps)
      await runDecemberNudge(deps)
      expect(sent.map((s) => s.chatId)).toEqual(['c2', 'c2'])
      expect(f.notifications).toHaveLength(4)
    } finally {
      errors.mockRestore()
    }
  })
})

describe('reminder and December nudge report their failures', () => {
  test('failed counts the chats that did not take the notice', async () => {
    const { deps } = await setup({ send: async (chatId) => { if (chatId === 'c1') throw new Error('telegram-down') } })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runReminder(deps)).toEqual({ failed: 1 })
      expect(await runDecemberNudge(deps)).toEqual({ failed: 1 })
    } finally {
      errors.mockRestore()
    }
  })

  test('all delivered, or no reminder on a closed day: 0', async () => {
    const open = await setup()
    expect(await runReminder(open.deps)).toEqual({ failed: 0 })
    expect(await runDecemberNudge(open.deps)).toEqual({ failed: 0 })
    const closed = await setup({ today: () => '2026-11-26' })
    expect(await runReminder(closed.deps)).toEqual({ failed: 0 })
  })
})

describe('a digest longer than one message', () => {
  async function longSetup(over: Partial<DayDeps> = {}) {
    const s = await setup(over, [])
    const st = emptyState(120)
    for (let i = 0; i < 120; i++) {
      st.buckets[i] = { index: i, state: 'held', shares: 10, buyPrice: 3402300n, buyFeeCents: 0, filledOn: '2026-11-03' }
      st.ages[i] = 3
    }
    st.cashCents = 1000000
    await s.f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'TSLA', name: 'T', poolCents: 1000000, costPpm: 30, initialRunState: st })
    return s
  }

  test('is sent in parts and recorded once per chat', async () => {
    const { f, deps, sent } = await longSetup()
    expect(await runMorningPipeline(deps)).toBe('sent')
    const c1 = sent.filter((s) => s.chatId === 'c1').map((s) => s.text)
    expect(c1).toHaveLength(2)
    expect(c1.every((p) => p.length <= 4000)).toBe(true)
    expect(f.notifications.map((n) => [n.runId, n.chatId])).toEqual([[1, 'c1'], [1, 'c2']])
    expect(f.notifications[0]!.text).toBe(c1.join('\n\n'))
    expect(f.notifications[1]!.text).toBe(c1.join('\n\n'))
  })

  test('a part that cannot be sent does not stop the later part or the other chat', async () => {
    let c1Calls = 0
    const sent: { chatId: string; text: string }[] = []
    const { f, deps } = await longSetup({
      send: async (chatId, text) => {
        if (chatId === 'c1' && c1Calls++ === 0) throw new Error('telegram-down')
        sent.push({ chatId, text })
      },
    })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(sent.filter((s) => s.chatId === 'c1')).toHaveLength(1)
      expect(sent.filter((s) => s.chatId === 'c2')).toHaveLength(2)
      expect(f.notifications).toHaveLength(2)
      expect(errors).toHaveBeenCalledWith('notice failed:', 'digest', { runId: 1, chatId: 'c1', part: 1 }, 'Error: telegram-down')
    } finally {
      errors.mockRestore()
    }
  })
})

describe('with no Telegram chat every notice leaves one web row', () => {
  test('closed', async () => {
    const { f, deps, sent } = await setup({ allowedChatIds: [], today: () => '2026-11-26' })
    expect(await runMorningPipeline(deps)).toBe('closed')
    expect(sent).toEqual([])
    expect(rowsOf(f)).toEqual([{ runId: null, chatId: 'web', text: 'Market closed (Thanksgiving)' }])
  })

  test('conflict', async () => {
    const { f, deps, sent } = await setup({ allowedChatIds: [], crossCheck: async () => ({ agree: false }) })
    expect(await runMorningPipeline(deps)).toBe('conflict')
    expect(sent).toEqual([])
    expect(rowsOf(f)).toEqual([{ runId: null, chatId: 'web', text: CONFLICT }])
    expect(f.orders).toEqual([])
  })

  test('digest', async () => {
    const { f, deps, sent } = await setup({ allowedChatIds: [] }, ['TSLA'])
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(sent).toEqual([])
    expect(f.notifications.map((n) => [n.runId, n.chatId, head(n.text)])).toEqual([[1, 'web', 'T  TSLA']])
  })

  test('reminder', async () => {
    const { f, deps, sent } = await setup({ allowedChatIds: [] })
    await runReminder(deps)
    expect(sent).toEqual([])
    expect(rowsOf(f)).toEqual([{ runId: null, chatId: 'web', text: '16:05 fill capture reminder' }])
  })

  test('December nudge', async () => {
    const { f, deps, sent } = await setup({ allowedChatIds: [] })
    await runDecemberNudge(deps)
    expect(sent).toEqual([])
    expect(rowsOf(f)).toEqual([{ runId: null, chatId: 'web', text: "December — time to load next year's NYSE calendar" }])
  })
})
