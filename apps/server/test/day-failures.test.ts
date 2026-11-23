import { describe, test, expect, spyOn } from 'bun:test'
import { emptyState } from '@st/core'
import { DEFAULT_MR_PARAMS } from '@st/strategies'
import { runMorningPipeline, type DayDeps } from '../src/pipeline/day'
import { makeFakes } from './http-fakes'

// Two runs (1 TSLA 'T', 2 AAPL 'A'), each with one held bucket aged 3: a planned run gets 2 orders
// (buy_loc bucket 0, sell_loc bucket 1) and its age becomes 4.
async function setup(over: Partial<DayDeps> = {}) {
  const f = makeFakes()
  for (const ticker of ['TSLA', 'AAPL']) {
    const st = emptyState(10)
    st.buckets[1] = { index: 1, state: 'held', shares: 10, buyPrice: 3402300n, buyFeeCents: 0, filledOn: '2026-11-03' }
    st.ages[1] = 3
    st.cashCents = 1000000
    await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: ticker[0]!, poolCents: 1000000, costPpm: 30, initialRunState: st })
  }
  const sent: string[] = []
  const deps: DayDeps = {
    today: () => '2026-11-06',
    fetchLastClose: async () => ({ date: '2026-11-05', close: 3402300n }),
    crossCheck: async () => ({ agree: true }),
    send: async (_chatId, text) => { sent.push(text.split('\n')[0]!) },
    allowedChatIds: ['c1'],
    repos: f.repos,
    params: () => DEFAULT_MR_PARAMS,
    digestLang: 'en',
    ...over,
  }
  return { f, deps, sent }
}
type Fakes = ReturnType<typeof makeFakes>
const orderCount = (f: Fakes, runId: number) => f.orders.filter((o) => o.runId === runId).length
const age = async (f: Fakes, runId: number) => (await f.repos.bucketRepo.loadState(runId)).ages[1]
const RUN_ERR = (id: number, tk: string) => `Morning pipeline error — run #${id} ${tk}: today's orders could not be planned. Check this run's Orders tab in the web app; if today's orders are missing, run the morning pipeline again.`
const SKIP = (id: number, tk: string) => `ℹ️ Run #${id} ${tk}: today's orders were already planned, so this run was not planned again.`
const PIPE_ERR = 'Morning pipeline error — the pipeline stopped before any run was planned. Check the server log, then run the morning pipeline again.'
// Makes the plan write fail for the given runs; returns a function that undoes it.
function failPlanWrite(f: Fakes, runIds: number[]) {
  const real = f.repos.bucketRepo.saveStateWithOrders
  f.repos.bucketRepo.saveStateWithOrders = async (runId, state, orders) => {
    if (runIds.includes(runId)) throw new Error('db-down')
    await real(runId, state, orders)
  }
  return () => { f.repos.bucketRepo.saveStateWithOrders = real }
}

describe('one failing run never stops the others', () => {
  test('a run whose plan cannot be saved is reported and the next run is still planned', async () => {
    const { f, deps, sent } = await setup()
    failPlanWrite(f, [1])
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(orderCount(f, 1)).toBe(0)
      expect(await age(f, 1)).toBe(3)
      expect(orderCount(f, 2)).toBe(2)
      expect(await age(f, 2)).toBe(4)
      expect(sent).toEqual([RUN_ERR(1, 'TSLA'), 'A  AAPL'])
      expect(f.notifications[0]).toMatchObject({ runId: 1, chatId: 'c1', text: RUN_ERR(1, 'TSLA') })
      expect(errors).toHaveBeenCalledWith('morning run failed:', { runId: 1, ticker: 'TSLA' }, 'Error: db-down')
    } finally {
      errors.mockRestore()
    }
  })

  test('a run whose planning throws is reported the same way', async () => {
    const { f, deps, sent } = await setup({
      params: (run) => {
        if (run.id === 1) throw new Error('bad-params')
        return DEFAULT_MR_PARAMS
      },
    })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(orderCount(f, 1)).toBe(0)
      expect(orderCount(f, 2)).toBe(2)
      expect(sent).toEqual([RUN_ERR(1, 'TSLA'), 'A  AAPL'])
      expect(errors).toHaveBeenCalledWith('morning run failed:', { runId: 1, ticker: 'TSLA' }, 'Error: bad-params')
    } finally {
      errors.mockRestore()
    }
  })

  test('the warning is rendered in Korean', async () => {
    const { f, deps, sent } = await setup({ digestLang: 'ko' })
    failPlanWrite(f, [1])
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await runMorningPipeline(deps)
      expect(sent[0]).toBe('아침 파이프라인 오류 — 런 #1 TSLA: 오늘 주문을 계획하지 못했습니다. 웹 앱에서 이 런의 주문 탭을 확인하고, 오늘 주문이 없으면 아침 파이프라인을 다시 실행하세요.')
    } finally {
      errors.mockRestore()
    }
  })

  test('data-error only when every active run failed', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      {
        const { f, deps, sent } = await setup()
        failPlanWrite(f, [1, 2])
        expect(await runMorningPipeline(deps)).toBe('data-error')
        expect(sent).toEqual([RUN_ERR(1, 'TSLA'), RUN_ERR(2, 'AAPL')])
      }
      {
        const { f, deps } = await setup({
          fetchLastClose: async (ticker) => ({ date: ticker === 'TSLA' ? '2026-11-04' : '2026-11-05', close: 3402300n }),
        })
        failPlanWrite(f, [2])
        expect(await runMorningPipeline(deps)).toBe('data-error')
        expect(f.orders).toEqual([])
      }
    } finally {
      errors.mockRestore()
    }
  })
})

