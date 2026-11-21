import { describe, test, expect } from 'bun:test'
import { DomainError, emptyState, type RunState } from '@st/core'
import { feeCents, parseUsd } from '@st/core/money'
import { DEFAULT_MR_PARAMS, computeOrders, sellTarget } from '@st/strategies'
import type { OHLCBar } from '@st/market-data'
import { simulateDays, resolveDay, runSim } from '../src/sim/sim'
import { createApp } from '../src/http/app'
import { makeFakes as makeHttpFakes, makeDeps, loginAs } from './http-fakes'

const bars: OHLCBar[] = [
  { date: '2026-11-01', open: 3500000n, high: 3550000n, low: 3450000n, close: 3500000n },
  { date: '2026-11-02', open: 3400000n, high: 3450000n, low: 3350000n, close: 3400000n },
  { date: '2026-11-03', open: 3450000n, high: 3500000n, low: 3400000n, close: 3450000n },
]

// seed close 100.00 → buyGapPpm 10_000 buys at 99.00 (fills: day2 low 95 < 99);
// sellGapPpm 20_000 sells at floorCents(99.00 × 1.02) = 100.98 (fills: day3 high 101)
const gapBars: OHLCBar[] = [
  { date: '2026-12-01', open: parseUsd('100'), high: parseUsd('100'), low: parseUsd('100'), close: parseUsd('100') },
  { date: '2026-12-02', open: parseUsd('99.5'), high: parseUsd('99.5'), low: parseUsd('95'), close: parseUsd('90') },
  { date: '2026-12-03', open: parseUsd('100'), high: parseUsd('101'), low: parseUsd('99'), close: parseUsd('100.5') },
]

function makeRun(over?: Partial<{ poolCents: number; cutLossPpm: number }>): any {
  return { id: 0, name: 'sim', ticker: 'TSLA', strategyKey: 'mean-reversion', costPpm: 30, buyGapPpm: 0, sellGapPpm: 0, cutLossPpm: 0, poolCents: 1000000, status: 'active', ...over }
}

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

