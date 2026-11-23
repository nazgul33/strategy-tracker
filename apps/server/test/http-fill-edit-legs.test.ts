import { describe, test, expect } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, json, loginAs, createRun } from './http-fakes'

const D = '2026-11-10' // makeDeps().today()

async function setup(chatIds?: string[]) {
  const f = makeFakes()
  const deps = makeDeps(f)
  if (chatIds) deps.allowedChatIds = chatIds
  const app = createApp(deps)
  const auth = await loginAs(app)
  const id = await createRun(app, auth, {
    name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 100000,
    seed: { cashCents: 50000, buckets: [{ shares: 10, buyPrice: '100.0000', filledOn: '2026-11-02' }] },
  })
  await f.repos.orderRepo.insertMany([
    { runId: id, tradeDate: D, kind: 'sell_loc', bucketIdx: 0, limitPrice: 1030000n, shares: 10, status: 'open' },
    { runId: id, tradeDate: D, kind: 'stop_sell', bucketIdx: 0, limitPrice: 970000n, shares: 10, status: 'open' },
  ])
  const sell = await app.request(`/api/runs/${id}/fills`, { method: 'POST', body: JSON.stringify({ side: 'sell', shares: 6, price: '96.50', filledOn: D }), headers: { ...json, ...auth } })
  expect(sell.status).toBe(200)
  const sellId = f.fills.find((x) => x.side === 'sell')!.id
  const edit = () => app.request(`/api/runs/${id}/fills/${sellId}`, { method: 'PUT', body: JSON.stringify({ qty: 10, priceCents: 9650, feeCents: 0 }), headers: { ...json, ...auth } })
  return { f, edit, id }
}

const text = (id: number) => `⚠️ Run #${id} AAPL: cancel bucket 0 target ($103.00) at your broker — the other leg already filled, so this order is no longer needed.`

describe('fill edit that empties a bucket over HTTP', () => {
  test('an edit that empties the bucket tells every allowed chat to pull the other leg', async () => {
    const { f, edit, id } = await setup(['42', '43'])
    expect(f.sent).toEqual([])

    const res = await edit()

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, deltaCents: expect.any(Number) })
    expect(Object.keys(body).sort()).toEqual(['deltaCents', 'ok'])
    expect(f.sent).toEqual([{ chatId: '42', text: text(id) }, { chatId: '43', text: text(id) }])
  })

  test('with no allowed chats the notice is recorded for the web', async () => {
    const { f, edit, id } = await setup([])

    expect((await edit()).status).toBe(200)

    expect(f.sent).toEqual([])
    expect(f.notifications.map((n) => ({ runId: n.runId, chatId: n.chatId, text: n.text }))).toEqual([{ runId: id, chatId: 'web', text: text(id) }])
  })
})
