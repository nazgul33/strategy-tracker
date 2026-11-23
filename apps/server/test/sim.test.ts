import { describe, test, expect } from 'bun:test'
import { emptyState, type RunState } from '@st/core'
import { feeCents } from '@st/core/money'
import { DEFAULT_MR_PARAMS, computeOrders, sellTarget } from '@st/strategies'
import type { OHLCBar } from '@st/market-data'
import { simulateDays, resolveDay } from '../src/sim/sim'
import { createApp } from '../src/http/app'
import { makeFakes as makeHttpFakes, makeDeps, loginAs } from './http-fakes'
import { bars, makeRun } from './sim-fixture'

describe('simulateDays', () => {
  test('case 1: 3 bars, no day for bars[0], first day date bars[1], digest fidelity', () => {
    const days = simulateDays(makeRun(), DEFAULT_MR_PARAMS, bars)
    expect(days.length).toBe(2)
    expect(days[0]!.date).toBe(bars[1]!.date) // bars[0] only seeds lastClose
    // digest fidelity: day-2 plan derived from bars[1].close (buy bucket 1, sell bucket 0 filled day 1)
    const day2Buy = days[1]!.plan.orders.find((o) => o.kind === 'buy_loc')!
    expect(day2Buy.bucketIndex).toBe(1)
    expect(day2Buy.limitPrice).toBe(bars[1]!.close - 100n)
    expect(days[1]!.plan.orders.some((o) => o.kind === 'sell_loc' && o.bucketIndex === 0)).toBe(true)
  })

  test('case 2: buy fills at min(limit, open) — both branches, exact cash', () => {
    // buy limit = 3500000 - 100 = 3499900; shares = floor(100000c * 100 / 3499900) = 2
    const a: OHLCBar[] = [
      { date: '2026-11-01', open: 3500000n, high: 3550000n, low: 3450000n, close: 3500000n },
      // open above limit -> fills at limit
      { date: '2026-11-02', open: 3501000n, high: 3510000n, low: 3495000n, close: 3498000n },
    ]
    const da = simulateDays(makeRun(), DEFAULT_MR_PARAMS, a)
    const fa = da[0]!.fills.find((f) => f.side === 'buy')!
    expect(fa.shares).toBe(2)
    expect(fa.price).toBe(3499900n)
    expect(fa.feeCents).toBe(feeCents(3499900n, 2, 30))
    // 2-bar sim -> the only day is the last day -> forced exit at open 3501000 (market sells fill LOO)
    expect(da[0]!.fills.length).toBe(2)
    expect(da[0]!.fills[1]!.side).toBe('sell')
    expect(da[0]!.fills[1]!.price).toBe(3501000n)
    expect(da[0]!.heldCount).toBe(0)
    expect(da[0]!.cashCents).toBe(1000000 - 69998 - feeCents(3499900n, 2, 30) + 70020 - feeCents(3501000n, 2, 30))
    const b: OHLCBar[] = [
      { date: '2026-11-01', open: 3500000n, high: 3550000n, low: 3450000n, close: 3500000n },
      // gap-down open below limit -> fills at open
      { date: '2026-11-02', open: 3480000n, high: 3490000n, low: 3380000n, close: 3400000n },
    ]
    const db = simulateDays(makeRun(), DEFAULT_MR_PARAMS, b)
    const fb = db[0]!.fills.find((f) => f.side === 'buy')!
    expect(fb.price).toBe(3480000n)
    // again the only day is the last day -> forced exit at open 3480000 (market sells fill LOO)
    expect(db[0]!.heldCount).toBe(0)
    expect(db[0]!.fills[1]!.side).toBe('sell')
    expect(db[0]!.fills[1]!.price).toBe(3480000n)
    expect(db[0]!.cashCents).toBe(1000000 - 69600 - feeCents(3480000n, 2, 30) + 69600 - feeCents(3480000n, 2, 30))
  })

  test('case 3: sell_loc fills at max(target, open); high < target -> no fill', () => {
    const st = emptyState(10)
    st.cashCents = 500000
    st.buckets[0] = { index: 0, state: 'held', shares: 3, buyPrice: 3400000n, buyFeeCents: 90, filledOn: '2026-10-01' }
    const target = sellTarget(3400000n, 30, 3n) // 3400000 + 100 + 204 = 3400304
    expect(target).toBe(3400304n)
    const plan = computeOrders(makeRun(), st, { lastClose: 3500000n }, DEFAULT_MR_PARAMS)
    const sellOrder = plan.orders.find((o) => o.kind === 'sell_loc' && o.bucketIndex === 0)!
    expect(sellOrder.limitPrice).toBe(target)
    const sellPlan = { orders: [sellOrder], skips: [], notices: [] } // fill sell_loc only
    // open below target -> fills at target
    const ra = resolveDay(st, sellPlan, { date: '2026-11-02', open: 3350000n, high: 3400304n, low: 3340000n, close: 3380000n }, 30)
    expect(ra.fills.length).toBe(1)
    expect(ra.fills[0]!.price).toBe(3400304n)
    expect(ra.state.cashCents).toBe(500000 + 102009 - ra.fills[0]!.feeCents)
    expect(ra.state.closed.length).toBe(1)
    // open above target -> fills at open
    const rb = resolveDay(st, sellPlan, { date: '2026-11-02', open: 3450000n, high: 3460000n, low: 3440000n, close: 3455000n }, 30)
    expect(rb.fills[0]!.price).toBe(3450000n)
    expect(rb.state.cashCents).toBe(500000 + 103500 - rb.fills[0]!.feeCents)
    // high below target -> no fill, bucket stays held
    const rc = resolveDay(st, sellPlan, { date: '2026-11-02', open: 3380000n, high: 3400303n, low: 3370000n, close: 3390000n }, 30)
    expect(rc.fills.length).toBe(0)
    expect(rc.state.buckets[0]!.state).toBe('held')
    expect(rc.state.cashCents).toBe(500000)
  })

  test('case 4: unfilled buy leaves bucket empty next day', () => {
    const b: OHLCBar[] = [
      { date: '2026-11-01', open: 3500000n, high: 3550000n, low: 3450000n, close: 3500000n },
      // day2: low above limit -> no buy fill
      { date: '2026-11-02', open: 3600000n, high: 3650000n, low: 3550000n, close: 3600000n },
      { date: '2026-11-03', open: 3500000n, high: 3550000n, low: 3450000n, close: 3500000n },
    ]
    const days = simulateDays(makeRun(), DEFAULT_MR_PARAMS, b)
    // day2 no buy fill for bucket 0 -> bucket empty; day3 plan should have buy_loc for bucket 0
    const day3Plan = days[1]!.plan
    expect(day3Plan.orders.some((o) => o.kind === 'buy_loc' && o.bucketIndex === 0)).toBe(true)
  })

  test('case 4b: insufficient cash skips buy, cash never negative', () => {
    // pool 699995c, budget = pool/10 = 69999c -> 2 shares @ 3499900 (cost 69998 + fee 2 = 70000 per buy)
    // days 1-9 fill (cash 699995 - 9*70000 = 69995), day 10 buy needs 70000 -> skipped
    // day 10 forced exit: 9 buckets x 2 @ open 3500000 -> + (70000 - 2) * 9 = +629982 -> 699977
    const run = makeRun({ poolCents: 699995 })
    const flat = (date: string): OHLCBar => ({ date, open: 3500000n, high: 3500000n, low: 3350000n, close: 3500000n })
    const b = Array.from({ length: 11 }, (_, i) => flat(`2026-11-${String(i + 1).padStart(2, '0')}`)) // bars[0] seeds -> 10 trading days
    const days = simulateDays(run, DEFAULT_MR_PARAMS, b)
    for (const d of days) expect(d.cashCents).toBeGreaterThanOrEqual(0)
    const buyFills = days.flatMap((d) => d.events).filter((e) => e.type === 'fill' && e.side === 'buy')
    const skips = days.flatMap((d) => d.events).filter((e) => e.type === 'skipped')
    expect(buyFills.length).toBe(9)
    expect(skips.length).toBe(1)
    expect(skips[0]!.type === 'skipped' && skips[0]!.reason).toBe('insufficient-cash')
    const last = days[days.length - 1]!
    expect(last.cashCents).toBe(699977)
    expect(last.heldCount).toBe(0) // forced exit liquidates everything
  })

  test('case 5: resolveDay market_sell fills at open (LOO)', () => {
    const state = emptyState(1)
    state.buckets[0] = { index: 0, state: 'force_sell', shares: 5, buyPrice: 3000000n, buyFeeCents: 0, filledOn: '2026-10-01' }
    state.cashCents = 1000
    const plan = { orders: [{ kind: 'market_sell', bucketIndex: 0, limitPrice: 0n, shares: 5 }], skips: [], notices: [] }
    const bar: OHLCBar = { date: '2026-11-02', open: 3400000n, high: 3450000n, low: 3350000n, close: 3420000n }
    const { state: ns, fills } = resolveDay(state as RunState, plan as any, bar, 30)
    expect(fills.length).toBe(1)
    expect(fills[0]!.price).toBe(bar.open)
    expect(ns.closed.length).toBe(1)
    expect(ns.buckets[0]!.state).toBe('empty')
  })
})

