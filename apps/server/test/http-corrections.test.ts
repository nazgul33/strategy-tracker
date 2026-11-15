import { describe, test, expect } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, PASSWORD } from './http-fakes'

describe('http corrections', () => {
  const json = { 'content-type': 'application/json' }
  async function seed() {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const login = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: json })
    const auth = { Authorization: `Bearer ${(await login.json()).token}` }
    const create = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r', ticker: 'SOXL', costPpm: 0, poolCents: 1_000_000 }), headers: { ...json, ...auth } })
    const runId = (await create.json()).id as number
    const post = (body: Record<string, unknown>) =>
      app.request(`/api/runs/${runId}/fills`, { method: 'POST', body: JSON.stringify(body), headers: { ...json, ...auth } })
    expect((await post({ side: 'buy', shares: 44, price: '60.00', fee: '0.00', filledOn: '2026-11-10' })).status).toBe(200)
    expect((await post({ side: 'sell', shares: 44, price: '66.03', fee: '2.03', filledOn: '2026-11-11' })).status).toBe(200)
    const sell = f.fills.find((x) => x.side === 'sell')!
    const id = await f.repos.correctionRepo.insert({
      runId, fillId: sell.id, captureId: null, side: 'sell', ticker: 'SOXL', bookedShares: 44, bookedFilledOn: '2026-11-11',
      bookedPrice: sell.price, bookedFee: sell.fee, proposedPrice: 640_700n, proposedFee: 203,
    })
    const call = (method: string, path: string) => app.request(`/api${path}`, { method, headers: auth })
    return { f, app, auth, runId, sell, id, call }
  }

  test('GET /corrections lists open rows with string prices and stale:false', async () => {
    const { runId, sell, id, call } = await seed()
    const res = await call('GET', '/corrections')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{
      id, runId, fillId: sell.id, captureId: null, side: 'sell', ticker: 'SOXL', bookedShares: 44, bookedFilledOn: '2026-11-11',
      bookedPrice: '660300', bookedFee: 203, proposedPrice: '640700', proposedFee: 203,
      status: 'open', createdAt: '2026-11-15 00:00:00', stale: false,
    }])
  })

  test('GET /corrections requires auth', async () => {
    const { app } = await seed()
    expect((await app.request('/api/corrections')).status).toBe(401)
  })

  test('apply -> 200 {ok, deltaCents}; again -> 409 correction-not-open', async () => {
    const { f, sell, id, call } = await seed()
    const res = await call('POST', `/corrections/${id}/apply`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deltaCents: -8624 })
    expect(f.fills.find((x) => x.id === sell.id)!.price).toBe(640_700n)
    expect(f.corrections.find((c) => c.id === id)!.status).toBe('applied')
    const again = await call('POST', `/corrections/${id}/apply`)
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ error: 'correction-not-open' })
    expect(await (await call('GET', '/corrections')).json()).toEqual([])
  })

  test('apply on a stale correction -> 409 correction-stale; GET shows stale:true', async () => {
    const { f, app, auth, runId, sell, id, call } = await seed()
    const put = await app.request(`/api/runs/${runId}/fills/${sell.id}`, {
      method: 'PUT', body: JSON.stringify({ qty: 44, priceCents: 6500, feeCents: 203 }), headers: { ...json, ...auth },
    })
    expect(put.status).toBe(200)
    const res = await call('POST', `/corrections/${id}/apply`)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'correction-stale' })
    expect(f.corrections.find((c) => c.id === id)!.status).toBe('open')
    expect((await (await call('GET', '/corrections')).json())[0].stale).toBe(true)
  })

  test('apply refused by rebook validation -> 422 with the kind, nothing changed', async () => {
    const { f, runId, sell, call } = await seed()
    // A zero price can never be rebooked: rebookFill's input validation rejects it as invalid-fill.
    const bad = await f.repos.correctionRepo.insert({
      runId, fillId: sell.id, captureId: null, side: 'sell', ticker: 'SOXL', bookedShares: 44, bookedFilledOn: '2026-11-11',
      bookedPrice: sell.price, bookedFee: sell.fee, proposedPrice: 0n, proposedFee: null,
    })
    const adjustsBefore = f.ledger.filter((l) => l.kind === 'adjust').length
    const res = await call('POST', `/corrections/${bad}/apply`)
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'invalid-fill' })
    expect(f.corrections.find((c) => c.id === bad)!.status).toBe('open')
    expect(f.fills.find((x) => x.id === sell.id)!.price).toBe(660_300n)
    expect(f.ledger.filter((l) => l.kind === 'adjust').length).toBe(adjustsBefore)
  })

  test('unknown id -> 404 correction-not-found for apply and dismiss', async () => {
    const { call } = await seed()
    for (const action of ['apply', 'dismiss']) {
      const res = await call('POST', `/corrections/999/${action}`)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'correction-not-found' })
    }
  })

  test('dismiss -> 200 {ok}; again -> 409 correction-not-open', async () => {
    const { f, sell, id, call } = await seed()
    const res = await call('POST', `/corrections/${id}/dismiss`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(f.corrections.find((c) => c.id === id)!.status).toBe('dismissed')
    expect(f.fills.find((x) => x.id === sell.id)!.price).toBe(660_300n)
    const again = await call('POST', `/corrections/${id}/dismiss`)
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ error: 'correction-not-open' })
  })
})
