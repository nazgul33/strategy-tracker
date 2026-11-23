import { parseUsd, type ISODate } from '@st/core'
import { formatUsd } from '@st/core/money'
import { bookUnlocked, finalFeeCents, type BookingDeps, type FillBookingDeps } from './booking'
import { withRunLock } from './run-lock'
import { requireRun } from './require-run'
import { notifyBookingOutcome } from './booking-notify'
import { evidenceOf } from './order-type'
import { resolveReview } from './vision-review'

// Operator corrections to what the vision model read. feeCents: null recomputes the
// fee from the run's costPpm; undefined keeps the fee captured on the pending row.
// bucketIdx forces the sell's bucket (sell only; null/undefined = automatic).
export interface ConfirmOverrides {
  shares?: number
  price?: string
  filledOn?: ISODate
  side?: 'buy' | 'sell'
  feeCents?: number | null
  bucketIdx?: number | null
}

// When the operator asks to keep the screenshot, the keep flag is written first
// inside the lock, before anything is booked or the row flips, so a crash can
// never leave an unkept image for the boot janitor to delete:
// - setKeep throws: nothing is booked or decided; the confirm fails as a whole
//   and the operator retries.
// - A booking refusal (invalid-bucket, bucket-not-found, bucket-not-held,
//   too-many-shares, no-empty-bucket, no-bucket-for-sell, choose-bucket, fill-date-in-future, a lost decide race)
//   leaves the row pending and the image kept; the flag is sticky, so a later
//   confirm or reject, with or without keep, leaves it kept.
// - A crash or thrown write after decide flipped the row leaves it confirmed
//   with the image kept; the boot repair (refreezeKept, run by runBootSweeps)
//   rebuilds the missing frozen record at the next boot.
// archived is false when the vision-review bookkeeping (freeze, then keep or
// sweep) threw after the fill was booked; the confirm itself still succeeded and
// a requested keep is already in place. archived: true only means the
// bookkeeping did not throw: it is also true for a row with no capture or image.
export async function confirmPendingFill(pendingId: number, overrides: ConfirmOverrides | null, deps: FillBookingDeps, opts?: { keepImage?: boolean }): Promise<{ archived: boolean }> {
  const repos = deps.repos
  // Only a peek to learn which run this pending belongs to; everything that
  // reads and writes state happens inside the lock, where the row is re-read.
  const known = (await repos.pendingRepo.listPending()).find((p) => p.id === pendingId)
  if (!known) throw new Error('pending-not-found-or-not-pending')
  if (overrides?.side !== undefined && overrides.side !== 'buy' && overrides.side !== 'sell') throw new Error('invalid-side')
  const feeOverride = overrides?.feeCents
  if (feeOverride !== undefined && feeOverride !== null && !(Number.isInteger(feeOverride) && feeOverride >= 0)) throw new Error('invalid-fee')

  // bookUnlocked, not runBooking: the lock is not reentrant.
  const { outcome, archived } = await withRunLock(known.runId, async () => {
    const pendingList = await repos.pendingRepo.listPending()
    const pending = pendingList.find((p) => p.id === pendingId)
    if (!pending) throw new Error('pending-not-found-or-not-pending')

    const run = await requireRun(repos, pending.runId)
    if (pending.ticker !== run.ticker) throw new Error('ticker-mismatch')
    if (opts?.keepImage === true && pending.captureId != null) await repos.captureImageRepo.setKeep(pending.captureId)
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
      bucketIdx: overrides?.bucketIdx ?? null,
      order: side === 'sell' ? evidenceOf(pending) : undefined,
      // the kind of the override; the local `feeOverride` is its value (undefined = none, null = cleared)
      feeOverride: feeOverride === undefined ? 'none' : feeOverride === null ? 'cleared' : 'set',
    }, deps)

    // After booking, inside the lock: a late no-empty-bucket / no-bucket-for-sell
    // leaves the fill pending for a retry and must not leave a 'confirmed' record
    // behind. Once booked, archive bookkeeping must not fail the confirm or skip
    // the booking notifications, so a failure here is logged and swallowed.
    const price = parseUsd(priceStr)
    let archived = true
    try {
      await resolveReview(repos, {
        pendingRow: pending, captureId: pending.captureId ?? null, outcome: 'confirmed',
        final: { side, shares, price, filledOn, fee: finalFeeCents(run, price, shares, feeCents) },
        keepImage: opts?.keepImage === true, feeOverride,
      })
    } catch (e) {
      archived = false
      console.error('vision review archive failed:', pendingId, String(e))
    }
    return { outcome: booked, archived }
  })
  await notifyBookingOutcome(known.runId, outcome, deps)
  return { archived }
}

// Resolves null when the row is missing or already handled (the HTTP caller
// answers 409, the Telegram caller answers "Already handled"). Under the run
// lock so two siblings resolving at once cannot both see "no pending left" and
// race the sweep. As on the confirm path, a requested keep is written first,
// before decide flips the row:
// - setKeep throws: nothing is decided; the reject fails as a whole and the
//   operator retries.
// - A lost decide race resolves null with the image kept (the flag is sticky).
// - A crash after decide leaves the row rejected with the image kept; the boot
//   repair (refreezeKept, run by runBootSweeps) rebuilds the missing frozen
//   record at the next boot.
// The reject has taken effect once decide succeeds, so an archive failure is
// logged and contained and reported as archived: false, with a requested keep
// already in place. archived: true only means the bookkeeping did not throw; it
// is also true for a row with no capture or image.
export async function rejectPendingFill(pendingId: number, deps: Pick<BookingDeps, 'repos'>, opts?: { keepImage?: boolean }): Promise<{ archived: boolean } | null> {
  const repos = deps.repos
  // Only a peek to learn the run; the row is re-read inside the lock.
  const known = (await repos.pendingRepo.listPending()).find((p) => p.id === pendingId)
  if (!known) return null

  return withRunLock(known.runId, async () => {
    const pending = (await repos.pendingRepo.listPending()).find((p) => p.id === pendingId)
    if (!pending) return null
    if (opts?.keepImage === true && pending.captureId != null) await repos.captureImageRepo.setKeep(pending.captureId)
    if ((await repos.pendingRepo.decide(pendingId, 'rejected')) === false) return null
    try {
      await resolveReview(repos, {
        pendingRow: pending, captureId: pending.captureId ?? null, outcome: 'rejected',
        final: null, keepImage: opts?.keepImage === true,
      })
    } catch (e) {
      console.error('vision review archive failed:', pendingId, String(e))
      return { archived: false }
    }
    return { archived: true }
  })
}