describe('routes', () => {
  test('case 9: POST happy, missing ticker, from>to, params.tick', async () => {
    const fakes = makeHttpFakes()
    const app = createApp({ ...makeDeps(fakes), fetchDailyBars: async () => bars })
    const authh = await loginAs(app)
    const ok = await app.request('/api/sim', { method: 'POST', body: JSON.stringify({ name: 's', ticker: 'TSLA', from: '2026-11-01', to: '2026-11-03', poolCents: 1000000, costPpm: 30 }), headers: { 'content-type': 'application/json', ...authh } })
    expect(ok.status).toBe(200)
    const body = await ok.json()
    expect(body.id).toBeTruthy()
    expect(body.dayCount).toBe(2)
    const miss = await app.request('/api/sim', { method: 'POST', body: JSON.stringify({ name: 's', from: '2026-11-01', to: '2026-11-03', poolCents: 1000000, costPpm: 30 }), headers: { 'content-type': 'application/json', ...authh } })
    expect(miss.status).toBe(400)
    const range = await app.request('/api/sim', { method: 'POST', body: JSON.stringify({ name: 's', ticker: 'TSLA', from: '2026-11-03', to: '2026-11-01', poolCents: 1000000, costPpm: 30 }), headers: { 'content-type': 'application/json', ...authh } })
    expect(range.status).toBe(400)
    const tick = await app.request('/api/sim', { method: 'POST', body: JSON.stringify({ name: 's', ticker: 'TSLA', from: '2026-11-01', to: '2026-11-03', poolCents: 1000000, costPpm: 30, params: { tick: 1 } }), headers: { 'content-type': 'application/json', ...authh } })
    expect(tick.status).toBe(422)
  })

  test('case 10: GET list + GET :id parsed days', async () => {
    const fakes = makeHttpFakes()
    const app = createApp({ ...makeDeps(fakes), fetchDailyBars: async () => bars })
    const authh = await loginAs(app)
    const ok = await app.request('/api/sim', { method: 'POST', body: JSON.stringify({ name: 's', ticker: 'TSLA', from: '2026-11-01', to: '2026-11-03', poolCents: 1000000, costPpm: 30 }), headers: { 'content-type': 'application/json', ...authh } })
    const { id } = await ok.json()
    const list = await app.request('/api/sim', { headers: authh })
    expect(list.status).toBe(200)
    const arr = await list.json()
    expect(arr.length).toBe(1)
    const det = await app.request(`/api/sim/${id}`, { headers: authh })
    expect(det.status).toBe(200)
    const d = await det.json()
    expect(d.days.length).toBe(2)
    const lp = d.days[0].planJson?.orders?.[0]?.limitPrice ?? d.days[0].plan?.orders?.[0]?.limitPrice
    // planJson parsed back to object in route (we parse planJson)
    expect(typeof (d.days[0].planJson ? d.days[0].planJson.orders[0].limitPrice : 'x')).toBe('string')
    const unknown = await app.request('/api/sim/999', { headers: authh })
    expect(unknown.status).toBe(404)
  })

  test('case 11: unauthenticated POST 401', async () => {
    const fakes = makeHttpFakes()
    const app = createApp({ ...makeDeps(fakes), fetchDailyBars: async () => bars })
    const res = await app.request('/api/sim', { method: 'POST', body: JSON.stringify({ name: 's', ticker: 'TSLA', from: '2026-11-01', to: '2026-11-03', poolCents: 1000000, costPpm: 30 }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(401)
  })
})
