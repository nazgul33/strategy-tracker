import { describe, test, expect } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, json, loginAs, createRun } from './http-fakes'

describe('http runs', () => {
  describe('cut-loss', () => {
    const base = { name: 'c', ticker: 'A', costPpm: 0, poolCents: 100 }

    test('POST /runs defaults cutLossPpm to 0', async () => {
      const f = makeFakes()
      const app = createApp(makeDeps(f))
      const auth = await loginAs(app)
      const id = await createRun(app, auth, base)
      expect(f.runs.find((x) => x.id === id)!.cutLossPpm).toBe(0)
      const d = await (await app.request(`/api/runs/${id}`, { headers: auth })).json()
      expect(d.cutLossPpm).toBe(0)
    })

    test('POST /runs accepts a one-decimal percent in ppm', async () => {
      const f = makeFakes()
      const app = createApp(makeDeps(f))
      const auth = await loginAs(app)
      const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ ...base, cutLossPpm: 35_000 }), headers: { ...json, ...auth } })
      expect(cr.status).toBe(201)
      const { id } = await cr.json()
      expect(f.runs.find((x) => x.id === id)!.cutLossPpm).toBe(35_000)
    })

    test('POST /runs accepts the 0 and 500_000 boundaries', async () => {
      const f = makeFakes()
      const app = createApp(makeDeps(f))
      const auth = await loginAs(app)
      for (const v of [0, 500_000]) {
        const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ ...base, cutLossPpm: v }), headers: { ...json, ...auth } })
        expect(cr.status).toBe(201)
        const { id } = await cr.json()
        expect(f.runs.find((x) => x.id === id)!.cutLossPpm).toBe(v)
      }
    })

    test('POST /runs with an explicit cutLossPpm null stores 0; costPpm null is rejected', async () => {
      const f = makeFakes()
      const app = createApp(makeDeps(f))
      const auth = await loginAs(app)
      const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ ...base, cutLossPpm: null }), headers: { ...json, ...auth } })
      expect(cr.status).toBe(201)
      const { id } = await cr.json()
      expect(f.runs.find((x) => x.id === id)!.cutLossPpm).toBe(0)
      const bad = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ ...base, costPpm: null }), headers: { ...json, ...auth } })
      expect(bad.status).toBe(400)
      expect((await bad.json()).error).toBe('invalid costPpm')
      expect(f.runs.length).toBe(1)
    })

    test.each([35_001, -1_000, 600_000, 500_001, 1.5, '35000'])('POST /runs rejects %p', async (v) => {
      const f = makeFakes()
      const app = createApp(makeDeps(f))
      const auth = await loginAs(app)
      const res = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ ...base, cutLossPpm: v }), headers: { ...json, ...auth } })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('invalid cutLossPpm')
      expect(f.runs.length).toBe(0)
    })

    test('POST /runs/:id/gaps writes cutLossPpm when present', async () => {
      const f = makeFakes()
      const app = createApp(makeDeps(f))
      const auth = await loginAs(app)
      const id = await createRun(app, auth, base)
      const res = await app.request(`/api/runs/${id}/gaps`, { method: 'POST', body: JSON.stringify({ buyGapPpm: 100, sellGapPpm: 200, cutLossPpm: 35_000 }), headers: { ...json, ...auth } })
      expect(res.status).toBe(204)
      const run = f.runs.find((x) => x.id === id)!
      expect([run.buyGapPpm, run.sellGapPpm, run.cutLossPpm]).toEqual([100, 200, 35_000])
      // an explicit 0 turns it off, rather than being treated as absent
      const off = await app.request(`/api/runs/${id}/gaps`, { method: 'POST', body: JSON.stringify({ buyGapPpm: 100, sellGapPpm: 200, cutLossPpm: 0 }), headers: { ...json, ...auth } })
      expect(off.status).toBe(204)
      expect(f.runs.find((x) => x.id === id)!.cutLossPpm).toBe(0)
    })

    test('POST /runs/:id/gaps leaves cutLossPpm untouched when absent', async () => {
      const f = makeFakes()
      const app = createApp(makeDeps(f))
      const auth = await loginAs(app)
      const id = await createRun(app, auth, { ...base, cutLossPpm: 35_000 })
      const res = await app.request(`/api/runs/${id}/gaps`, { method: 'POST', body: JSON.stringify({ buyGapPpm: 100, sellGapPpm: 200 }), headers: { ...json, ...auth } })
      expect(res.status).toBe(204)
      const run = f.runs.find((x) => x.id === id)!
      expect([run.buyGapPpm, run.sellGapPpm, run.cutLossPpm]).toEqual([100, 200, 35_000])
    })

    test('POST /runs/:id/gaps cutLossPpm is editable in any status', async () => {
      const f = makeFakes()
      const app = createApp(makeDeps(f))
      const auth = await loginAs(app)
      const id = await createRun(app, auth, base)
      await app.request(`/api/runs/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'paused' }), headers: { ...json, ...auth } })
      const res = await app.request(`/api/runs/${id}/gaps`, { method: 'POST', body: JSON.stringify({ buyGapPpm: 0, sellGapPpm: 0, cutLossPpm: 20_000 }), headers: { ...json, ...auth } })
      expect(res.status).toBe(204)
      expect(f.runs.find((x) => x.id === id)!.cutLossPpm).toBe(20_000)
    })

    test.each([35_001, -1_000, 600_000, 1.5, '35000', null])('POST /runs/:id/gaps rejects cutLossPpm %p', async (v) => {
      const f = makeFakes()
      const app = createApp(makeDeps(f))
      const auth = await loginAs(app)
      const id = await createRun(app, auth, { ...base, buyGapPpm: 10, sellGapPpm: 20, cutLossPpm: 35_000 })
      const res = await app.request(`/api/runs/${id}/gaps`, { method: 'POST', body: JSON.stringify({ buyGapPpm: 100, sellGapPpm: 200, cutLossPpm: v }), headers: { ...json, ...auth } })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('invalid cutLossPpm')
      const run = f.runs.find((x) => x.id === id)!
      expect([run.buyGapPpm, run.sellGapPpm, run.cutLossPpm]).toEqual([10, 20, 35_000])
    })

    test('GET /runs/:id and GET /runs return cutLossPpm', async () => {
      const f = makeFakes()
      const app = createApp(makeDeps(f))
      const auth = await loginAs(app)
      const id = await createRun(app, auth, { ...base, cutLossPpm: 35_000 })
      expect((await (await app.request(`/api/runs/${id}`, { headers: auth })).json()).cutLossPpm).toBe(35_000)
      const listed = await (await app.request('/api/runs', { headers: auth })).json()
      expect(listed.find((x: any) => x.id === id).cutLossPpm).toBe(35_000)
    })
  })

  describe('costPpm default', () => {
    const base = { name: 'c', ticker: 'A', poolCents: 100 }
    const setup = (defaultCostPpm: number) => {
      const f = makeFakes()
      const deps = makeDeps(f)
      deps.defaultSettings.defaultCostPpm = defaultCostPpm
      return { f, app: createApp(deps) }
    }

    test('POST /runs without costPpm uses the env default', async () => {
      const { f, app } = setup(1250)
      const auth = await loginAs(app)
      const id = await createRun(app, auth, base)
      expect(f.runs.find((x) => x.id === id)!.costPpm).toBe(1250)
    })

    test('an explicit costPpm of 0 is kept, not replaced by the default', async () => {
      const { f, app } = setup(1250)
      const auth = await loginAs(app)
      const id = await createRun(app, auth, { ...base, costPpm: 0 })
      expect(f.runs.find((x) => x.id === id)!.costPpm).toBe(0)
    })

    test('a supplied costPpm wins over the default', async () => {
      const { f, app } = setup(1250)
      const auth = await loginAs(app)
      const id = await createRun(app, auth, { ...base, costPpm: 200 })
      expect(f.runs.find((x) => x.id === id)!.costPpm).toBe(200)
    })

    test.each([5, 15, 701, -10, 1.5, '200', null])('POST /runs rejects costPpm %p', async (v) => {
      const { f, app } = setup(1250)
      const auth = await loginAs(app)
      const res = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ ...base, costPpm: v }), headers: { ...json, ...auth } })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('invalid costPpm')
      expect(f.runs.length).toBe(0)
    })
  })
})
