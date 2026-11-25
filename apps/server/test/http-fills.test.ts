import { describe, test, expect } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, PASSWORD, json, loginAs, createRun, postFill } from './http-fakes'

describe('fill edit + delete endpoints', () => {

  test('PUT rebooks a buy fill: row patched, state rebuilt, adjust booked, views updated', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    // seeded run: pool 100000, one seed buy 100 @ 10.0000, cash overwritten to 85547
    const id = await createRun(app, auth, {
      name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 100000,
      seed: { cashCents: 85547, buckets: [{ shares: 100, buyPrice: '10.0000', filledOn: '2026-11-01' }] },
    })
    const res = await app.request(`/api/runs/${id}/fills/1`, {
      method: 'PUT', body: JSON.stringify({ qty: 300, priceCents: 1005, feeCents: 2855 }), headers: { ...json, ...auth },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deltaCents: -289902 }) // -204355 - 85547
    // fill row patched: price '10.05' = 100500 myriadths
    expect(f.fills.length).toBe(1)
    expect(f.fills[0].shares).toBe(300)
    expect(f.fills[0].price).toBe(100500n)
    expect(f.fills[0].fee).toBe(2855)
    // state rebuilt from history: 100000 - (301500 + 2855) = -204355
    const state = f.states.get(id)!
    expect(state.cashCents).toBe(-204355)
    expect(state.buckets[0].shares).toBe(300)
    expect(state.buckets[0].state).toBe('held')
    // books: seed row + one 'adjust' for the cash difference vs stored state
    expect(f.ledger.length).toBe(2)
    expect(f.ledger[0].kind).toBe('seed')
    expect(f.ledger[1].kind).toBe('adjust')
    expect(f.ledger[1].amountCents).toBe(-289902) // -204355 - 85547
    expect(JSON.parse(f.ledger[1].ref!)).toEqual({ fillId: 1, bookedOn: '2026-11-10', reason: 'fill-edit' })
    // read paths see the new numbers
    const run = await (await app.request(`/api/runs/${id}`, { headers: auth })).json()
    expect(run.progressView.cashCents).toBe(-204355)
    const rows = await (await app.request(`/api/runs/${id}/fills`, { headers: auth })).json()
    expect(rows.length).toBe(1)
    expect(rows[0].price).toBe('100500')
    expect(rows[0].shares).toBe(300)
    expect(rows[0].fee).toBe(2855)
  })

  test('PUT priceCents converts to 2-decimal price (5 -> "0.05")', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 100000 })
    await postFill(app, auth, id, { side: 'buy', shares: 100, price: '10.0000', filledOn: '2026-11-10' })
    const res = await app.request(`/api/runs/${id}/fills/1`, {
      method: 'PUT', body: JSON.stringify({ qty: 100, priceCents: 5, feeCents: 0 }), headers: { ...json, ...auth },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deltaCents: 99500 }) // cash 0 -> 99500
    expect(f.fills[0].price).toBe(500n) // '0.05'
    expect(f.states.get(id)!.cashCents).toBe(99500) // 100000 - 500
  })

  test('PUT feeCents null recomputes the fee from run costPpm', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r1', ticker: 'AAPL', costPpm: 1000, poolCents: 200000 })
    await postFill(app, auth, id, { side: 'buy', shares: 100, price: '10.0000', filledOn: '2026-11-10' })
    expect(f.fills[0].fee).toBe(100) // auto-fee on the original booking
    const res = await app.request(`/api/runs/${id}/fills/1`, {
      method: 'PUT', body: JSON.stringify({ qty: 100, priceCents: 1234, feeCents: null }), headers: { ...json, ...auth },
    })
    expect(res.status).toBe(200)
    expect(f.fills[0].price).toBe(123400n) // '12.34'
    expect(f.fills[0].fee).toBe(123) // roundDiv(123400*100*1000, 1e8)
    expect(f.states.get(id)!.cashCents).toBe(76477) // 200000 - 123400 - 123
  })

  test('PUT on a sell fill -> 200, price edited', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 100000 })
    await postFill(app, auth, id, { side: 'buy', shares: 2, price: '10.0000', filledOn: '2026-11-10' })
    await postFill(app, auth, id, { side: 'sell', shares: 2, price: '12.0000', filledOn: '2026-11-10' })
    const res = await app.request(`/api/runs/${id}/fills/2`, {
      method: 'PUT', body: JSON.stringify({ qty: 2, priceCents: 1100, feeCents: 0 }), headers: { ...json, ...auth },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).deltaCents).toBe(-200) // cash drops: the sell now brings in 2200 instead of 2400
    expect(f.fills[1].price).toBe(110000n)
    expect(f.states.get(id)!.cashCents).toBe(100200) // 100000 - 2000 + 2200
    const adjusts = f.ledger.filter((l) => l.kind === 'adjust')
    expect(adjusts.length).toBe(1)
    expect(adjusts[0].amountCents).toBe(-200)
  })

  test('PUT invalid bodies -> 400 invalid-body, and 400 beats 404', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 100000 })
    await postFill(app, auth, id, { side: 'buy', shares: 1, price: '10.0000', filledOn: '2026-11-10' })
    const badBodies: Record<string, unknown>[] = [
      {},
      { qty: 0, priceCents: 100, feeCents: 0 },
      { qty: 1.5, priceCents: 100, feeCents: 0 },
      { qty: '100', priceCents: 100, feeCents: 0 },
      { priceCents: 100, feeCents: 0 }, // qty missing
      { qty: 100, feeCents: 0 }, // priceCents missing
      { qty: 100, priceCents: 0, feeCents: 0 },
      { qty: 100, priceCents: 100.5, feeCents: 0 },
      { qty: 100, priceCents: 100 }, // feeCents key missing — must be present (null allowed)
      { qty: 100, priceCents: 100, feeCents: -1 },
      { qty: 100, priceCents: 100, feeCents: 1.5 },
      { qty: 100, priceCents: 100, feeCents: '0' },
    ]
    for (const body of badBodies) {
      const res = await app.request(`/api/runs/${id}/fills/1`, { method: 'PUT', body: JSON.stringify(body), headers: { ...json, ...auth } })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid-body' })
    }
    // body validation runs before the run lookup
    const ghost = await app.request('/api/runs/999/fills/1', { method: 'PUT', body: JSON.stringify({}), headers: { ...json, ...auth } })
    expect(ghost.status).toBe(400)
    // nothing changed
    expect(f.fills[0].shares).toBe(1)
    expect(f.states.get(id)!.cashCents).toBe(99000)
  })

  test('PUT valid body on unknown run -> 404 no-run', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const res = await app.request('/api/runs/999/fills/1', {
      method: 'PUT', body: JSON.stringify({ qty: 1, priceCents: 100, feeCents: 0 }), headers: { ...json, ...auth },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no-run' })
  })

  test('PUT unknown or NaN fillId -> 422 no-fill', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 100000 })
    await postFill(app, auth, id, { side: 'buy', shares: 1, price: '10.0000', filledOn: '2026-11-10' })
    for (const bad of ['42', 'abc']) {
      const res = await app.request(`/api/runs/${id}/fills/${bad}`, {
        method: 'PUT', body: JSON.stringify({ qty: 1, priceCents: 100, feeCents: 0 }), headers: { ...json, ...auth },
      })
      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ error: 'no-fill' })
    }
  })

  test('PUT huge qty -> 200 with negative cash (no insufficient-cash guard)', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 100000 })
    await postFill(app, auth, id, { side: 'buy', shares: 1, price: '10.0000', filledOn: '2026-11-10' })
    const res = await app.request(`/api/runs/${id}/fills/1`, {
      method: 'PUT', body: JSON.stringify({ qty: 100000, priceCents: 100000, feeCents: 0 }), headers: { ...json, ...auth },
    })
    expect(res.status).toBe(200)
    // 100000 - roundDiv(10000000 * 100000, 100) = 100000 - 1e10
    expect(f.states.get(id)!.cashCents).toBe(-9999900000)
    expect(f.ledger[f.ledger.length - 1].amountCents).toBe(-9999999000) // -9999900000 - 99000
    const run = await (await app.request(`/api/runs/${id}`, { headers: auth })).json()
    expect(run.progressView.cashCents).toBe(-9999900000)
  })

  test('PUT and DELETE without auth -> 401', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const put = await app.request('/api/runs/1/fills/1', { method: 'PUT', body: JSON.stringify({ qty: 1, priceCents: 100, feeCents: 0 }), headers: json })
    expect(put.status).toBe(401)
    const del = await app.request('/api/runs/1/fills/1', { method: 'DELETE' })
    expect(del.status).toBe(401)
  })

  test('DELETE last fill rolls back state and books a compensating adjust', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 100000 })
    await postFill(app, auth, id, { side: 'buy', shares: 2, price: '10.0000', filledOn: '2026-11-10' })
    expect(f.states.get(id)!.cashCents).toBe(98000)
    const res = await app.request(`/api/runs/${id}/fills/1`, { method: 'DELETE', headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deletedFillId: 1, deltaCents: 2000 })
    expect(f.fills.length).toBe(0)
    const state = f.states.get(id)!
    expect(state.cashCents).toBe(100000) // back to the pool
    expect(state.buckets[0].state).toBe('empty')
    const last = f.ledger[f.ledger.length - 1]
    expect(last.kind).toBe('adjust')
    expect(last.amountCents).toBe(2000)
    expect(JSON.parse(last.ref!)).toEqual({ fillId: 1, bookedOn: '2026-11-10', reason: 'fill-delete' })
    const rows = await (await app.request(`/api/runs/${id}/fills`, { headers: auth })).json()
    expect(rows.length).toBe(0)
    const run = await (await app.request(`/api/runs/${id}`, { headers: auth })).json()
    expect(run.progressView.cashCents).toBe(100000)
  })

  test('DELETE a bucket-last fill that is not globally newest -> 200', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 100000 })
    await postFill(app, auth, id, { side: 'buy', shares: 1, price: '10.0000', filledOn: '2026-11-10' })
    await postFill(app, auth, id, { side: 'buy', shares: 1, price: '11.0000', filledOn: '2026-11-09' })
    const res = await app.request(`/api/runs/${id}/fills/1`, { method: 'DELETE', headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deletedFillId: 1, deltaCents: 1000 })
    expect(f.fills.map((x: any) => x.id)).toEqual([2])
    expect(f.states.get(id)!.cashCents).toBe(98900)
    const last = f.ledger[f.ledger.length - 1]
    expect(last.kind).toBe('adjust')
    expect(last.amountCents).toBe(1000)
    expect(JSON.parse(last.ref!)).toEqual({ fillId: 1, bookedOn: '2026-11-10', reason: 'fill-delete' })
    const rows = await (await app.request(`/api/runs/${id}/fills`, { headers: auth })).json()
    expect(rows.length).toBe(1)
  })

  test('DELETE non-newest fill of the same bucket -> 422 not-last', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 100000 })
    await postFill(app, auth, id, { side: 'buy', shares: 2, price: '10.0000', filledOn: '2026-11-10' })
    await postFill(app, auth, id, { side: 'sell', shares: 2, price: '11.0000', filledOn: '2026-11-10' })
    const res = await app.request(`/api/runs/${id}/fills/1`, { method: 'DELETE', headers: auth })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'not-last' })
    expect(f.fills.length).toBe(2)
  })

  test('DELETE non-canonical fillId -> 422 no-fill', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 100000 })
    await postFill(app, auth, id, { side: 'buy', shares: 1, price: '10.0000', filledOn: '2026-11-10' })
    for (const bad of ['abc', '1.5', '-2']) {
      const res = await app.request(`/api/runs/${id}/fills/${bad}`, { method: 'DELETE', headers: auth })
      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ error: 'no-fill' })
    }
    expect(f.fills.length).toBe(1)
  })

  test('DELETE unknown numeric fillId -> 422 no-fill', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 100000 })
    await postFill(app, auth, id, { side: 'buy', shares: 1, price: '10.0000', filledOn: '2026-11-10' })
    for (const bad of ['99', '0']) {
      const res = await app.request(`/api/runs/${id}/fills/${bad}`, { method: 'DELETE', headers: auth })
      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ error: 'no-fill' })
    }
    expect(f.fills.length).toBe(1)
  })

  test('DELETE on run without fills -> 422 no-fill', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 100000 })
    const res = await app.request(`/api/runs/${id}/fills/1`, { method: 'DELETE', headers: auth })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'no-fill' })
  })

  test('DELETE unknown run -> 404 no-run', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const res = await app.request('/api/runs/999/fills/1', { method: 'DELETE', headers: auth })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no-run' })
  })
})

