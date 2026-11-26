import { describe, test, expect } from 'bun:test'
import { feeCents } from '@st/core/money'
import type { NewVrPending } from '../src/domain/vr/repo-types'
import { createRun, json } from './http-fakes'
import { newVrRun, vrSetup } from './vr-http-fixture'

const NOT_FOUND = { status: 404, body: { error: 'not found' } }
const NOT_PENDING = { status: 409, body: { error: 'vr-not-pending' } }
const GOOD = { side: 'buy', shares: 4, price: '44.39', filledOn: '2026-11-09' }

async function withRun() {
  const s = await vrSetup()
  const id = await newVrRun(s)
  const base = `/api/vr/runs/${id}/pending`
  const seed = async (over: Partial<NewVrPending> = {}, image = true) => {
    const row: NewVrPending = { runId: id, captureId: 7, side: 'buy', shares: 10, price: 451_500n, fee: null, filledOn: '2026-11-09', dateRead: true, dupPrice: null, orderPrice: null, ...over }
    const [pid] = await s.f.repos.vrPendingRepo.insertMany([row])
    if (image) await s.f.repos.captureImageRepo.insertIgnore({ captureId: row.captureId, mime: 'image/png', bytes: Buffer.from('x'), byteLen: 1 })
    return pid!
  }
  return { ...s, id, base, seed }
}

describe('GET /api/vr/runs/:id/pending', () => {
  test('waiting rows only, ascending date then id, in the exact wire shape', async () => {
    const s = await withRun()
    const late = await s.seed({ filledOn: '2026-11-11', dupPrice: 443_900n, orderPrice: 443_900n })
    const early = await s.seed({ filledOn: '2026-11-02', captureId: 8, fee: 32 }, false)
    const rejected = await s.seed({ filledOn: '2026-11-01' }, false)
    await s.req('POST', `${s.base}/${rejected}/reject`)
    const res = await s.req('GET', s.base)
    expect(res.status).toBe(200)
    expect(res.body.map((r: { id: number }) => r.id)).toEqual([early, late])
    expect(Object.keys(res.body[0]).sort()).toEqual(['captureId', 'createdAt', 'dateAfterToday', 'dateRead', 'dupPrice', 'fee', 'filledOn', 'hasImage', 'id', 'orderPrice', 'price', 'shares', 'side'])
    expect(res.body[0]).toEqual({
      id: early, captureId: 8, side: 'buy', shares: 10, price: '451500', fee: 32, filledOn: '2026-11-02', dateRead: true, dateAfterToday: false,
      dupPrice: null, orderPrice: null, hasImage: false, createdAt: expect.any(String),
    })
    expect(res.body[1]).toMatchObject({ id: late, dateAfterToday: true, hasImage: true, dupPrice: '443900', orderPrice: '443900', fee: null })
  })

  test('an empty run answers an empty list', async () => {
    const s = await withRun()
    expect(await s.req('GET', s.base)).toEqual({ status: 200, body: [] })
  })
})

describe('PUT /api/vr/runs/:id/pending/:pid', () => {
  test('204 and the row holds the typed values', async () => {
    const s = await withRun()
    const pid = await s.seed()
    expect(await s.req('PUT', `${s.base}/${pid}`, { ...GOOD, fee: '0.25' })).toEqual({ status: 204, body: null })
    expect(await s.f.repos.vrPendingRepo.get(s.id, pid)).toMatchObject({ shares: 4, price: 443_900n, fee: 25, filledOn: '2026-11-09' })
  })

  test('422 with the code, 409 for a decided row, 404 for an unknown id', async () => {
    const s = await withRun()
    const pid = await s.seed()
    expect(await s.req('PUT', `${s.base}/${pid}`, { ...GOOD, price: 'abc' })).toEqual({ status: 422, body: { error: 'invalid-price' } })
    expect(await s.req('PUT', `${s.base}/999`, GOOD)).toEqual(NOT_FOUND)
    await s.req('POST', `${s.base}/${pid}/reject`)
    expect(await s.req('PUT', `${s.base}/${pid}`, GOOD)).toEqual(NOT_PENDING)
  })
})

describe('POST /api/vr/runs/:id/pending/:pid/confirm', () => {
  test('201 with the new fill id; the fill is a capture fill and the row is confirmed', async () => {
    const s = await withRun()
    const pid = await s.seed()
    const res = await s.req('POST', `${s.base}/${pid}/confirm`)
    expect(res).toEqual({ status: 201, body: { fillId: s.f.vr.fills[0]!.id } })
    expect(s.f.vr.fills[0]).toMatchObject({ source: 'capture', fee: feeCents(451_500n, 10, 700) })
    expect((await s.req('GET', s.base)).body).toEqual([])
  })

  test('409 for a decided row, 404 for an unknown id, 422 for a row dated after today', async () => {
    const s = await withRun()
    const done = await s.seed()
    const future = await s.seed({ filledOn: '2026-11-11', captureId: 8 }, false)
    await s.req('POST', `${s.base}/${done}/confirm`)
    expect(await s.req('POST', `${s.base}/${done}/confirm`)).toEqual(NOT_PENDING)
    expect(await s.req('POST', `${s.base}/999/confirm`)).toEqual(NOT_FOUND)
    expect(await s.req('POST', `${s.base}/${future}/confirm`)).toEqual({ status: 422, body: { error: 'fill-date-in-future' } })
    expect(s.f.vr.fills).toHaveLength(1)
  })
})

