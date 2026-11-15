import type { ISODate } from '@st/core'

export type CorrectionStatus = 'open' | 'applied' | 'dismissed'

// A proposed price/fee fix for an already-booked fill. booked* fields are a
// snapshot of the fill at proposal time; proposedFee null = keep the booked fee.
export interface CorrectionRow {
  id: number; runId: number; fillId: number; captureId: number | null
  side: 'buy' | 'sell'; ticker: string; bookedShares: number; bookedFilledOn: ISODate
  bookedPrice: bigint; bookedFee: number; proposedPrice: bigint; proposedFee: number | null
  status: CorrectionStatus; createdAt: string
}

export type NewCorrection = Omit<CorrectionRow, 'id' | 'status' | 'createdAt'>

export interface CorrectionRepo {
  insert(c: NewCorrection): Promise<number>
  get(id: number): Promise<CorrectionRow | null>
  listOpen(): Promise<CorrectionRow[]>
  decide(id: number, status: 'applied' | 'dismissed'): Promise<boolean> // false unless it was 'open'
  listBlocking(fillId: number, proposedPrice: bigint): Promise<CorrectionRow[]> // open or dismissed only, by id
  hasOpenForCapture(captureId: number): Promise<boolean>
}

// The booked-fill fields a snapshot covers; FillRow satisfies it structurally.
export interface SnapshotFill {
  side: 'buy' | 'sell'; ticker: string; shares: number; price: bigint; fee: number; filledOn: ISODate
}

// A correction is stale when its target fill is gone or no longer matches the
// snapshot taken when it was proposed (hand edit, delete, or a sibling applied).
export function isCorrectionStale(c: CorrectionRow, fill: SnapshotFill | undefined): boolean {
  return !fill
    || fill.side !== c.side
    || fill.ticker !== c.ticker
    || fill.shares !== c.bookedShares
    || fill.filledOn !== c.bookedFilledOn
    || fill.price !== c.bookedPrice
    || fill.fee !== c.bookedFee
}
