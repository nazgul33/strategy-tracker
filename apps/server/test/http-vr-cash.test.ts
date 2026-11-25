import { describe, test, expect } from 'bun:test'
import { newVrRun, seedCycle, vrSetup } from './vr-http-fixture'

async function withRun() {
  const s = await vrSetup()
  const id = await newVrRun(s)
  const openId = s.f.vr.cash[0]!.id
  return { ...s, id, openId, url: `/api/vr/runs/${id}/cash` }
}
const dep = { kind: 'deposit', amountCents: 5_000, movedOn: '2026-11-05' }

describe('POST /api/vr/runs/:id/cash', () => {
  test('books a deposit, a withdrawal and an adjustment', async () => {
    const s = await withRun()
    const a = await s.req('POST', s.url, { ...dep, note: 'bonus' })
    expect(a.status).toBe(201)
    const b = await s.req('POST', s.url, { kind: 'withdraw', amountCents: -2_000, movedOn: '2026-11-06' })
    const c = await s.req('POST', s.url, { kind: 'adjust', amountCents: -7, movedOn: '2026-11-07', note: '' })
    expect([b.status, c.status]).toEqual([201, 201])
    expect(s.f.vr.cash.slice(1)).toMatchObject([
      { id: a.body.id, runId: s.id, kind: 'deposit', amountCents: 5_000, movedOn: '2026-11-05', note: 'bonus', cycleId: null },
      { id: b.body.id, kind: 'withdraw', amountCents: -2_000, note: null },
      { id: c.body.id, kind: 'adjust', amountCents: -7, note: null },
    ])
  })

  test('an adjustment may be positive', async () => {
    const s = await withRun()
    expect((await s.req('POST', s.url, { kind: 'adjust', amountCents: 7, movedOn: '2026-11-07' })).status).toBe(201)
  })

  const bad: [string, Record<string, unknown>][] = [
    ['invalid-kind', { kind: 'bonus' }], ['invalid-kind', { kind: undefined }],
    ['invalid-amount', { amountCents: 2_147_483_648 }], ['invalid-amount', { amountCents: -1 }], ['invalid-amount', { amountCents: 0 }], ['invalid-amount', { amountCents: 1.5 }], ['invalid-amount', { amountCents: '5' }],
    ['invalid-amount', { kind: 'withdraw', amountCents: 5 }], ['invalid-amount', { kind: 'withdraw', amountCents: 0 }],
    ['invalid-amount', { kind: 'adjust', amountCents: 0 }], ['invalid-amount', { kind: 'adjust', amountCents: 0.5 }],
    ['invalid-date', { movedOn: '05-11-2026' }], ['invalid-date', { movedOn: '2026-02-30' }], ['invalid-date', { movedOn: undefined }],
    ['cash-date-in-future', { movedOn: '2026-11-11' }],
    ['invalid-note', { note: 5 }], ['invalid-note', { note: 'x'.repeat(256) }],
    ['vr-open-required', { kind: 'open' }],
  ]
  for (const [code, patch] of bad) {
    test(`${code} for ${JSON.stringify(patch).slice(0, 60)}`, async () => {
      const s = await withRun()
      expect(await s.req('POST', s.url, { ...dep, ...patch })).toEqual({ status: 422, body: { error: code } })
      expect(s.f.vr.cash).toHaveLength(1)
    })
  }

  test('a note of exactly 255 characters is kept', async () => {
    const s = await withRun()
    await s.req('POST', s.url, { ...dep, note: 'x'.repeat(255) })
    expect(s.f.vr.cash[1]!.note).toHaveLength(255)
  })

  test('a withdrawal may take the Pool negative', async () => {
    const s = await withRun()
    expect((await s.req('POST', s.url, { kind: 'withdraw', amountCents: -2_000_000, movedOn: '2026-11-06' })).status).toBe(201)
  })
})

