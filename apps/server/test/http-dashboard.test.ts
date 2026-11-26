import { describe, test, expect } from 'bun:test'
import { createRun } from './http-fakes'
import { newVrRun, seedFill, vrSetup, type VrSetup } from './vr-http-fixture'

async function seeded(): Promise<{ s: VrSetup; mrId: number; vrId: number }> {
  const s = await vrSetup()
  const mrId = await createRun(s.app, s.auth, { name: 'mr', ticker: 'SOXL', costPpm: 0, poolCents: 100 })
  s.f.states.get(mrId)!.buckets[0] = { index: 0, state: 'held', shares: 118, buyPrice: 350_000n, buyFeeCents: 0, filledOn: '2026-11-03' }
  const vrId = await newVrRun(s, { name: 'vr', ticker: 'TQQQ', cashCents: 4_000_000 })
  await seedFill(s, vrId, 'buy', 277, 700_000n, 0, '2026-11-04')
  await s.f.repos.priceHistoryRepo.upsertMany([
    { ticker: 'SOXL', tradeDate: '2026-11-08', close: 350_000n },
    { ticker: 'SOXL', tradeDate: '2026-11-09', close: 361_800n },
    { ticker: 'TQQQ', tradeDate: '2026-11-06', close: 714_000n },
  ])
  return { s, mrId, vrId }
}

describe('GET /api/dashboard', () => {
  test('answers without a session as /api/vr/runs does', async () => {
    const { app } = await vrSetup()
    const a = await app.request('/api/dashboard')
    const b = await app.request('/api/vr/runs')
    expect(a.status).toBe(401)
    expect(a.status).toBe(b.status)
    expect(await a.json()).toEqual(await b.json())
  })

  test('answers both groups, prices as strings and cents as numbers', async () => {
    const { s, mrId, vrId } = await seeded()
    const { status, body } = await s.req('GET', '/api/dashboard')
    expect(status).toBe(200)
    expect(body.today).toBe('2026-11-10')
    expect(body.closeDate).toBe('2026-11-09')
    expect(body.groups[0].strategy).toBe('mean-reversion')
    expect(body.groups[1].strategy).toBe('value-rebalancing')
    const mr = body.groups[0].runs[0]
    expect(mr.id).toBe(mrId)
    expect(mr.close).toBe('361800')
    for (const k of ['stockCents', 'cashCents', 'valueCents', 'shares', 'waiting']) expect(typeof mr[k]).toBe('number')
    expect(typeof body.groups[0].totalCents).toBe('number')
    expect(mr.stockCents).toBe(426_924)
    expect(body.groups[1].runs[0]).toMatchObject({ id: vrId, close: '714000', closeDate: '2026-11-06', closeMark: 'older', stockCents: 1_977_780, shares: 277 })
    expect(body.groups[1].olderClose).toBe(true)
    expect(body.groups[0].olderClose).toBe(false)
  })

  test('reading the dashboard changes neither list nor run page', async () => {
    const { s, mrId, vrId } = await seeded()
    const read = async () => [
      await s.req('GET', '/api/runs'), await s.req('GET', `/api/runs/${mrId}`),
      await s.req('GET', '/api/vr/runs'), await s.req('GET', `/api/vr/runs/${vrId}`),
    ]
    const before = await read()
    expect((await s.req('GET', '/api/dashboard')).status).toBe(200)
    expect(await read()).toEqual(before)
    expect(before.every((r) => r.status === 200)).toBe(true)
  })
})
