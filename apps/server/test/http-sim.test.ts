import { describe, test, expect } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, PASSWORD, json, loginAs } from './http-fakes'

describe('http sim gaps', () => {
  test('sim run validates gaps', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const base = { name: 's', ticker: 'A', from: '2026-11-01', to: '2026-11-03', poolCents: 1000, costPpm: 30 }
    for (const bad of [{ buyGapPpm: -1 }, { sellGapPpm: 1.5 }, { buyGapPpm: 1000001 }, { sellGapPpm: 'x' }]) {
      const br = await app.request('/api/sim', { method: 'POST', body: JSON.stringify({ ...base, ...bad }), headers: { 'content-type': 'application/json', ...auth } })
      expect(br.status).toBe(400)
    }
    // valid gaps pass validation and reach the simulator (bars fake → not-enough-bars 422)
    const ok = await app.request('/api/sim', { method: 'POST', body: JSON.stringify({ ...base, buyGapPpm: 10000, sellGapPpm: 20000 }), headers: { 'content-type': 'application/json', ...auth } })
    expect(ok.status).toBe(422)
    expect((await ok.json()).error).toBe('not-enough-bars')
  })
  test('sim run defaults gaps to 0 and persists them', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    // fake fetchDailyBars returns [] → runSim throws before insert; assert via repo fake instead:
    // give this app real day data by overriding deps
    const f2 = makeFakes()
    const deps = makeDeps(f2)
    deps.fetchDailyBars = async () => [
      { date: '2026-11-01', open: 1000000n, high: 1000000n, low: 1000000n, close: 1000000n },
      { date: '2026-11-02', open: 995000n, high: 995000n, low: 950000n, close: 900000n },
    ]
    const app2 = createApp(deps)
    const lr2 = await app2.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const auth2 = { Authorization: `Bearer ${(await lr2.json()).token}` }
    const base = { name: 's', ticker: 'A', from: '2026-11-01', to: '2026-11-02', poolCents: 1000000, costPpm: 30 }
    const r1 = await app2.request('/api/sim', { method: 'POST', body: JSON.stringify(base), headers: { 'content-type': 'application/json', ...auth2 } })
    expect(r1.status).toBe(200)
    expect(f2.simRuns[0].buyGapPpm).toBe(0)
    expect(f2.simRuns[0].sellGapPpm).toBe(0)
    const r2 = await app2.request('/api/sim', { method: 'POST', body: JSON.stringify({ ...base, buyGapPpm: 10000, sellGapPpm: 20000 }), headers: { 'content-type': 'application/json', ...auth2 } })
    expect(r2.status).toBe(200)
    expect(f2.simRuns[1].buyGapPpm).toBe(10000)
    expect(f2.simRuns[1].sellGapPpm).toBe(20000)
    const rows = await (await app2.request('/api/sim', { headers: auth2 })).json()
    expect(rows[0].buyGapPpm).toBe(0)
    expect(rows[1].sellGapPpm).toBe(20000)
  })
})

describe('http sim costPpm default', () => {
  const bars = [
    { date: '2026-11-01', open: 1000000n, high: 1000000n, low: 1000000n, close: 1000000n },
    { date: '2026-11-02', open: 995000n, high: 995000n, low: 950000n, close: 900000n },
  ]
  const base = { name: 's', ticker: 'A', from: '2026-11-01', to: '2026-11-02', poolCents: 1000000 }
  const setup = async () => {
    const f = makeFakes()
    const deps = makeDeps(f)
    deps.defaultSettings.defaultCostPpm = 1250
    deps.fetchDailyBars = async () => bars
    const app = createApp(deps)
    const auth = await loginAs(app)
    const post = (body: Record<string, unknown>) =>
      app.request('/api/sim', { method: 'POST', body: JSON.stringify(body), headers: { ...json, ...auth } })
    return { f, post }
  }

  test('POST /api/sim without costPpm uses the env default', async () => {
    const { f, post } = await setup()
    expect((await post(base)).status).toBe(200)
    expect(f.simRuns[0].costPpm).toBe(1250)
  })

  test('an explicit costPpm of 0 is kept, not replaced by the default', async () => {
    const { f, post } = await setup()
    expect((await post({ ...base, costPpm: 0 })).status).toBe(200)
    expect(f.simRuns[0].costPpm).toBe(0)
  })

  test.each([5, 15, 701, -10, 1.5, '30', null])('rejects costPpm %p', async (v) => {
    const { f, post } = await setup()
    const res = await post({ ...base, costPpm: v })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid costPpm')
    expect(f.simRuns.length).toBe(0)
  })
})