describe('cash moves that the books cannot hold', () => {
  // A buy that leaves the Pool a few hundred million cents short of the safe-integer limit.
  async function nearLimit() {
    const s = await withRun()
    await s.f.repos.vrFillRepo.insert({ runId: s.id, side: 'buy', shares: 1_000_000_000, price: 900_719_900n, fee: 0, filledOn: '2026-11-01', source: 'manual' })
    expect((await s.req('GET', `/api/vr/runs/${s.id}`)).status).toBe(200)
    return s
  }
  const withdraw = { kind: 'withdraw', amountCents: -2_000_000_000, movedOn: '2026-11-06' }

  test('a move that overflows the books is refused on add and nothing is written', async () => {
    const s = await nearLimit()
    expect(await s.req('POST', s.url, withdraw)).toEqual({ status: 422, body: { error: 'vr-too-large' } })
    expect(s.f.vr.cash).toHaveLength(1)
    expect((await s.req('GET', `/api/vr/runs/${s.id}`)).status).toBe(200)
  })

  test('the same through PUT leaves the move as it was', async () => {
    const s = await nearLimit()
    const { body } = await s.req('POST', s.url, { ...withdraw, amountCents: -100 })
    expect(await s.req('PUT', `${s.url}/${body.id}`, { amountCents: -2_000_000_000, movedOn: '2026-11-06' })).toEqual({ status: 422, body: { error: 'vr-too-large' } })
    expect(s.f.vr.cash[1]!.amountCents).toBe(-100)
  })
})

describe('a cash delete that the books cannot hold', () => {
  test('deleting a withdrawal that keeps the Pool under the safe-integer limit is refused and the move stays', async () => {
    const s = await withRun()
    const fills = `/api/vr/runs/${s.id}/fills`
    const withdraw = await s.req('POST', s.url, { kind: 'withdraw', amountCents: -2_000_000_000, movedOn: '2026-11-05' })
    expect((await s.req('POST', s.url, { kind: 'deposit', amountCents: 1_000_000_000, movedOn: '2026-11-05' })).status).toBe(201)
    const big = { shares: 1_000_000_000, fee: '0', filledOn: '2026-11-04' }
    expect((await s.req('POST', fills, { ...big, side: 'buy', price: '0.0001' })).status).toBe(201)
    expect((await s.req('POST', fills, { ...big, side: 'sell', price: '90071.9925' })).status).toBe(201)
    expect((await s.req('GET', `/api/vr/runs/${s.id}`)).status).toBe(200)
    expect(await s.req('DELETE', `${s.url}/${withdraw.body.id}`)).toEqual({ status: 422, body: { error: 'vr-too-large' } })
    expect(s.f.vr.cash.map((m) => m.id)).toContain(withdraw.body.id)
    expect(s.f.vr.cash).toHaveLength(3)
    expect((await s.req('GET', s.url)).body).toHaveLength(3)
    expect((await s.req('GET', `/api/vr/runs/${s.id}`)).status).toBe(200)
    expect((await s.req('GET', '/api/vr/runs')).status).toBe(200)
  })
})

