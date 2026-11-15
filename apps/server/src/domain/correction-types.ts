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
  findBlocking(fillId: number, proposedPrice: bigint): Promise<CorrectionRow | null> // open or dismissed only
  hasOpenForCapture(captureId: number): Promise<boolean>
}
