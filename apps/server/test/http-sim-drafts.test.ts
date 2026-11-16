import { describe, test, expect } from 'bun:test'
import { isTradingDay } from '@st/calendar'
import { MarketDataError, type OHLCBar } from '@st/market-data'
import { createApp } from '../src/http/app'
import { makeCachedBarReader } from '../src/market/bars'
import { makeFakes, makeDeps, json, loginAs } from './http-fakes'

describe('http sim drafts', () => {
  const day = (d: string, n: number) => {
    const dt = new Date(`${d}T12:00:00Z`)
    dt.setUTCDate(dt.getUTCDate() + n)
    return dt.toISOString().slice(0, 10)
  }
  // closes wobble so the planner actually places orders; one bar per NYSE trading day
  const mkBar = (date: string): OHLCBar => {
    const k = BigInt(Number(date.slice(8)) % 5)
    const close = 1_000_000n - k * 20_000n
    return { date, open: close + 5_000n, high: close + 15_000n, low: close - 40_000n, close }
  }
  const base = { name: 's', ticker: 'A', from: '2026-11-02', to: '2026-11-06', poolCents: 1_000_000, costPpm: 30 }

  async function setup() {
    const f = makeFakes()
    const deps = makeDeps(f)
    const upstream = { calls: 0, failNext: false }
    const raw = async (_t: string, from: string, to: string): Promise<OHLCBar[]> => {
      upstream.calls += 1
      if (upstream.failNext) { upstream.failNext = false; throw new MarketDataError('http') }
      const out: OHLCBar[] = []
      for (let d = from; d <= to; d = day(d, 1)) if (isTradingDay(d)) out.push(mkBar(d))
      if (out.length === 0) throw new MarketDataError('no-data')
      return out
    }
    deps.fetchDailyBars = makeCachedBarReader({ upstream: raw, repos: f.repos as any, today: deps.today })
    const app = createApp(deps)
    const auth = await loginAs(app)
    const call = (method: string, path: string, body?: unknown) =>
      app.request(`/api/sim${path}`, { method, headers: { ...json, ...auth }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const create = async (over: Record<string, unknown> = {}) => {
      const res = await call('POST', '', { ...base, ...over })
      expect(res.status).toBe(200)
      return (await res.json()) as { id: number; dayCount: number }
    }
    const detail = async (id: number) => (await (await call('GET', `/${id}`)).json()) as { run: any; days: any[] }
    const { ticker: _t, ...edit } = base
    return { f, upstream, call, create, detail, edit }
  }

  test('POST /api/sim creates a draft', async () => {
    const { call, create } = await setup()
    const { id } = await create()
    const rows = await (await call('GET', '')).json()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, draft: true })
    expect((await (await call('GET', `/${id}`)).json()).run.draft).toBe(true)
  })

  test('POST persists cutLossPpm and rejects invalid values', async () => {
    const { f, call, create } = await setup()
    await create({ cutLossPpm: 35_000 })
    expect(f.simRuns[0].cutLossPpm).toBe(35_000)
    for (const bad of [35_001, -1_000, 600_000, 'x', 1_500.5]) {
      const res = await call('POST', '', { ...base, cutLossPpm: bad })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('invalid cutLossPpm')
    }
    expect(f.simRuns).toHaveLength(1)
  })

  test('PUT /api/sim/:id recomputes in place, same id, new config', async () => {
    const { f, call, create, detail, edit } = await setup()
    const { id, dayCount } = await create()
    expect(dayCount).toBe(4)
    const res = await call('PUT', `/${id}`, { ...edit, to: '2026-11-05', cutLossPpm: 35_000, buyGapPpm: 10_000, poolCents: 2_000_000 })
    expect(res.status).toBe(200)
    const put = await res.json()
    expect(put).toEqual({ id, dayCount: 3 })
    const d = await detail(id)
    expect(d.run).toMatchObject({ id, ticker: 'A', draft: true, toDate: '2026-11-05', cutLossPpm: 35_000, buyGapPpm: 10_000, poolCents: 2_000_000 })
    expect(d.days.map((x) => x.tradeDate)).toEqual(['2026-11-03', '2026-11-04', '2026-11-05'])
    expect(f.simRuns).toHaveLength(1)
    expect(f.simDays.filter((x) => x.simRunId === id)).toHaveLength(3)
  })

  test('PUT reuses the cached bars — no second provider call', async () => {
    const { upstream, call, create, edit } = await setup()
    const { id } = await create()
    const after = upstream.calls
    expect(after).toBeGreaterThan(0)
    expect((await call('PUT', `/${id}`, { ...edit, cutLossPpm: 35_000 })).status).toBe(200)
    expect((await call('PUT', `/${id}`, { ...edit, cutLossPpm: 70_000 })).status).toBe(200)
    expect(upstream.calls).toBe(after)
  })

  test('PUT ignores a ticker in the body: the stored ticker is the identity', async () => {
    const { call, create, detail, edit } = await setup()
    const { id } = await create()
    const res = await call('PUT', `/${id}`, { ...edit, ticker: 'ZZZ' })
    expect(res.status).toBe(200)
    expect((await detail(id)).run.ticker).toBe('A')
  })

  test('PUT validates like POST', async () => {
    const { call, create, detail, edit } = await setup()
    const { id } = await create()
    const before = await detail(id)
    const bodies: [Record<string, unknown>, string][] = [
      [{ cutLossPpm: 35_001 }, 'invalid cutLossPpm'],
      [{ cutLossPpm: 600_000 }, 'invalid cutLossPpm'],
      [{ buyGapPpm: -1 }, 'invalid buyGapPpm'],
      [{ costPpm: 15 }, 'invalid costPpm'],
      [{ poolCents: 0 }, 'invalid poolCents'],
      [{ name: ' ' }, 'invalid name'],
      [{ from: '2026-11-06', to: '2026-11-02' }, 'invalid range'],
      [{ params: { bucketCount: 51 } }, 'invalid bucketCount'],
    ]
    for (const [over, error] of bodies) {
      const res = await call('PUT', `/${id}`, { ...edit, ...over })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(error)
    }
    const unknownKey = await call('PUT', `/${id}`, { ...edit, params: { tick: 1 } })
    expect(unknownKey.status).toBe(422)
    expect((await unknownKey.json()).error).toBe('invalid-params')
    expect(await detail(id)).toEqual(before)
  })

  test('PUT omitting costPpm uses the env default, like POST', async () => {
    const { f, call, create, edit } = await setup()
    const { id } = await create({ costPpm: 30 })
    const { costPpm: _c, ...noCost } = edit
    expect((await call('PUT', `/${id}`, noCost)).status).toBe(200)
    expect(f.simRuns.find((r) => r.id === id).costPpm).toBe(700)
  })

  test('a failed re-run leaves the draft days and config intact', async () => {
    const { f, upstream, call, create, detail, edit } = await setup()
    const { id } = await create()
    const before = await detail(id)
    expect(before.days).toHaveLength(4)
    upstream.failNext = true
    const res = await call('PUT', `/${id}`, { ...edit, to: '2026-11-12', cutLossPpm: 35_000 }) // new range ⇒ needs the provider
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe('market-data:http')
    expect(await detail(id)).toEqual(before)
    // a domain failure (a single bar is not enough to simulate) is equally harmless
    const tooShort = await call('PUT', `/${id}`, { ...edit, from: '2026-11-02', to: '2026-11-02' })
    expect(tooShort.status).toBe(422)
    expect((await tooShort.json()).error).toBe('not-enough-bars')
    expect(await detail(id)).toEqual(before)
    expect(f.simDays.filter((x) => x.simRunId === id)).toHaveLength(4)
  })

  test('POST /api/sim/:id/save finalizes once', async () => {
    const { call, create, detail } = await setup()
    const { id } = await create()
    const first = await call('POST', `/${id}/save`)
    expect(first.status).toBe(204)
    expect((await detail(id)).run.draft).toBe(false)
    const second = await call('POST', `/${id}/save`)
    expect(second.status).toBe(409)
    expect((await second.json()).error).toBe('sim-finalized')
  })

  test('PUT and DELETE on a saved sim are 409 sim-finalized and change nothing', async () => {
    const { f, call, create, detail, edit } = await setup()
    const { id } = await create()
    await call('POST', `/${id}/save`)
    const before = await detail(id)
    const put = await call('PUT', `/${id}`, { ...edit, cutLossPpm: 35_000 })
    expect(put.status).toBe(409)
    expect((await put.json()).error).toBe('sim-finalized')
    const del = await call('DELETE', `/${id}`)
    expect(del.status).toBe(409)
    expect((await del.json()).error).toBe('sim-finalized')
    expect(await detail(id)).toEqual(before)
    expect(f.simDays.filter((x) => x.simRunId === id)).toHaveLength(4)
  })

  test('PUT on a saved sim is rejected before any provider call', async () => {
    const { upstream, call, create, edit } = await setup()
    const { id } = await create()
    await call('POST', `/${id}/save`)
    const calls = upstream.calls
    await call('PUT', `/${id}`, { ...edit, to: '2026-11-12' })
    expect(upstream.calls).toBe(calls)
  })

  test('DELETE removes a draft and its days', async () => {
    const { f, call, create } = await setup()
    const { id } = await create()
    const other = await create({ ticker: 'B' })
    const del = await call('DELETE', `/${id}`)
    expect(del.status).toBe(204)
    expect((await call('GET', `/${id}`)).status).toBe(404)
    expect(f.simDays.filter((x) => x.simRunId === id)).toHaveLength(0)
    expect(f.simDays.filter((x) => x.simRunId === other.id)).toHaveLength(4)
  })

  test.each([
    ['PUT', ''],
    ['POST', '/save'],
    ['DELETE', ''],
  ])('%s %s on an unknown id is 404', async (method, suffix) => {
    const { call, edit } = await setup()
    const res = await call(method, `/999${suffix}`, method === 'PUT' ? edit : undefined)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('not-found')
  })

  test('GET /api/sim marks drafts and saved runs, newest first', async () => {
    const { call, create } = await setup()
    const a = await create({ name: 'a' })
    const b = await create({ name: 'b' })
    const c = await create({ name: 'c' })
    await call('POST', `/${b.id}/save`)
    const rows = await (await call('GET', '')).json()
    expect(rows.map((r: any) => [r.id, r.draft])).toEqual([[c.id, true], [b.id, false], [a.id, true]])
  })
})
