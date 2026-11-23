import { describe, test, expect } from 'bun:test'
import { emptyState, type RunState } from '@st/core'
import { feeCents, parseUsd } from '@st/core/money'
import { DEFAULT_MR_PARAMS } from '@st/strategies'
import type { OHLCBar } from '@st/market-data'
import { simulateDays, resolveDay } from '../src/sim/sim'
import { makeRun } from './sim-fixture'

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