describe('cut-loss stops', () => {
  const trigger = parseUsd('97')
  const target = parseUsd('101')

  function heldState(extra?: (st: RunState) => void): RunState {
    const st = emptyState(2)
    st.cashCents = 1000
    st.buckets[0] = { index: 0, state: 'held', shares: 3, buyPrice: parseUsd('100'), buyFeeCents: 0, filledOn: '2026-10-01' }
    extra?.(st)
    return st
  }
  const stopOrder = { kind: 'stop_sell', bucketIndex: 0, limitPrice: trigger, shares: 3 }
  const targetOrder = { kind: 'sell_loc', bucketIndex: 0, limitPrice: target, shares: 3 }
  const planOf = (...orders: any[]): any => ({ orders, skips: [], notices: [] })
  const barOf = (open: string, high: string, low: string): OHLCBar => ({ date: '2026-11-02', open: parseUsd(open), high: parseUsd(high), low: parseUsd(low), close: parseUsd(open) })

  test('a gap-down open fills the stop at the open', () => {
    const r = resolveDay(heldState(), planOf(stopOrder), barOf('90', '92', '88'), 30)
    expect(r.fills.length).toBe(1)
    expect(r.fills[0]!.side).toBe('sell')
    expect(r.fills[0]!.price).toBe(parseUsd('90'))
    expect(r.fills[0]!.shares).toBe(3)
    expect(r.fills[0]!.feeCents).toBe(feeCents(parseUsd('90'), 3, 30))
    expect(r.state.buckets[0]!.state).toBe('empty')
  })

  test('an open exactly at the trigger counts as a gap and fills at the open', () => {
    const r = resolveDay(heldState(), planOf(stopOrder), barOf('97', '98', '95'), 30)
    expect(r.fills[0]!.price).toBe(parseUsd('97'))
  })

  test('an intraday touch fills the stop at the trigger, not the low', () => {
    const r = resolveDay(heldState(), planOf(stopOrder), barOf('99', '99.5', '96'), 30)
    expect(r.fills.length).toBe(1)
    expect(r.fills[0]!.price).toBe(trigger)
    expect(r.fills[0]!.feeCents).toBe(feeCents(trigger, 3, 30))
    expect(r.state.buckets[0]!.state).toBe('empty')
  })

  test('a low exactly at the trigger fires the stop', () => {
    const r = resolveDay(heldState(), planOf(stopOrder), barOf('99', '99.5', '97'), 30)
    expect(r.fills[0]!.price).toBe(trigger)
  })

  test('a day that never reaches the trigger does not fill', () => {
    const r = resolveDay(heldState(), planOf(stopOrder), barOf('99', '99.5', '98'), 30)
    expect(r.fills.length).toBe(0)
    expect(r.events.length).toBe(0)
    expect(r.state.buckets[0]!.state).toBe('held')
  })

  test('when both the target and the stop are reachable the stop wins and says so', () => {
    const r = resolveDay(heldState(), planOf(targetOrder, stopOrder), barOf('99', '102', '96'), 30)
    expect(r.fills.length).toBe(1)
    expect(r.fills[0]!.price).toBe(trigger)
    expect(r.state.buckets[0]!.state).toBe('empty')
    expect(r.events).toContainEqual({ type: 'skipped', bucketIndex: 0, reason: 'stop-preempted' })
  })

  test('a gap-down through the stop with the target also in range still says stop-preempted', () => {
    const r = resolveDay(heldState(), planOf(targetOrder, stopOrder), barOf('90', '102', '88'), 30)
    expect(r.fills.length).toBe(1)
    expect(r.fills[0]!.price).toBe(parseUsd('90'))
    expect(r.events).toContainEqual({ type: 'skipped', bucketIndex: 0, reason: 'stop-preempted' })
  })

  test('a stop-out whose target never traded is not reported as stop-preempted', () => {
    const r = resolveDay(heldState(), planOf(targetOrder, stopOrder), barOf('99', '100', '96'), 30)
    expect(r.fills.length).toBe(1)
    expect(r.fills[0]!.price).toBe(trigger)
    expect(r.events.some((e) => e.type === 'skipped')).toBe(false)
  })

  test('the target still fills when the stop is not reached', () => {
    const r = resolveDay(heldState(), planOf(targetOrder, stopOrder), barOf('99', '102', '98'), 30)
    expect(r.fills.length).toBe(1)
    expect(r.fills[0]!.price).toBe(target)
    expect(r.events.some((e) => e.type === 'skipped')).toBe(false)
  })

  test('stop-preempted is reported only for the bucket the stop emptied', () => {
    const st = heldState((s) => {
      s.buckets[1] = { index: 1, state: 'held', shares: 2, buyPrice: parseUsd('90'), buyFeeCents: 0, filledOn: '2026-10-01' }
    })
    // bucket 1: target 104, stop 87.30 -> neither reached; bucket 0 stops out with its target reachable
    const b1Target = { kind: 'sell_loc', bucketIndex: 1, limitPrice: parseUsd('104'), shares: 2 }
    const b1Stop = { kind: 'stop_sell', bucketIndex: 1, limitPrice: parseUsd('87.3'), shares: 2 }
    const r = resolveDay(st, planOf(targetOrder, stopOrder, b1Target, b1Stop), barOf('99', '102', '96'), 30)
    expect(r.fills.map((f) => f.bucketIndex)).toEqual([0])
    expect(r.events.filter((e) => e.type === 'skipped')).toEqual([{ type: 'skipped', bucketIndex: 0, reason: 'stop-preempted' }])
    expect(r.state.buckets[1]!.state).toBe('held')
  })

  test('stops resolve after market sells', () => {
    const st = heldState((s) => {
      s.buckets[1] = { index: 1, state: 'force_sell', shares: 2, buyPrice: parseUsd('100'), buyFeeCents: 0, filledOn: '2026-10-01' }
    })
    const market = { kind: 'market_sell', bucketIndex: 1, limitPrice: 0n, shares: 2 }
    const r = resolveDay(st, planOf(stopOrder, market), barOf('99', '99.5', '96'), 30)
    expect(r.fills.map((f) => [f.bucketIndex, f.price])).toEqual([[1, parseUsd('99')], [0, trigger]])
  })

  test('a stop fill event carries kind stop_sell, and so does the fill record', () => {
    const r = resolveDay(heldState(), planOf(stopOrder), barOf('90', '92', '88'), 30)
    expect(r.events).toEqual([{ type: 'fill', side: 'sell', kind: 'stop_sell', bucketIndex: 0, shares: 3, price: parseUsd('90'), feeCents: feeCents(parseUsd('90'), 3, 30) }])
    expect(r.fills[0]!.kind).toBe('stop_sell')
  })

  test('when the target is also reachable, the one sell fill is still the stop', () => {
    const r = resolveDay(heldState(), planOf(targetOrder, stopOrder), barOf('99', '102', '96'), 30)
    const sells = r.events.filter((e) => e.type === 'fill')
    expect(sells.map((e) => (e as any).kind)).toEqual(['stop_sell'])
  })

  test('a target fill event carries kind sell_loc', () => {
    const r = resolveDay(heldState(), planOf(targetOrder, stopOrder), barOf('99', '102', '98'), 30)
    expect(r.events).toEqual([expect.objectContaining({ type: 'fill', side: 'sell', kind: 'sell_loc', price: target })])
    expect(r.fills[0]!.kind).toBe('sell_loc')
  })

  test('a market sell fill carries kind market_sell', () => {
    const market = { kind: 'market_sell', bucketIndex: 0, limitPrice: parseUsd('95'), shares: 3 }
    const r = resolveDay(heldState(), planOf(market), barOf('99', '99.5', '98'), 30)
    expect(r.events).toEqual([expect.objectContaining({ type: 'fill', side: 'sell', kind: 'market_sell', price: parseUsd('99') })])
  })

  test('a market sell that empties the bucket leaves no stop-preempted, even with the stop and the target in range', () => {
    const market = { kind: 'market_sell', bucketIndex: 0, limitPrice: 0n, shares: 3 }
    const r = resolveDay(heldState(), planOf(market, targetOrder, stopOrder), barOf('99', '102', '96'), 30)
    expect(r.events).toEqual([{ type: 'fill', side: 'sell', kind: 'market_sell', bucketIndex: 0, shares: 3, price: parseUsd('99'), feeCents: feeCents(parseUsd('99'), 3, 30) }])
    expect(r.state.buckets[0]!.state).toBe('empty')
  })

  test('a buy fill carries kind buy_loc', () => {
    const buy = { kind: 'buy_loc', bucketIndex: 1, limitPrice: parseUsd('98'), shares: 2 }
    const r = resolveDay(heldState((st) => { st.cashCents = 1_000_000 }), planOf(buy), barOf('99', '99.5', '97'), 30)
    expect(r.events).toEqual([expect.objectContaining({ type: 'fill', side: 'buy', kind: 'buy_loc', bucketIndex: 1 })])
    expect(r.fills[0]!.kind).toBe('buy_loc')
  })

  test('the forced exit at the end of a sim is a market_sell, not a stop', () => {
    const b = (date: string, o: string, h: string, l: string, c: string): OHLCBar => ({ date, open: parseUsd(o), high: parseUsd(h), low: parseUsd(l), close: parseUsd(c) })
    const path: OHLCBar[] = [b('2026-12-01', '100', '100', '100', '100'), b('2026-12-02', '99.5', '99.8', '99.2', '99.6')]
    const days = simulateDays(makeRun({ cutLossPpm: 30_000 }), DEFAULT_MR_PARAMS, path)
    const kinds = days[0]!.events.filter((e) => e.type === 'fill').map((e) => [(e as any).side, (e as any).kind])
    expect(kinds).toEqual([['buy', 'buy_loc'], ['sell', 'market_sell']])
    expect(days[0]!.fills.map((f) => f.kind)).toEqual(['buy_loc', 'market_sell'])
  })

  test('end to end: cutLossPpm drives the planned stop and a same-day conflict is replayed as the stop', () => {
    const b = (date: string, o: string, h: string, l: string, c: string): OHLCBar => ({ date, open: parseUsd(o), high: parseUsd(h), low: parseUsd(l), close: parseUsd(c) })
    const path: OHLCBar[] = [
      b('2026-12-01', '100', '100', '100', '100'),
      b('2026-12-02', '99.5', '99.5', '95', '99'), // buys bucket 0 at the open, 99.50
      b('2026-12-03', '99', '101', '96', '98'), // target ~99.5+ reachable AND low 96 < stop 96.51
      b('2026-12-04', '98', '99', '97.5', '98.5'),
    ]
    const days = simulateDays(makeRun({ cutLossPpm: 30_000 }), DEFAULT_MR_PARAMS, path)
    // stop = floorCents(995000 * 970000 / 1e6) = floorCents(965150) = 965100
    const stopPlan = days[1]!.plan.orders.find((o) => o.kind === 'stop_sell')!
    expect(stopPlan.limitPrice).toBe(965100n)
    const sell = days[1]!.fills.find((f) => f.side === 'sell' && f.bucketIndex === 0)!
    expect(sell.price).toBe(965100n)
    expect(days[1]!.events).toContainEqual({ type: 'skipped', bucketIndex: 0, reason: 'stop-preempted' })
    // cut-loss off: no stop is planned and the same path fills the target instead
    const off = simulateDays(makeRun(), DEFAULT_MR_PARAMS, path)
    expect(off[1]!.plan.orders.some((o) => o.kind === 'stop_sell')).toBe(false)
    const offSell = off[1]!.fills.find((f) => f.side === 'sell' && f.bucketIndex === 0)!
    expect(offSell.price).toBeGreaterThan(995000n)
    expect(off[1]!.events.some((e) => e.type === 'skipped')).toBe(false)
  })
})

