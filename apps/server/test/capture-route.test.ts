import { describe, test, expect } from 'bun:test'
import type { NewPending } from '../src/domain/repo-types'
import { makeCaptureRouting, type CaptureEvent, type VisionApiKey, type VisionInUse } from '../src/wire/capture-route'
import { activeRun, keyEchoFetch, keyParts, LEAK_KEY, makeCaptureFakes, multiVisionFetch, PNG_B64, visionFetch, type FakeOpts } from './wire-capture-fakes'

function routing(opts: FakeOpts & { fetchImpl?: typeof fetch; key?: VisionApiKey } = {}) {
  const fakes = makeCaptureFakes(opts)
  const inner = opts.fetchImpl ?? visionFetch
  let visionCalls = 0
  const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
    visionCalls++
    return inner(...args)
  }) as unknown as typeof fetch
  const route = makeCaptureRouting({
    repos: fakes.repos,
    vision: { baseUrl: 'https://vision.example/v1', baseUrlSource: 'env', model: 'vision-model', modelSource: 'settings' },
    getVisionApiKey: async () => opts.key ?? { key: 'k', source: 'settings' },
    today: () => '2026-11-10',
    fetchImpl,
  })
  const events: CaptureEvent[] = []
  const run = (pinnedRunId: number | null, visionTimeoutMs?: number) =>
    route({ image: { base64: PNG_B64, mime: 'image/png' }, pinnedRunId, visionTimeoutMs }, async (e) => { events.push(e) })
  return { ...fakes, events, run, visionCalls: () => visionCalls }
}

const vision500 = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch
const visionSays = (content: string) =>
  (async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) })) as unknown as typeof fetch
const IN_USE: VisionInUse = { model: 'vision-model', modelSource: 'settings', baseUrl: 'https://vision.example/v1', baseUrlSource: 'env', keySource: 'settings' }

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
    expect(r.events).toEqual([{ type: 'bad-extract', reason: 'http', detail: 'http 500', vision: IN_USE }])
    expect(r.visionCalls()).toBe(1)
    expect(r.captures.length).toBe(0)
  })

  test('an unreadable answer is unparseable and names the config in use', async () => {
    const r = routing({ runs: [activeRun(1, 'NVDA')], fetchImpl: visionSays("I can't read this") })
    await r.run(null)
    expect(r.events).toEqual([{ type: 'bad-extract', reason: 'unparseable', detail: 'no json', vision: IN_USE }])
  })

  test('a 200 answer that is not an OpenAI reply is incompatible and names the config in use', async () => {
    const htmlPage = (async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } })) as unknown as typeof fetch
    const r = routing({ runs: [activeRun(1, 'NVDA')], fetchImpl: htmlPage })
    await r.run(null)
    expect(r.events).toEqual([{ type: 'bad-extract', reason: 'incompatible', detail: 'response body not json', vision: IN_USE }])
  })

  test('an image without fills is empty and carries no config', async () => {
    const r = routing({ runs: [activeRun(1, 'NVDA')], fetchImpl: visionSays('{"fills":[]}') })
    await r.run(null)
    expect(r.events).toEqual([{ type: 'bad-extract', reason: 'empty', detail: 'no valid fills' }])
    expect('vision' in r.events[0]!).toBe(false)
  })

  test('no key anywhere is reported as none', async () => {
    const r = routing({ runs: [activeRun(1, 'NVDA')], fetchImpl: vision500, key: { key: '', source: 'none' } })
    await r.run(null)
    expect(r.events).toEqual([{ type: 'bad-extract', reason: 'http', detail: 'http 500', vision: { ...IN_USE, keySource: 'none' } }])
  })

  test('the key value never reaches an event', async () => {
    const r = routing({ runs: [activeRun(1, 'NVDA')], fetchImpl: keyEchoFetch, key: { key: LEAK_KEY, source: 'env' } })
    await r.run(null)
    expect(keyParts(JSON.stringify(r.events))).toEqual([])
    expect(r.events[0]).toMatchObject({
      reason: 'http',
      detail: 'http 401: Incorrect API key provided: sk-L....9c2e; masked sk-LEA*********9c2e',
      vision: { keySource: 'env' },
    })
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

describe('vision time limit', () => {
  function switchable() {
    let signal: AbortSignal | null | undefined
    let impl: typeof fetch = visionFetch
    const hanging = (async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }) as unknown as typeof fetch
    const recording = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      signal = init?.signal
      return visionFetch(url, init)
    }) as unknown as typeof fetch
    const fetchImpl = ((...args: Parameters<typeof fetch>) => impl(...args)) as unknown as typeof fetch
    return {
      fetchImpl,
      hang: () => { impl = hanging },
      record: () => { impl = recording },
      signal: () => signal,
    }
  }

  test('a vision read slower than the limit is a bad-extract and aborts the request', async () => {
    const f = switchable()
    f.hang()
    const r = routing({ runs: [activeRun(1, 'NVDA')], fetchImpl: f.fetchImpl })
    await r.run(null, 20)
    expect(r.events).toEqual([{ type: 'bad-extract', reason: 'http', detail: 'vision timed out', vision: IN_USE }])
    expect(f.signal()?.aborted).toBe(true)
    expect(r.captures.length).toBe(0)
  })

  test('a timed-out file can be uploaded again', async () => {
    const f = switchable()
    f.hang()
    const r = routing({ runs: [activeRun(1, 'NVDA')], fetchImpl: f.fetchImpl })
    await r.run(null, 20)
    f.record()
    await r.run(null, 20)
    expect(r.events).toHaveLength(2)
    expect(r.events[1]).toMatchObject({ type: 'outcome', runId: 1, ticker: 'NVDA', outcome: { pending: [{ runId: 1, ticker: 'NVDA' }] } })
  })

  test('a read inside the limit is unaffected', async () => {
    const f = switchable()
    f.record()
    const r = routing({ runs: [activeRun(1, 'NVDA')], fetchImpl: f.fetchImpl })
    await r.run(null, 1000)
    expect(r.events).toHaveLength(1)
    expect(r.events[0]).toMatchObject({ type: 'outcome', runId: 1, ticker: 'NVDA' })
    expect(f.signal()).toBeDefined()
    expect(f.signal()?.aborted).toBe(false)
  })

  test('without a limit the vision request carries no signal', async () => {
    const f = switchable()
    f.record()
    const r = routing({ runs: [activeRun(1, 'NVDA')], fetchImpl: f.fetchImpl })
    await r.run(null)
    expect(r.events).toHaveLength(1)
    expect(f.signal()).toBeUndefined()
  })
})