describe('http fill edit date', () => {
  test('PUT fill with filledOn updates the stored date; invalid filledOn is 400', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = { Authorization: `Bearer ${(await (await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })).json()).token}` }
    const id = (await (await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r', ticker: 'A', costPpm: 100, poolCents: 100000 }), headers: { 'content-type': 'application/json', ...auth } })).json()).id
    await app.request(`/api/runs/${id}/fills`, { method: 'POST', body: JSON.stringify({ side: 'buy', shares: 10, price: '10.00', filledOn: '2026-11-09' }), headers: { 'content-type': 'application/json', ...auth } })
    const fillId = f.fills[0]!.id

    const ok = await app.request(`/api/runs/${id}/fills/${fillId}`, { method: 'PUT', body: JSON.stringify({ qty: 10, priceCents: 1000, feeCents: 500, filledOn: '2026-11-03' }), headers: { 'content-type': 'application/json', ...auth } })
    expect(ok.status).toBe(200)
    expect(f.fills[0]!.filledOn).toBe('2026-11-03')

    for (const bad of ['11/03', '2026-11-3', 'yesterday', '']) {
      const res = await app.request(`/api/runs/${id}/fills/${fillId}`, { method: 'PUT', body: JSON.stringify({ qty: 10, priceCents: 1000, feeCents: 500, filledOn: bad }), headers: { 'content-type': 'application/json', ...auth } })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('invalid-body')
    }
    expect(f.fills[0]!.filledOn).toBe('2026-11-03') // rejected bodies never touched the row

    // omitted filledOn keeps the stored date (regression guard for Task 1's optional patch)
    const keep = await app.request(`/api/runs/${id}/fills/${fillId}`, { method: 'PUT', body: JSON.stringify({ qty: 12, priceCents: 1000, feeCents: 500 }), headers: { 'content-type': 'application/json', ...auth } })
    expect(keep.status).toBe(200)
    expect(f.fills[0]!.filledOn).toBe('2026-11-03')
  })
})
