import { DomainError, emptyState, advanceDay, applyBuyFill, applySellFill, type ISODate, type Run, type RunState, type DayPlan } from '@st/core'
import { feeCents, roundDiv } from '@st/core/money'
import { computeOrders, DEFAULT_MR_PARAMS, type MrParams } from '@st/strategies'
import type { OHLCBar } from '@st/market-data'

export interface SimFill {
  side: 'buy' | 'sell'
  bucketIndex: number
  shares: number
  price: bigint
  feeCents: number
}

export type SimEvent =
  | { type: 'fill'; side: 'buy' | 'sell'; bucketIndex: number; shares: number; price: bigint; feeCents: number }
  | { type: 'skipped'; bucketIndex: number; reason: string }

export interface SimDay {
  date: ISODate
  plan: DayPlan
  fills: SimFill[]
  events: SimEvent[]
  cashCents: number
  heldCount: number
}

export interface SimInput {
  name: string
  ticker: string
  from: ISODate
  to: ISODate
  poolCents: number
  costPpm: number
  params?: Partial<MrParams>
}

export interface SimRunRow {
  id: number
  ticker: string
  fromDate: string
  toDate: string
  poolCents: number
  costPpm: number
  paramsJson: string
  createdAt: any
}

export interface SimDayRow {
  id: number
  simRunId: number
  tradeDate: string
  planJson: string
  stateJson: string
  eventsJson: string
}

export interface SimRepoSurface {
  insertRun(input: { ticker: string; fromDate: string; toDate: string; poolCents: number; costPpm: number; paramsJson: string }): Promise<number>
  insertDays(rows: { simRunId: number; tradeDate: string; planJson: string; stateJson: string; eventsJson: string }[]): Promise<void>
  listRuns(): Promise<SimRunRow[]>
  getRun(id: number): Promise<SimRunRow | null>
  listDays(id: number): Promise<SimDayRow[]>
}

function bigintReplacer(_k: string, v: any): any {
  return typeof v === 'bigint' ? v.toString() : v
}

function heldCount(state: RunState): number {
  return state.buckets.filter((b) => b.state !== 'empty').length
}

export function resolveDay(state: RunState, plan: DayPlan, bar: OHLCBar, costPpm: number): { state: RunState; fills: SimFill[]; events: SimEvent[] } {
  let cur = state
  const events: SimEvent[] = []
  const fill = (e: Omit<Extract<SimEvent, { type: 'fill' }>, 'type'>) => events.push({ type: 'fill', ...e })

  const marketSells = plan.orders.filter((o) => o.kind === 'market_sell').sort((a, b) => a.bucketIndex - b.bucketIndex)
  const sellLocs = plan.orders.filter((o) => o.kind === 'sell_loc').sort((a, b) => a.bucketIndex - b.bucketIndex)
  const buyLocs = plan.orders.filter((o) => o.kind === 'buy_loc').sort((a, b) => a.bucketIndex - b.bucketIndex)

  for (const o of marketSells) {
    const price = bar.open // market sells are limit-on-open orders placed in the morning
    const fee = feeCents(price, o.shares, costPpm)
    try {
      cur = applySellFill(cur, o.bucketIndex, o.shares, price, fee, bar.date)
      fill({ side: 'sell', bucketIndex: o.bucketIndex, shares: o.shares, price, feeCents: fee })
    } catch {
      // not filled
    }
  }
  for (const o of sellLocs) {
    if (bar.high < o.limitPrice) continue
    const price = o.limitPrice > bar.open ? o.limitPrice : bar.open
    const fee = feeCents(price, o.shares, costPpm)
    try {
      cur = applySellFill(cur, o.bucketIndex, o.shares, price, fee, bar.date)
      fill({ side: 'sell', bucketIndex: o.bucketIndex, shares: o.shares, price, feeCents: fee })
    } catch {
      // not filled
    }
  }
  for (const o of buyLocs) {
    if (bar.low > o.limitPrice) continue
    const price = o.limitPrice < bar.open ? o.limitPrice : bar.open
    const fee = feeCents(price, o.shares, costPpm)
    const cost = Number(roundDiv(price * BigInt(o.shares), 100n)) // same math as applyBuyFill
    if (cur.cashCents - cost - fee < 0n) {
      events.push({ type: 'skipped', bucketIndex: o.bucketIndex, reason: 'insufficient-cash' })
      continue
    }
    try {
      cur = applyBuyFill(cur, o.bucketIndex, o.shares, price, fee, bar.date)
      fill({ side: 'buy', bucketIndex: o.bucketIndex, shares: o.shares, price, feeCents: fee })
    } catch {
      // not filled
    }
  }

  const fills: SimFill[] = events
    .filter((e): e is Extract<SimEvent, { type: 'fill' }> => e.type === 'fill')
    .map(({ type: _type, ...f }) => f)
  return { state: cur, fills, events }
}

