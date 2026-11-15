import { parseUsd, type ISODate } from '@st/core'
import { centsFromUsd } from '@st/core/money'
import type { CaptureConflict } from './capture-dedup'
import type { CorrectionRepo } from './correction-types'

// Only the booked-fill fields the snapshot needs, declared here so this module
// stays independent of booking.ts (which imports the recorder, never the other
// way round). FillRow satisfies it structurally.
interface SnapshotFill {
  id: number
  side: 'buy' | 'sell'
  ticker: string
  shares: number
  price: bigint
  fee: number
  filledOn: ISODate
}

export interface CorrectionRecorderRepos {
  fillRepo: { listForRun(runId: number): Promise<SnapshotFill[]> }
  correctionRepo: CorrectionRepo
}

/**
 * Turns each booked-fill conflict into a correction proposal and stamps the
 * conflict with it. A correction for the same fill + extracted price that is
 * still open is reused; a dismissed one is reported but never re-created
 * (dismiss sticks); otherwise a new open correction snapshots the booked fill.
 * Pending-row conflicts pass through untouched. Must run inside the run lock,
 * right after matchCapturedFills, so the cited fills cannot move.
 */
export async function recordCorrections(
  repos: CorrectionRecorderRepos,
  runId: number,
  captureId: number,
  conflicts: CaptureConflict[],
): Promise<CaptureConflict[]> {
  if (!conflicts.some((c) => c.bookedId !== null)) return conflicts
  const fills = new Map((await repos.fillRepo.listForRun(runId)).map((f) => [f.id, f]))
  const out: CaptureConflict[] = []
  for (const c of conflicts) {
    const fill = c.bookedId === null ? undefined : fills.get(c.bookedId)
    if (!fill) {
      out.push(c)
      continue
    }
    const proposedPrice = parseUsd(c.extractedPrice)
    const blocking = await repos.correctionRepo.findBlocking(fill.id, proposedPrice)
    if (blocking) {
      out.push({ ...c, correction: { id: blocking.id, status: blocking.status === 'dismissed' ? 'dismissed' : 'open' } })
      continue
    }
    const id = await repos.correctionRepo.insert({
      runId, fillId: fill.id, captureId, side: fill.side, ticker: fill.ticker,
      bookedShares: fill.shares, bookedFilledOn: fill.filledOn, bookedPrice: fill.price, bookedFee: fill.fee,
      proposedPrice, proposedFee: c.extractedFee ? centsFromUsd(parseUsd(c.extractedFee)) : null,
    })
    out.push({ ...c, correction: { id, status: 'open' } })
  }
  return out
}
