import { describe, test, expect } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, PASSWORD } from './http-fakes'

// Replay-failure path of PUT /api/runs/:id/fills/:fillId, end to end through the
// HTTP layer. The domain-level pin lives in rebooking.test.ts.
describe('PUT fill edit that breaks the replay', () => {
  const json = { 'content-type': 'application/json' }
  const loginAs = async (app: ReturnType<typeof createApp>) => {
    const res = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: json })
    return { Authorization: `Bearer ${(await res.json()).token}` }
  }
  const postFill = async (app: ReturnType<typeof createApp>, auth: Record<string, string>, id: number, body: Record<string, unknown>) => {
    const res = await app.request(`/api/runs/${id}/fills`, { method: 'POST', body: JSON.stringify(body), headers: { ...json, ...auth } })
    expect(res.status).toBe(200)
  }
  const put = (app: ReturnType<typeof createApp>, auth: Record<string, string>, id: number, fillId: number, body: Record<string, unknown>) =>
    app.request(`/api/runs/${id}/fills/${fillId}`, { method: 'PUT', body: JSON.stringify(body), headers: { ...json, ...auth } })

  async function setup() {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const res = await app.request('/api/runs', {
      method: 'POST', body: JSON.stringify({ name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 1000000 }), headers: { ...json, ...auth },
    })
    expect(res.status).toBe(201)
    const id = (await res.json()).id as number
    await postFill(app, auth, id, { side: 'buy', shares: 10, price: '10.0000', filledOn: '2026-11-10' })
    await postFill(app, auth, id, { side: 'sell', shares: 8, price: '11.0000', filledOn: '2026-11-10' })
    return { f, app, auth, id }
  }

  test('shrinking the buy below a later sell -> 422 too-many-shares, nothing written', async () => {
    const { f, app, auth, id } = await setup()
    // sanity: both fills share bucket 0, so the sell replays against the edited buy
    expect(f.fills.map((x: any) => [x.id, x.side, x.bucketIdx, x.shares])).toEqual([[1, 'buy', 0, 10], [2, 'sell', 0, 8]])
    const before = {
      fills: structuredClone(f.fills),
      state: structuredClone(f.states.get(id)!),
      ledger: structuredClone(f.ledger),
    }

    const res = await put(app, auth, id, 1, { qty: 5, priceCents: 1000, feeCents: 0 })

    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'too-many-shares' })
    expect(f.fills).toEqual(before.fills)
    expect(f.states.get(id)).toEqual(before.state)
    expect(f.ledger).toEqual(before.ledger)
  })

  test('a still-valid shrink on the same history succeeds (the failure above is the replay, not the setup)', async () => {
    const { f, app, auth, id } = await setup()
    const res = await put(app, auth, id, 1, { qty: 8, priceCents: 1000, feeCents: 0 })
    expect(res.status).toBe(200)
    expect(f.fills[0].shares).toBe(8)
    expect(f.states.get(id)!.buckets[0]!.shares).toBe(0)
  })
})
