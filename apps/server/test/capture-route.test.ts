import { describe, test, expect } from 'bun:test'
import type { NewPending } from '../src/domain/repo-types'
import { makeCaptureRouting, type CaptureEvent } from '../src/wire/capture-route'
import { activeRun, makeCaptureFakes, multiVisionFetch, PNG_B64, visionFetch, type FakeOpts } from './wire-capture-fakes'

function routing(opts: FakeOpts & { fetchImpl?: typeof fetch } = {}) {
  const fakes = makeCaptureFakes(opts)
  const inner = opts.fetchImpl ?? visionFetch
  let visionCalls = 0
  const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
    visionCalls++
    return inner(...args)
  }) as unknown as typeof fetch
  const route = makeCaptureRouting({
    repos: fakes.repos,
    vision: { baseUrl: 'https://vision.example/v1', model: 'vision-model' },
    getVisionApiKey: async () => 'k',
    today: () => '2026-11-10',
    fetchImpl,
  })
  const events: CaptureEvent[] = []
  const run = (pinnedRunId: number | null) =>
    route({ image: { base64: PNG_B64, mime: 'image/png' }, pinnedRunId }, async (e) => { events.push(e) })
  return { ...fakes, events, run, visionCalls: () => visionCalls }
}

const vision500 = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch

describe('capture routing core', () => {
  test('unknown pinned run: one unknown-run event, no vision call', async () => {
    const r = routing({ runs: [activeRun(1, 'NVDA')] })
    await r.run(42)
    expect(r.events).toEqual([{ type: 'unknown-run', id: 42 }])
    expect(r.visionCalls()).toBe(0)
    expect(r.captures.length).toBe(0)
  })

  test("vision failure is a bad-extract with the extractor's detail", async () => {
    const r = routing({ runs: [activeRun(1, 'NVDA')], fetchImpl: vision500 })
    await r.run(null)
    expect(r.events).toEqual([{ type: 'bad-extract', detail: 'http 500' }])
    expect(r.captures.length).toBe(0)
  })

  test('a pinned paused run books its own ticker', async () => {
    const r = routing({ runs: [{ ...activeRun(7, 'NVDA'), status: 'paused' }] })
    await r.run(7)
    expect(r.events).toHaveLength(1)
    expect(r.events[0]).toMatchObject({
      type: 'outcome',
      runId: 7,
      ticker: 'NVDA',
      outcome: { pending: [{ runId: 7, ticker: 'NVDA', side: 'buy', shares: 10, price: '180.50', filledOn: '2026-11-10', needsBucket: false, dateAfterToday: false }] },
    })
  })

  test('a pinned run with no fill of its ticker', async () => {
    const r = routing({ runs: [activeRun(1, 'NVDA'), activeRun(3, 'AAPL')] })
    await r.run(3)
    expect(r.events).toEqual([{ type: 'pin-nomatch', runId: 3, ticker: 'AAPL' }])
  })

  test('a pinned run reports foreign tickers before its outcome', async () => {
    const r = routing({ runs: [activeRun(1, 'NVDA')], fetchImpl: multiVisionFetch })
    await r.run(1)
    expect(r.events.map((e) => e.type)).toEqual(['pin-skipped', 'outcome'])
    expect(r.events[0]).toEqual({ type: 'pin-skipped', runId: 1, tickers: ['AAPL'] })
  })

  test('auto-route: one outcome per ticker group, in fill order', async () => {
    const r = routing({ runs: [activeRun(1, 'NVDA'), activeRun(2, 'AAPL')], fetchImpl: multiVisionFetch })
    await r.run(null)
    expect(r.events.map((e) => [e.type, 'ticker' in e ? e.ticker : null])).toEqual([['outcome', 'NVDA'], ['outcome', 'AAPL']])
  })

  test('auto-route: no-run and ambiguous do not stop the other group', async () => {
    const one = routing({ runs: [activeRun(1, 'NVDA')], fetchImpl: multiVisionFetch })
    await one.run(null)
    expect(one.events.map((e) => e.type)).toEqual(['outcome', 'no-run'])
    expect(one.events[1]).toEqual({ type: 'no-run', ticker: 'AAPL' })

    const three = routing({ runs: [activeRun(1, 'NVDA'), activeRun(2, 'AAPL'), activeRun(3, 'AAPL')], fetchImpl: multiVisionFetch })
    await three.run(null)
    expect(three.events.map((e) => e.type)).toEqual(['outcome', 'ambiguous'])
    expect(three.events[1]).toEqual({ type: 'ambiguous', ticker: 'AAPL' })
  })

  test('auto-route considers active runs only', async () => {
    const r = routing({ runs: [{ ...activeRun(1, 'NVDA'), status: 'paused' }] })
    await r.run(null)
    expect(r.events).toEqual([{ type: 'no-run', ticker: 'NVDA' }])
  })

  test('the same image twice is a duplicate outcome', async () => {
    const r = routing({ runs: [activeRun(1, 'NVDA')] })
    await r.run(null)
    await r.run(null)
    expect(r.events[1]).toEqual({ type: 'outcome', runId: 1, ticker: 'NVDA', outcome: 'duplicate' })
  })

  test("a throw in the second ticker group leaves the first group's event delivered", async () => {
    const r = routing({ runs: [activeRun(1, 'NVDA'), activeRun(2, 'AAPL')], fetchImpl: multiVisionFetch })
    const insert = r.repos.pendingRepo.insert
    r.repos.pendingRepo.insert = async (row: NewPending) => {
      if (row.ticker === 'AAPL') throw new Error('db-down')
      return insert(row)
    }
    await expect(r.run(null)).rejects.toThrow('db-down')
    expect(r.events.map((e) => e.type)).toEqual(['outcome'])
  })
})
