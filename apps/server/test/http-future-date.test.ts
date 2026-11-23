import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/http/app'
import { createRun, json, loginAs, makeDeps, makeFakes, postFill } from './http-fakes'

// The fake deps' today() is 2026-11-10.
const TODAY = '2026-11-10'
const FUTURE = '2026-11-11'

async function setup() {
  const f = makeFakes()
  const deps = makeDeps(f)
  const app = createApp(deps)
  const auth = await loginAs(app)
  return { f, deps, app, auth }
}

const post = (app: ReturnType<typeof createApp>, auth: Record<string, string>, path: string, body: unknown, method = 'POST') =>
  app.request(path, { method, body: JSON.stringify(body), headers: { ...json, ...auth } })

describe('HTTP refuses a fill dated after today (#96)', () => {
  test('POST /runs with a seed dated after today', async () => {
    const { f, app, auth } = await setup()
    const before = structuredClone(await f.repos.runRepo.list())
    const res = await post(app, auth, '/api/runs', {
      name: 'r', ticker: 'AAPL', costPpm: 0, poolCents: 1_000_000,
      seed: { cashCents: 500_000, buckets: [{ shares: 10, buyPrice: '100.00', filledOn: FUTURE }] },
    })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'fill-date-in-future' })
    expect(await f.repos.runRepo.list()).toEqual(before)
    expect(f.fills).toEqual([])
  })

  test('POST /runs/:id/fills with a future date', async () => {
    const { f, app, auth } = await setup()
    const id = await createRun(app, auth, { name: 'r', ticker: 'AAPL', costPpm: 0, poolCents: 1_000_000 })
    const res = await post(app, auth, `/api/runs/${id}/fills`, { side: 'buy', shares: 10, price: '100.00', filledOn: FUTURE })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'fill-date-in-future' })
    expect(f.fills).toEqual([])
  })

  test('PUT /runs/:id/fills/:fillId with a future date', async () => {
    const { f, app, auth } = await setup()
    const id = await createRun(app, auth, { name: 'r', ticker: 'AAPL', costPpm: 0, poolCents: 1_000_000 })
    await postFill(app, auth, id, { side: 'buy', shares: 10, price: '100.00', filledOn: TODAY })
    const before = structuredClone(f.fills)
    const res = await post(app, auth, `/api/runs/${id}/fills/1`, { qty: 10, priceCents: 10_000, feeCents: 0, filledOn: FUTURE }, 'PUT')
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'fill-date-in-future' })
    expect(f.fills).toEqual(before)
  })

  test('GET /runs/:id carries today', async () => {
    const { deps, app, auth } = await setup()
    const id = await createRun(app, auth, { name: 'r', ticker: 'AAPL', costPpm: 0, poolCents: 1_000_000 })
    const res = await app.request(`/api/runs/${id}`, { headers: auth })
    expect((await res.json()).today).toBe(deps.today())
  })
})
