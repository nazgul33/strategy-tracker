import { roundDiv, TICK_USD } from './money'

export type ISODate = string // 'YYYY-MM-DD'

export type BucketState = 'empty' | 'held' | 'force_sell'
export interface Bucket {
  index: number
  state: BucketState
  shares: number
  buyPrice: bigint
  buyFeeCents: number
  filledOn: ISODate
}
export interface ClosedBucket {
  index: number
  shares: number
  buyPrice: bigint
  soldPrice: bigint
  buyFeeCents: number
  sellFeeCents: number
  openedOn: ISODate
  closedOn: ISODate
}
export interface RunState {
  buckets: Bucket[]
  cashCents: number
  closed: ClosedBucket[]
  ages: Record<number, number>
}
export interface Run {
  id: number
  name: string
  ticker: string
  strategyKey: 'mean-reversion'
  costPpm: number
  buyGapPpm: number
  sellGapPpm: number
  poolCents: number
  status: 'active' | 'paused' | 'closed'
}
export interface Notice {
  code: string
  params?: Record<string, string | number>
}
export interface DayContext {
  tradeDate: ISODate
  lastClose: bigint
  lastCloseDate: ISODate
}
export type OrderKind = 'buy_loc' | 'sell_loc' | 'market_sell'
export interface PlannedOrder {
  kind: OrderKind
  bucketIndex: number
  limitPrice: bigint
  shares: number
  /** Bucket age (trading days, post-morning bump) stamped at plan time; sell
   * orders only. Required because applySellFill deletes the bucket's age, so
   * the stored plan is the only surviving record for the sim replay. */
  ageDays?: number
}
export interface DayPlan {
  orders: PlannedOrder[]
  skips: PlannedOrder[]
  notices: Notice[]
}
export class DomainError extends Error {
  kind: string
  constructor(kind: string, message?: string) {
    super(message)
    this.kind = kind
    this.name = 'DomainError'
  }
}

export function bucketBudgetCents(poolCents: number): number {
  return Math.floor(poolCents / 10)
}

export function sellTarget(buyPrice: bigint, costPpm: number, shares: bigint): bigint {
  return buyPrice + TICK_USD + roundDiv(buyPrice * 2n * BigInt(costPpm), 1_000_000n)
}