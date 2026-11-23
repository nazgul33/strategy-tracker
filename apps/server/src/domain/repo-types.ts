import type { ISODate, RunState } from '@st/core'
import type { CaptureImageInsert, CaptureImageListing } from '../db/repos-vision'
import type { CorrectionRepo } from './correction-types'
import type { OrderRow } from './sell-match'
import type { ReviewedPendingRow, VisionReviewInsert, VisionReviewRow } from './vision-review'

// How a confirm treated the fee: left it alone, cleared it (feeCents: null), or set one.
export type FeeOverrideKind = 'none' | 'cleared' | 'set'

// feeOverride is optional so that existing patch literals stay as they are; bookUnlocked always sets it.
export interface PendingDecisionPatch { side: 'buy' | 'sell'; shares: number; price: bigint; fee: number; filledOn: ISODate; bucketIdx: number; feeOverride?: FeeOverrideKind }

export type FillSource = 'capture' | 'manual' | 'seed'

export interface FillRow { id: number; runId: number; bucketIdx: number; side: 'buy' | 'sell'; ticker: string; shares: number; price: bigint; fee: number; filledOn: ISODate; source: FillSource }

export type NewFill = Omit<FillRow, 'id'>

export interface FillPatch { shares?: number; price?: bigint; fee?: number; filledOn?: ISODate }

export interface FillRepo {
  insert(fill: NewFill): Promise<void>
  listForRun(runId: number): Promise<FillRow[]>
  update(runId: number, fillId: number, patch: FillPatch): Promise<void>
  deleteById(runId: number, fillId: number): Promise<void>
}

export type CaptureStatus = 'pending' | 'parsed' | 'unparseable' | 'duplicate' | 'confirmed'

export interface NewCapture { runId: number; chatId: string | null; imageHash: string; status: CaptureStatus }

export interface CaptureRepo {
  findByHash(runId: number, hash: string): Promise<{ id: number; status: CaptureStatus } | null>
  setStatus(id: number, status: 'parsed' | 'unparseable'): Promise<void>
  insert(c: NewCapture): Promise<{ inserted: boolean; id?: number }>
}

export interface LedgerRow { id: number; runId: number; ts: string; kind: string; amountCents: number; ref: string | null }

export type NewLedgerEntry = Omit<LedgerRow, 'id' | 'ts'>

export interface LedgerRepo {
  insert(l: NewLedgerEntry): Promise<void>
  listForRun(runId: number): Promise<LedgerRow[]>
}

export interface NotificationRow { id: number; runId: number | null; chatId: string; text: string; sentAt: string }

export type NewNotification = Omit<NotificationRow, 'id' | 'sentAt'>

export interface NotificationRepo {
  insert(n: NewNotification): Promise<void>
  listForRun(runId: number): Promise<NotificationRow[]>
  /** Newest first (id descending); only rows with id < before when before is not null. */
  listBefore(before: number | null, limit: number): Promise<NotificationRow[]>
}

export type OrderKind = 'buy_loc' | 'sell_loc' | 'market_sell' | 'stop_sell'
export type OrderStatus = 'open' | 'filled' | 'stale' | 'cancelled'

export interface OrderRecord extends OrderRow { kind: OrderKind; status: OrderStatus; skipReason: string | null; cancelReason: string | null; reportedAt: string | null }

export interface NewOrder { runId: number; tradeDate: ISODate; kind: OrderKind; bucketIdx: number; limitPrice: bigint; shares: number; status: OrderStatus }

export interface OrderRepo {
  insertMany(orders: NewOrder[]): Promise<void>
  get(id: number): Promise<OrderRecord | null>
  listForDate(date: string): Promise<OrderRecord[]>
  listForRun(runId: number, date?: string): Promise<OrderRecord[]>
  listForRunFrom(runId: number, fromDate: string): Promise<OrderRecord[]>
  markStale(date: string): Promise<number>
  setStatus(id: number, status: OrderStatus, cancelReason?: string): Promise<void>
  /** The run's stale orders no recorded digest has named yet, lowest id first. */
  listUnreportedStale(runId: number): Promise<OrderRecord[]>
  /** Stamps reported_at on these orders; an empty list writes nothing. */
  markReported(ids: number[]): Promise<void>
}

export type PendingStatus = 'pending' | 'confirmed' | 'rejected'

export interface PendingRow extends ReviewedPendingRow {
  captureId: number | null; bucketIdx: number | null; side: 'buy' | 'sell'; shares: number; price: bigint
  fee: number | null; filledOn: ISODate; status: PendingStatus; createdAt: string
  feeOverride?: FeeOverrideKind | null   // server-internal: how the confirm treated the fee; never sent to a client
}

export type NewPending = Omit<PendingRow, 'id' | 'createdAt'>

export interface PendingRepo {
  insert(p: NewPending): Promise<number>
  listPending(): Promise<PendingRow[]>
  get(id: number): Promise<PendingRow | null>
  hasLiveForCapture(captureId: number): Promise<boolean>
  hasConfirmedForCapture(captureId: number): Promise<boolean>
  decide(id: number, status: 'confirmed' | 'rejected', edited?: PendingDecisionPatch): Promise<boolean>
}

export type RunStatus = 'active' | 'paused' | 'closed'

export interface RunRow {
  id: number; strategyKey: string; ticker: string; name: string; poolCents: number; costPpm: number
  buyGapPpm: number; sellGapPpm: number; cutLossPpm: number; status: RunStatus; stateJson: string; createdAt: string
}

export interface NewRun {
  strategyKey: string; ticker: string; name: string; poolCents: number; costPpm: number
  buyGapPpm?: number; sellGapPpm?: number; cutLossPpm?: number; initialRunState?: RunState
}

export interface RunRepo {
  list(): Promise<RunRow[]>
  get(id: number): Promise<RunRow | null>
  /** The runs with these ids, in no particular order; unknown ids are skipped; an empty list runs no query. */
  getMany(ids: number[]): Promise<RunRow[]>
  create(input: NewRun): Promise<number>
  updateStatus(id: number, status: RunStatus): Promise<void>
  updateStatusMany(ids: number[], from: RunStatus[], to: RunStatus): Promise<number>
  updatePool(id: number, poolCents: number): Promise<void>
  updateOrderShaping(id: number, v: { buyGapPpm: number; sellGapPpm: number; cutLossPpm: number }): Promise<void>
}

export interface RepoSurface {
  runRepo: Pick<RunRepo, 'list' | 'get' | 'create' | 'updateStatus'>
  bucketRepo: { loadState(runId: number): Promise<RunState>; saveState(runId: number, state: RunState): Promise<void> }
  orderRepo: OrderRepo
  // update/deleteById: rebook/delete history surface (Cash Model A rebuild).
  fillRepo: Pick<FillRepo, 'insert' | 'listForRun'> & Partial<Pick<FillRepo, 'update' | 'deleteById'>>
  pendingRepo: Omit<PendingRepo, 'get'>
  correctionRepo: CorrectionRepo
  captureRepo: CaptureRepo
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
  ledgerRepo: LedgerRepo
  notificationRepo: Pick<NotificationRepo, 'insert'>
}

/** What the morning pipeline needs beyond RepoSurface. */
export interface DayRepoSurface extends RepoSurface {
  bucketRepo: RepoSurface['bucketRepo'] & {
    /** One transaction, orders first: both are written or neither is. */
    saveStateWithOrders(runId: number, state: RunState, orders: NewOrder[]): Promise<void>
  }
}