describe('runSim', () => {
  function makeRepos() {
    const runs: any[] = []
    const days: any[] = []
    let runSeq = 1
    let daySeq = 1
    const simRepo = {
      async insertRun(input: any) { const id = runSeq++; runs.push({ id, ...input }); return id },
      async insertDays(rows: any[]) { for (const r of rows) days.push({ id: daySeq++, ...r }) },
      async listRuns() { return [...runs] },
      async getRun(id: number) { return runs.find((r) => r.id === id) ?? null },
      async listDays(id: number) { return days.filter((d) => d.simRunId === id) },
    }
    return { simRepo, runs, days }
  }

  test('case 6: persists 1 run + N days, strings not corrupted', async () => {
    const f = makeRepos()
    const fetchDailyBars = async () => bars
    const res = await runSim({ name: 'x', ticker: 'TSLA', from: '2026-11-01', to: '2026-11-03', poolCents: 1000000, costPpm: 30 }, { fetchDailyBars, repos: f.simRepo })
    expect(res.dayCount).toBe(2)
    expect(f.runs.length).toBe(1)
    expect(f.days.length).toBe(2)
    for (const d of f.days) {
      expect(typeof d.planJson).toBe('string')
      expect(d.planJson).not.toContain('e+')
      const parsed = JSON.parse(d.planJson)
      // limitPrice should be string if present
      if (parsed.orders?.length) expect(typeof parsed.orders[0].limitPrice).toBe('string')
    }
  })

  test('case 7: 1 bar -> not-enough-bars, no run inserted', async () => {
    const f = makeRepos()
    const fetchDailyBars = async () => [bars[0]!]
    try {
      await runSim({ name: 'x', ticker: 'TSLA', from: '2026-11-01', to: '2026-11-01', poolCents: 1000000, costPpm: 30 }, { fetchDailyBars, repos: f.simRepo })
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.kind).toBe('not-enough-bars')
    }
    expect(f.runs.length).toBe(0)
  })

  test('case 8: invalid params key -> invalid-params, no rows', async () => {
    const f = makeRepos()
    const fetchDailyBars = async () => bars
    try {
      await runSim({ name: 'x', ticker: 'TSLA', from: '2026-11-01', to: '2026-11-03', poolCents: 1000000, costPpm: 30, params: { tick: '1' } as any }, { fetchDailyBars, repos: f.simRepo })
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.kind).toBe('invalid-params')
    }
    expect(f.runs.length).toBe(0)
  })

  test('simulation honours buy and sell gaps', async () => {
    const f = makeRepos()
    const res = await runSim({ name: 'g', ticker: 'TSLA', from: '2026-12-01', to: '2026-12-03', poolCents: 1000000, costPpm: 30, buyGapPpm: 10_000, sellGapPpm: 20_000 }, { fetchDailyBars: async () => gapBars, repos: f.simRepo })
    expect(res.dayCount).toBe(2)
    // day1 buy plan price = buyLimit(100.00, 10_000) = 99.00 — the tell vs the legacy 99.99
    const plan1 = JSON.parse(f.days[0]!.planJson)
    expect(plan1.orders.find((o: any) => o.kind === 'buy_loc').limitPrice).toBe(parseUsd('99').toString())
    const ev1 = JSON.parse(f.days[0]!.eventsJson)
    expect(ev1[0]).toMatchObject({ type: 'fill', side: 'buy', price: '990000' }) // open 99.50 above limit → fills at limit
    // day2 sell plan price = sellLimit(99.00, 30, 10, 20_000) = 100.98 truncated, not the legacy sellTarget
    const plan2 = JSON.parse(f.days[1]!.planJson)
    expect(plan2.orders.find((o: any) => o.kind === 'sell_loc').limitPrice).toBe('1009800')
    const ev2 = JSON.parse(f.days[1]!.eventsJson)
    const sell = ev2.find((e: any) => e.side === 'sell')
    expect(sell.price).toBe('1009800') // fills at the gap target, and the sim ends flat — the final sell is this one
  })

  test('sim gaps default to 0 and are persisted on the sim run row', async () => {
    const f = makeRepos()
    await runSim({ name: 'g', ticker: 'TSLA', from: '2026-12-01', to: '2026-12-03', poolCents: 1000000, costPpm: 30 }, { fetchDailyBars: async () => gapBars, repos: f.simRepo })
    expect(f.runs[0].buyGapPpm).toBe(0)
    expect(f.runs[0].sellGapPpm).toBe(0)
    // gaps unset → legacy prices: lastClose − 100 myriadths
    expect(JSON.parse(f.days[0]!.planJson).orders.find((o: any) => o.kind === 'buy_loc').limitPrice).toBe('999900')
    const f2 = makeRepos()
    await runSim({ name: 'g', ticker: 'TSLA', from: '2026-12-01', to: '2026-12-03', poolCents: 1000000, costPpm: 30, buyGapPpm: 10_000, sellGapPpm: 20_000 }, { fetchDailyBars: async () => gapBars, repos: f2.simRepo })
    expect(f2.runs[0].buyGapPpm).toBe(10_000)
    expect(f2.runs[0].sellGapPpm).toBe(20_000)
  })

  test('cutLossPpm is persisted on the sim run and defaults to 0', async () => {
    const f = makeRepos()
    await runSim({ name: 'c', ticker: 'TSLA', from: '2026-12-01', to: '2026-12-03', poolCents: 1000000, costPpm: 30, cutLossPpm: 35_000 }, { fetchDailyBars: async () => gapBars, repos: f.simRepo })
    expect(f.runs[0].cutLossPpm).toBe(35_000)
    const f2 = makeRepos()
    await runSim({ name: 'c', ticker: 'TSLA', from: '2026-12-01', to: '2026-12-03', poolCents: 1000000, costPpm: 30 }, { fetchDailyBars: async () => gapBars, repos: f2.simRepo })
    expect(f2.runs[0].cutLossPpm).toBe(0)
  })

  test('runSim plans stops from the input cutLossPpm', async () => {
    const f = makeRepos()
    // day 1 buys bucket 0 at 99.00 (gapBars, buy gap 1%); day 2 plans a stop at floorCents(990000 * 0.965) = 955300
    await runSim({ name: 'c', ticker: 'TSLA', from: '2026-12-01', to: '2026-12-03', poolCents: 1000000, costPpm: 30, buyGapPpm: 10_000, sellGapPpm: 20_000, cutLossPpm: 35_000 }, { fetchDailyBars: async () => gapBars, repos: f.simRepo })
    const stop = JSON.parse(f.days[1]!.planJson).orders.find((o: any) => o.kind === 'stop_sell')
    expect(stop.limitPrice).toBe('955300')
  })

  test.each([35_001, -1_000, 600_000, 1_500.5])('runSim rejects cutLossPpm %p', async (v) => {
    const f = makeRepos()
    await expect(runSim({ name: 'c', ticker: 'TSLA', from: '2026-12-01', to: '2026-12-03', poolCents: 1000000, costPpm: 30, cutLossPpm: v }, { fetchDailyBars: async () => gapBars, repos: f.simRepo })).rejects.toMatchObject({ kind: 'invalid-params' })
    expect(f.runs.length).toBe(0)
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