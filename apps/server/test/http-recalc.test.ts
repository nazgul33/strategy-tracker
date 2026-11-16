import { describe, test, expect } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, loginAs, createRun, postFill } from './http-fakes'

describe('POST /runs/:id/recalc endpoint', () => {
  const adjustRows = (f: ReturnType<typeof makeFakes>) => f.ledger.filter((l: any) => l.kind === 'adjust')
  // buy 300 @ 10.00 then partial sell 120 @ 11.00 -> one closed tranche, 180 held
  const seedPartialSell = async (app: ReturnType<typeof createApp>, auth: Record<string, string>, id: number) => {
    await postFill(app, auth, id, { side: 'buy', shares: 300, price: '10.0000', filledOn: '2026-11-10' })
    await postFill(app, auth, id, { side: 'sell', shares: 120, price: '11.0000', filledOn: '2026-11-10' })
  }

  test('recalc on consistent state -> 200 ok, tranche row present, no adjust booked', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 1_000_000 })
    await seedPartialSell(app, auth, id)
    const cash = f.states.get(id)!.cashCents

    const res = await app.request(`/api/runs/${id}/recalc`, { method: 'POST', headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deltaCents: 0, fillCount: 2 })
    const st = f.states.get(id)!
    expect(st.cashCents).toBe(cash)
    expect(st.closed.length).toBe(1)
    expect(st.closed[0].shares).toBe(120)
    expect(st.buckets[0].shares).toBe(180)
    expect(adjustRows(f).length).toBe(0)
  })

  test('recalc repairs a stored state missing the tranche row', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 1_000_000 })
    await seedPartialSell(app, auth, id)
    // corrupt out-of-band: legacy state without tranche rows
    const stale = f.states.get(id)!
    stale.closed = []
    stale.buckets[0].shares = 300

    const res = await app.request(`/api/runs/${id}/recalc`, { method: 'POST', headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deltaCents: 0, fillCount: 2 })
    const st = f.states.get(id)!
    expect(st.closed.length).toBe(1)
    expect(st.closed[0].shares).toBe(120)
    expect(st.buckets[0].shares).toBe(180)
    expect(adjustRows(f).length).toBe(0)
  })

  test('recalc on drifted cash -> reports the delta and books one adjust', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 1_000_000 })
    await seedPartialSell(app, auth, id)
    const trueCash = f.states.get(id)!.cashCents
    // corrupt out-of-band: stored cash overshoots the cash derived from history
    f.states.get(id)!.cashCents = trueCash + 777

    const res = await app.request(`/api/runs/${id}/recalc`, { method: 'POST', headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deltaCents: -777, fillCount: 2 })
    expect(f.states.get(id)!.cashCents).toBe(trueCash)
    const adjusts = adjustRows(f)
    expect(adjusts.length).toBe(1)
    expect(adjusts[0].amountCents).toBe(-777)
    expect(JSON.parse(adjusts[0].ref)).toEqual({ bookedOn: '2026-11-10', reason: 'recalc' })
  })

  test('recalc unknown run -> 404 no-run', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const res = await app.request('/api/runs/999/recalc', { method: 'POST', headers: auth })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no-run' })
  })

  test('recalc with a corrupted oversize sell row -> 422 too-many-shares, state untouched', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const auth = await loginAs(app)
    const id = await createRun(app, auth, { name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 1_000_000 })
    await seedPartialSell(app, auth, id)
    // tamper the stored sell row: 900 shares cannot come out of a 300-share bucket
    f.fills[1].shares = 900
    const cash = f.states.get(id)!.cashCents

    const res = await app.request(`/api/runs/${id}/recalc`, { method: 'POST', headers: auth })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'too-many-shares' })
    expect(f.states.get(id)!.cashCents).toBe(cash)
    expect(adjustRows(f).length).toBe(0)
  })
})
