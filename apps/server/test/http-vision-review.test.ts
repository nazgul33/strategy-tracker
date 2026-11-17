import { describe, test, expect } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, PASSWORD, json, loginAs } from './http-fakes'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10])

function review(captureId: number, pendingFillId: number, extra: Record<string, unknown> = {}) {
  return {
    runId: 1, captureId, pendingFillId, ticker: 'AAPL', outcome: 'confirmed',
    detectedSide: 'buy', detectedShares: 3, detectedPrice: 100000n, detectedFilledOn: '2026-11-10', detectedFee: null,
    finalSide: 'buy', finalShares: 2, finalPrice: 100000n, finalFilledOn: '2026-11-10', finalFee: 7,
    edited: true, createdAt: '2026-11-10 10:00:00', ...extra,
  }
}

async function setup() {
  const f = makeFakes()
  const app = createApp(makeDeps(f))
  const auth = await loginAs(app)
  const keep = async (captureId: number, createdAt: string, mime = 'image/png') => {
    await f.repos.captureImageRepo.insertIgnore({ captureId, mime, bytes: PNG, byteLen: PNG.length })
    await f.repos.captureImageRepo.setKeep(captureId)
    f.captureImages.find((x) => x.captureId === captureId)!.createdAt = createdAt
  }
  return { f, app, auth, keep }
}

