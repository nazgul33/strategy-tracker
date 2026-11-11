import { describe, test, expect, beforeEach } from 'bun:test'
import { createApp, type HttpDeps, type HttpRepoSurface } from '../src/http/app'
import { makeToken, verifyToken } from '../src/http/auth'
import { emptyState } from '@st/core'
import type { RunState } from '@st/core'
import { CANCEL_REASONS } from '../src/domain/booking'

function makeFakes() {
  let runIdSeq = 1
  const runs: any[] = []
  const poolEdits: any[] = []
  const fills: any[] = []
  const ledger: any[] = []
  const orders: any[] = []
  const pending: any[] = []
  const notifications: any[] = []
  const settings: Record<string, string> = {}
  const states = new Map<number, RunState>()
  const bucketRepo = {
    async loadState(runId: number) { return states.get(runId)! },
    async saveState(runId: number, state: RunState) { states.set(runId, state) },
  }
  const runRepo = {
    async list() { return [...runs] },
    async get(id: number) { return runs.find((r) => r.id === id) ?? null },
    async create(input: any) {
      const id = runIdSeq++
      const state = input.initialRunState
      if (state) states.set(id, state)
      runs.push({ id, strategyKey: input.strategyKey, ticker: input.ticker, name: input.name, poolCents: input.poolCents, costPpm: input.costPpm, buyGapPpm: input.buyGapPpm ?? 0, sellGapPpm: input.sellGapPpm ?? 0, status: 'active', stateJson: JSON.stringify(state, (_k, v) => typeof v === 'bigint' ? v.toString() : v), createdAt: new Date() })
      return id
    },
    async updateStatus(id: number, status: string) {
      const r = runs.find((x) => x.id === id); if (r) r.status = status
    },
    async updateStatusMany(ids: number[], from: string[], to: string) {
      let n = 0
      for (const r of runs) if (ids.includes(r.id) && from.includes(r.status)) { r.status = to; n += 1 }
      return n
    },
    async updatePool(id: number, poolCents: number) {
      const r = runs.find((x) => x.id === id); if (r) r.poolCents = poolCents
    },
    async updateGaps(id: number, buyGapPpm: number, sellGapPpm: number) {
      const r = runs.find((x) => x.id === id); if (r) { r.buyGapPpm = buyGapPpm; r.sellGapPpm = sellGapPpm }
    },
  }
  const orderRepo = {
    async insertMany(os: any[]) { for (const o of os) orders.push({ id: orders.length + 1, ...o }) },
    async listForDate(date: string) { return orders.filter((o) => o.tradeDate === date) },
    async markStale() { return 0 },
    async get(id: number) { return orders.find((x) => x.id === id) ?? null },
    async setStatus(id: number, status: string, cancelReason?: string) {
      const o = orders.find((x) => x.id === id)
      if (o) { o.status = status; if (cancelReason !== undefined) o.cancelReason = cancelReason }
    },
    async listOpenBefore() { return [] },
    async listForRun(runId: number, date?: string) {
      let out = orders.filter((o) => o.runId === runId)
      if (date) out = out.filter((o) => o.tradeDate === date)
      return out
    },
  }
  const fillRepo = {
    async insert(f: any) { fills.push({ id: fills.length + 1, ...f }) },
    async listForRun(runId: number) { return fills.filter((f) => f.runId === runId) },
  }
  const pendingRepo = {
    async insert(p: any) { const id = pending.length + 1; pending.push({ id, ...p }); return id },
    async listPending() { return pending.filter((p) => p.status === 'pending') },
    async decide(id: number, status: string, edited?: any): Promise<boolean> {
      const p = pending.find((x) => x.id === id); if (!p || p.status !== 'pending') return false
      p.status = status
      if (edited) Object.assign(p, edited)
      return true
    },
    async get(id: number) { return pending.find((x) => x.id === id) ?? null },
  }
  const captureRepo = { async hasHash() { return false }, async insert(c: any) { return { inserted: true, id: 1 } } }
  const ledgerRepo = {
    async insert(l: any) { ledger.push({ id: ledger.length + 1, ...l }) },
    async listForRun(runId: number) { return ledger.filter((l) => l.runId === runId) },
  }
  const notificationRepo = {
    async insert(n: any) { notifications.push({ id: notifications.length + 1, ...n }) },
    async listForRun(runId: number) { return notifications.filter((n) => n.runId === runId) },
  }
  const sent: { chatId: string; text: string }[] = []
  const settingsRepo = {
    async getAll() { return { ...settings } },
    async set(key: string, value: string) { settings[key] = value },
  }
  const poolEditRepo = {
    async insert(input: { runId: number; poolCents: number }) { poolEdits.push({ id: poolEdits.length + 1, ...input }) },
  }
  const simRuns: any[] = []
  const simRepo = {
    async insertRun(i: any) { simRuns.push({ id: simRuns.length + 1, createdAt: '2026-11-10T00:00:00Z', ...i }); return simRuns.length },
    async insertDays() {},
    async listRuns() { return simRuns },
    async getRun() { return null },
    async listDays() { return [] },
  }
  const repos: HttpRepoSurface = {
    runRepo, bucketRepo, orderRepo, fillRepo, pendingRepo, captureRepo, ledgerRepo, notificationRepo,
    settingsRepo, poolEditRepo, simRepo,
  } as any
  return { repos, runs, poolEdits, fills, ledger, orders, pending, notifications, sent, settings, states, simRuns }
}

