import { describe, test, expect } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, PASSWORD, json, loginAs, createRun } from './http-fakes'

describe('http pending', () => {
  test('pending list + confirm with overrides + reject non-pending 409', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r', ticker: 'AAPL', costPpm: 100, poolCents: 1000 }), headers: { 'content-type': 'application/json', ...auth } })
    const { id } = await cr.json()
    // insert pending manually
    const pid = await f.repos.pendingRepo.insert({ runId: id, captureId: null, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 3, price: 100000n, fee: null, filledOn: '2026-11-10', status: 'pending' })
    const pl = await app.request('/api/pending', { headers: auth })
    expect(pl.status).toBe(200)
    const arr = await pl.json()
    expect(arr.length).toBe(1)
    const conf = await app.request(`/api/pending/${pid}/confirm`, { method: 'POST', body: JSON.stringify({ overrides: { shares: 2 } }), headers: { 'content-type': 'application/json', ...auth } })
    expect(conf.status).toBe(200)
    // override applied: booked fill has 2 shares (not the pending's 3), booked into state
    expect(f.fills.length).toBe(1)
    expect(f.fills[0].shares).toBe(2)
    const st = f.states.get(id)!
    const held = st.buckets.find((b) => b.state !== 'empty')
    expect(held).toBeDefined()
    expect(held!.shares).toBe(2)
    expect(st.cashCents).toBeLessThan(1000)
    // reject non-pending
    const rej = await app.request(`/api/pending/${pid}/reject`, { method: 'POST', headers: auth })
    expect(rej.status).toBe(409)
    expect((await rej.json()).error).toBe('not-pending')
  })

  describe('lost decide race -> 409 not-pending', () => {
    async function setup() {
      const f = makeFakes()
      const app = createApp(makeDeps(f))
      const auth = await loginAs(app)
      const id = await createRun(app, auth, { name: 'r', ticker: 'AAPL', costPpm: 100, poolCents: 1000 })
      const pid = await f.repos.pendingRepo.insert({ runId: id, captureId: null, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 3, price: 100000n, fee: null, filledOn: '2026-11-10', status: 'pending' })
      // The row still reads as pending, but another decider wins the atomic flip.
      f.repos.pendingRepo.decide = async () => false
      return { f, app, auth, pid }
    }

    test('reject', async () => {
      const { app, auth, pid } = await setup()
      const res = await app.request(`/api/pending/${pid}/reject`, { method: 'POST', headers: auth })
      expect(res.status).toBe(409)
      expect((await res.json()).error).toBe('not-pending')
    })

    test('confirm', async () => {
      const { f, app, auth, pid } = await setup()
      const res = await app.request(`/api/pending/${pid}/confirm`, { method: 'POST', body: JSON.stringify({}), headers: { ...json, ...auth } })
      expect(res.status).toBe(409)
      expect((await res.json()).error).toBe('not-pending')
      expect(f.fills.length).toBe(0)
    })
  })

  test('double confirm books exactly one fill', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r', ticker: 'AAPL', costPpm: 100, poolCents: 1000 }), headers: { 'content-type': 'application/json', ...auth } })
    const { id } = await cr.json()
    const pid = await f.repos.pendingRepo.insert({ runId: id, captureId: null, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 3, price: 100000n, fee: null, filledOn: '2026-11-10', status: 'pending' })
    const conf1 = await app.request(`/api/pending/${pid}/confirm`, { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json', ...auth } })
    expect(conf1.status).toBe(200)
    const conf2 = await app.request(`/api/pending/${pid}/confirm`, { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json', ...auth } })
    expect(conf2.status).toBe(409)
    expect(await conf2.json()).toEqual({ error: 'not-pending' })
    expect(f.fills.length).toBe(1)
    expect(f.ledger.length).toBe(1)
  })

  test('confirm of an unknown id -> 409 not-pending', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const res = await app.request('/api/pending/99999/confirm', { method: 'POST', body: JSON.stringify({}), headers: { ...json, ...auth } })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'not-pending' })
    expect(f.fills.length).toBe(0)
  })

  test('confirm of a rejected row -> 409 not-pending', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r', ticker: 'AAPL', costPpm: 100, poolCents: 1000 })
    const pid = await f.repos.pendingRepo.insert({ runId: id, captureId: null, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 3, price: 100000n, fee: null, filledOn: '2026-11-10', status: 'pending' })
    expect((await app.request(`/api/pending/${pid}/reject`, { method: 'POST', headers: auth })).status).toBe(200)
    const res = await app.request(`/api/pending/${pid}/confirm`, { method: 'POST', body: JSON.stringify({}), headers: { ...json, ...auth } })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'not-pending' })
    expect(f.fills.length).toBe(0)
  })

  test('confirm raising a DomainError -> 422 with its kind, nothing booked', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r', ticker: 'AAPL', costPpm: 100, poolCents: 1000 })
    // a sell with no held bucket -> DomainError('no-bucket-for-sell') from booking
    const pid = await f.repos.pendingRepo.insert({ runId: id, captureId: null, bucketIdx: null, side: 'sell', ticker: 'AAPL', shares: 3, price: 100000n, fee: null, filledOn: '2026-11-10', status: 'pending' })
    const res = await app.request(`/api/pending/${pid}/confirm`, { method: 'POST', body: JSON.stringify({}), headers: { ...json, ...auth } })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'no-bucket-for-sell' })
    expect(f.fills.length).toBe(0)
    expect(f.ledger.length).toBe(0)
    expect((await f.repos.pendingRepo.get(pid))!.status).toBe('pending')
  })

  test('confirm with invalid override shares -> 422 invalid-shares', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r', ticker: 'AAPL', costPpm: 100, poolCents: 1000 })
    const pid = await f.repos.pendingRepo.insert({ runId: id, captureId: null, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 3, price: 100000n, fee: null, filledOn: '2026-11-10', status: 'pending' })
    const res = await app.request(`/api/pending/${pid}/confirm`, { method: 'POST', body: JSON.stringify({ overrides: { shares: 0 } }), headers: { ...json, ...auth } })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'invalid-shares' })
    expect(f.fills.length).toBe(0)
    expect((await f.repos.pendingRepo.get(pid))!.status).toBe('pending')
  })

  test('confirm with ticker mismatch returns 409', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r', ticker: 'AAPL', costPpm: 100, poolCents: 1000 }), headers: { 'content-type': 'application/json', ...auth } })
    const { id } = await cr.json()
    const pid = await f.repos.pendingRepo.insert({ runId: id, captureId: null, bucketIdx: null, side: 'buy', ticker: 'ZZZ', shares: 3, price: 100000n, fee: null, filledOn: '2026-11-10', status: 'pending' })
    const conf = await app.request(`/api/pending/${pid}/confirm`, { method: 'POST', headers: auth })
    expect(conf.status).toBe(409)
    expect((await conf.json()).error).toBe('ticker-mismatch')
    expect(f.fills.length).toBe(0)
  })
})

