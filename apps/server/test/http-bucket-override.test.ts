import { describe, test, expect } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, json, loginAs, createRun } from './http-fakes'
import { NO_SNAPSHOT } from './booking-fakes'

const D = '2026-11-10' // makeDeps().today()
const TWO_BUCKETS = [{ shares: 10, buyPrice: '100.0000', filledOn: '2026-11-02' }, { shares: 10, buyPrice: '88.0000', filledOn: '2026-11-02' }]

async function setup() {
  const f = makeFakes()
  const app = createApp(makeDeps(f))
  const auth = await loginAs(app)
  const id = await createRun(app, auth, {
    name: 'r2', ticker: 'AAPL', costPpm: 0, poolCents: 100000,
    seed: { cashCents: 50000, buckets: TWO_BUCKETS },
  })
  await f.repos.orderRepo.insertMany([
    { runId: id, tradeDate: D, kind: 'sell_loc', bucketIdx: 0, limitPrice: 1030000n, shares: 10, status: 'open' },
    { runId: id, tradeDate: D, kind: 'stop_sell', bucketIdx: 0, limitPrice: 970000n, shares: 10, status: 'open' },
    { runId: id, tradeDate: D, kind: 'sell_loc', bucketIdx: 1, limitPrice: 910000n, shares: 10, status: 'open' },
    { runId: id, tradeDate: D, kind: 'stop_sell', bucketIdx: 1, limitPrice: 854000n, shares: 10, status: 'open' },
  ])
  const postFill = (body: Record<string, unknown>) =>
    app.request(`/api/runs/${id}/fills`, { method: 'POST', body: JSON.stringify(body), headers: { ...json, ...auth } })
  const addPending = (extra: Record<string, unknown> = {}) =>
    f.repos.pendingRepo.insert({ runId: id, captureId: null, bucketIdx: null, side: 'sell', ticker: 'AAPL', shares: 10, price: 965000n, fee: null, filledOn: D, status: 'pending', ...NO_SNAPSHOT, ...extra })
  const confirm = (pid: number, body: unknown) =>
    app.request(`/api/pending/${pid}/confirm`, { method: 'POST', body: JSON.stringify(body), headers: { ...json, ...auth } })
  return { f, app, auth, id, postFill, addPending, confirm }
}

describe('bucket override on POST /runs/:id/fills', () => {
  test('with bucketIdx books the sell to that bucket', async () => {
    const { f, id, postFill } = await setup()
    const res = await postFill({ side: 'sell', shares: 10, price: '96.50', filledOn: D, bucketIdx: 1 })
    expect(res.status).toBe(200)
    expect(f.fills.filter((x) => x.side === 'sell')).toMatchObject([{ bucketIdx: 1, shares: 10 }])
    const buckets = f.states.get(id)!.buckets
    expect(buckets[1]!.state).toBe('empty')
    expect(buckets[0]!.state).toBe('held')
  })

  test('a bucketIdx past the run\'s bucket count is 422 bucket-not-found and books nothing', async () => {
    const { f, postFill } = await setup()
    const before = f.fills.length
    const res = await postFill({ side: 'sell', shares: 10, price: '96.50', filledOn: D, bucketIdx: 10 })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'bucket-not-found' })
    expect(f.fills).toHaveLength(before)
  })

  test('rejects a bad bucket with 422 and books nothing', async () => {
    const { f, postFill } = await setup()
    const before = f.fills.length
    const sell = { side: 'sell', shares: 10, price: '96.50', filledOn: D }
    const bad = await postFill({ ...sell, bucketIdx: 'x' })
    expect(bad.status).toBe(422)
    expect(await bad.json()).toEqual({ error: 'invalid-bucket' })
    const notHeld = await postFill({ ...sell, bucketIdx: 5 })
    expect(notHeld.status).toBe(422)
    expect(await notHeld.json()).toEqual({ error: 'bucket-not-held' })
    const buy = await postFill({ side: 'buy', shares: 1, price: '90.00', filledOn: D, bucketIdx: 0 })
    expect(buy.status).toBe(422)
    expect(await buy.json()).toEqual({ error: 'invalid-bucket' })
    expect(f.fills).toHaveLength(before)
  })
})

describe('bucket override on POST /pending/:id/confirm', () => {
  test('overrides.bucketIdx books the sell there', async () => {
    const { f, id, addPending, confirm } = await setup()
    const pid = await addPending()
    const res = await confirm(pid, { overrides: { bucketIdx: 1 } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, archived: true })
    expect(f.fills.filter((x) => x.side === 'sell')).toMatchObject([{ bucketIdx: 1 }])
    expect(f.states.get(id)!.buckets[1]!.state).toBe('empty')
  })

  test('a bucketIdx on a buy is 422 invalid-bucket and the row stays pending', async () => {
    const { f, addPending, confirm } = await setup()
    const pid = await addPending({ side: 'buy', shares: 1, price: 900000n })
    const before = f.fills.length
    const res = await confirm(pid, { overrides: { bucketIdx: 0 } })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'invalid-bucket' })
    expect(f.fills).toHaveLength(before)
    expect(f.pending.find((p) => p.id === pid)!.status).toBe('pending')
  })
})

describe('GET /api/pending heldBuckets', () => {
  test("lists each row's own run's held buckets", async () => {
    const { f, app, auth, addPending } = await setup()
    const runB = await createRun(app, auth, {
      name: 'rb', ticker: 'AAPL', costPpm: 0, poolCents: 100000,
      seed: { cashCents: 50000, buckets: [{ shares: 5, buyPrice: '100.0000', filledOn: '2026-11-02' }] },
    })
    await addPending()
    await f.repos.pendingRepo.insert({ runId: runB, captureId: null, bucketIdx: null, side: 'sell', ticker: 'AAPL', shares: 5, price: 965000n, fee: null, filledOn: D, status: 'pending', ...NO_SNAPSHOT })
    const rows = await (await app.request('/api/pending', { headers: auth })).json()
    expect(rows.map((r: any) => r.heldBuckets)).toEqual([
      [{ index: 0, shares: 10 }, { index: 1, shares: 10 }],
      [{ index: 0, shares: 5 }],
    ])
  })

  test('includes a force_sell bucket', async () => {
    const { f, app, auth, id, addPending } = await setup()
    f.states.get(id)!.buckets[1]!.state = 'force_sell'
    await addPending()
    const rows = await (await app.request('/api/pending', { headers: auth })).json()
    expect(rows[0].heldBuckets).toEqual([{ index: 0, shares: 10 }, { index: 1, shares: 10 }])
  })

  test('gives a row whose run is gone no buckets', async () => {
    const { f, app, auth } = await setup()
    await f.repos.pendingRepo.insert({ runId: 999, captureId: null, bucketIdx: null, side: 'sell', ticker: 'AAPL', shares: 5, price: 965000n, fee: null, filledOn: D, status: 'pending', ...NO_SNAPSHOT })
    const res = await app.request('/api/pending', { headers: auth })
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ runId: 999, heldBuckets: [], costPpm: makeDeps(f).defaultSettings.defaultCostPpm })
  })
})
