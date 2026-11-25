import { describe, test, expect } from 'bun:test'
import { feeCents } from '@st/core/money'
import { newVrRun, seedCycle, seedFill, vrSetup } from './vr-http-fixture'

const BUY = { side: 'buy', shares: 10, price: '45.15', filledOn: '2026-11-04' }

async function withRun(costPpm?: number) {
  const s = await vrSetup()
  const id = await newVrRun(s, costPpm === undefined ? {} : { costPpm })
  return { ...s, id, url: `/api/vr/runs/${id}/fills` }
}

describe('POST /api/vr/runs/:id/fills', () => {
  test('books a manual fill and computes the fee from the run cost when absent', async () => {
    const s = await withRun()
    const res = await s.req('POST', s.url, BUY)
    expect(res.status).toBe(201)
    expect(s.f.vr.fills).toHaveLength(1)
    expect(res.body).toEqual({ id: s.f.vr.fills[0]!.id })
    expect(s.f.vr.fills[0]).toMatchObject({ runId: s.id, side: 'buy', shares: 10, price: 451_500n, filledOn: '2026-11-04', source: 'manual', fee: feeCents(451_500n, 10, 700) })
  })

  test('uses the run own cost, so a free run gets no fee', async () => {
    const s = await withRun(0)
    await s.req('POST', s.url, BUY)
    expect(s.f.vr.fills[0]!.fee).toBe(0)
  })

  test('an explicit fee wins, in cents', async () => {
    const s = await withRun()
    await s.req('POST', s.url, { ...BUY, fee: '1.25' })
    expect(s.f.vr.fills[0]!.fee).toBe(125)
    await s.req('POST', s.url, { ...BUY, fee: '0' })
    expect(s.f.vr.fills[1]!.fee).toBe(0)
  })

  const bad: [string, Record<string, unknown>][] = [
    ['invalid-side', { side: 'hold' }], ['invalid-side', { side: undefined }],
    ['invalid-shares', { shares: 0 }], ['invalid-shares', { shares: 1.5 }], ['invalid-shares', { shares: '3' }], ['invalid-shares', { shares: 2_147_483_648 }],
    ['invalid-price', { price: '0' }], ['invalid-price', { price: 'abc' }], ['invalid-price', { price: '1.23456' }], ['invalid-price', { price: 45.15 }], ['invalid-price', { price: '-1' }],
    ['invalid-fee', { fee: '-1' }], ['invalid-fee', { fee: 'x' }], ['invalid-fee', { fee: 1 }], ['invalid-fee', { fee: '21474836.48' }],
    ['invalid-date', { filledOn: '2026/11/01' }], ['invalid-date', { filledOn: '2026-13-45' }], ['invalid-date', { filledOn: undefined }],
    ['fill-date-in-future', { filledOn: '2026-11-11' }],
  ]
  for (const [code, patch] of bad) {
    test(`${code} for ${JSON.stringify(patch)}`, async () => {
      const s = await withRun()
      expect(await s.req('POST', s.url, { ...BUY, ...patch })).toEqual({ status: 422, body: { error: code } })
      expect(s.f.vr.fills).toHaveLength(0)
    })
  }

  test('today itself is accepted', async () => {
    const s = await withRun()
    expect((await s.req('POST', s.url, { ...BUY, filledOn: '2026-11-10' })).status).toBe(201)
  })

  test('a sell that would take the run below 0 shares is refused and changes nothing', async () => {
    const s = await withRun()
    await seedFill(s, s.id, 'buy', 10, 451_500n, 0, '2026-11-01')
    expect(await s.req('POST', s.url, { ...BUY, side: 'sell', shares: 11 })).toEqual({ status: 422, body: { error: 'vr-negative-shares' } })
    expect(s.f.vr.fills).toHaveLength(1)
    expect((await s.req('POST', s.url, { ...BUY, side: 'sell', shares: 10 })).status).toBe(201)
  })
})

describe('fills that the books cannot hold', () => {
  const HUGE = { side: 'buy', shares: 2_000_000_000, price: '50000.00', fee: '0', filledOn: '2026-11-04' }

  test('a price above $100,000 is accepted', async () => {
    const s = await withRun()
    expect((await s.req('POST', s.url, { ...BUY, shares: 1, price: '750000.00' })).status).toBe(201)
    expect((await s.req('GET', s.url)).body[0]).toMatchObject({ shares: 1, price: '7500000000' })
  })

  test('a fill that overflows the books is refused, nothing is written and the reads still work', async () => {
    const s = await withRun()
    await seedFill(s, s.id, 'buy', 10, 451_500n, 0, '2026-11-01')
    expect(await s.req('POST', s.url, HUGE)).toEqual({ status: 422, body: { error: 'vr-too-large' } })
    expect(s.f.vr.fills).toHaveLength(1)
    expect((await s.req('GET', s.url)).body).toHaveLength(1)
    expect((await s.req('GET', `/api/vr/runs/${s.id}`)).status).toBe(200)
    expect((await s.req('GET', '/api/vr/runs')).status).toBe(200)
  })

  test('the same through PUT leaves the fill as it was', async () => {
    const s = await withRun()
    const fillId = await seedFill(s, s.id, 'buy', 10, 451_500n, 0, '2026-11-01')
    expect(await s.req('PUT', `${s.url}/${fillId}`, HUGE)).toEqual({ status: 422, body: { error: 'vr-too-large' } })
    expect(s.f.vr.fills[0]).toMatchObject({ shares: 10, price: 451_500n, filledOn: '2026-11-01' })
    expect((await s.req('GET', `/api/vr/runs/${s.id}`)).status).toBe(200)
    expect((await s.req('GET', '/api/vr/runs')).status).toBe(200)
  })
})

