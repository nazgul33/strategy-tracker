import { describe, test, expect } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, PASSWORD, json, loginAs, createRun } from './http-fakes'

describe('http runs', () => {
  test('create run appears in list, progressView cash===pool', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = { Authorization: `Bearer ${(await (await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })).json()).token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r1', ticker: 'AAPL', costPpm: 100, poolCents: 1000 }), headers: { 'content-type': 'application/json', ...auth } })
    expect(cr.status).toBe(201)
    const { id } = await cr.json()
    const list = await app.request('/api/runs', { headers: auth })
    expect(list.status).toBe(200)
    const arr = await list.json()
    expect(arr.length).toBe(1)
    const det = await app.request(`/api/runs/${id}`, { headers: auth })
    const d = await det.json()
    expect(d.progressView.cashCents).toBe(1000)
    expect(d.progressView.heldCount).toBe(0)
  })
  test('create run with seed -> buckets seeded + ledger source seed', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r2', ticker: 'AAPL', costPpm: 100, poolCents: 1000, seed: { cashCents: 500, buckets: [{ shares: 5, buyPrice: '10.0000', filledOn: '2026-11-01' }] } }), headers: { 'content-type': 'application/json', ...auth } })
    const { id } = await cr.json()
    const state = f.states.get(id)!
    expect(state.buckets.filter((b) => b.state !== 'empty').length).toBe(1)
    const fills = await f.repos.fillRepo.listForRun(id)
    expect(fills[0].source).toBe('seed')
    const ledger = await f.repos.ledgerRepo.listForRun(id)
    expect(ledger.length).toBe(1)
  })
  // A seed without cashCents would leave state.cashCents undefined in
  // booking.seedRun and permanently brick the run — reject before creating.
  test('seed without cashCents -> 400, no run created', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r3', ticker: 'AAPL', costPpm: 100, poolCents: 1000, seed: { buckets: [] } }), headers: { 'content-type': 'application/json', ...auth } })
    expect(cr.status).toBe(400)
    expect(await cr.json()).toEqual({ error: 'invalid seed' })
    expect(f.runs.length).toBe(0) // runRepo.create never called
    expect(f.states.size).toBe(0)
  })
  test('seed cashCents 1.5 -> 400, no run created', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r3', ticker: 'AAPL', costPpm: 100, poolCents: 1000, seed: { cashCents: 1.5, buckets: [] } }), headers: { 'content-type': 'application/json', ...auth } })
    expect(cr.status).toBe(400)
    expect(f.runs.length).toBe(0)
  })
  test('seed bucket shares 0 -> 400, no run created', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r3', ticker: 'AAPL', costPpm: 100, poolCents: 1000, seed: { cashCents: 500, buckets: [{ shares: 0, buyPrice: '10.0000', filledOn: '2026-11-01' }] } }), headers: { 'content-type': 'application/json', ...auth } })
    expect(cr.status).toBe(400)
    expect(f.runs.length).toBe(0)
  })
  test('seed with more buckets than bucketCount -> 400, no run created', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const buckets = Array.from({ length: 11 }, () => ({ shares: 1, buyPrice: '10.0000', filledOn: '2026-11-01' }))
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r3', ticker: 'AAPL', costPpm: 100, poolCents: 1000, seed: { cashCents: 500, buckets } }), headers: { 'content-type': 'application/json', ...auth } })
    expect(cr.status).toBe(400)
    expect(f.runs.length).toBe(0)
  })
  test('invalid body 400', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: '', ticker: 'A', costPpm: -1, poolCents: 0 }), headers: { 'content-type': 'application/json', ...auth } })
    expect(cr.status).toBe(400)
  })
  test('unsupported param 400', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r', ticker: 'A', costPpm: 0, poolCents: 100, params: { foo: 1 } }), headers: { 'content-type': 'application/json', ...auth } })
    expect(cr.status).toBe(400)
  })
  test('pool edit changes poolCents + pool_edits row', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r', ticker: 'A', costPpm: 0, poolCents: 100 }), headers: { 'content-type': 'application/json', ...auth } })
    const { id } = await cr.json()
    const pr = await app.request(`/api/runs/${id}/pool`, { method: 'POST', body: JSON.stringify({ amountCents: 200 }), headers: { 'content-type': 'application/json', ...auth } })
    expect(pr.status).toBe(200)
    const run = f.runs.find((x) => x.id === id)
    expect(run.poolCents).toBe(200)
    expect(f.poolEdits.length).toBe(1)
  })
  test('patch status valid + invalid', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r', ticker: 'A', costPpm: 0, poolCents: 100 }), headers: { 'content-type': 'application/json', ...auth } })
    const { id } = await cr.json()
    const ok = await app.request(`/api/runs/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'paused' }), headers: { 'content-type': 'application/json', ...auth } })
    expect(ok.status).toBe(200)
    const bad = await app.request(`/api/runs/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'nope' }), headers: { 'content-type': 'application/json', ...auth } })
    expect(bad.status).toBe(400)
  })
  test('patch status enforces lifecycle; closed is terminal', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const id = (await (await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r1', ticker: 'A', costPpm: 0, poolCents: 100 }), headers: { 'content-type': 'application/json', ...auth } })).json()).id
    expect((await app.request(`/api/runs/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'closed' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(200)
    // 200 must actually persist: re-read via GET
    expect((await (await app.request(`/api/runs/${id}`, { headers: auth })).json()).status).toBe('closed')
    expect((await app.request(`/api/runs/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(409)
    expect((await app.request(`/api/runs/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(400)
    // fresh run: same-status no-op is invalid too
    const id2 = (await (await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r2', ticker: 'B', costPpm: 0, poolCents: 100 }), headers: { 'content-type': 'application/json', ...auth } })).json()).id
    expect((await app.request(`/api/runs/${id2}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(409)
    expect((await app.request(`/api/runs/${id2}`, { method: 'PATCH', body: JSON.stringify({ status: 'paused' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(200)
    // paused as source: paused->paused invalid, paused->active and paused->closed legal, each persisting
    expect((await app.request(`/api/runs/${id2}`, { method: 'PATCH', body: JSON.stringify({ status: 'paused' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(409)
    expect((await app.request(`/api/runs/${id2}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(200)
    expect((await (await app.request(`/api/runs/${id2}`, { headers: auth })).json()).status).toBe('active')
    expect((await app.request(`/api/runs/${id2}`, { method: 'PATCH', body: JSON.stringify({ status: 'paused' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(200)
    expect((await app.request(`/api/runs/${id2}`, { method: 'PATCH', body: JSON.stringify({ status: 'closed' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(200)
    expect((await (await app.request(`/api/runs/${id2}`, { headers: auth })).json()).status).toBe('closed')
    expect((await app.request('/api/runs/999999', { method: 'PATCH', body: JSON.stringify({ status: 'paused' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(404)
  })
  // Legacy rows may still carry the pre-lifecycle `done` status: the
  // RUN_TRANSITIONS[run.status] ?? [] guard must yield 409, not a crash.
  test('legacy done row rejects transitions with 409', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    f.runs.push({ id: 900, strategyKey: 'mean-reversion', ticker: 'Z', name: 'legacy', poolCents: 100, costPpm: 0, status: 'done', stateJson: '{}', createdAt: new Date() })
    expect((await app.request('/api/runs/900', { method: 'PATCH', body: JSON.stringify({ status: 'active' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(409)
    expect((await app.request('/api/runs/900', { method: 'PATCH', body: JSON.stringify({ status: 'closed' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(409)
  })
  // Status validation runs before the lookup: an invalid value on a
  // nonexistent id is 400, not 404.
  test('invalid status on nonexistent run -> 400 beats 404', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const res = await app.request('/api/runs/999999', { method: 'PATCH', body: JSON.stringify({ status: 'done' }), headers: { 'content-type': 'application/json', ...auth } })
    expect(res.status).toBe(400)
  })
  test('manual fill books', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r', ticker: 'AAPL', costPpm: 100, poolCents: 1000 }), headers: { 'content-type': 'application/json', ...auth } })
    const { id } = await cr.json()
    const before = f.states.get(id)!.cashCents
    const fr = await app.request(`/api/runs/${id}/fills`, { method: 'POST', body: JSON.stringify({ side: 'buy', shares: 2, price: '10.0000', filledOn: '2026-11-10' }), headers: { 'content-type': 'application/json', ...auth } })
    expect(fr.status).toBe(200)
    const after = f.states.get(id)!.cashCents
    expect(after).toBeLessThan(before)
    expect(f.fills.length).toBe(1)
    expect(f.fills[0].ticker).toBe('AAPL')
  })
  test('manual fill with legacy ticker body -> 200, run ticker stamped', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r', ticker: 'AAPL', costPpm: 100, poolCents: 1000 }), headers: { 'content-type': 'application/json', ...auth } })
    const { id } = await cr.json()
    const fr = await app.request(`/api/runs/${id}/fills`, { method: 'POST', body: JSON.stringify({ side: 'buy', ticker: 'ZZZ', shares: 2, price: '10.0000', filledOn: '2026-11-10' }), headers: { 'content-type': 'application/json', ...auth } })
    expect(fr.status).toBe(200)
    expect(f.fills.length).toBe(1)
    expect(f.fills[0].ticker).toBe('AAPL')
  })
  test('manual fill domain error -> 422 {error}', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r', ticker: 'AAPL', costPpm: 100, poolCents: 1000 }), headers: { 'content-type': 'application/json', ...auth } })
    const { id } = await cr.json()
    // sell with no held bucket -> DomainError from booking
    const fr = await app.request(`/api/runs/${id}/fills`, { method: 'POST', body: JSON.stringify({ side: 'sell', ticker: 'AAPL', shares: 1, price: '10.0000', filledOn: '2026-11-10' }), headers: { 'content-type': 'application/json', ...auth } })
    expect(fr.status).toBe(422)
    expect(await fr.json()).toEqual({ error: 'no-bucket-for-sell' })
    expect(f.fills.length).toBe(0)
  })
  test('manual fill with zero shares -> 422 invalid-shares', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r', ticker: 'AAPL', costPpm: 100, poolCents: 1000 })
    const fr = await app.request(`/api/runs/${id}/fills`, { method: 'POST', body: JSON.stringify({ side: 'buy', shares: 0, price: '10.0000', filledOn: '2026-11-10' }), headers: { ...json, ...auth } })
    expect(fr.status).toBe(422)
    expect(await fr.json()).toEqual({ error: 'invalid-shares' })
    expect(f.fills.length).toBe(0)
  })
  test('bulk-status updates eligible rows only', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const createRun = async (name: string) =>
      (await (await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name, ticker: 'A', costPpm: 0, poolCents: 100 }), headers: { 'content-type': 'application/json', ...auth } })).json()).id as number
    const a = await createRun('a')
    const b = await createRun('b')
    const c = await createRun('c')
    // move b -> paused and c -> closed so the bulk call sees mixed states
    expect((await app.request(`/api/runs/${b}`, { method: 'PATCH', body: JSON.stringify({ status: 'paused' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(200)
    expect((await app.request(`/api/runs/${c}`, { method: 'PATCH', body: JSON.stringify({ status: 'closed' }), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(200)
    const bulk = (body: unknown) => app.request('/api/runs/bulk-status', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...auth } })
    const pause = await bulk({ ids: [a, b, c], status: 'paused' })
    expect(pause.status).toBe(200)
    expect((await pause.json()).updated).toBe(1) // only a; b is already paused, c is terminal
    // 200 must actually persist: legal transition applied to a only
    expect((await (await app.request(`/api/runs/${a}`, { headers: auth })).json()).status).toBe('paused')
    expect((await (await app.request(`/api/runs/${c}`, { headers: auth })).json()).status).toBe('closed')
    const close = await bulk({ ids: [a, b, c], status: 'closed' })
    expect((await close.json()).updated).toBe(2) // a + b resume-close; c already terminal
    expect((await (await app.request(`/api/runs/${a}`, { headers: auth })).json()).status).toBe('closed')
    expect((await (await app.request(`/api/runs/${b}`, { headers: auth })).json()).status).toBe('closed')
    expect(f.runs.find((x) => x.id === c)!.status).toBe('closed')
  })
  test('bulk-status rejects malformed bodies', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    for (const body of [{ ids: [], status: 'paused' }, { ids: 'x', status: 'paused' }, { ids: [0], status: 'paused' },
      { ids: [1.5], status: 'paused' }, { ids: [1], status: 'done' }, { ids: [1], status: 'nope' }, { status: 'paused' }]) {
      expect((await app.request('/api/runs/bulk-status', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...auth } })).status).toBe(400)
    }
  })
  test('POST /runs accepts gap fields and rejects invalid', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const base = { name: 'g', ticker: 'A', costPpm: 0, poolCents: 100 }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ ...base, buyGapPpm: 10000, sellGapPpm: 20000 }), headers: { 'content-type': 'application/json', ...auth } })
    expect(cr.status).toBe(201)
    const { id } = await cr.json()
    const d = await (await app.request(`/api/runs/${id}`, { headers: auth })).json()
    expect(d.buyGapPpm).toBe(10000)
    expect(d.sellGapPpm).toBe(20000)
    // GET /runs list DTO carries the gaps too
    const listed = await (await app.request('/api/runs', { headers: auth })).json()
    expect(listed.find((x: any) => x.id === id)!.buyGapPpm).toBe(10000)
    expect(listed.find((x: any) => x.id === id)!.sellGapPpm).toBe(20000)
    for (const bad of [{ buyGapPpm: 1.5 }, { sellGapPpm: -1 }, { buyGapPpm: 1000001 }]) {
      const br = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ ...base, ...bad }), headers: { 'content-type': 'application/json', ...auth } })
      expect(br.status).toBe(400)
    }
    expect(f.runs.length).toBe(1) // create never called for invalid gaps
    // absent gaps default to 0 on both GET DTOs, like the DB column default
    const cr2 = await app.request('/api/runs', { method: 'POST', body: JSON.stringify(base), headers: { 'content-type': 'application/json', ...auth } })
    expect(cr2.status).toBe(201)
    const id2 = (await cr2.json()).id
    const d2 = await (await app.request(`/api/runs/${id2}`, { headers: auth })).json()
    expect(d2.buyGapPpm).toBe(0)
    expect(d2.sellGapPpm).toBe(0)
    const listed2 = await (await app.request('/api/runs', { headers: auth })).json()
    expect(listed2.find((x: any) => x.id === id2)!.buyGapPpm).toBe(0)
    expect(listed2.find((x: any) => x.id === id2)!.sellGapPpm).toBe(0)
  })
  test('POST /runs/:id/gaps updates, validates, 404s', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'g', ticker: 'A', costPpm: 0, poolCents: 100, buyGapPpm: 10000, sellGapPpm: 20000 }), headers: { 'content-type': 'application/json', ...auth } })
    const { id } = await cr.json()
    const gr = await app.request(`/api/runs/${id}/gaps`, { method: 'POST', body: JSON.stringify({ buyGapPpm: 100, sellGapPpm: 200 }), headers: { 'content-type': 'application/json', ...auth } })
    expect(gr.status).toBe(204)
    const d = await (await app.request(`/api/runs/${id}`, { headers: auth })).json()
    expect(d.buyGapPpm).toBe(100)
    expect(d.sellGapPpm).toBe(200)
    // missing / non-integer / out-of-range → 400, gaps unchanged
    for (const bad of [{ buyGapPpm: 100 }, { sellGapPpm: 200 }, { buyGapPpm: 'x', sellGapPpm: 200 },
      { buyGapPpm: 1.5, sellGapPpm: 200 }, { buyGapPpm: 100, sellGapPpm: -1 }, { buyGapPpm: 1000001, sellGapPpm: 200 }]) {
      const br = await app.request(`/api/runs/${id}/gaps`, { method: 'POST', body: JSON.stringify(bad), headers: { 'content-type': 'application/json', ...auth } })
      expect(br.status).toBe(400)
    }
    const d2 = await (await app.request(`/api/runs/${id}`, { headers: auth })).json()
    expect(d2.buyGapPpm).toBe(100)
    expect(d2.sellGapPpm).toBe(200)
    // unknown id → 404
    const nf = await app.request('/api/runs/999/gaps', { method: 'POST', body: JSON.stringify({ buyGapPpm: 1, sellGapPpm: 2 }), headers: { 'content-type': 'application/json', ...auth } })
    expect(nf.status).toBe(404)
    // gaps are editable in any status
    await app.request(`/api/runs/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'paused' }), headers: { 'content-type': 'application/json', ...auth } })
    const pr = await app.request(`/api/runs/${id}/gaps`, { method: 'POST', body: JSON.stringify({ buyGapPpm: 0, sellGapPpm: 0 }), headers: { 'content-type': 'application/json', ...auth } })
    expect(pr.status).toBe(204)
    expect(f.runs.find((x) => x.id === id)!.status).toBe('paused')
  })

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