describe('the pipeline is safe to run again', () => {
  test('running again after a failure plans only the failed run', async () => {
    const { f, deps, sent } = await setup()
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const logs = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const undo = failPlanWrite(f, [1])
      await runMorningPipeline(deps)
      undo()
      sent.length = 0
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(orderCount(f, 1)).toBe(2)
      expect(await age(f, 1)).toBe(4)
      expect(orderCount(f, 2)).toBe(2)
      expect(await age(f, 2)).toBe(4)
      expect(sent).toEqual(['T  TSLA', SKIP(2, 'AAPL')])
      expect(f.notifications[f.notifications.length - 1]).toMatchObject({ runId: 2, chatId: 'c1', text: SKIP(2, 'AAPL') })
      expect(logs).toHaveBeenCalledWith('morning run skipped, already planned today:', { runId: 2, ticker: 'AAPL' })
    } finally {
      errors.mockRestore()
      logs.mockRestore()
    }
  })

  test('two pipelines at once plan each run once', async () => {
    const { f, deps, sent } = await setup()
    const logs = spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(await Promise.all([runMorningPipeline(deps), runMorningPipeline(deps)])).toEqual(['sent', 'sent'])
      expect(f.orders.length).toBe(4)
      expect(await age(f, 1)).toBe(4)
      expect(await age(f, 2)).toBe(4)
      expect([...sent].sort()).toEqual(['A  AAPL', 'T  TSLA', SKIP(1, 'TSLA'), SKIP(2, 'AAPL')].sort())
    } finally {
      logs.mockRestore()
    }
  })

  test('a pipeline run that skips every run returns sent and tells each run once', async () => {
    const { f, deps, sent } = await setup()
    const logs = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runMorningPipeline(deps)
      sent.length = 0
      const before = f.notifications.length
      const second = await runMorningPipeline({ ...deps, fetchLastClose: async () => { throw new Error('yahoo down') } })
      expect(second).toBe('sent')
      expect(sent).toEqual([SKIP(1, 'TSLA'), SKIP(2, 'AAPL')])
      expect(f.notifications.length).toBe(before + 2)
      expect(f.orders.length).toBe(4)
    } finally {
      logs.mockRestore()
    }
  })

  test('a skipped run counts as completed while another run fails', async () => {
    const { f, deps, sent } = await setup()
    failPlanWrite(f, [1])
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const logs = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runMorningPipeline(deps)
      sent.length = 0
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(sent).toEqual([RUN_ERR(1, 'TSLA'), SKIP(2, 'AAPL')])
    } finally {
      errors.mockRestore()
      logs.mockRestore()
    }
  })

  test('the skip notice is rendered in Korean and recorded for the web with no chat', async () => {
    const { f, deps } = await setup({ digestLang: 'ko', allowedChatIds: [] })
    const logs = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runMorningPipeline(deps)
      await runMorningPipeline(deps)
      expect(f.notifications.slice(-2).map((n) => [n.runId, n.chatId, n.text])).toEqual([
        [1, 'web', 'ℹ️ 런 #1 TSLA: 오늘 주문이 이미 계획되어 있어 다시 계획하지 않았습니다.'],
        [2, 'web', 'ℹ️ 런 #2 AAPL: 오늘 주문이 이미 계획되어 있어 다시 계획하지 않았습니다.'],
      ])
    } finally {
      logs.mockRestore()
    }
  })
})

describe('a failure outside any run', () => {
  test('a failing stale roll does not stop the morning', async () => {
    const { f, deps, sent } = await setup()
    f.repos.orderRepo.markStale = async () => { throw new Error('db-down') }
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(f.orders.length).toBe(4)
      expect(sent).toEqual(['T  TSLA', 'A  AAPL'])
      expect(errors).toHaveBeenCalledWith('stale roll failed:', 'Error: db-down')
    } finally {
      errors.mockRestore()
    }
  })

  test('a failure outside any run sends one global warning and rejects', async () => {
    const { f, deps, sent } = await setup()
    f.repos.runRepo.list = async () => { throw new Error('db-down') }
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(runMorningPipeline(deps)).rejects.toThrow('db-down')
      expect(sent).toEqual([PIPE_ERR])
      expect(f.notifications).toHaveLength(1)
      expect(f.notifications[0]).toMatchObject({ runId: null, chatId: 'c1', text: PIPE_ERR })
      expect(f.orders).toEqual([])
      expect(errors).toHaveBeenCalledWith('morning pipeline failed:', 'Error: db-down')
    } finally {
      errors.mockRestore()
    }
  })

  test('a throwing cross-check is reported the same way, on the web with no chat, in Korean', async () => {
    const { f, deps } = await setup({
      crossCheck: async () => { throw new Error('cc-down') },
      allowedChatIds: [],
      digestLang: 'ko',
    })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(runMorningPipeline(deps)).rejects.toThrow('cc-down')
      expect(f.notifications).toHaveLength(1)
      expect(f.notifications[0]).toMatchObject({
        runId: null,
        chatId: 'web',
        text: '아침 파이프라인 오류 — 런을 하나도 계획하지 못하고 중단되었습니다. 서버 로그를 확인한 뒤 아침 파이프라인을 다시 실행하세요.',
      })
    } finally {
      errors.mockRestore()
    }
  })

  test('a global warning that cannot be delivered does not mask the error', async () => {
    const { f, deps } = await setup({ send: async () => { throw new Error('also-down') } })
    f.repos.runRepo.list = async () => { throw new Error('db-down') }
    f.repos.notificationRepo.insert = async () => { throw new Error('also-down') }
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(runMorningPipeline(deps)).rejects.toThrow('db-down')
    } finally {
      errors.mockRestore()
    }
  })
})
