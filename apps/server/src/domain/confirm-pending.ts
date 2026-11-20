import { parseUsd, type ISODate } from '@st/core'
import { formatUsd } from '@st/core/money'
import { bookUnlocked, finalFeeCents, type BookingDeps, type FillBookingDeps } from './booking'
import { withRunLock } from './run-lock'
import { notifyBookingOutcome } from './booking-notify'
import { resolveReview } from './vision-review'

// Operator corrections to what the vision model read. feeCents: null recomputes the
// fee from the run's costPpm; undefined keeps the fee captured on the pending row.
export interface ConfirmOverrides {
  shares?: number
  price?: string
  filledOn?: ISODate
  side?: 'buy' | 'sell'
  feeCents?: number | null
}

export async function confirmPendingFill(pendingId: number, overrides: ConfirmOverrides | null, deps: FillBookingDeps, opts?: { keepImage?: boolean }): Promise<void> {
  const repos = deps.repos
  if (overrides?.side !== undefined && overrides.side !== 'buy' && overrides.side !== 'sell') throw new Error('invalid-side')
  const feeOverride = overrides?.feeCents
  if (feeOverride !== undefined && feeOverride !== null && !(Number.isInteger(feeOverride) && feeOverride >= 0)) throw new Error('invalid-fee')
  // Only a peek to learn which run this pending belongs to; everything that
  // reads and writes state happens inside the lock, where the row is re-read.
  const known = (await repos.pendingRepo.listPending()).find((p: any) => p.id === pendingId)
  if (!known) throw new Error('pending-not-found-or-not-pending')

  // bookUnlocked, not runBooking: the lock is not reentrant.
  const outcome = await withRunLock(known.runId, async () => {
    const pendingList = await repos.pendingRepo.listPending()
    const pending = pendingList.find((p: any) => p.id === pendingId)
    if (!pending) throw new Error('pending-not-found-or-not-pending')

    const run = await repos.runRepo.get(pending.runId)
    if (pending.ticker !== run.ticker) throw new Error('ticker-mismatch')
    const priceStr = overrides?.price ?? formatUsd(pending.price)
    const shares = overrides?.shares ?? pending.shares
    const filledOn = overrides?.filledOn ?? pending.filledOn

    const side = overrides?.side ?? pending.side
    const feeCents: number | null = feeOverride !== undefined ? feeOverride : pending.fee
    const booked = await bookUnlocked({
      runId: pending.runId,
      side,
      shares,
      priceStr,
      feeCents,
      filledOn,
      pendingId,
      source: 'capture',
    }, deps)

    // After booking, inside the lock: a late no-empty-bucket / no-bucket-for-sell
    // leaves the fill pending for a retry and must not leave a 'confirmed' record
    // behind. Once booked, archive bookkeeping must not fail the confirm or skip
    // the booking notifications, so a failure here is logged and swallowed.
    const price = parseUsd(priceStr)
    try {
      await resolveReview(repos, {
        pendingRow: pending, captureId: pending.captureId ?? null, outcome: 'confirmed',
        final: { side, shares, price, filledOn, fee: finalFeeCents(run, price, shares, feeCents) },
        keepImage: opts?.keepImage === true, feeOverride,
      })
    } catch (e) {
      console.error('vision review archive failed:', pendingId, String(e))
    }
    return booked
  })
  await notifyBookingOutcome(known.runId, outcome, deps)
}

// Resolves false when the row is missing or already handled (callers answer 409 /
// the duplicate message). Under the run lock so two siblings resolving at once
// cannot both see "no pending left" and race the sweep. The reject has taken
// effect once decide succeeds, so an archive failure is logged and contained,
// exactly as on the confirm path.
export async function rejectPendingFill(pendingId: number, deps: Pick<BookingDeps, 'repos'>, opts?: { keepImage?: boolean }): Promise<boolean> {
  const repos = deps.repos
  // Only a peek to learn the run; the row is re-read inside the lock.
  const known = (await repos.pendingRepo.listPending()).find((p: any) => p.id === pendingId)
  if (!known) return false

  return withRunLock(known.runId, async () => {
    const pending = (await repos.pendingRepo.listPending()).find((p: any) => p.id === pendingId)
    if (!pending) return false
    if ((await repos.pendingRepo.decide(pendingId, 'rejected')) === false) return false
    try {
      await resolveReview(repos, {
        pendingRow: pending, captureId: pending.captureId ?? null, outcome: 'rejected',
        final: null, keepImage: opts?.keepImage === true,
      })
    } catch (e) {
      console.error('vision review archive failed:', pendingId, String(e))
    }
    return true
  })
}
