import type { Bucket, ClosedBucket, DayPlan, Notice, PlannedOrder, Run, RunState } from '@st/core'
import { bucketBudgetCents as coreBucketBudget, ceilCents, floorCents, formatUsd, roundDiv, sellTarget as coreSellTarget } from '@st/core'
import { nextTradingDay } from '@st/calendar'
import type { ISODate } from '@st/core'

export const MEAN_REVERSION = 'mean-reversion'

export interface MrParams {
  bucketCount: number
  tick: bigint
  maxAgeDays: number
}

export const DEFAULT_MR_PARAMS: MrParams = {
  bucketCount: 10,
  tick: 100n,
  maxAgeDays: 20,
}

export function bucketBudgetCents(poolCents: number): number {
  return coreBucketBudget(poolCents)
}

export function buyShares(budgetCents: number, price: bigint): number {
  if (price <= 0n) return 0
  return Number((BigInt(budgetCents) * 100n) / price)
}

export function sellTarget(buyPrice: bigint, costPpm: number, shares: bigint): bigint {
  return coreSellTarget(buyPrice, costPpm, shares)
}

export const MILLION = 1_000_000n

export function buyLimit(lastClose: bigint, buyGapPpm: number): bigint {
  const raw = buyGapPpm === 0
    ? lastClose - 100n
    : (lastClose * (MILLION - BigInt(buyGapPpm))) / MILLION
  return ceilCents(raw)
}

export function sellLimit(buyPrice: bigint, costPpm: number, shares: number, sellGapPpm: number): bigint {
  if (sellGapPpm === 0) return sellTarget(buyPrice, costPpm, BigInt(shares))
  return floorCents((buyPrice * (MILLION + BigInt(sellGapPpm))) / MILLION)
}

export function ageBuckets(
  ages: Record<number, number>,
  tradeDate: ISODate,
  filledOnByIndex: Record<number, ISODate>,
): Record<number, number> {
  const out: Record<number, number> = { ...ages }
  for (const [idxStr, filledOn] of Object.entries(filledOnByIndex)) {
    const idx = Number(idxStr)
    if (!filledOn) {
      out[idx] = 0
      continue
    }
    if (tradeDate <= filledOn) {
      out[idx] = 0
      continue
    }
    let count = 0
    let cur = filledOn
    while (true) {
      const next = nextTradingDay(cur as ISODate)
      if (next > tradeDate) break
      count++
      cur = next
      if (cur >= tradeDate) break
    }
    out[idx] = count
  }
  return out
}

export function computeOrders(
  run: Run,
  state: RunState,
  ctx: { lastClose: bigint },
  params: MrParams = DEFAULT_MR_PARAMS,
): DayPlan {
  const orders: PlannedOrder[] = []
  const skips: PlannedOrder[] = []
  const notices: Notice[] = []

  // BUY: lowest-index empty bucket
  const emptyIndices = state.buckets
    .filter((b) => b.state === 'empty')
    .map((b) => b.index)
    .sort((a, b) => a - b)
  const lowestEmpty = emptyIndices.length ? emptyIndices[0]! : null
  if (lowestEmpty === null) {
    notices.push({ code: 'no-bucket-available' })
  } else {
    const limit = buyLimit(ctx.lastClose, run.buyGapPpm)
    const shares = buyShares(bucketBudgetCents(run.poolCents), limit)
    if (shares === 0) {
      notices.push({ code: 'shares-zero', params: { price: formatUsd(limit) } })
    } else {
      orders.push({ kind: 'buy_loc', bucketIndex: lowestEmpty, limitPrice: limit, shares })
    }
  }

  // held buckets
  const held = state.buckets
    .filter((b) => b.state === 'held')
    .sort((a, b) => a.index - b.index)
  for (const b of held) {
    const target = sellLimit(b.buyPrice, run.costPpm, b.shares, run.sellGapPpm)
    orders.push({ kind: 'sell_loc', bucketIndex: b.index, limitPrice: target, shares: b.shares, ageDays: state.ages[b.index] ?? 0 })
  }

  // force_sell
  const forced = state.buckets
    .filter((b) => b.state === 'force_sell')
    .sort((a, b) => a.index - b.index)
  for (const b of forced) {
    orders.push({ kind: 'market_sell', bucketIndex: b.index, limitPrice: 0n, shares: b.shares, ageDays: state.ages[b.index] ?? 0 })
  }

  return { orders, skips, notices }
}

export interface ProgressView {
  heldCount: number
  cashCents: number
  exposureCents: number
  realizedCents: number
  winRate: number | null
}

function realizedCentsOfClosed(c: ClosedBucket): bigint {
  return roundDiv((c.soldPrice - c.buyPrice) * BigInt(c.shares), 100n) - BigInt(c.buyFeeCents + c.sellFeeCents)
}

export function progressView(state: RunState): ProgressView {
  const held = state.buckets.filter((b) => b.state !== 'empty')
  let exposure = 0n
  for (const b of held) exposure += roundDiv(b.buyPrice * BigInt(b.shares), 100n)
  let realized = 0n
  let wins = 0
  for (const c of state.closed) {
    const r = realizedCentsOfClosed(c)
    realized += r
    if (r > 0n) wins++
  }
  return {
    heldCount: held.length,
    cashCents: state.cashCents,
    exposureCents: Number(exposure),
    realizedCents: Number(realized),
    winRate: state.closed.length === 0 ? null : wins / state.closed.length,
  }
}


