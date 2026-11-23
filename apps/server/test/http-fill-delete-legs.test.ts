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
  const id = await createRun(app, auth, { name: 'r1', ticker: 'AAPL', costPpm: 0, poolCents: 100000 })
  const buy = await app.request(`/api/runs/${id}/fills`, { method: 'POST', body: JSON.stringify({ side: 'buy', shares: 10, price: '100.00', filledOn: D }), headers: { ...json, ...auth } })
  expect(buy.status).toBe(200)
  const buyId = f.fills.find((x) => x.side === 'buy')!.id
  await f.repos.orderRepo.insertMany([
    { runId: id, tradeDate: D, kind: 'sell_loc', bucketIdx: 0, limitPrice: 1030000n, shares: 10, status: 'open' },
    { runId: id, tradeDate: D, kind: 'stop_sell', bucketIdx: 0, limitPrice: 970000n, shares: 10, status: 'open' },
  ])
  const del = () => app.request(`/api/runs/${id}/fills/${buyId}`, { method: 'DELETE', headers: auth })
  return { f, del, id, buyId }
}

const TAIL = 'at your broker — the buy it was placed for was deleted, so this order is no longer needed.'
const texts = (id: number) => [
  `⚠️ Run #${id} AAPL: cancel bucket 0 target ($103.00) ${TAIL}`,
  `⚠️ Run #${id} AAPL: cancel bucket 0 stop ($97.00) ${TAIL}`,
]

describe('fill delete that removes a bucket\'s buy over HTTP', () => {
  test('answers with the unchanged body and tells every allowed chat to pull each open leg', async () => {
    const { f, del, id, buyId } = await setup(['42'])
    expect(f.sent).toEqual([])

    const res = await del()

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, deletedFillId: buyId, deltaCents: expect.any(Number) })
    expect(Object.keys(body).sort()).toEqual(['deletedFillId', 'deltaCents', 'ok'])
    expect(f.sent).toEqual(texts(id).map((text) => ({ chatId: '42', text })))
  })

  test('with no allowed chats the notices are recorded for the web', async () => {
    const { f, del, id } = await setup([])

    expect((await del()).status).toBe(200)

    expect(f.sent).toEqual([])
    expect(f.notifications.map((n) => ({ runId: n.runId, chatId: n.chatId, text: n.text }))).toEqual(texts(id).map((text) => ({ runId: id, chatId: 'web', text })))
  })
})
