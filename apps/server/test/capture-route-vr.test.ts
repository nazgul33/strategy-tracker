import { describe, test, expect } from 'bun:test'
import type { RawFill } from '@st/ingest'
import { DEFAULT_VR_SETTINGS } from '@st/strategies/value-rebalancing'
import { makeCaptureRouting, type CaptureEvent } from '../src/wire/capture-route'
import { activeRun, makeCaptureFakes, PNG_B64, type FakeOpts } from './wire-capture-fakes'

const visionOf = (fills: readonly object[]) =>
  (async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ fills }) } }] }) })) as unknown as typeof fetch

function routing(opts: FakeOpts & { fetchImpl: typeof fetch }) {
  const fakes = makeCaptureFakes(opts)
  let visionCalls = 0
  const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
    visionCalls++
    return opts.fetchImpl(...args)
  }) as unknown as typeof fetch
  const route = makeCaptureRouting({
    repos: fakes.repos,
    vision: { baseUrl: 'https://vision.example/v1', baseUrlSource: 'env', model: 'vision-model', modelSource: 'settings' },
    getVisionApiKey: async () => ({ key: 'k', source: 'settings' }),
    today: () => '2026-11-10',
    fetchImpl,
  })
  const events: CaptureEvent[] = []
  const run = (pinnedRunId: number | null) =>
    route({ image: { base64: PNG_B64, mime: 'image/png' }, pinnedRunId }, async (e) => { events.push(e) })
  const vrRun = (ticker = 'TQQQ') =>
    fakes.repos.vrRunRepo.create({ ...DEFAULT_VR_SETTINGS, ticker, name: `V${ticker}${fakes.vr.runs.length}`, costPpm: 0, initialVCents: 500_000, openingCashCents: 1_000_000, openedOn: '2026-11-01' })
  const nothingTakenIn = () => {
    expect(fakes.captures).toEqual([])
    expect(fakes.pending).toEqual([])
    expect(fakes.vr.pending).toEqual([])
    expect(fakes.choices).toEqual([])
  }
  return { ...fakes, events, run, vrRun, nothingTakenIn, visionCalls: () => visionCalls }
}

const fill = (ticker: string, extra: Partial<RawFill> = {}): RawFill => ({ side: 'buy', ticker, shares: 3, price: '45.15', date: '2026-11-10', ...extra })
const TQ = (extra: Partial<RawFill> = {}) => fill('TQQQ', extra)
const WAIT1 = { waiting: 1, dropped: 0, possibleDuplicates: 0 }

describe('routing across MR and VR: un-pinned', () => {
  test('no candidate: a VR run on another ticker is no help', async () => {
    const r = routing({ fetchImpl: visionOf([TQ()]) })
    await r.vrRun('SOXL')
    await r.run(null)
    expect(r.events).toEqual([{ type: 'no-run', ticker: 'TQQQ' }])
    r.nothingTakenIn()
  })

  test('a ticker only VR trades goes to the VR run', async () => {
    const r = routing({ fetchImpl: visionOf([TQ()]) })
    const vrId = await r.vrRun()
    await r.run(null)
    expect(r.events).toEqual([{ type: 'vr-outcome', runId: vrId, ticker: 'TQQQ', outcome: WAIT1 }])
    expect(vrId).toBe(100001)
    expect(r.vr.pending).toHaveLength(1)
    expect(r.pending).toEqual([])
    expect(r.captures.map((c) => c.runId)).toEqual([100001])
  })

  test('exactly one MR run and one VR run: a choice, nothing taken in', async () => {
    const r = routing({ runs: [activeRun(1, 'TQQQ')], fetchImpl: visionOf([TQ()]) })
    await r.vrRun()
    await r.run(null)
    expect(r.events.map((e) => e.type)).toEqual(['choose'])
    r.nothingTakenIn()
  })

  test('choose carries the ticker, both run ids and every fill of the group with all fields', async () => {
    const withOrder = TQ({ fee: '0.05', orderType: 'LOC', orderPrice: '45.20', orderedShares: 3 })
    const dateless: RawFill = { side: 'buy', ticker: 'TQQQ', shares: 2, price: '45.10' }
    const sell = TQ({ side: 'sell', shares: 1, price: '46.00' })
    const r = routing({ runs: [activeRun(1, 'TQQQ')], fetchImpl: visionOf([withOrder, dateless, sell]) })
    await r.vrRun()
    await r.run(null)
    expect(r.events).toEqual([{ type: 'choose', ticker: 'TQQQ', mrRunId: 1, vrRunId: 100001, fills: [withOrder, dateless, sell] }])
    expect('date' in (r.events[0] as Extract<CaptureEvent, { type: 'choose' }>).fills[1]!).toBe(false)
    r.nothingTakenIn()
  })

  test('two VR runs on the ticker are ambiguous', async () => {
    const r = routing({ fetchImpl: visionOf([TQ()]) })
    await r.vrRun()
    await r.vrRun()
    await r.run(null)
    expect(r.events).toEqual([{ type: 'ambiguous', ticker: 'TQQQ' }])
    r.nothingTakenIn()
  })

  test('one MR run and two VR runs are ambiguous', async () => {
    const r = routing({ runs: [activeRun(1, 'TQQQ')], fetchImpl: visionOf([TQ()]) })
    await r.vrRun()
    await r.vrRun()
    await r.run(null)
    expect(r.events).toEqual([{ type: 'ambiguous', ticker: 'TQQQ' }])
    r.nothingTakenIn()
  })

  test('two MR runs and one VR run are ambiguous', async () => {
    const r = routing({ runs: [activeRun(1, 'TQQQ'), activeRun(2, 'TQQQ')], fetchImpl: visionOf([TQ()]) })
    await r.vrRun()
    await r.run(null)
    expect(r.events).toEqual([{ type: 'ambiguous', ticker: 'TQQQ' }])
    r.nothingTakenIn()
  })

  test('a paused VR run is not a candidate: one MR run plus one paused VR run is an MR outcome', async () => {
    const r = routing({ runs: [activeRun(1, 'TQQQ')], fetchImpl: visionOf([TQ()]) })
    const vrId = await r.vrRun()
    await r.repos.vrRunRepo.updateStatus(vrId, 'paused')
    await r.run(null)
    expect(r.events.map((e) => e.type)).toEqual(['outcome'])
    expect(r.events[0]).toMatchObject({ runId: 1, ticker: 'TQQQ' })
    expect(r.vr.pending).toEqual([])
  })

  test('a closed VR run alone is no run', async () => {
    const r = routing({ fetchImpl: visionOf([TQ()]) })
    const vrId = await r.vrRun()
    await r.repos.vrRunRepo.updateStatus(vrId, 'closed')
    await r.run(null)
    expect(r.events).toEqual([{ type: 'no-run', ticker: 'TQQQ' }])
  })

  test('the same screenshot twice to a VR-only ticker: the second is a duplicate', async () => {
    const r = routing({ fetchImpl: visionOf([TQ()]) })
    const vrId = await r.vrRun()
    await r.run(null)
    await r.run(null)
    expect(r.events).toEqual([
      { type: 'vr-outcome', runId: vrId, ticker: 'TQQQ', outcome: WAIT1 },
      { type: 'vr-outcome', runId: vrId, ticker: 'TQQQ', outcome: 'duplicate' },
    ])
    expect(r.vr.pending).toHaveLength(1)
  })

  test('three tickers in one screenshot: outcome, vr-outcome and choose in fill order', async () => {
    const r = routing({ runs: [activeRun(1, 'NVDA'), activeRun(2, 'TQQQ')], fetchImpl: visionOf([fill('NVDA'), fill('SOXL'), TQ()]) })
    await r.vrRun('SOXL')
    await r.vrRun('TQQQ')
    await r.run(null)
    expect(r.events.map((e) => [e.type, 'ticker' in e ? e.ticker : null])).toEqual([['outcome', 'NVDA'], ['vr-outcome', 'SOXL'], ['choose', 'TQQQ']])
    expect(r.captures.map((c) => c.runId).sort()).toEqual([1, 100001])
    expect(r.vr.pending.map((p) => p.runId)).toEqual([100001])
  })

  test('the same three tickers in another order: one group does not stop the next', async () => {
    const r = routing({ runs: [activeRun(1, 'NVDA'), activeRun(2, 'TQQQ')], fetchImpl: visionOf([TQ(), fill('NVDA'), fill('SOXL')]) })
    await r.vrRun('SOXL')
    await r.vrRun('TQQQ')
    await r.run(null)
    expect(r.events.map((e) => [e.type, 'ticker' in e ? e.ticker : null])).toEqual([['choose', 'TQQQ'], ['outcome', 'NVDA'], ['vr-outcome', 'SOXL']])
  })
})