describe('PUT /api/vr/runs/:id/fills/:fillId', () => {
  test('replaces the fill, recomputes an absent fee and keeps the source', async () => {
    const s = await withRun()
    const fillId = await s.f.repos.vrFillRepo.insert({ runId: s.id, side: 'buy', shares: 10, price: 451_500n, fee: 99, filledOn: '2026-11-01', source: 'capture' })
    const res = await s.req('PUT', `${s.url}/${fillId}`, { side: 'buy', shares: 5, price: '50', filledOn: '2026-11-02' })
    expect(res).toEqual({ status: 204, body: null })
    expect(s.f.vr.fills[0]).toMatchObject({ shares: 5, price: 500_000n, filledOn: '2026-11-02', fee: feeCents(500_000n, 5, 700), source: 'capture' })
  })

  test('turning a buy into a sell below 0 is refused', async () => {
    const s = await withRun()
    const fillId = await seedFill(s, s.id, 'buy', 10, 451_500n, 0, '2026-11-01')
    expect(await s.req('PUT', `${s.url}/${fillId}`, { ...BUY, side: 'sell' })).toEqual({ status: 422, body: { error: 'vr-negative-shares' } })
    expect(s.f.vr.fills[0]!.side).toBe('buy')
  })

  test('a bad body is a 422, a future date too', async () => {
    const s = await withRun()
    const fillId = await seedFill(s, s.id, 'buy', 10, 451_500n, 0, '2026-11-01')
    expect(await s.req('PUT', `${s.url}/${fillId}`, { ...BUY, shares: 0 })).toEqual({ status: 422, body: { error: 'invalid-shares' } })
    expect(await s.req('PUT', `${s.url}/${fillId}`, { ...BUY, filledOn: '2026-11-11' })).toEqual({ status: 422, body: { error: 'fill-date-in-future' } })
  })

  test('an unknown fill or another run fill is a 404', async () => {
    const s = await withRun()
    const other = await newVrRun(s, { name: 'other' })
    const theirs = await seedFill(s, other, 'buy', 10, 451_500n, 0, '2026-11-01')
    const expected = { status: 404, body: { error: 'not found' } }
    expect(await s.req('PUT', `${s.url}/${theirs}`, BUY)).toEqual(expected)
    expect(await s.req('PUT', `${s.url}/9999`, BUY)).toEqual(expected)
    expect(await s.req('PUT', `${s.url}/${theirs}`, { side: 'nonsense' })).toEqual(expected)
    expect(s.f.vr.fills[0]).toMatchObject({ runId: other, shares: 10 })
  })
})

describe('DELETE /api/vr/runs/:id/fills/:fillId', () => {
  test('removes the fill', async () => {
    const s = await withRun()
    const fillId = await seedFill(s, s.id, 'buy', 10, 451_500n, 0, '2026-11-01')
    expect(await s.req('DELETE', `${s.url}/${fillId}`)).toEqual({ status: 204, body: null })
    expect(s.f.vr.fills).toHaveLength(0)
  })

  test('deleting a buy that a sell depends on is refused and both rows stay', async () => {
    const s = await withRun()
    const buy = await seedFill(s, s.id, 'buy', 10, 451_500n, 0, '2026-11-01')
    await seedFill(s, s.id, 'sell', 10, 500_000n, 0, '2026-11-02')
    expect(await s.req('DELETE', `${s.url}/${buy}`)).toEqual({ status: 422, body: { error: 'vr-negative-shares' } })
    expect(s.f.vr.fills).toHaveLength(2)
  })

  test('an unknown fill or another run fill is a 404', async () => {
    const s = await withRun()
    const other = await newVrRun(s, { name: 'other' })
    const theirs = await seedFill(s, other, 'buy', 10, 451_500n, 0, '2026-11-01')
    expect(await s.req('DELETE', `${s.url}/${theirs}`)).toEqual({ status: 404, body: { error: 'not found' } })
    expect(await s.req('DELETE', `${s.url}/9999`)).toEqual({ status: 404, body: { error: 'not found' } })
    expect(s.f.vr.fills).toHaveLength(1)
  })
})

describe('GET /api/vr/runs/:id/fills', () => {
  test('newest first, price as a string, beforeCycle against the current cycle', async () => {
    const s = await withRun()
    await seedFill(s, s.id, 'buy', 10, 451_500n, 3, '2026-11-01')
    await seedFill(s, s.id, 'buy', 2, 460_000n, 1, '2026-11-04')
    expect((await s.req('GET', s.url)).body.map((f: { beforeCycle: boolean }) => f.beforeCycle)).toEqual([false, false])
    await seedCycle(s, s.id)
    const { status, body } = await s.req('GET', s.url)
    expect(status).toBe(200)
    expect(body).toEqual([
      { id: 2, side: 'buy', shares: 2, price: '460000', fee: 1, filledOn: '2026-11-04', source: 'manual', createdAt: body[0].createdAt, beforeCycle: false },
      { id: 1, side: 'buy', shares: 10, price: '451500', fee: 3, filledOn: '2026-11-01', source: 'manual', createdAt: body[1].createdAt, beforeCycle: true },
    ])
  })

  test('another run fills are not listed', async () => {
    const s = await withRun()
    const other = await newVrRun(s, { name: 'other' })
    await seedFill(s, other, 'buy', 1, 100_000n, 0, '2026-11-01')
    expect((await s.req('GET', s.url)).body).toEqual([])
  })
})
