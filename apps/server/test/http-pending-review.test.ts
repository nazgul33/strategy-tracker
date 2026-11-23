import { describe, test, expect } from 'bun:test'
import { feeCents } from '@st/core/money'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, json, loginAs, createRun } from './http-fakes'
import { NO_SNAPSHOT } from './booking-fakes'

describe('http pending: vision review surface', () => {
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

  test('GET /api/pending exposes hasImage and the detected snapshot', async () => {
    const { app, auth, addPending, addImage } = await setup()
    await addImage(7)
    await addPending({ captureId: 7, ...DETECTED })
    await addPending({ captureId: 8, ...DETECTED })
    await addPending({ captureId: null, ...DETECTED })
    const rows = await (await app.request('/api/pending', { headers: auth })).json()
    expect(rows.map((r: any) => r.hasImage)).toEqual([true, false, false])
    expect(rows[0].detected).toEqual({ side: 'buy', shares: 3, price: '100000', filledOn: '2026-11-10', fee: 12 })
    expect(rows[0].price).toBe('100000')
    expect(rows[0].shares).toBe(3)
  })

  test('GET /api/pending never carries image bytes', async () => {
    const { app, auth, addPending, addImage } = await setup()
    await addImage(7)
    await addPending({ captureId: 7, ...DETECTED })
    const text = await (await app.request('/api/pending', { headers: auth })).text()
    expect(text).not.toContain('bytes')
    expect(text).not.toContain('png-bytes')
  })

  test('GET /api/pending reports detected null for a legacy row without detectedAt', async () => {
    const { app, auth, addPending } = await setup()
    await addPending({ captureId: 7, detectedSide: null, detectedShares: null, detectedPrice: null, detectedFilledOn: null, detectedFee: null, detectedAt: null })
    const rows = await (await app.request('/api/pending', { headers: auth })).json()
    expect(rows[0].detected).toBeNull()
  })

  test('GET /api/pending keeps detected as an object of nulls when vision missed fields on a snapshotted row', async () => {
    const { app, auth, addPending } = await setup()
    await addPending({ captureId: 7, detectedSide: 'buy', detectedShares: 3, detectedPrice: null, detectedFilledOn: null, detectedFee: null, detectedAt: '2026-11-10 09:00:00' })
    const rows = await (await app.request('/api/pending', { headers: auth })).json()
    expect(rows[0].detected).toEqual({ side: 'buy', shares: 3, price: null, filledOn: null, fee: null })
  })

  test('GET /api/pending exposes the run cost ppm so the client can derive a fee as qty and price change', async () => {
    const { app, auth, addPending } = await setup(5000)
    await addPending({ captureId: 7, ...DETECTED })
    const rows = await (await app.request('/api/pending', { headers: auth })).json()
    expect(rows[0].costPpm).toBe(5000)
    expect(rows[0]).not.toHaveProperty('autoFeeCents')
  })

  test('GET /api/pending leaves the fee_override column out, which the real repository returns on every row', async () => {
    const { app, auth, addPending } = await setup()
    await addPending({ captureId: 7, ...DETECTED, feeOverride: null })
    const rows = await (await app.request('/api/pending', { headers: auth })).json()
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toHaveProperty('feeOverride')
    expect(rows[0].shares).toBe(3)
  })

  test('POST confirm forwards side and feeCents overrides', async () => {
    const { f, addPending, post } = await setup()
    const pid = await addPending({ side: 'sell' })
    const res = await post(`/api/pending/${pid}/confirm`, { overrides: { side: 'buy', feeCents: 42 } })
    expect(res.status).toBe(200)
    expect(f.fills).toHaveLength(1)
    expect(f.fills[0].side).toBe('buy')
    expect(f.fills[0].fee).toBe(42)
  })

  test('POST confirm with feeCents null recomputes the fee from the run cost ppm', async () => {
    const { f, addPending, post } = await setup(5000)
    const pid = await addPending({ fee: 99 })
    expect((await post(`/api/pending/${pid}/confirm`, { overrides: { feeCents: null } })).status).toBe(200)
    expect(f.fills[0].fee).toBe(feeCents(100000n, 3, 5000))
  })

  test('POST confirm with keepImage true keeps the image', async () => {
    const { f, addPending, addImage, post } = await setup()
    await addImage(7)
    const pid = await addPending({ captureId: 7, ...DETECTED })
    expect((await post(`/api/pending/${pid}/confirm`, { keepImage: true })).status).toBe(200)
    expect(f.captureImages).toHaveLength(1)
    expect(f.captureImages[0].keep).toBe(true)
    expect(f.visionReviews).toHaveLength(1)
  })

  test('POST confirm without keepImage sweeps the image', async () => {
    const { f, addPending, addImage, post } = await setup()
    await addImage(7)
    const pid = await addPending({ captureId: 7, ...DETECTED })
    expect((await post(`/api/pending/${pid}/confirm`, { overrides: { shares: 2 } })).status).toBe(200)
    expect(f.captureImages).toHaveLength(0)
    expect(f.visionReviews).toHaveLength(0)
  })

  test('POST reject with keepImage true keeps the image', async () => {
    const { f, addPending, addImage, post } = await setup()
    await addImage(7)
    const pid = await addPending({ captureId: 7, ...DETECTED })
    expect((await post(`/api/pending/${pid}/reject`, { keepImage: true })).status).toBe(200)
    expect(f.captureImages).toHaveLength(1)
    expect(f.captureImages[0].keep).toBe(true)
    expect(f.visionReviews).toHaveLength(1)
    expect(f.visionReviews[0].outcome).toBe('rejected')
  })

  test('POST reject without a body sweeps the image', async () => {
    const { f, addPending, addImage, post } = await setup()
    await addImage(7)
    const pid = await addPending({ captureId: 7, ...DETECTED })
    expect((await post(`/api/pending/${pid}/reject`)).status).toBe(200)
    expect(f.captureImages).toHaveLength(0)
  })
})
