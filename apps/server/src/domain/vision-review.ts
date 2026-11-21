import type { RepoSurface } from './booking'

// What the vision model read, as frozen onto the pending row at ingest.
// detectedAt null marks a row that predates the snapshot.
export interface DetectedValues {
  side: string | null
  shares: number | null
  price: bigint | null
  filledOn: string | null
  fee: number | null
  detectedAt: string | null
}

// What was booked once the operator was done with the fill.
export interface FinalValues {
  side: string
  shares: number
  price: bigint
  filledOn: string
  fee: number
}

export type VisionReviewInsert = {
  runId: number
  captureId: number
  pendingFillId: number
  ticker: string
  outcome: 'confirmed' | 'rejected'
  detectedSide: string | null
  detectedShares: number | null
  detectedPrice: bigint | null
  detectedFilledOn: string | null
  detectedFee: number | null
  finalSide: string | null
  finalShares: number | null
  finalPrice: bigint | null
  finalFilledOn: string | null
  finalFee: number | null
  edited: boolean
  // True whenever the confirm carried a fee override, `null` (cleared: the server books the default
  // fee) included (operator ruling 2026-11-20). Without it, a final fee that differs from the
  // detected one could be the system-derived fee, so the review tab highlights the fee only when
  // this is true and the final fee differs from the detected one. Always false for a reject.
  feeOverridden: boolean
}
export type VisionReviewRow = VisionReviewInsert & { id: number; createdAt: string }

// The pending_fills columns resolveReview reads.
export interface ReviewedPendingRow {
  id: number; runId: number; ticker: string
  detectedSide: string | null; detectedShares: number | null; detectedPrice: bigint | null
  detectedFilledOn: string | null; detectedFee: number | null; detectedAt: string | null
}

export type ReviewRepos = Pick<RepoSurface, 'pendingRepo' | 'captureImageRepo' | 'visionReviewRepo'>

function feeCounts(detected: DetectedValues, feeOverride: number | null | undefined): boolean {
  if (feeOverride === undefined) return false
  return !(feeOverride === null && detected.fee === null)
}

/**
 * null detected value + non-null final counts as edited; legacy rows (detectedAt null) never do.
 * The fee is the one field the system derives on its own (a feeless capture books at the run's
 * cost), so it counts only when the confirm carried a `feeCents` override (`feeOverride`, undefined
 * when absent), and `feeCents: null` ("recompute from cost ppm") is an edit only when it discards
 * a fee vision read (`detected.fee !== null`), compared by value against the booked fee.
 */
export function isEdited(detected: DetectedValues, final: FinalValues | null, opts: { feeOverride: number | null | undefined }): boolean {
  if (detected.detectedAt === null || final === null) return false
  return detected.side !== final.side
    || detected.shares !== final.shares
    || detected.price !== final.price
    || detected.filledOn !== final.filledOn
    || (feeCounts(detected, opts.feeOverride) && detected.fee !== final.fee)
}

// Freeze, keep, sweep, in that order. The frozen row is written for every
// resolution, kept or not: a later Keep on a sibling must still be able to show
// what happened here, and by then the pending row's live values are gone.
// Callers hold the run lock, so two siblings cannot both decide they were last.
export async function resolveReview(
  repos: ReviewRepos,
  args: {
    pendingRow: ReviewedPendingRow
    captureId: number | null
    outcome: 'confirmed' | 'rejected'
    final: FinalValues | null
    keepImage: boolean
    /**
     * The confirm's `feeCents` override (undefined when it carried none, and for a reject); see `isEdited`
     * and the `feeOverridden` field comment above.
     */
    feeOverride?: number | null
  },
): Promise<void> {
  const { pendingRow, captureId, outcome, final, keepImage, feeOverride } = args
  if (captureId === null) return

  const detected: DetectedValues = {
    side: pendingRow.detectedSide ?? null,
    shares: pendingRow.detectedShares ?? null,
    price: pendingRow.detectedPrice ?? null,
    filledOn: pendingRow.detectedFilledOn ?? null,
    fee: pendingRow.detectedFee ?? null,
    detectedAt: pendingRow.detectedAt ?? null,
  }
  await repos.visionReviewRepo.insertIgnore({
    runId: pendingRow.runId,
    captureId,
    pendingFillId: pendingRow.id,
    ticker: pendingRow.ticker,
    outcome,
    detectedSide: detected.side,
    detectedShares: detected.shares,
    detectedPrice: detected.price,
    detectedFilledOn: detected.filledOn,
    detectedFee: detected.fee,
    finalSide: final?.side ?? null,
    finalShares: final?.shares ?? null,
    finalPrice: final?.price ?? null,
    finalFilledOn: final?.filledOn ?? null,
    finalFee: final?.fee ?? null,
    edited: isEdited(detected, final, { feeOverride }),
    feeOverridden: feeOverride !== undefined,
  })

  // Sticky: only ever raised, never lowered.
  if (keepImage) await repos.captureImageRepo.setKeep(captureId)

  if (await repos.pendingRepo.hasLiveForCapture(captureId)) return
  if (await repos.captureImageRepo.isKept(captureId)) return
  await repos.captureImageRepo.deleteFor(captureId)
  await repos.visionReviewRepo.deleteFor(captureId)
}
