import { DomainError, emptyState, advanceDay, applyBuyFill, applySellFill, type ISODate, type Run, type RunState, type DayPlan } from '@st/core'
import { feeCents, roundDiv } from '@st/core/money'
import { computeOrders, DEFAULT_MR_PARAMS, type MrParams } from '@st/strategies'
import { isValidPpm, isValidCutLossPpm } from '../domain/ppm'
import type { OHLCBar } from '@st/market-data'
import { bigintReplacer, serializeDays, type SimDayBody } from './serialize'

export type SimFillKind = 'buy_loc' | 'sell_loc' | 'market_sell' | 'stop_sell'

export interface SimFill {
  side: 'buy' | 'sell'
  kind: SimFillKind
  bucketIndex: number
  shares: number
  price: bigint
  feeCents: number
}

export type SimEvent =
  | { type: 'fill'; side: 'buy' | 'sell'; kind: SimFillKind; bucketIndex: number; shares: number; price: bigint; feeCents: number }
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
  buyGapPpm?: number
  sellGapPpm?: number
  cutLossPpm?: number
  params?: Partial<MrParams>
}

export interface SimRunRow {
  id: number
  ticker: string
  fromDate: string
  toDate: string
  poolCents: number
  costPpm: number
  buyGapPpm: number
  sellGapPpm: number
  cutLossPpm: number
  paramsJson: string
  draft: boolean
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

export interface SimConfig {
  fromDate: string
  toDate: string
  poolCents: number
  costPpm: number
  buyGapPpm: number
  sellGapPpm: number
  cutLossPpm: number
  paramsJson: string
}

export interface SimRepoSurface {
  insertRun(input: SimConfig & { ticker: string }): Promise<number>
  insertDays(rows: (SimDayBody & { simRunId: number })[]): Promise<void>
  rewriteDraft(id: number, config: SimConfig, rows: (SimDayBody & { simRunId: number })[]): Promise<boolean>
  finalize(id: number): Promise<boolean>
  deleteRun(id: number): Promise<boolean>
  sweepDrafts(createdBefore: Date): Promise<number>
  // Newest first; the list route relies on this order.
  listRuns(): Promise<SimRunRow[]>
  getRun(id: number): Promise<SimRunRow | null>
  listDays(id: number): Promise<SimDayRow[]>
}

function heldCount(state: RunState): number {
  return state.buckets.filter((b) => b.state !== 'empty').length
}

export function resolveDay(state: RunState, plan: DayPlan, bar: OHLCBar, costPpm: number): { state: RunState; fills: SimFill[]; events: SimEvent[] } {
  let cur = state
  const events: SimEvent[] = []
  const fill = (e: Omit<Extract<SimEvent, { type: 'fill' }>, 'type'>) => events.push({ type: 'fill', ...e })

  const marketSells = plan.orders.filter((o) => o.kind === 'market_sell').sort((a, b) => a.bucketIndex - b.bucketIndex)
  const stops = plan.orders.filter((o) => o.kind === 'stop_sell').sort((a, b) => a.bucketIndex - b.bucketIndex)
  const sellLocs = plan.orders.filter((o) => o.kind === 'sell_loc').sort((a, b) => a.bucketIndex - b.bucketIndex)
  const buyLocs = plan.orders.filter((o) => o.kind === 'buy_loc').sort((a, b) => a.bucketIndex - b.bucketIndex)

  for (const o of marketSells) {
    const price = bar.open // market sells are limit-on-open orders placed in the morning
    const fee = feeCents(price, o.shares, costPpm)
    try {
      cur = applySellFill(cur, o.bucketIndex, o.shares, price, fee, bar.date)
      fill({ side: 'sell', kind: 'market_sell', bucketIndex: o.bucketIndex, shares: o.shares, price, feeCents: fee })
    } catch {
      // not filled
    }
  }
  // Stops are morning events and resolve before the limit-on-close target. A daily bar has no
  // intraday path, so when the target and the stop are both reachable on the same bar we cannot
  // know which came first; the stop wins, deliberately pessimistic, so the loss is never hidden.
  // A stop triggers on the way down: a bar opening at or below the trigger gapped through it and
  // fills at the open (worse than the trigger, as in reality); otherwise an intraday touch of the
  // low fills exactly at the trigger, ignoring slippage.
  const stoppedOut = new Set<number>()
  for (const o of stops) {
    const trigger = o.limitPrice
    const price = bar.open <= trigger ? bar.open : bar.low <= trigger ? trigger : null
    if (price === null) continue
    const fee = feeCents(price, o.shares, costPpm)
    try {
      cur = applySellFill(cur, o.bucketIndex, o.shares, price, fee, bar.date)
      fill({ side: 'sell', kind: 'stop_sell', bucketIndex: o.bucketIndex, shares: o.shares, price, feeCents: fee })
      stoppedOut.add(o.bucketIndex)
    } catch {
      // not filled
    }
  }
  for (const o of sellLocs) {
    if (bar.high < o.limitPrice) continue
    if (stoppedOut.has(o.bucketIndex)) {
      events.push({ type: 'skipped', bucketIndex: o.bucketIndex, reason: 'stop-preempted' })
      continue
    }
    const price = o.limitPrice > bar.open ? o.limitPrice : bar.open
    const fee = feeCents(price, o.shares, costPpm)
    try {
      cur = applySellFill(cur, o.bucketIndex, o.shares, price, fee, bar.date)
      fill({ side: 'sell', kind: 'sell_loc', bucketIndex: o.bucketIndex, shares: o.shares, price, feeCents: fee })
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
      fill({ side: 'buy', kind: 'buy_loc', bucketIndex: o.bucketIndex, shares: o.shares, price, feeCents: fee })
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
    const f = { side: 'sell' as const, kind: 'market_sell' as const, bucketIndex: i, shares: b.shares, price, feeCents: fee }
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

type FetchBars = (ticker: string, from: string, to: string) => Promise<OHLCBar[]>

// The one validate -> fetch bars -> simulate -> serialize path behind both runSim and
// updateSimRun. It writes nothing, so a caller persists only a fully computed result.
async function prepareSim(input: SimInput, fetchDailyBars: FetchBars): Promise<{ config: SimConfig; days: SimDayBody[] }> {
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

  const buyGapPpm = input.buyGapPpm ?? 0
  const sellGapPpm = input.sellGapPpm ?? 0
  if (!isValidPpm(buyGapPpm) || !isValidPpm(sellGapPpm)) throw new DomainError('invalid-params')

  const cutLossPpm = input.cutLossPpm ?? 0
  if (!isValidCutLossPpm(cutLossPpm)) throw new DomainError('invalid-params')

  const run: Run = { id: 0, name: input.name, ticker: input.ticker, strategyKey: 'mean-reversion', costPpm: input.costPpm, buyGapPpm, sellGapPpm, cutLossPpm, poolCents: input.poolCents, status: 'active' }

  const bars = await fetchDailyBars(input.ticker, input.from, input.to)
  const { days, states } = simulate(run, params, bars)
  const config: SimConfig = {
    fromDate: input.from,
    toDate: input.to,
    poolCents: input.poolCents,
    costPpm: input.costPpm,
    buyGapPpm,
    sellGapPpm,
    cutLossPpm,
    paramsJson: JSON.stringify(params, bigintReplacer),
  }
  return { config, days: serializeDays(days, states) }
}

export async function runSim(input: SimInput, deps: { fetchDailyBars: FetchBars; repos: Pick<SimRepoSurface, 'insertRun' | 'insertDays'> }): Promise<{ id: number; dayCount: number }> {
  const { config, days } = await prepareSim(input, deps.fetchDailyBars)
  const id = await deps.repos.insertRun({ ticker: input.ticker, ...config })
  await deps.repos.insertDays(days.map((d) => ({ simRunId: id, ...d })))
  return { id, dayCount: days.length }
}

// Re-runs a draft in place. The ticker is the draft's identity, so it comes from the stored
// row; no name is stored, so the in-memory run is labelled by id. Everything is simulated
// before anything is written, and the write is one guarded transaction: a failure leaves the
// draft as it was, and a draft saved or discarded after the check above is never overwritten.
export async function updateSimRun(id: number, input: Omit<SimInput, 'ticker' | 'name'>, deps: { fetchDailyBars: FetchBars; repos: Pick<SimRepoSurface, 'getRun' | 'rewriteDraft'> }): Promise<{ id: number; dayCount: number }> {
  const run = await deps.repos.getRun(id)
  if (!run) throw new DomainError('sim-not-found')
  if (!run.draft) throw new DomainError('sim-finalized')
  const { config, days } = await prepareSim({ ...input, name: `Sim #${id}`, ticker: run.ticker }, deps.fetchDailyBars)
  if (!(await deps.repos.rewriteDraft(id, config, days.map((d) => ({ simRunId: id, ...d }))))) {
    throw new DomainError((await deps.repos.getRun(id)) ? 'sim-finalized' : 'sim-not-found')
  }
  return { id, dayCount: days.length }
}
