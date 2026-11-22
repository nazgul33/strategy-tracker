import type { ISODate, RunState } from '@st/core'
import type { CaptureImageInsert, CaptureImageListing } from '../db/repos-vision'
import type { CorrectionRepo } from './correction-types'
import type { OrderRow } from './sell-match'
import type { ReviewedPendingRow, VisionReviewInsert, VisionReviewRow } from './vision-review'

export interface PendingDecisionPatch { side: 'buy' | 'sell'; shares: number; price: bigint; fee: number; filledOn: ISODate; bucketIdx: number }

export interface FillRow { id: number; runId: number; bucketIdx: number; side: 'buy' | 'sell'; ticker: string; shares: number; price: bigint; fee: number; filledOn: ISODate; source: string }

export type OrderKind = 'buy_loc' | 'sell_loc' | 'market_sell' | 'stop_sell'
export type OrderStatus = 'open' | 'filled' | 'stale' | 'cancelled'

export interface OrderRecord extends OrderRow { kind: OrderKind; status: OrderStatus; skipReason: string | null; cancelReason: string | null }

export interface NewOrder { runId: number; tradeDate: ISODate; kind: OrderKind; bucketIdx: number; limitPrice: bigint; shares: number; status: OrderStatus }

export interface OrderRepo {
  insertMany(orders: NewOrder[]): Promise<void>
  get(id: number): Promise<OrderRecord | null>
  listForDate(date: string): Promise<OrderRecord[]>
  listForRun(runId: number, date?: string): Promise<OrderRecord[]>
  listForRunFrom(runId: number, fromDate: string): Promise<OrderRecord[]>
  listOpenBefore(date: string): Promise<OrderRecord[]>
  markStale(date: string): Promise<number>
  setStatus(id: number, status: OrderStatus, cancelReason?: string): Promise<void>
}

export type PendingStatus = 'pending' | 'confirmed' | 'rejected'

export interface PendingRow extends ReviewedPendingRow {
  captureId: number | null; bucketIdx: number | null; side: 'buy' | 'sell'; shares: number; price: bigint
  fee: number | null; filledOn: ISODate; status: PendingStatus; createdAt: string
}

// The vision snapshot is optional on insert: a row without it is the legacy shape (detectedAt null).
type DetectedKey = 'detectedSide' | 'detectedShares' | 'detectedPrice' | 'detectedFilledOn' | 'detectedFee' | 'detectedAt'
export type NewPending = Omit<PendingRow, 'id' | 'createdAt' | DetectedKey> & Partial<Pick<PendingRow, DetectedKey>>

export interface PendingRepo {
  insert(p: NewPending): Promise<number>
  listPending(): Promise<PendingRow[]>
  get(id: number): Promise<PendingRow | null>
  hasLiveForCapture(captureId: number): Promise<boolean>
  hasConfirmedForCapture(captureId: number): Promise<boolean>
  decide(id: number, status: 'confirmed' | 'rejected', edited?: PendingDecisionPatch): Promise<boolean>
}

export interface RepoSurface {
  runRepo: { list(): Promise<any[]>; get(id: number): Promise<any>; create(input: any): Promise<number>; updateStatus(id: number, status: string): Promise<void> }
  bucketRepo: { loadState(runId: number): Promise<RunState>; saveState(runId: number, state: RunState): Promise<void> }
  orderRepo: OrderRepo
  fillRepo: {
    insert(fill: any): Promise<any>
    listForRun(runId: number): Promise<FillRow[]>
    // Rebook/delete history surface (Cash Model A rebuild).
    update?(runId: number, fillId: number, patch: { shares?: number; price?: bigint; fee?: number }): Promise<void>
    deleteById?(runId: number, fillId: number): Promise<void>
  }
  pendingRepo: Omit<PendingRepo, 'get'>
  correctionRepo: CorrectionRepo
  captureRepo: { findByHash(runId: number, hash: string): Promise<{ id: number; status: string } | null>; setStatus(id: number, status: 'parsed' | 'unparseable'): Promise<void>; insert(c: any): Promise<{ inserted: boolean; id?: number }> }
  captureImageRepo: {
    insertIgnore(row: CaptureImageInsert): Promise<boolean>
    getBytes(captureId: number): Promise<{ mime: string; bytes: Buffer } | null>
    isKept(captureId: number): Promise<boolean>
    setKeep(captureId: number): Promise<void>
    deleteFor(captureId: number): Promise<void>
    discard(captureId: number): Promise<void>
    listKept(limit: number): Promise<CaptureImageListing[]>
  }
  visionReviewRepo: {
    insertIgnore(row: VisionReviewInsert): Promise<void>
    listForCaptures(captureIds: number[]): Promise<VisionReviewRow[]>
    deleteFor(captureId: number): Promise<void>
  }
  ledgerRepo: { insert(l: any): Promise<any>; listForRun(runId: number): Promise<any[]> }
  notificationRepo: { insert(n: any): Promise<any> }
}
