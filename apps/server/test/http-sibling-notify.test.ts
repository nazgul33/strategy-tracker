import { describe, test, expect, spyOn } from 'bun:test'
import { createApp } from '../src/http/app'
import { makeFakes, makeDeps, json, loginAs, createRun } from './http-fakes'
import { NO_SNAPSHOT } from './booking-fakes'

const D = '2026-11-10' // makeDeps().today()
const WHY_PRICE_10 = 'A target fills at or above its limit, a stop at or below its trigger and a market sell at any price, so more than one order fit this price. A target at exactly the fill price wins; otherwise the only order for exactly 10 shares, if there is one; otherwise the order whose price is nearest the fill, a target before a stop at an equal distance, then the lowest bucket.'

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
  return { f, deps, app, auth, id }
}

const postSell = (app: ReturnType<typeof createApp>, auth: Record<string, string>, id: number, shares: number, price: string) =>
  app.request(`/api/runs/${id}/fills`, { method: 'POST', body: JSON.stringify({ side: 'sell', shares, price, filledOn: D }), headers: { ...json, ...auth } })

describe('sibling-cancel notification over HTTP', () => {
  test('a manual stop fill that empties the bucket tells every allowed chat to pull the other leg', async () => {
    const { f, app, auth, id } = await setup(['42', '43'])
    const res = await postSell(app, auth, id, 10, '96.50')
    expect(res.status).toBe(200)
    const text = `⚠️ Run #${id} AAPL: cancel bucket 0 target ($103.00) at your broker — the other leg already filled, so this order is no longer needed.`
    expect(f.sent).toEqual([{ chatId: '42', text }, { chatId: '43', text }])
    expect(f.notifications.map((n) => ({ runId: n.runId, chatId: n.chatId, text: n.text }))).toEqual([
      { runId: id, chatId: '42', text }, { runId: id, chatId: '43', text },
    ])
  })

  test('the message follows the digest language setting', async () => {
    const { f, deps, app, auth, id } = await setup(['42'])
    deps.defaultSettings.digestLang = 'ko'
    await postSell(app, auth, id, 10, '96.50')
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.text).toBe(`⚠️ 런 #${id} AAPL: 증권사에서 버킷 0 목표가 매도 ($103.00) 주문을 취소하세요 — 반대편 주문이 이미 체결되어 이 주문은 더 이상 필요하지 않습니다.`)
  })

  test('a partial manual fill sends nothing', async () => {
    const { f, app, auth, id } = await setup()
    expect((await postSell(app, auth, id, 4, '96.50')).status).toBe(200)
    expect(f.sent).toEqual([])
    expect(f.notifications).toEqual([])
  })

  test('with no allowed chats the booking succeeds, nothing is sent and the notice is recorded for the web', async () => {
    const { f, app, auth, id } = await setup([])
    expect((await postSell(app, auth, id, 10, '96.50')).status).toBe(200)
    expect(f.sent).toEqual([])
    const text = `⚠️ Run #${id} AAPL: cancel bucket 0 target ($103.00) at your broker — the other leg already filled, so this order is no longer needed.`
    expect(f.notifications.map((n) => ({ runId: n.runId, chatId: n.chatId, text: n.text }))).toEqual([{ runId: id, chatId: 'web', text }])
  })

  test('a Telegram outage never fails or rolls back the manual fill', async () => {
    const { f, deps, app, auth, id } = await setup()
    deps.send = async () => { throw new Error('telegram-down') }
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await postSell(app, auth, id, 10, '96.50')
      expect(res.status).toBe(200)
      expect(f.fills.filter((x) => x.side === 'sell')).toHaveLength(1)
      expect(f.ledger.filter((l) => l.kind === 'sell')).toHaveLength(1)
      expect(f.orders.find((o) => o.kind === 'sell_loc')).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
      expect(f.states.get(id)!.buckets[0]!.state).toBe('empty')
      expect(errors).toHaveBeenCalled()
    } finally { errors.mockRestore() }
  })

  test('an ambiguous manual sell records and sends the attribution notice before the sibling notice', async () => {
    const f = makeFakes()
    const deps = makeDeps(f)
    deps.allowedChatIds = ['42']
    const app = createApp(deps)
    const auth = await loginAs(app)
    const id = await createRun(app, auth, {
      name: 'r2', ticker: 'AAPL', costPpm: 0, poolCents: 100000,
      seed: { cashCents: 50000, buckets: [{ shares: 10, buyPrice: '100.0000', filledOn: '2026-11-02' }, { shares: 10, buyPrice: '88.0000', filledOn: '2026-11-02' }] },
    })
    await f.repos.orderRepo.insertMany([
      { runId: id, tradeDate: D, kind: 'sell_loc', bucketIdx: 0, limitPrice: 1030000n, shares: 10, status: 'open' },
      { runId: id, tradeDate: D, kind: 'stop_sell', bucketIdx: 0, limitPrice: 970000n, shares: 10, status: 'open' },
      { runId: id, tradeDate: D, kind: 'sell_loc', bucketIdx: 1, limitPrice: 910000n, shares: 10, status: 'open' },
      { runId: id, tradeDate: D, kind: 'stop_sell', bucketIdx: 1, limitPrice: 854000n, shares: 10, status: 'open' },
    ])
    expect((await postSell(app, auth, id, 10, '96.50')).status).toBe(200)
    const attributed = `ℹ️ Run #${id} AAPL: sell 10 sh @ $96.50 was booked to bucket 0 stop ($97.00, $0.50 away). Also possible: bucket 1 target ($91.00, $5.50 away). ${WHY_PRICE_10}`
    const cancel = `⚠️ Run #${id} AAPL: cancel bucket 0 target ($103.00) at your broker — the other leg already filled, so this order is no longer needed.`
    expect(f.sent).toEqual([{ chatId: '42', text: attributed }, { chatId: '42', text: cancel }])
    expect(f.notifications.map((n) => ({ runId: n.runId, chatId: n.chatId, text: n.text }))).toEqual([
      { runId: id, chatId: '42', text: attributed }, { runId: id, chatId: '42', text: cancel },
    ])
  })

  test('confirming a pending sell over HTTP notifies as well', async () => {
    const { f, app, auth, id } = await setup()
    const pid = await f.repos.pendingRepo.insert({ runId: id, captureId: null, bucketIdx: null, side: 'sell', ticker: 'AAPL', shares: 10, price: 965000n, fee: null, filledOn: D, status: 'pending', ...NO_SNAPSHOT })
    const res = await app.request(`/api/pending/${pid}/confirm`, { method: 'POST', body: JSON.stringify({}), headers: { ...json, ...auth } })
    expect(res.status).toBe(200)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]).toMatchObject({ chatId: '42' })
    expect(f.sent[0]!.text).toContain('bucket 0 target ($103.00)')
    expect(f.notifications).toHaveLength(1)
  })

  test('a Telegram outage never fails the pending confirm', async () => {
    const { f, deps, app, auth, id } = await setup()
    deps.send = async () => { throw new Error('telegram-down') }
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const pid = await f.repos.pendingRepo.insert({ runId: id, captureId: null, bucketIdx: null, side: 'sell', ticker: 'AAPL', shares: 10, price: 965000n, fee: null, filledOn: D, status: 'pending', ...NO_SNAPSHOT })
      const res = await app.request(`/api/pending/${pid}/confirm`, { method: 'POST', body: JSON.stringify({}), headers: { ...json, ...auth } })
      expect(res.status).toBe(200)
      expect(f.pending.find((p) => p.id === pid)!.status).toBe('confirmed')
      expect(f.fills.filter((x) => x.side === 'sell')).toHaveLength(1)
      expect(f.orders.find((o) => o.kind === 'sell_loc')!.status).toBe('cancelled')
    } finally { errors.mockRestore() }
  })
})
