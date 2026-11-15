import { parseUsd } from '@st/core'
import { centsFromUsd } from '@st/core/money'
import type { CaptureConflict } from './capture-dedup'
import { isCorrectionStale, type CorrectionRepo, type CorrectionRow, type SnapshotFill } from './correction-types'

// Only the booked-fill fields the snapshot needs, declared here so this module
// stays independent of booking.ts (which imports the recorder, never the other
// way round). FillRow satisfies it structurally.
interface RecorderFill extends SnapshotFill {
  id: number
}

export interface CorrectionRecorderRepos {
  fillRepo: { listForRun(runId: number): Promise<RecorderFill[]> }
  correctionRepo: CorrectionRepo
}

// First non-stale open row wins over a non-stale dismissed one; none → undefined.
function pickBlocking(rows: CorrectionRow[], fill: SnapshotFill): CorrectionRow | undefined {
  const live = rows.filter((r) => !isCorrectionStale(r, fill))
  return live.find((r) => r.status === 'open') ?? live.find((r) => r.status === 'dismissed')
}

/**
 * Turns each booked-fill conflict into a correction proposal and stamps the
 * conflict with it. A correction for the same fill + extracted price that is
 * still open is reused; a dismissed one is reported but never re-created
 * (dismiss sticks) — both only while the fill still matches their snapshot.
 * A stale row (the fill was hand-edited since) is ignored, so a new open
 * correction snapshots the booked fill as it is now.
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
    const blocking = pickBlocking(await repos.correctionRepo.listBlocking(fill.id, proposedPrice), fill)
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