describe('http settings', () => {
  test('get masks key, put validates digestLang, reflects db', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    await f.repos.settingsRepo.set('visionApiKey', 'sk-123')
    const g = await app.request('/api/settings', { headers: auth })
    const gb = await g.json()
    expect(gb.hasVisionApiKey).toBe(true)
    expect(JSON.stringify(gb)).not.toContain('sk-123')
    // invalid digestLang
    const bad = await app.request('/api/settings', { method: 'PUT', body: JSON.stringify({ digestLang: 'fr' }), headers: { 'content-type': 'application/json', ...auth } })
    expect(bad.status).toBe(400)
    // put then get
    const put = await app.request('/api/settings', { method: 'PUT', body: JSON.stringify({ visionModel: 'newmodel', digestLang: 'ko' }), headers: { 'content-type': 'application/json', ...auth } })
    expect(put.status).toBe(200)
    const g2 = await app.request('/api/settings', { headers: auth })
    const gb2 = await g2.json()
    expect(gb2.visionModel).toBe('newmodel')
    expect(gb2.digestLang).toBe('ko')
  })

  test('GET exposes the env-owned defaultCostPpm; PUT cannot change it', async () => {
    const f = makeFakes()
    const deps = makeDeps(f)
    deps.defaultSettings.defaultCostPpm = 1250
    const app = createApp(deps)
    const auth = await loginAs(app)
    expect((await (await app.request('/api/settings', { headers: auth })).json()).defaultCostPpm).toBe(1250)
    const put = await app.request('/api/settings', { method: 'PUT', body: JSON.stringify({ defaultCostPpm: 50, digestLang: 'ko' }), headers: { ...json, ...auth } })
    expect(put.status).toBe(200)
    expect(Object.keys(f.settings)).not.toContain('defaultCostPpm')
    const after = await (await app.request('/api/settings', { headers: auth })).json()
    expect(after.defaultCostPpm).toBe(1250)
    expect(after.digestLang).toBe('ko')
  })
})