describe('POST /api/vr/runs/:id/pending/:pid/reject', () => {
  test('204, then 409 and 404', async () => {
    const s = await withRun()
    const pid = await s.seed()
    expect(await s.req('POST', `${s.base}/${pid}/reject`)).toEqual({ status: 204, body: null })
    expect(await s.req('POST', `${s.base}/${pid}/reject`)).toEqual(NOT_PENDING)
    expect(await s.req('POST', `${s.base}/999/reject`)).toEqual(NOT_FOUND)
    expect(s.f.captureImages).toHaveLength(0)
  })
})

describe('POST /api/vr/runs/:id/pending/confirm-all', () => {
  test('200 with the result', async () => {
    const s = await withRun()
    await s.seed()
    const future = await s.seed({ filledOn: '2026-11-11', captureId: 8 }, false)
    await s.seed({ dupPrice: 443_900n, captureId: 9 }, false)
    await s.seed({ dateRead: false, captureId: 10 }, false)
    expect(await s.req('POST', `${s.base}/confirm-all`)).toEqual({
      status: 200, body: { confirmed: 1, refused: [{ id: future, error: 'fill-date-in-future' }], skippedDuplicates: 1, skippedUndated: 1 },
    })
  })

  test('nothing waiting gives zeros', async () => {
    const s = await withRun()
    expect(await s.req('POST', `${s.base}/confirm-all`)).toEqual({ status: 200, body: { confirmed: 0, refused: [], skippedDuplicates: 0, skippedUndated: 0 } })
  })
})

describe('run and row scoping, authentication', () => {
  test('an MR run, a malformed id and an unknown run answer 404 on every route', async () => {
    const s = await withRun()
    const mr = await createRun(s.app, s.auth, { name: 'mr', ticker: 'AAPL', costPpm: 0, poolCents: 100 })
    for (const rid of [mr, 'abc', 999_999]) {
      const base = `/api/vr/runs/${rid}/pending`
      expect(await s.req('GET', base)).toEqual(NOT_FOUND)
      expect(await s.req('PUT', `${base}/1`, GOOD)).toEqual(NOT_FOUND)
      expect(await s.req('POST', `${base}/1/confirm`)).toEqual(NOT_FOUND)
      expect(await s.req('POST', `${base}/1/reject`)).toEqual(NOT_FOUND)
      expect(await s.req('POST', `${base}/confirm-all`)).toEqual(NOT_FOUND)
    }
  })

  test("another run's pending id answers 404 on PUT, confirm and reject", async () => {
    const s = await withRun()
    const other = await newVrRun(s, { name: 'other' })
    const [foreign] = await s.f.repos.vrPendingRepo.insertMany([{ runId: other, captureId: 9, side: 'buy', shares: 1, price: 10_000n, fee: 0, filledOn: '2026-11-09', dateRead: true, dupPrice: null, orderPrice: null }])
    expect(await s.req('PUT', `${s.base}/${foreign}`, GOOD)).toEqual(NOT_FOUND)
    expect(await s.req('POST', `${s.base}/${foreign}/confirm`)).toEqual(NOT_FOUND)
    expect(await s.req('POST', `${s.base}/${foreign}/reject`)).toEqual(NOT_FOUND)
    expect((await s.f.repos.vrPendingRepo.get(other, foreign!))!.status).toBe('pending')
  })

  test('no token answers 401 on every route', async () => {
    const s = await withRun()
    for (const [method, path] of [['GET', s.base], ['PUT', `${s.base}/1`], ['POST', `${s.base}/1/confirm`], ['POST', `${s.base}/1/reject`], ['POST', `${s.base}/confirm-all`]] as const) {
      const res = await s.app.request(path, { method, headers: json, body: method === 'PUT' ? JSON.stringify(GOOD) : undefined })
      expect(res.status).toBe(401)
    }
  })
})

describe('pendingCount', () => {
  test('the detail and the list carry the number of waiting rows', async () => {
    const s = await withRun()
    await s.seed()
    const second = await s.seed({ price: 443_900n }, false)
    const rejected = await s.seed({ price: 400_000n }, false)
    await s.req('POST', `${s.base}/${rejected}/reject`)
    expect((await s.req('GET', `/api/vr/runs/${s.id}`)).body.pendingCount).toBe(2)
    expect((await s.req('GET', '/api/vr/runs')).body[0].pendingCount).toBe(2)
    await s.req('POST', `${s.base}/${second}/confirm`)
    expect((await s.req('GET', `/api/vr/runs/${s.id}`)).body.pendingCount).toBe(1)
    expect((await s.req('GET', '/api/vr/runs')).body[0].pendingCount).toBe(1)
  })
})