const PASSWORD = 'secret'
const SECRET = 'session-secret'

function makeDeps(fakes: ReturnType<typeof makeFakes>): HttpDeps {
  return {
    repos: fakes.repos,
    password: PASSWORD,
    sessionSecret: SECRET,
    today: () => '2026-11-10',
    defaultSettings: { visionBaseUrl: 'http://x', visionModel: 'm', digestLang: 'en' },
    triggerMorning: async () => 'morning-ok',
    fetchDailyBars: async () => [],
    allowedChatIds: ['42'],
    send: async (chatId: string, text: string) => { fakes.sent.push({ chatId, text }) },
  }
}

describe('http auth', () => {
  test('wrong password 401 no cookie', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const res = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: 'nope' }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
  test('right password sets cookie + token', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const res = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.token).toBeTruthy()
    expect(res.headers.get('set-cookie')).toContain('st_session')
  })
  test('health is public', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
  test('protected 401 without token', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const res = await app.request('/api/runs')
    expect(res.status).toBe(401)
  })
  test('protected 200 with cookie', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const cookie = lr.headers.get('set-cookie')!
    const res = await app.request('/api/runs', { headers: { Cookie: cookie.split(';')[0]! } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
  test('protected 200 with bearer', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const body = await lr.json()
    const res = await app.request('/api/runs', { headers: { Authorization: `Bearer ${body.token}` } })
    expect(res.status).toBe(200)
  })
  test('tampered token 401', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const body = await lr.json()
    const token = body.token as string
    // flip a payload byte
    const parts = token.split('.')
    const arr = parts[0]!.split('')
    arr[0] = arr[0] === 'A' ? 'B' : 'A'
    const tampered = arr.join('') + '.' + parts[1]
    const res = await app.request('/api/runs', { headers: { Authorization: `Bearer ${tampered}` } })
    expect(res.status).toBe(401)
  })
  test('expired token 401', async () => {
    const token = makeToken(Date.now() - 1000, SECRET)
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const res = await app.request('/api/runs', { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(401)
  })
})

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
    const body = await fr.json()
    expect(typeof body.error).toBe('string')
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
})

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
    expect(conf2.status).toBe(422)
    expect(f.fills.length).toBe(1)
    expect(f.ledger.length).toBe(1)
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
})

