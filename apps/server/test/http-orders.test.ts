import { describe, test, expect, spyOn } from 'bun:test'
import { createApp } from '../src/http/app'
import { CANCEL_REASONS } from '../src/domain/booking'
import { makeFakes, makeDeps, PASSWORD } from './http-fakes'

describe('http trigger', () => {
  test('trigger morning returns result', async () => {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const res = await app.request('/api/trigger/morning', { method: 'POST', headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ result: 'morning-ok' })
  })

  async function setup() {
    const f = makeFakes()
    const app = createApp(makeDeps(f))
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r', ticker: 'A', costPpm: 0, poolCents: 100 }), headers: { 'content-type': 'application/json', ...auth } })
    const { id: runId } = await cr.json()
    return { f, app, auth, runId }
  }

  test('cancel order: happy path stores reason, notifies each allowed chat', async () => {
    const { f, app, auth, runId } = await setup()
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-10', kind: 'sell_loc', bucketIdx: 2, limitPrice: 3500000n, shares: 1, status: 'open' }])
    const id = f.orders[f.orders.length - 1].id
    const res = await app.request(`/api/runs/${runId}/orders/${id}/cancel`, {
      method: 'POST', headers: auth, body: JSON.stringify({ reason: 'stale-price' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const row = f.orders.find((o) => o.id === id)!
    expect(row.status).toBe('cancelled')
    expect(row.cancelReason).toBe('stale-price')
    expect(f.notifications.filter((n) => n.runId === runId)).toHaveLength(1)
    expect(f.notifications.find((n) => n.runId === runId)!.text).toContain('Cancelled')
    expect(f.sent).toEqual([{ chatId: '42', text: f.notifications.find((n) => n.runId === runId)!.text }])
  })
  test('cancel order: 400 invalid-reason, 404 unknown order, 409 not open', async () => {
    const { f, app, auth, runId } = await setup()
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-10', kind: 'buy_loc', bucketIdx: 0, limitPrice: 1000000n, shares: 1, status: 'open' }])
    const id = f.orders[f.orders.length - 1].id
    const bad = await app.request(`/api/runs/${runId}/orders/${id}/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ reason: 'nope' }) })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'invalid-reason' })
    expect(f.orders[0].status).toBe('open')
    expect(f.notifications).toHaveLength(0)
    expect(f.sent).toHaveLength(0)
    const missing = await app.request(`/api/runs/${runId}/orders/9999/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ reason: 'other' }) })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'order-not-found' })
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-10', kind: 'buy_loc', bucketIdx: 1, limitPrice: 1000000n, shares: 1, status: 'filled' }])
    const filledId = f.orders[f.orders.length - 1].id
    const notOpen = await app.request(`/api/runs/${runId}/orders/${filledId}/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ reason: 'other' }) })
    expect(notOpen.status).toBe(409)
    expect(await notOpen.json()).toEqual({ error: 'order-not-open' })
    expect(f.orders[1].status).toBe('filled')
    expect(f.notifications).toHaveLength(0)
    expect(f.sent).toHaveLength(0)
  })
  test('cancel order with no allowed chats: 200, one web row, no sends', async () => {
    const f = makeFakes()
    const deps = makeDeps(f)
    deps.allowedChatIds = []
    const app = createApp(deps)
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const token = (await lr.json()).token
    const auth = { Authorization: `Bearer ${token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r', ticker: 'A', costPpm: 0, poolCents: 100 }), headers: { 'content-type': 'application/json', ...auth } })
    const { id: runId } = await cr.json()
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-10', kind: 'sell_loc', bucketIdx: 0, limitPrice: 2000000n, shares: 1, status: 'open' }])
    const id = f.orders[f.orders.length - 1].id
    const res = await app.request(`/api/runs/${runId}/orders/${id}/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ reason: 'strategy-change' }) })
    expect(res.status).toBe(200)
    expect(f.orders[0].status).toBe('cancelled')
    expect(f.notifications.filter((n) => n.runId === runId).map((n) => n.chatId)).toEqual(['web'])
    expect(f.notifications[0]!.text).toContain('Cancelled')
    expect(f.sent).toHaveLength(0)
  })
  test('cancel order: a failing Telegram send still answers ok and keeps the row', async () => {
    const f = makeFakes()
    const deps = makeDeps(f)
    deps.send = async () => { throw new Error('telegram-down') }
    const app = createApp(deps)
    const lr = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'content-type': 'application/json' } })
    const auth = { Authorization: `Bearer ${(await lr.json()).token}` }
    const cr = await app.request('/api/runs', { method: 'POST', body: JSON.stringify({ name: 'r', ticker: 'A', costPpm: 0, poolCents: 100 }), headers: { 'content-type': 'application/json', ...auth } })
    const { id: runId } = await cr.json()
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-10', kind: 'sell_loc', bucketIdx: 0, limitPrice: 2000000n, shares: 1, status: 'open' }])
    const id = f.orders[f.orders.length - 1].id
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await app.request(`/api/runs/${runId}/orders/${id}/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ reason: 'other' }) })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(f.orders.find((o) => o.id === id)!.status).toBe('cancelled')
      expect(f.notifications.map((n) => n.chatId)).toEqual(['42'])
      expect(errors.mock.calls).toEqual([['notice failed:', 'order-cancelled', { runId, orderId: id, chatId: '42' }, 'Error: telegram-down']])
    } finally {
      errors.mockRestore()
    }
  })
  test('cancel order: a failing notification insert still answers ok and still sends', async () => {
    const { f, app, auth, runId } = await setup()
    f.repos.notificationRepo.insert = async () => { throw new Error('db-down') }
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-10', kind: 'sell_loc', bucketIdx: 0, limitPrice: 2000000n, shares: 1, status: 'open' }])
    const id = f.orders[f.orders.length - 1].id
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await app.request(`/api/runs/${runId}/orders/${id}/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ reason: 'other' }) })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(f.sent).toHaveLength(1)
      expect(f.sent[0]!.chatId).toBe('42')
      expect(f.sent[0]!.text).toContain('Cancelled')
      expect(errors.mock.calls).toHaveLength(1)
      expect(String(errors.mock.calls[0]!.at(-1))).toEndWith('Error: db-down')
    } finally {
      errors.mockRestore()
    }
  })
  test('cancel order: unmapped booking error surfaces as 422', async () => {
    expect(CANCEL_REASONS.length).toBe(4)
    const { f, app, auth, runId } = await setup()
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-10', kind: 'buy_loc', bucketIdx: 0, limitPrice: 1000000n, shares: 1, status: 'open' }])
    const id = f.orders[f.orders.length - 1].id
    const orig = f.repos.orderRepo.setStatus
    f.repos.orderRepo.setStatus = async () => { throw new Error('db-exploded') }
    const res = await app.request(`/api/runs/${runId}/orders/${id}/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ reason: 'other' }) })
    f.repos.orderRepo.setStatus = orig
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'db-exploded' })
  })
})
