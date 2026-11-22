import { describe, test, expect } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, json, loginAs, createRun, postFill } from './http-fakes'

// each one Number()s to 1
const RAW = ['0x1', '1e0', '+1', '01']

async function setup() {
  const f = makeFakes()
  const app = createApp(makeDeps(f))
  const auth = await loginAs(app)
  const id = await createRun(app, auth, { name: 'r', ticker: 'AAPL', costPpm: 0, poolCents: 100000 })
  expect(id).toBe(1)
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method, headers: { ...json, ...auth }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    return { status: res.status, body: text === '' ? null : JSON.parse(text) }
  }
  return { f, app, auth, call }
}

describe('runs routes: canonical path ids only', () => {
  async function seeded() {
    const s = await setup()
    await postFill(s.app, s.auth, 1, { side: 'buy', shares: 1, price: '10.0000', filledOn: '2026-11-10' })
    await s.f.repos.orderRepo.insertMany([{ runId: 1, tradeDate: '2026-11-10', kind: 'sell_loc', bucketIdx: 0, limitPrice: 110000n, shares: 1, status: 'open' }] as any)
    await s.f.repos.notificationRepo.insert({ runId: 1, chatId: '42', text: 'n' })
    return s
  }

  test('a non-canonical id never reads a run', async () => {
    const { call } = await seeded()
    for (const raw of RAW) {
      expect(await call('GET', `/runs/${raw}`)).toEqual({ status: 404, body: { error: 'not found' } })
      expect(await call('GET', `/runs/${raw}/price-history`)).toEqual({ status: 404, body: { error: 'not found' } })
      for (const sub of ['orders', 'fills', 'notifications']) {
        expect(await call('GET', `/runs/${raw}/${sub}`)).toEqual({ status: 200, body: [] })
      }
    }
    const own = await call('GET', '/runs/1/fills')
    expect(own.status).toBe(200)
    expect(own.body.length).toBe(1)
  })

  test('a non-canonical id never changes a run', async () => {
    const { f, call } = await seeded()
    for (const raw of RAW) {
      const notFound = { status: 404, body: { error: 'not found' } }
      expect(await call('PATCH', `/runs/${raw}`, { status: 'paused' })).toEqual(notFound)
      expect(await call('POST', `/runs/${raw}/pool`, { amountCents: 5 })).toEqual(notFound)
      expect(await call('POST', `/runs/${raw}/gaps`, { buyGapPpm: 1, sellGapPpm: 2 })).toEqual(notFound)
      expect(await call('POST', `/runs/${raw}/fills`, { side: 'buy', shares: 1, price: '10.00', filledOn: '2026-11-10' })).toEqual(notFound)
    }
    expect(f.runs[0]).toMatchObject({ status: 'active', poolCents: 100000, buyGapPpm: 0 })
    expect(f.poolEdits).toEqual([])
    expect(f.fills.length).toBe(1)
  })

  test('an unknown run id is 404 on pool and manual fill, and writes nothing', async () => {
    const { f, call } = await seeded()
    expect(await call('POST', '/runs/999/pool', { amountCents: 5 })).toEqual({ status: 404, body: { error: 'not found' } })
    expect(await call('POST', '/runs/999/fills', { side: 'buy', shares: 1, price: '10.00', filledOn: '2026-11-10' })).toEqual({ status: 404, body: { error: 'not found' } })
    expect(f.poolEdits).toEqual([])
    expect(f.fills.length).toBe(1)
  })

  test('cancel answers order-not-found for a non-canonical id even with a bad reason', async () => {
    const { f, call } = await seeded()
    const notFound = { status: 404, body: { error: 'order-not-found' } }
    expect(await call('POST', '/runs/0x1/orders/1/cancel', { reason: 'other' })).toEqual(notFound)
    expect(await call('POST', '/runs/1/orders/01/cancel', { reason: 'other' })).toEqual(notFound)
    expect(await call('POST', '/runs/1/orders/1e0/cancel', { reason: 'nope' })).toEqual(notFound)
    expect(f.orders[0].status).toBe('open')
    expect(f.sent).toEqual([])
  })
})

describe('fills routes: canonical path ids only', () => {
  async function seeded() {
    const s = await setup()
    await postFill(s.app, s.auth, 1, { side: 'buy', shares: 2, price: '10.0000', filledOn: '2026-11-10' })
    return s
  }
  const edit = { qty: 1, priceCents: 100, feeCents: 0 }

  test('a non-canonical run id never edits, deletes or recalcs', async () => {
    const { f, call } = await seeded()
    const noRun = { status: 404, body: { error: 'no-run' } }
    for (const raw of RAW) {
      expect(await call('PUT', `/runs/${raw}/fills/1`, edit)).toEqual(noRun)
      expect(await call('DELETE', `/runs/${raw}/fills/1`)).toEqual(noRun)
      expect(await call('POST', `/runs/${raw}/recalc`)).toEqual(noRun)
    }
    expect(f.fills.map((x) => x.shares)).toEqual([2])
  })

  test('a non-canonical fill id is no-fill and leaves the fill alone', async () => {
    const { f, call } = await seeded()
    const ledgerLen = f.ledger.length
    const cash = f.states.get(1)!.cashCents
    for (const raw of RAW) {
      const noFill = { status: 422, body: { error: 'no-fill' } }
      expect(await call('PUT', `/runs/1/fills/${raw}`, edit)).toEqual(noFill)
      expect(await call('DELETE', `/runs/1/fills/${raw}`)).toEqual(noFill)
    }
    expect(f.fills.length).toBe(1)
    expect(f.fills[0]).toMatchObject({ id: 1, shares: 2 })
    expect(f.ledger.length).toBe(ledgerLen)
    expect(f.states.get(1)!.cashCents).toBe(cash)
  })
})

describe('pending routes: canonical path ids only', () => {
  test('a non-canonical id never confirms or rejects', async () => {
    const { f, call } = await setup()
    await f.repos.pendingRepo.insert({ runId: 1, captureId: null, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 3, price: 100000n, fee: null, filledOn: '2026-11-10', status: 'pending' } as any)
    for (const raw of RAW) {
      const notPending = { status: 409, body: { error: 'not-pending' } }
      expect(await call('POST', `/pending/${raw}/confirm`, {})).toEqual(notPending)
      expect(await call('POST', `/pending/${raw}/reject`, {})).toEqual(notPending)
    }
    expect(f.pending[0].status).toBe('pending')
    expect(f.fills).toEqual([])
  })
})
