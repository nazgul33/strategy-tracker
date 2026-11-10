import type { Bucket, DayPlan, Notice, PlannedOrder, Run, RunState } from '@st/core'
import { bucketBudgetCents as coreBucketBudget, formatUsd, sellTarget as coreSellTarget } from '@st/core'
import { nextTradingDay } from '@st/calendar'
import type { ISODate } from '@st/core'

export const MEAN_REVERSION = 'mean-reversion'

export interface MrParams {
  bucketCount: number
  tick: bigint
  sellCapBps: number
  maxAgeDays: number
}

export const DEFAULT_MR_PARAMS: MrParams = {
  bucketCount: 10,
  tick: 100n,
  sellCapBps: 13000,
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
    const limit = ctx.lastClose - 100n
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
    const target = sellTarget(b.buyPrice, run.costPpm, BigInt(b.shares))
    const cap = (ctx.lastClose * BigInt(params.sellCapBps)) / 10000n
    if (target >= cap) {
      // skip
      const skipOrder: PlannedOrder = { kind: 'sell_loc', bucketIndex: b.index, limitPrice: target, shares: b.shares }
      skips.push(skipOrder)
      notices.push({ code: 'sell-capped', params: { bucket: String(b.index), price: formatUsd(target) } })
    } else {
      orders.push({ kind: 'sell_loc', bucketIndex: b.index, limitPrice: target, shares: b.shares })
    }
  }

  // force_sell
  const forced = state.buckets
    .filter((b) => b.state === 'force_sell')
    .sort((a, b) => a.index - b.index)
  for (const b of forced) {
    orders.push({ kind: 'market_sell', bucketIndex: b.index, limitPrice: 0n, shares: b.shares })
  }

  return { orders, skips, notices }
}