describe('http vision reviews', () => {
  test('GET /api/vision-reviews is empty when nothing is kept', async () => {
    const { f, app, auth } = await setup()
    await f.repos.captureImageRepo.insertIgnore({ captureId: 1, mime: 'image/png', bytes: PNG, byteLen: PNG.length })
    const res = await app.request('/api/vision-reviews', { headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ entries: [] })
  })

  test('GET /api/vision-reviews groups frozen fills under their capture, newest first', async () => {
    const { f, app, auth, keep } = await setup()
    await keep(1, '2026-11-10 09:00:00')
    await keep(2, '2026-11-12 09:00:00', 'image/jpeg')
    await f.repos.visionReviewRepo.insertIgnore(review(1, 10, { createdAt: '2026-11-10 10:00:00' }) as any)
    await f.repos.visionReviewRepo.insertIgnore(review(2, 20, { ticker: 'MSFT', runId: 2, createdAt: '2026-11-12 10:00:00' }) as any)
    // a second resolution generation on capture 1, plus a same-second sibling: ordered by createdAt, then id
    await f.repos.visionReviewRepo.insertIgnore(review(1, 12, { outcome: 'rejected', edited: false, finalSide: null, finalShares: null, finalPrice: null, finalFilledOn: null, finalFee: null, createdAt: '2026-11-11 10:00:00' }) as any)
    await f.repos.visionReviewRepo.insertIgnore(review(1, 11, { createdAt: '2026-11-10 10:00:00' }) as any)

    const { entries } = await (await app.request('/api/vision-reviews', { headers: auth })).json()
    expect(entries.map((e: any) => e.captureId)).toEqual([2, 1])
    expect(entries[0]).toMatchObject({ captureId: 2, runId: 2, ticker: 'MSFT', mime: 'image/jpeg', byteLen: PNG.length, createdAt: '2026-11-12 09:00:00' })
    expect(entries[0].fills).toHaveLength(1)

    const fills = entries[1].fills
    expect(fills.map((x: any) => x.outcome)).toEqual(['confirmed', 'confirmed', 'rejected'])
    expect(fills[0]).toEqual({
      id: expect.any(Number), outcome: 'confirmed', edited: true,
      detected: { side: 'buy', shares: 3, price: '100000', filledOn: '2026-11-10', fee: null },
      final: { side: 'buy', shares: 2, price: '100000', filledOn: '2026-11-10', fee: 7 },
    })
    expect(fills[2].final).toBeNull()
    expect(fills[0].id).toBeLessThan(fills[1].id)
  })

  test('GET /api/vision-reviews lists entries in the order the repo returns them: newest first, same-time ties by capture id', async () => {
    const { f, app, auth, keep } = await setup()
    for (const [id, at] of [[1, '2026-11-10 09:00:00'], [2, '2026-11-12 09:00:00'], [3, '2026-11-12 09:00:00'], [4, '2026-11-11 09:00:00']] as const) {
      await keep(id, at)
      await f.repos.visionReviewRepo.insertIgnore(review(id, id * 10) as any)
    }
    const { entries } = await (await app.request('/api/vision-reviews', { headers: auth })).json()
    expect(entries.map((e: any) => e.captureId)).toEqual([3, 2, 4, 1])
  })

  test('GET /api/vision-reviews never carries image bytes', async () => {
    const { f, app, auth, keep } = await setup()
    await keep(1, '2026-11-10 09:00:00')
    await f.repos.visionReviewRepo.insertIgnore(review(1, 10) as any)
    const body = await (await app.request('/api/vision-reviews', { headers: auth })).json()
    expect(Object.keys(body.entries[0]).sort()).toEqual(['byteLen', 'captureId', 'createdAt', 'fills', 'mime', 'runId', 'ticker'])
  })

  test('DELETE /api/vision-reviews/:captureId removes the image and its frozen rows', async () => {
    const { f, app, auth, keep } = await setup()
    await keep(1, '2026-11-10 09:00:00')
    await keep(2, '2026-11-11 09:00:00')
    await f.repos.visionReviewRepo.insertIgnore(review(1, 10) as any)
    await f.repos.visionReviewRepo.insertIgnore(review(1, 11) as any)
    await f.repos.visionReviewRepo.insertIgnore(review(2, 20) as any)
    const res = await app.request('/api/vision-reviews/1', { method: 'DELETE', headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(f.captureImages.map((x) => x.captureId)).toEqual([2])
    expect(f.visionReviews.map((x) => x.captureId)).toEqual([2])
  })

  test('DELETE /api/vision-reviews/:captureId 404s for an unknown capture', async () => {
    const { f, app, auth, keep } = await setup()
    await keep(2, '2026-11-11 09:00:00')
    const res = await app.request('/api/vision-reviews/99', { method: 'DELETE', headers: auth })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not-found' })
    expect(f.captureImages).toHaveLength(1)
  })

  test('DELETE /api/vision-reviews/:captureId refuses an image that is not kept', async () => {
    const { f, app, auth } = await setup()
    await f.repos.captureImageRepo.insertIgnore({ captureId: 1, mime: 'image/png', bytes: PNG, byteLen: PNG.length })
    const res = await app.request('/api/vision-reviews/1', { method: 'DELETE', headers: auth })
    expect(res.status).toBe(404)
    expect(f.captureImages).toHaveLength(1)
  })

  test('vision review routes require credentials', async () => {
    const { app } = await setup()
    expect((await app.request('/api/vision-reviews')).status).toBe(401)
    expect((await app.request('/api/vision-reviews/1', { method: 'DELETE' })).status).toBe(401)
  })
})

describe('http capture image', () => {
  test('GET /api/captures/:id/image returns the bytes with the stored content type', async () => {
    const { app, auth, keep } = await setup()
    await keep(5, '2026-11-10 09:00:00', 'image/jpeg')
    const res = await app.request('/api/captures/5/image', { headers: auth })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toBe('private, max-age=300')
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true)
  })

  test('GET /api/captures/:id/image serves an unkept image too (the pending thumbnail)', async () => {
    const { f, app, auth } = await setup()
    await f.repos.captureImageRepo.insertIgnore({ captureId: 5, mime: 'image/png', bytes: PNG, byteLen: PNG.length })
    expect((await app.request('/api/captures/5/image', { headers: auth })).status).toBe(200)
  })

  test('GET /api/captures/:id/image 404s for an unknown capture', async () => {
    const { app, auth, keep } = await setup()
    await keep(5, '2026-11-10 09:00:00')
    for (const id of ['99', 'abc', '0', '-1', '1.5']) {
      const res = await app.request(`/api/captures/${id}/image`, { headers: auth })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not-found' })
    }
  })

  test('GET /api/captures/:id/image without credentials 401s and leaks no bytes', async () => {
    const { app, keep } = await setup()
    await keep(5, '2026-11-10 09:00:00')
    const res = await app.request('/api/captures/5/image')
    expect(res.status).toBe(401)
    expect(Buffer.from(await res.arrayBuffer()).includes(PNG)).toBe(false)
    expect((await app.request('/api/captures/5/image', { headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
  })

  test('GET /api/captures/:id/image works with the session cookie alone, as an <img> sends it', async () => {
    const { app, keep } = await setup()
    await keep(5, '2026-11-10 09:00:00')
    const login = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: json })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const res = await app.request('/api/captures/5/image', { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true)
  })
})