describe('routing across MR and VR: pinned', () => {
  for (const status of ['active', 'paused', 'closed'] as const) {
    test(`a pinned ${status} VR run takes in its own ticker`, async () => {
      const r = routing({ fetchImpl: visionOf([TQ(), TQ({ shares: 5 })]) })
      const vrId = await r.vrRun()
      await r.repos.vrRunRepo.updateStatus(vrId, status)
      await r.run(vrId)
      expect(r.events).toEqual([{ type: 'vr-outcome', runId: vrId, ticker: 'TQQQ', outcome: { waiting: 2, dropped: 0, possibleDuplicates: 0 } }])
    })
  }

  test('a pin goes to the VR run only, even when an active MR run trades the ticker', async () => {
    const r = routing({ runs: [activeRun(1, 'TQQQ')], fetchImpl: visionOf([TQ()]) })
    const vrId = await r.vrRun()
    await r.run(vrId)
    expect(r.events.map((e) => e.type)).toEqual(['vr-outcome'])
    expect(r.pending).toEqual([])
    expect(r.vr.pending).toHaveLength(1)
    expect(r.captures.map((c) => c.runId)).toEqual([vrId])
  })

  test('pin-nomatch when the screenshot has no fill of the VR ticker', async () => {
    const r = routing({ fetchImpl: visionOf([fill('NVDA')]) })
    const vrId = await r.vrRun()
    await r.run(vrId)
    expect(r.events).toEqual([{ type: 'pin-nomatch', runId: vrId, ticker: 'TQQQ' }])
    r.nothingTakenIn()
  })

  test('pin-skipped names the other tickers before the outcome', async () => {
    const r = routing({ fetchImpl: visionOf([TQ(), fill('NVDA'), fill('AAPL')]) })
    const vrId = await r.vrRun()
    await r.run(vrId)
    expect(r.events.map((e) => e.type)).toEqual(['pin-skipped', 'vr-outcome'])
    expect(r.events[0]).toEqual({ type: 'pin-skipped', runId: vrId, tickers: ['NVDA', 'AAPL'] })
    expect(r.vr.pending).toHaveLength(1)
  })

  test('an unknown pin with VR runs present: unknown-run and no vision call', async () => {
    const r = routing({ runs: [activeRun(1, 'TQQQ')], fetchImpl: visionOf([TQ()]) })
    await r.vrRun()
    await r.run(99)
    expect(r.events).toEqual([{ type: 'unknown-run', id: 99 }])
    expect(r.visionCalls()).toBe(0)
    r.nothingTakenIn()
  })
})
