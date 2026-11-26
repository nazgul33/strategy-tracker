import type { ISODate } from '@st/core'
import { centsFromUsd, parseUsd } from '@st/core/money'
import type { RawFill } from '@st/ingest'
import { sha256 } from '../booking'
import { claimCapture } from '../capture-claim'
import { storeCaptureImage } from '../capture-image'
import type { RepoSurface } from '../repo-types'
import { withRunLock } from '../run-lock'
import { knownOrderPrice, matchVrFills, type VrExisting } from './capture-match'
import type { NewVrPending, VrRepos, VrRunRow } from './repo-types'

export type VrCaptureOutcome = 'duplicate' | { waiting: number; dropped: number; possibleDuplicates: number }

export interface VrCaptureRepos extends Pick<VrRepos, 'vrFillRepo' | 'vrPendingRepo'>, Pick<RepoSurface, 'captureRepo' | 'captureImageRepo'> {}

export interface VrCaptureDeps { repos: VrCaptureRepos; today: ISODate }

const feeOf = (fee: string | null | undefined): number | null => (fee == null ? null : centsFromUsd(parseUsd(fee)))

/** Turns the fills read from a screenshot into waiting rows on a VR run. */
export async function ingestVrCapture(
  run: VrRunRow, image: { base64: string; mime: string }, fills: readonly RawFill[], deps: VrCaptureDeps,
): Promise<VrCaptureOutcome> {
  const { repos, today } = deps
  // Routing already hands over this run's ticker only; a stray fill must not become a row under the wrong ticker.
  const own = fills.filter((f) => f.ticker === run.ticker)
  const hash = await sha256(new TextEncoder().encode(image.base64))

  return withRunLock(run.id, async () => {
    const claim = await claimCapture({
      captureRepo: repos.captureRepo,
      pendingRepo: {
        // A screenshot that already produced rows for this run is never taken in again, whatever became of them.
        hasLiveForCapture: (id) => repos.vrPendingRepo.hasAnyForCapture(id),
        hasConfirmedForCapture: async () => false,
      },
      correctionRepo: { hasOpenForCapture: async () => false },
    }, run.id, hash, 'parsed')
    if (claim === null) return 'duplicate'

    // Confirmed rows are not entries: their fills are among the booked ones already.
    const [booked, waiting, rejected] = await Promise.all([
      repos.vrFillRepo.listForRun(run.id),
      repos.vrPendingRepo.listForRun(run.id, 'pending'),
      repos.vrPendingRepo.listForRun(run.id, 'rejected'),
    ])
    const entry = (kind: VrExisting['kind']) => (r: Omit<VrExisting, 'kind'>): VrExisting =>
      ({ kind, side: r.side, shares: r.shares, price: r.price, filledOn: r.filledOn, orderPrice: r.orderPrice })
    const existing = [...booked.map(entry('booked')), ...waiting.map(entry('waiting')), ...rejected.map(entry('rejected'))]
    const { rows: matched, dropped } = matchVrFills(existing, own, today)
    const rows = matched.map(({ fill: f, dupPrice }): NewVrPending => ({
      runId: run.id, captureId: claim.id, side: f.side, shares: f.shares, price: parseUsd(f.price), fee: feeOf(f.fee),
      filledOn: f.date ?? today, dateRead: f.date != null, dupPrice, orderPrice: knownOrderPrice(f.orderPrice),
    }))
    if (rows.length > 0) {
      await repos.vrPendingRepo.insertMany(rows)
      await storeCaptureImage(repos, claim.id, image)
    }
    return { waiting: rows.length, dropped, possibleDuplicates: rows.filter((r) => r.dupPrice !== null).length }
  })
}
