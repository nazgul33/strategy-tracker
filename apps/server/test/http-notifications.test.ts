import { describe, test, expect } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, loginAs, createRun, json } from './http-fakes'
import { FAKE_CREATED_AT } from './booking-fakes'

async function setup() {
  const f = makeFakes()
  const app = createApp(makeDeps(f))
  const auth = await loginAs(app)
  const add = (runId: number | null, chatId: string, text: string) => f.repos.notificationRepo.insert({ runId, chatId, text })
  const get = async (path: string) => {
    const res = await app.request(path, { headers: auth })
    return { status: res.status, body: await res.json() }
  }
  return { f, app, auth, add, get }
}

// Rows 1-6; newest first the entries are: 6 (run 1), 5 (run 99), 4 (global), 3 (run 3), 2+1 (run 1).
async function mixedFeed() {
  const s = await setup()
  for (const ticker of ['AAPL', 'MSFT', 'NVDA']) await createRun(s.app, s.auth, { name: ticker, ticker, costPpm: 0, poolCents: 100 })
  await s.add(1, '42', 'digest'); await s.add(1, '43', 'digest'); await s.add(3, '42', 'digest')
  await s.add(null, '42', 'closed'); await s.add(99, 'web', 'orphan'); await s.add(1, '42', 'skip')
  return s
}
// Records every shared getMany call and makes every other way to read runs throw.
function watchRuns(f: Awaited<ReturnType<typeof setup>>['f']) {
  const calls: number[][] = []
  const getMany = f.repos.sharedRunRepo.getMany
  f.repos.sharedRunRepo.getMany = async (ids) => { calls.push([...ids]); return getMany(ids) }
  f.repos.runRepo.list = async () => { throw new Error('the feed must not list every run') }
  f.repos.vrRunRepo.list = async () => { throw new Error('the feed must not list every run') }
  f.repos.runRepo.getMany = async () => { throw new Error('the feed reads runs through sharedRunRepo') }
  return calls
}

describe('GET /api/notifications', () => {
  test('looks up only the runs on the page, in one call, and never lists every run', async () => {
    const { f, get } = await mixedFeed()
    const calls = watchRuns(f)
    const { status, body } = await get('/api/notifications')
    expect(status).toBe(200)
    expect(body.entries.map((e: { runId: number | null; ticker: string | null; strategyKey: string | null }) => [e.runId, e.ticker, e.strategyKey])).toEqual([
      [1, 'AAPL', 'mean-reversion'], [99, null, null], [null, null, null], [3, 'NVDA', 'mean-reversion'], [1, 'AAPL', 'mean-reversion'],
    ])
    expect(calls.map((ids) => [...ids].sort((a, b) => a - b))).toEqual([[1, 3, 99]])
  })

  test('a page of global notices asks for no run', async () => {
    const { f, add, get } = await setup()
    await add(null, '42', 'closed'); await add(null, '42', 'reminder')
    const calls = watchRuns(f)
    expect((await get('/api/notifications')).body.entries.map((e: { ticker: string | null }) => e.ticker)).toEqual([null, null])
    expect(calls).toEqual([[]])
  })

  test('401 without a token', async () => {
    const { app } = await setup()
    expect((await app.request('/api/notifications')).status).toBe(401)
  })

  test('lists every notice newest first, grouped, with the run ticker', async () => {
    const { app, auth, add, get } = await setup()
    await createRun(app, auth, { name: 'r', ticker: 'AAPL', costPpm: 0, poolCents: 100 })
    await add(1, '42', 'digest')
    await add(1, '43', 'digest')
    await add(null, '42', 'closed')
    await add(99, 'web', 'orphan')
    expect(await get('/api/notifications')).toEqual({ status: 200, body: {
      entries: [
        { id: 4, runId: 99, ticker: null, strategyKey: null, text: 'orphan', sentAt: FAKE_CREATED_AT, chatIds: ['web'] },
        { id: 3, runId: null, ticker: null, strategyKey: null, text: 'closed', sentAt: FAKE_CREATED_AT, chatIds: ['42'] },
        { id: 2, runId: 1, ticker: 'AAPL', strategyKey: 'mean-reversion', text: 'digest', sentAt: FAKE_CREATED_AT, chatIds: ['42', '43'] },
      ],
      nextBefore: null,
    } })
  })

  test("a VR run's notice carries its ticker and strategy", async () => {
    const { app, auth, add, get } = await setup()
    const res = await app.request('/api/vr/runs', { method: 'POST', headers: { ...json, ...auth }, body: JSON.stringify({ name: 'vr', ticker: 'TQQQ', cashCents: 1_000_000 }) })
    expect(res.status).toBe(201)
    const { id } = await res.json()
    await add(id, '42', 'cycle')
    expect((await get('/api/notifications')).body.entries).toEqual([
      { id: 1, runId: id, ticker: 'TQQQ', strategyKey: 'value-rebalancing', text: 'cycle', sentAt: FAKE_CREATED_AT, chatIds: ['42'] },
    ])
  })

  test('pages 20 at a time by default and before continues without repeats', async () => {
    const { add, get } = await setup()
    for (let i = 1; i <= 25; i++) await add(null, '42', `n${i}`)
    const p1 = await get('/api/notifications')
    expect(p1.body.entries.map((e: { id: number }) => e.id)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i))
    expect(p1.body.nextBefore).toBe(6)
    const p2 = await get('/api/notifications?before=6')
    expect(p2.body.entries.map((e: { id: number }) => e.id)).toEqual([5, 4, 3, 2, 1])
    expect(p2.body.nextBefore).toBeNull()
  })

  test('limit is honoured and clamped to 100', async () => {
    const { add, get } = await setup()
    for (let i = 1; i <= 105; i++) await add(null, '42', `n${i}`)
    const two = await get('/api/notifications?limit=2')
    expect(two.body.entries.map((e: { id: number }) => e.id)).toEqual([105, 104])
    expect(two.body.nextBefore).toBe(104)
    const big = await get('/api/notifications?limit=1000')
    expect(big.body.entries).toHaveLength(100)
    expect(big.body.nextBefore).toBe(6)
  })

  test('a malformed cursor or limit is a 400', async () => {
    const { get } = await setup()
    for (const q of ['before=abc', 'before=0', 'before=1.5']) {
      expect(await get(`/api/notifications?${q}`)).toEqual({ status: 400, body: { error: 'invalid before' } })
    }
    for (const q of ['limit=0', 'limit=abc']) {
      expect(await get(`/api/notifications?${q}`)).toEqual({ status: 400, body: { error: 'invalid limit' } })
    }
  })
})
