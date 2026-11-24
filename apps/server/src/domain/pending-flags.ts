import type { ISODate, RunState } from '@st/core'
import type { OrderEvidence } from './order-type'
import type { RepoSurface } from './repo-types'
import { sellNeedsChoice } from './sell-attribute'

export interface FlagRow { id: number; side: 'buy' | 'sell'; shares: number; price: bigint; filledOn: ISODate; evidence: OrderEvidence }

// A dry run of the sell matcher: never writes. It reads the run's state and orders once, so the
// caller must either hold the run lock or accept a hint that may be stale. A sell dated after
// `today` is never flagged (its date is fixed first), and a failing read is logged and means
// "no row needs a bucket": the hint must never fail the caller.
export async function rowsNeedingBucket(repos: Pick<RepoSurface, 'bucketRepo' | 'orderRepo'>, runId: number, rows: FlagRow[], today: ISODate, loaded?: RunState): Promise<Set<number>> {
  const sells = rows.filter((r) => r.side === 'sell' && r.filledOn <= today)
  if (sells.length === 0) return new Set()
  try {
    const state = loaded ?? await repos.bucketRepo.loadState(runId)
    const earliest = sells.reduce((min, r) => (r.filledOn < min ? r.filledOn : min), sells[0]!.filledOn)
    const orders = await repos.orderRepo.listForRunFrom(runId, earliest)
    const needing = sells.filter((r) => sellNeedsChoice(orders, state, { runId, filledOn: r.filledOn, shares: r.shares, price: r.price, evidence: r.evidence }))
    return new Set(needing.map((r) => r.id))
  } catch (e) {
    console.error('bucket hint failed:', { runId }, String(e))
    return new Set()
  }
}