describe('http trigger', () => {
  test('trigger morning returns result', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const res = await app.request('/api/trigger/morning', { method: 'POST', headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ result: 'morning-ok' })
  })

  async function setup() {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r', ticker: 'A', costPpm: 0, poolCents: 100 }), headers: { 'content-type': 'application/json', ...auth } })
    const { id: runId } = await cr.json()
    return { f, app, auth, runId }
  }

  test('cancel order: happy path stores reason, notifies each allowed chat', async () => {
    const { f, app, auth, runId } = await setup()
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-10', kind: 'sell_loc', bucketIdx: 2, limitPrice: 3500000n, shares: 1, status: 'open' }])
    const id = f.orders[f.orders.length - 1].id
    const res = await app.request(`/api/runs/${runId}/orders/${id}/cancel`, {
      method: 'POST', headers: auth, body: JSON.stringify({ reason: 'stale-price' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const row = f.orders.find((o) => o.id === id)!
    expect(row.status).toBe('cancelled')
    expect(row.cancelReason).toBe('stale-price')
    expect(f.notifications.filter((n) => n.runId === runId)).toHaveLength(1)
    expect(f.notifications.find((n) => n.runId === runId)!.text).toContain('Cancelled')
    expect(f.sent).toEqual([{ chatId: '42', text: f.notifications.find((n) => n.runId === runId)!.text }])
  })
  test('cancel order: 400 invalid-reason, 404 unknown order, 409 not open', async () => {
    const { f, app, auth, runId } = await setup()
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-10', kind: 'buy_loc', bucketIdx: 0, limitPrice: 1000000n, shares: 1, status: 'open' }])
    const id = f.orders[f.orders.length - 1].id
    const bad = await app.request(`/api/runs/${runId}/orders/${id}/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ reason: 'nope' }) })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'invalid-reason' })
    expect(f.orders[0].status).toBe('open')
    expect(f.notifications).toHaveLength(0)
    expect(f.sent).toHaveLength(0)
    const missing = await app.request(`/api/runs/${runId}/orders/9999/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ reason: 'other' }) })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'order-not-found' })
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-10', kind: 'buy_loc', bucketIdx: 1, limitPrice: 1000000n, shares: 1, status: 'filled' }])
    const filledId = f.orders[f.orders.length - 1].id
    const notOpen = await app.request(`/api/runs/${runId}/orders/${filledId}/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ reason: 'other' }) })
    expect(notOpen.status).toBe(409)
    expect(await notOpen.json()).toEqual({ error: 'order-not-open' })
    expect(f.orders[1].status).toBe('filled')
    expect(f.notifications).toHaveLength(0)
    expect(f.sent).toHaveLength(0)
  })
  test('cancel order succeeds with no allowed chats: 200, no notification rows, no sends', async () => {
    const f = makeFakes()
    const deps = makeDeps(f)
    deps.allowedChatIds = []
    const app = createApp(deps)
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r', ticker: 'A', costPpm: 0, poolCents: 100 }), headers: { 'content-type': 'application/json', ...auth } })
    const { id: runId } = await cr.json()
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-10', kind: 'sell_loc', bucketIdx: 0, limitPrice: 2000000n, shares: 1, status: 'open' }])
    const id = f.orders[f.orders.length - 1].id
    const res = await app.request(`/api/runs/${runId}/orders/${id}/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ reason: 'strategy-change' }) })
    expect(res.status).toBe(200)
    expect(f.orders[0].status).toBe('cancelled')
    expect(f.notifications.filter((n) => n.runId === runId)).toHaveLength(0)
    expect(f.sent).toHaveLength(0)
  })
  test('cancel order: unmapped booking error surfaces as 422', async () => {
    expect(CANCEL_REASONS.length).toBe(4)
    const { f, app, auth, runId } = await setup()
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-10', kind: 'buy_loc', bucketIdx: 0, limitPrice: 1000000n, shares: 1, status: 'open' }])
    const id = f.orders[f.orders.length - 1].id
    const orig = f.repos.orderRepo.setStatus
    f.repos.orderRepo.setStatus = async () => { throw new Error('db-exploded') }
    const res = await app.request(`/api/runs/${runId}/orders/${id}/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ reason: 'other' }) })
    f.repos.orderRepo.setStatus = orig
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'db-exploded' })
  })
})
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
