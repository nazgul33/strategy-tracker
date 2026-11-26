import type { ISODate } from '@st/core'
import { centsFromUsd, formatUsd, parseUsd } from '@st/core/money'
import type { RawFill } from '@st/ingest'
import { sha256 } from '../booking'
import { claimCapture } from '../capture-claim'
import { storeCaptureImage } from '../capture-image'
import { dropExactMatches, matchCapturedFills, type CaptureConflict, type CaptureTradeReader } from '../capture-dedup'
import type { RepoSurface } from '../repo-types'
import { withRunLock } from '../run-lock'
import type { NewVrPending, VrRepos, VrRunRow } from './repo-types'

export type VrCaptureOutcome = 'duplicate' | { waiting: number; dropped: number; possibleDuplicates: number }

export interface VrCaptureRepos extends Pick<VrRepos, 'vrFillRepo' | 'vrPendingRepo'>, Pick<RepoSurface, 'captureRepo' | 'captureImageRepo'> {}

export interface VrCaptureDeps { repos: VrCaptureRepos; today: ISODate }

const feeOf = (fee: string | null | undefined): number | null => (fee == null ? null : centsFromUsd(parseUsd(fee)))

// A conflict does not carry the raw fill, so whether its date was read is recovered from the fills the matcher
// did not call fresh: the conflicts are the last of their exact key (phase 1 of the matcher consumes the earliest).
function unreadDates(kept: readonly RawFill[], fresh: readonly RawFill[], today: ISODate) {
  const freshSet = new Set(fresh)
  const key = (side: string, shares: number, price: string, date: string) => `${side}|${shares}|${formatUsd(parseUsd(price))}|${date}`
  const byKey = new Map<string, RawFill[]>()
  for (const f of kept) {
    if (freshSet.has(f)) continue
    const k = key(f.side, f.shares, f.price, f.date ?? today)
    byKey.set(k, [...(byKey.get(k) ?? []), f])
  }
  return (c: CaptureConflict): boolean => byKey.get(key(c.side, c.shares, c.extractedPrice, c.filledOn))?.pop()?.date != null
}

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

    const rejected = (await repos.vrPendingRepo.listForRun(run.id, 'rejected'))
      .map((p) => ({ side: p.side, ticker: run.ticker, shares: p.shares, price: p.price, filledOn: p.filledOn }))
    const { kept, dropped: rejectedDropped } = dropExactMatches(rejected, own, today)

    const reader: CaptureTradeReader = {
      fillRepo: {
        listForRun: async () => (await repos.vrFillRepo.listForRun(run.id))
          .map((f) => ({ id: f.id, side: f.side, ticker: run.ticker, shares: f.shares, price: f.price, filledOn: f.filledOn })),
      },
      pendingRepo: {
        listPending: async () => (await repos.vrPendingRepo.listForRun(run.id, 'pending'))
          .map((p) => ({ id: p.id, runId: run.id, side: p.side, ticker: run.ticker, shares: p.shares, price: p.price, filledOn: p.filledOn })),
      },
    }
    const { fresh, conflicts } = await matchCapturedFills(reader, run.id, kept, today)
    const dropped = rejectedDropped + (kept.length - fresh.length - conflicts.length)

    const dateRead = unreadDates(kept, fresh, today)
    const rows: NewVrPending[] = [
      ...fresh.map((f): NewVrPending => ({
        runId: run.id, captureId: claim.id, side: f.side, shares: f.shares, price: parseUsd(f.price), fee: feeOf(f.fee),
        filledOn: f.date ?? today, dateRead: f.date != null, dupPrice: null,
      })),
      ...conflicts.map((c): NewVrPending => ({
        runId: run.id, captureId: claim.id, side: c.side, shares: c.shares, price: parseUsd(c.extractedPrice), fee: feeOf(c.extractedFee),
        filledOn: c.filledOn, dateRead: dateRead(c), dupPrice: parseUsd(c.matchedKind === 'booked' ? c.bookedPrice : c.pendingPrice),
      })),
    ]
    if (rows.length > 0) {
      await repos.vrPendingRepo.insertMany(rows)
      await storeCaptureImage(repos, claim.id, image)
    }
    return { waiting: rows.length, dropped, possibleDuplicates: conflicts.length }
  })
}
