import { describe, test, expect } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, loginAs, createRun } from './http-fakes'
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

describe('GET /api/notifications', () => {
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
        { id: 4, runId: 99, ticker: null, text: 'orphan', sentAt: FAKE_CREATED_AT, chatIds: ['web'] },
        { id: 3, runId: null, ticker: null, text: 'closed', sentAt: FAKE_CREATED_AT, chatIds: ['42'] },
        { id: 2, runId: 1, ticker: 'AAPL', text: 'digest', sentAt: FAKE_CREATED_AT, chatIds: ['42', '43'] },
      ],
      nextBefore: null,
    } })
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