interface SimResult { days: SimDay[]; states: RunState[] }

function simulate(run: Run, params: MrParams, bars: OHLCBar[]): SimResult {
  if (bars.length < 2) throw new DomainError('not-enough-bars')
  const state0 = emptyState(params.bucketCount)
  state0.cashCents = run.poolCents
  let state: RunState = state0
  const days: SimDay[] = []
  const states: RunState[] = []
  for (let i = 1; i < bars.length; i++) {
    state = advanceDay(state, params.maxAgeDays)
    const plan = computeOrders(run, state, { lastClose: bars[i - 1]!.close }, params)
    const { state: nextState, fills, events } = resolveDay(state, plan, bars[i]!, run.costPpm)
    state = nextState
    days.push({ date: bars[i]!.date, plan, fills, events, cashCents: state.cashCents, heldCount: heldCount(state) })
    states.push(state)
  }
  // forced exit: liquidate every held bucket at the last bar's open (LOO, supersedes R25's close fill)
  const lastBar = bars[bars.length - 1]!
  const lastDay = days[days.length - 1]!
  for (let i = 0; i < state.buckets.length; i++) {
    const b = state.buckets[i]!
    if (b.state === 'empty') continue
    const price = lastBar.open
    const fee = feeCents(price, b.shares, run.costPpm)
    state = applySellFill(state, i, b.shares, price, fee, lastBar.date)
    const f = { side: 'sell' as const, bucketIndex: i, shares: b.shares, price, feeCents: fee }
    lastDay.fills.push(f)
    lastDay.events.push({ type: 'fill', ...f })
  }
  lastDay.cashCents = state.cashCents
  lastDay.heldCount = heldCount(state)
  states[states.length - 1] = state
  return { days, states }
}

export function simulateDays(run: Run, params: MrParams, bars: OHLCBar[]): SimDay[] {
  return simulate(run, params, bars).days
}

export async function runSim(input: SimInput, deps: { fetchDailyBars: (ticker: string, from: string, to: string) => Promise<OHLCBar[]>; repos: SimRepoSurface }): Promise<{ id: number; dayCount: number }> {
  if (input.params) {
    for (const k of Object.keys(input.params)) {
      if (!['bucketCount', 'maxAgeDays'].includes(k)) {
        throw new DomainError('invalid-params')
      }
    }
    if (input.params.bucketCount != null) {
      if (!Number.isInteger(input.params.bucketCount) || input.params.bucketCount < 1 || input.params.bucketCount > 50) {
        throw new DomainError('invalid-params')
      }
    }
  }
  const params = { ...DEFAULT_MR_PARAMS, ...(input.params ?? {}) }

  const run: Run = { id: 0, name: input.name, ticker: input.ticker, strategyKey: 'mean-reversion', costPpm: input.costPpm, poolCents: input.poolCents, status: 'active' }

  const bars = await deps.fetchDailyBars(input.ticker, input.from, input.to)
  const { days, states } = simulate(run, params, bars)

  const id = await deps.repos.insertRun({
    ticker: input.ticker,
    fromDate: input.from,
    toDate: input.to,
    poolCents: input.poolCents,
    costPpm: input.costPpm,
    paramsJson: JSON.stringify(params, bigintReplacer),
  })

  const rows = days.map((d, idx) => ({
    simRunId: id,
    tradeDate: d.date,
    planJson: JSON.stringify({ ...d.plan, orders: d.plan.orders.map((o) => ({ ...o, limitPrice: o.limitPrice.toString() })), skips: d.plan.skips.map((o) => ({ ...o, limitPrice: o.limitPrice.toString() })) }, bigintReplacer),
    stateJson: JSON.stringify(states[idx], bigintReplacer),
    eventsJson: JSON.stringify(d.events, bigintReplacer),
  }))
  await deps.repos.insertDays(rows)
  return { id, dayCount: days.length }
}