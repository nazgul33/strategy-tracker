import type { ISODate, RunState } from '@st/core'
import type { OrderRepo } from './repo-types'
import { openSellLegs, staleSellLegs, type OrderRow } from './sell-match'

export type EmptyCause =
  | { kind: 'sold'; filledOn: ISODate; legId: number | null }   // legId: the order the emptying sell belongs to
  | { kind: 'buy-removed'; filledOn: ISODate }                  // filledOn: the deleted buy's trade date

const SELL_SIDE_KINDS: readonly string[] = ['sell_loc', 'stop_sell', 'market_sell']

// Indices of the buckets that are not 'empty' in prev and 'empty' in next, ascending.
export function emptiedBuckets(prev: RunState, next: RunState): number[] {
  const wasEmpty = new Set(prev.buckets.filter((b) => b.state === 'empty').map((b) => b.index))
  return next.buckets.filter((b) => b.state === 'empty' && !wasEmpty.has(b.index)).map((b) => b.index).sort((a, b) => a - b)
}

// A bucket that just became empty (its last shares sold, or its buy removed) leaves
// every sell-side order of it with nothing to sell, however the bucket was chosen and
// whenever the order was planned. A partial change leaves shares that still need both
// legs, so callers invoke this only for a bucket in emptiedBuckets. Plain status
// writer, not cancelOrder (that re-enters the run lock).
//
// `orders` is the run's orders from cause.filledOn onwards. Open legs are cancelled
// and returned: the operator must pull them at the broker. Stale legs are cancelled
// silently, since nothing is live at the broker for them; left alone, a later rebuy of
// the bucket would let one pass the shares gate and absorb an unrelated late fill.
// A sell then flips its own order to filled; a removed buy flips nothing.
export async function retireLegs(
  repos: { orderRepo: Pick<OrderRepo, 'setStatus'> },
  orders: OrderRow[],
  key: { runId: number; bucketIdx: number },
  cause: EmptyCause,
): Promise<number[]> {
  const sold = cause.kind === 'sold'
  const exceptId = sold ? cause.legId : null
  const reason = sold ? 'broker-filled' : 'other'
  const open = openSellLegs(orders, { ...key, fromTradeDate: cause.filledOn }, exceptId)
  const stale = sold
    ? staleSellLegs(orders, { ...key, tradeDate: cause.filledOn }, exceptId)
    : orders
        .filter((o) => o.runId === key.runId && o.bucketIdx === key.bucketIdx && o.tradeDate >= cause.filledOn && o.status === 'stale' && SELL_SIDE_KINDS.includes(o.kind))
        .sort((a, b) => a.id - b.id)
  const cancelledIds: number[] = []
  for (const o of open) {
    await repos.orderRepo.setStatus(o.id, 'cancelled', reason)
    cancelledIds.push(o.id)
  }
  for (const o of stale) await repos.orderRepo.setStatus(o.id, 'cancelled', reason)
  if (sold && cause.legId !== null) await repos.orderRepo.setStatus(cause.legId, 'filled')
  return cancelledIds
}