describe('PUT /api/vr/runs/:id/cash/:cashId', () => {
  test('edits amount, date and note of a deposit; the kind stays', async () => {
    const s = await withRun()
    const { body } = await s.req('POST', s.url, { ...dep, note: 'old' })
    const res = await s.req('PUT', `${s.url}/${body.id}`, { kind: 'withdraw', amountCents: 6_000, movedOn: '2026-11-08' })
    expect(res).toEqual({ status: 204, body: null })
    expect(s.f.vr.cash[1]).toMatchObject({ kind: 'deposit', amountCents: 6_000, movedOn: '2026-11-08', note: null })
  })

  test('the open move keeps its kind; amount and date can change', async () => {
    const s = await withRun()
    expect(await s.req('PUT', `${s.url}/${s.openId}`, { amountCents: 2_000_000, movedOn: '2026-11-01' })).toEqual({ status: 204, body: null })
    expect(s.f.vr.cash[0]).toMatchObject({ kind: 'open', amountCents: 2_000_000, movedOn: '2026-11-01' })
  })

  test('the open amount must stay positive', async () => {
    const s = await withRun()
    for (const amountCents of [0, -5]) {
      expect(await s.req('PUT', `${s.url}/${s.openId}`, { amountCents, movedOn: '2026-11-01' })).toEqual({ status: 422, body: { error: 'invalid-amount' } })
    }
    expect(s.f.vr.cash[0]!.amountCents).toBe(1_000_000)
  })

  test('the stored kind sets the sign rule, and dates and notes are checked', async () => {
    const s = await withRun()
    const { body } = await s.req('POST', s.url, { kind: 'withdraw', amountCents: -100, movedOn: '2026-11-05' })
    const put = (b: Record<string, unknown>) => s.req('PUT', `${s.url}/${body.id}`, b)
    expect(await put({ amountCents: 100, movedOn: '2026-11-05' })).toEqual({ status: 422, body: { error: 'invalid-amount' } })
    expect(await put({ amountCents: -100, movedOn: 'x' })).toEqual({ status: 422, body: { error: 'invalid-date' } })
    expect(await put({ amountCents: -100, movedOn: '2026-11-11' })).toEqual({ status: 422, body: { error: 'cash-date-in-future' } })
    expect(await put({ amountCents: -100, movedOn: '2026-11-05', note: 'y'.repeat(300) })).toEqual({ status: 422, body: { error: 'invalid-note' } })
  })

  test('another run move or an unknown move is a 404', async () => {
    const s = await withRun()
    const other = await newVrRun(s, { name: 'other' })
    const theirs = s.f.vr.cash.find((m) => m.runId === other)!.id
    const body = { amountCents: 1, movedOn: '2026-11-01' }
    expect(await s.req('PUT', `${s.url}/${theirs}`, body)).toEqual({ status: 404, body: { error: 'not found' } })
    expect(await s.req('PUT', `${s.url}/9999`, body)).toEqual({ status: 404, body: { error: 'not found' } })
    expect(s.f.vr.cash.find((m) => m.id === theirs)!.amountCents).toBe(1_000_000)
  })
})

describe('DELETE /api/vr/runs/:id/cash/:cashId', () => {
  test('removes a deposit', async () => {
    const s = await withRun()
    const { body } = await s.req('POST', s.url, dep)
    expect(await s.req('DELETE', `${s.url}/${body.id}`)).toEqual({ status: 204, body: null })
    expect(s.f.vr.cash).toHaveLength(1)
  })

  test('the open move cannot be deleted', async () => {
    const s = await withRun()
    expect(await s.req('DELETE', `${s.url}/${s.openId}`)).toEqual({ status: 422, body: { error: 'vr-open-required' } })
    expect(s.f.vr.cash).toHaveLength(1)
  })

  test('another run move or an unknown move is a 404', async () => {
    const s = await withRun()
    const other = await newVrRun(s, { name: 'other' })
    const theirs = s.f.vr.cash.find((m) => m.runId === other)!.id
    expect(await s.req('DELETE', `${s.url}/${theirs}`)).toEqual({ status: 404, body: { error: 'not found' } })
    expect(await s.req('DELETE', `${s.url}/9999`)).toEqual({ status: 404, body: { error: 'not found' } })
    expect(s.f.vr.cash).toHaveLength(2)
  })
})

describe('GET /api/vr/runs/:id/cash', () => {
  test('newest first with beforeCycle against the current cycle', async () => {
    const s = await withRun()
    await s.req('POST', s.url, { ...dep, movedOn: '2026-11-05' })
    expect((await s.req('GET', s.url)).body.map((m: { beforeCycle: boolean }) => m.beforeCycle)).toEqual([false, false])
    await seedCycle(s, s.id)
    const { status, body } = await s.req('GET', s.url)
    expect(status).toBe(200)
    expect(body.map((m: { kind: string; movedOn: string; beforeCycle: boolean }) => [m.kind, m.movedOn, m.beforeCycle])).toEqual([
      ['open', '2026-11-10', false], ['deposit', '2026-11-05', false],
    ])
    expect(body[0]).toMatchObject({ amountCents: 1_000_000, note: null, cycleId: null })
    await s.req('POST', s.url, { ...dep, movedOn: '2026-11-02' })
    const again = (await s.req('GET', s.url)).body
    expect(again.map((m: { movedOn: string }) => m.movedOn)).toEqual(['2026-11-10', '2026-11-05', '2026-11-02'])
    expect(again[2].beforeCycle).toBe(true)
  })
})
