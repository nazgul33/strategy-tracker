import { type ISODate } from '@st/core'
import { formatUsd } from '@st/core/money'
import { bookUnlocked, type BookingDeps } from './booking'
import { withRunLock } from './run-lock'
import { notifySiblingsCancelled } from './sibling-notify'

// Operator corrections to what the vision model read. feeCents: null recomputes the
// fee from the run's costPpm; undefined keeps the fee captured on the pending row.
export interface ConfirmOverrides {
  shares?: number
  price?: string
  filledOn?: ISODate
  side?: 'buy' | 'sell'
  feeCents?: number | null
}

export async function confirmPendingFill(pendingId: number, overrides: ConfirmOverrides | null, deps: BookingDeps): Promise<void> {
  const repos = deps.repos
  if (overrides?.side !== undefined && overrides.side !== 'buy' && overrides.side !== 'sell') throw new Error('invalid-side')
  const feeOverride = overrides?.feeCents
  if (feeOverride !== undefined && feeOverride !== null && !(Number.isInteger(feeOverride) && feeOverride >= 0)) throw new Error('invalid-fee')
  // Only a peek to learn which run this pending belongs to; everything that
  // reads and writes state happens inside the lock, where the row is re-read.
  const known = (await repos.pendingRepo.listPending()).find((p: any) => p.id === pendingId)
  if (!known) throw new Error('pending-not-found-or-not-pending')

  // bookUnlocked, not runBooking: the lock is not reentrant.
  const cancelled = await withRunLock(known.runId, async () => {
    const pendingList = await repos.pendingRepo.listPending()
    const pending = pendingList.find((p: any) => p.id === pendingId)
    if (!pending) throw new Error('pending-not-found-or-not-pending')

    const run = await repos.runRepo.get(pending.runId)
    if (pending.ticker !== run.ticker) throw new Error('ticker-mismatch')
    const priceStr = overrides?.price ?? formatUsd(pending.price)
    const shares = overrides?.shares ?? pending.shares
    const filledOn = overrides?.filledOn ?? pending.filledOn

    return bookUnlocked({
      runId: pending.runId,
      side: overrides?.side ?? pending.side,
      shares,
      priceStr,
      feeCents: feeOverride !== undefined ? feeOverride : pending.fee,
      filledOn,
      pendingId,
      source: 'capture',
    }, deps)
  })
  await notifySiblingsCancelled(known.runId, cancelled, deps)
}
