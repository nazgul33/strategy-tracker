import { describe, test, expect, spyOn } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, json, loginAs, createRun } from './http-fakes'
import { NO_SNAPSHOT } from './booking-fakes'

const DETECTED = { detectedSide: 'buy', detectedShares: 3, detectedPrice: 100000n, detectedFilledOn: '2026-11-10', detectedFee: 12, detectedAt: '2026-11-10 09:00:00' }

async function setup(costPpm = 5000) {
  const f = makeFakes()
  const app = createApp(makeDeps(f))
  const auth = await loginAs(app)
  const runId = await createRun(app, auth, { name: 'r', ticker: 'AAPL', costPpm, poolCents: 1000000 })
  const addPending = (extra: Record<string, unknown> = {}) => f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 3, price: 100000n, fee: null, filledOn: '2026-11-10', status: 'pending', ...NO_SNAPSHOT, ...extra })
  const addImage = (captureId: number) => f.repos.captureImageRepo.insertIgnore({ captureId, mime: 'image/png', bytes: Buffer.from('png-bytes'), byteLen: 9 })
  const post = (path: string, body?: unknown) => app.request(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers: { ...json, ...auth } })
  return { f, app, auth, runId, addPending, addImage, post }
}

describe('http pending archived flag', () => {
  test('confirm and reject answer archived true normally', async () => {
    const { addPending, addImage, post } = await setup()
    await addImage(7)
    await addImage(8)
    const confirmId = await addPending({ captureId: 7, ...DETECTED })
    const rejectId = await addPending({ captureId: 8, ...DETECTED })
    const confirmed = await post(`/api/pending/${confirmId}/confirm`, { keepImage: true })
    expect(confirmed.status).toBe(200)
    expect(await confirmed.json()).toEqual({ ok: true, archived: true })
    const rejected = await post(`/api/pending/${rejectId}/reject`, { keepImage: true })
    expect(rejected.status).toBe(200)
    expect(await rejected.json()).toEqual({ ok: true, archived: true })
  })

  test('confirm and reject answer archived false when the archive write failed', async () => {
    const { f, addPending, addImage, post } = await setup()
    await addImage(7)
    await addImage(8)
    const confirmId = await addPending({ captureId: 7, ...DETECTED })
    const rejectId = await addPending({ captureId: 8, ...DETECTED })
    f.repos.visionReviewRepo.insertIgnore = async () => { throw new Error('archive-down') }
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const confirmed = await post(`/api/pending/${confirmId}/confirm`, { keepImage: true })
      expect(confirmed.status).toBe(200)
      expect(await confirmed.json()).toEqual({ ok: true, archived: false })
      const rejected = await post(`/api/pending/${rejectId}/reject`, { keepImage: true })
      expect(rejected.status).toBe(200)
      expect(await rejected.json()).toEqual({ ok: true, archived: false })
      expect(err).toHaveBeenCalledTimes(2)
    } finally {
      err.mockRestore()
    }
    expect(f.fills).toHaveLength(1)
    expect((await f.repos.pendingRepo.get(confirmId))!.status).toBe('confirmed')
    expect((await f.repos.pendingRepo.get(rejectId))!.status).toBe('rejected')
  })
})

describe('http pending reject refusal', () => {
  test('a keep write that throws answers 422 with the message, like confirm, and decides nothing', async () => {
    const { f, addPending, addImage, post } = await setup()
    await addImage(7)
    await addImage(8)
    const confirmId = await addPending({ captureId: 7, ...DETECTED })
    const rejectId = await addPending({ captureId: 8, ...DETECTED })
    f.repos.captureImageRepo.setKeep = async () => { throw new Error('keep-down') }
    const confirmed = await post(`/api/pending/${confirmId}/confirm`, { keepImage: true })
    expect(confirmed.status).toBe(422)
    expect(await confirmed.json()).toEqual({ error: 'keep-down' })
    const rejected = await post(`/api/pending/${rejectId}/reject`, { keepImage: true })
    expect(rejected.status).toBe(422)
    expect(await rejected.json()).toEqual({ error: 'keep-down' })
    expect((await f.repos.pendingRepo.get(rejectId))!.status).toBe('pending')
  })
})

describe('http pending validation order', () => {
  test('a malformed override on an already handled row is 409 not-pending, not 422', async () => {
    const { f, addPending, post } = await setup()
    const pid = await addPending()
    expect((await post(`/api/pending/${pid}/reject`)).status).toBe(200)
    for (const overrides of [{ side: 'hold' }, { feeCents: -1 }]) {
      const res = await post(`/api/pending/${pid}/confirm`, { overrides })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'not-pending' })
    }
    expect(f.fills).toHaveLength(0)
  })
})

describe('GET /api/pending run lookup', () => {
  test('looks each distinct run up once, concurrently', async () => {
    const { f, app, auth, runId, addPending } = await setup(5000)
    const otherRun = await createRun(app, auth, { name: 'r2', ticker: 'AAPL', costPpm: 250, poolCents: 1000000 })
    await addPending()
    await addPending()
    await f.repos.pendingRepo.insert({ runId: otherRun, captureId: null, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 3, price: 100000n, fee: null, filledOn: '2026-11-10', status: 'pending', ...NO_SNAPSHOT })

    const calls: number[] = []
    let inFlight = 0
    let maxInFlight = 0
    const get = f.repos.runRepo.get.bind(f.repos.runRepo)
    f.repos.runRepo.get = async (id: number) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      await Promise.resolve()
      inFlight -= 1
      calls.push(id)
      return get(id)
    }

    const stateCalls: number[] = []
    const loadState = f.repos.bucketRepo.loadState.bind(f.repos.bucketRepo)
    f.repos.bucketRepo.loadState = async (id: number) => {
      stateCalls.push(id)
      return loadState(id)
    }

    const rows = await (await app.request('/api/pending', { headers: auth })).json()
    expect(calls.sort()).toEqual([runId, otherRun].sort())
    expect(stateCalls.sort()).toEqual([runId, otherRun].sort())
    expect(maxInFlight).toBe(2)
    expect(rows.map((r: any) => r.costPpm)).toEqual([5000, 5000, 250])
  })
})
