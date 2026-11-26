import type { ISODate } from '@st/core'
import type { VrCashKind, VrFormula, VrSettings } from '@st/strategies/value-rebalancing'
import type { RunStatus } from '../repo-types'

export interface SharedRunRow { id: number; strategyKey: string; ticker: string; name: string; costPpm: number; status: RunStatus; createdAt: string }
/** Reads strategy_runs for every strategy; an empty list runs no query. */
export interface SharedRunRepo { getMany(ids: number[]): Promise<SharedRunRow[]> }

export interface VrRunRow extends SharedRunRow, VrSettings { initialVCents: number }
export interface NewVrRun extends VrSettings { ticker: string; name: string; costPpm: number; initialVCents: number; openingCashCents: number; openedOn: ISODate }
export class VrNameTakenError extends Error {
  constructor(name?: string) {
    super(name === undefined ? 'run name taken' : `run name taken: ${name}`)
    this.name = 'VrNameTakenError'
  }
}
export interface VrRunRepo {
  /** strategy_runs inner join vr_runs, ascending id. */
  list(): Promise<VrRunRow[]>
  get(id: number): Promise<VrRunRow | null>
  /** One transaction: strategy_runs, vr_runs and the 'open' cash move. VrNameTakenError on a duplicate name. */
  create(input: NewVrRun): Promise<number>
  /** Only a run that has a vr_runs row. */
  updateStatus(id: number, status: RunStatus): Promise<void>
  updateSettings(id: number, s: VrSettings): Promise<void>
}

export interface VrCycleRow {
  id: number; runId: number; seq: number; scheduledStart: ISODate; startDate: ISODate
  vCents: number; bandMinCents: number; bandMaxCents: number; openShares: number; openPoolCents: number; buyBudgetCents: number
  buyLot: number; sellLot: number
  prevClose: bigint | null; evalCents: number | null; poolBeforeCents: number | null // null on cycle 1
  g: number; formula: VrFormula; depositCents: number; vKept: boolean
  /** The highest vr_fills.id of the run when the cycle opened, 0 for none: only later fills count toward the cycle's ladder and budget. */
  openFillId: number
  createdAt: string
}
export type NewVrCycle = Omit<VrCycleRow, 'id' | 'createdAt'>
export interface VrCashMoveRow { id: number; runId: number; kind: VrCashKind; amountCents: number; movedOn: ISODate; note: string | null; cycleId: number | null; createdAt: string }
export type NewVrCashMove = Omit<VrCashMoveRow, 'id' | 'createdAt'>
export interface VrCycleRepo {
  /** Ascending seq. */
  listForRun(runId: number): Promise<VrCycleRow[]>
  latest(runId: number): Promise<VrCycleRow | null>
  /** One transaction: the cycle row, then the deposit move carrying its id. */
  open(cycle: NewVrCycle, deposit: Omit<NewVrCashMove, 'cycleId'> | null): Promise<number>
}

export interface VrFillRow {
  id: number; runId: number; side: 'buy' | 'sell'; shares: number; price: bigint; fee: number; filledOn: ISODate; source: 'manual' | 'capture'
  orderPrice: bigint | null    // read from the screenshot; null for a typed fill or a view without one
  createdAt: string
}
export type NewVrFill = Omit<VrFillRow, 'id' | 'createdAt' | 'orderPrice'> & { orderPrice?: bigint | null }
export type VrFillPatch = Pick<VrFillRow, 'side' | 'shares' | 'price' | 'fee' | 'filledOn'>
export interface VrFillRepo {
  /** Ascending filledOn, then id. */
  listForRun(runId: number): Promise<VrFillRow[]>
  get(runId: number, id: number): Promise<VrFillRow | null>
  insert(f: NewVrFill): Promise<number>
  update(runId: number, id: number, patch: VrFillPatch): Promise<void>
  deleteById(runId: number, id: number): Promise<void>
}

export type VrCashPatch = Pick<VrCashMoveRow, 'amountCents' | 'movedOn' | 'note'>
export interface VrCashRepo {
  /** Ascending movedOn, then id. */
  listForRun(runId: number): Promise<VrCashMoveRow[]>
  get(runId: number, id: number): Promise<VrCashMoveRow | null>
  insert(m: NewVrCashMove): Promise<number>
  update(runId: number, id: number, patch: VrCashPatch): Promise<void>
  deleteById(runId: number, id: number): Promise<void>
}

export type VrPendingStatus = 'pending' | 'confirmed' | 'rejected'
export interface VrPendingRow {
  id: number; runId: number; captureId: number; side: 'buy' | 'sell'; shares: number; price: bigint
  fee: number | null            // null = compute from the run's trade cost at confirm
  filledOn: ISODate; dateRead: boolean   // false = the screenshot had no date and the reading day was used
  dupPrice: bigint | null       // price of the booked, waiting or rejected entry, or another row of the same screenshot, this may duplicate
  orderPrice: bigint | null     // read from the screenshot; null when the view has none or showed 0
  status: VrPendingStatus; createdAt: string
}
export type NewVrPending = Omit<VrPendingRow, 'id' | 'status' | 'createdAt'>
export type VrPendingPatch = Pick<VrPendingRow, 'side' | 'shares' | 'price' | 'fee' | 'filledOn'>
export interface VrPendingRepo {
  /** Ascending filledOn, then id; every status when omitted. */
  listForRun(runId: number, status?: VrPendingStatus): Promise<VrPendingRow[]>
  get(runId: number, id: number): Promise<VrPendingRow | null>
  insertMany(rows: NewVrPending[]): Promise<number[]>
  /** Only a row still pending; false otherwise. */
  update(runId: number, id: number, patch: VrPendingPatch): Promise<boolean>
  /** One transaction: mark the row confirmed if still pending, then insert the fill. The fill id, or null (nothing written) when the row was not pending. */
  confirm(runId: number, id: number, fill: NewVrFill): Promise<number | null>
  /** Only a row still pending. */
  reject(runId: number, id: number): Promise<boolean>
  countPending(runId: number): Promise<number>
  hasPendingForCapture(captureId: number): Promise<boolean>
  hasConfirmedForCapture(captureId: number): Promise<boolean>
  /** A row of the capture in any status. */
  hasAnyForCapture(captureId: number): Promise<boolean>
}

export interface VrRepos { vrRunRepo: VrRunRepo; vrCycleRepo: VrCycleRepo; vrFillRepo: VrFillRepo; vrCashRepo: VrCashRepo; vrPendingRepo: VrPendingRepo }
