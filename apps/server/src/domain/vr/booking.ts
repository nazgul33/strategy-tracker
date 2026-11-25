import { DomainError, type ISODate } from '@st/core'
import { centsFromUsd, feeCents, parseUsd } from '@st/core/money'
import type { VrCashKind } from '@st/strategies/value-rebalancing'
import { withRunLock } from '../run-lock'
import { isInt32 } from './runs'
import type { VrCashMoveRow, VrCashPatch, VrFillPatch, VrFillRow, VrRepos, VrRunRow } from './repo-types'

export class VrNotFoundError extends Error {}

export interface VrBookingDeps {
  repos: Pick<VrRepos, 'vrFillRepo' | 'vrCashRepo'>
  today: ISODate
}

const MAX_PRICE = 1_000_000_000n
const MAX_NOTE = 255
const CASH_KINDS: readonly VrCashKind[] = ['open', 'deposit', 'withdraw', 'adjust']

function isIsoDate(v: unknown): v is ISODate {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const t = Date.parse(`${v}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v
}

function usd(v: unknown, code: string): bigint {
  if (typeof v !== 'string') throw new DomainError(code)
  try {
    return parseUsd(v)
  } catch {
    throw new DomainError(code)
  }
}

export function parseVrFillBody(body: any, costPpm: number): VrFillPatch {
  const side = body?.side
  if (side !== 'buy' && side !== 'sell') throw new DomainError('invalid-side')
  const shares = body?.shares
  if (!isInt32(shares) || shares <= 0) throw new DomainError('invalid-shares')
  const price = usd(body?.price, 'invalid-price')
  if (price <= 0n || price > MAX_PRICE) throw new DomainError('invalid-price')
  let fee: number
  if (body?.fee === undefined || body.fee === null) fee = feeCents(price, shares, costPpm)
  else {
    const v = usd(body.fee, 'invalid-fee')
    if (v < 0n) throw new DomainError('invalid-fee')
    fee = centsFromUsd(v)
  }
  if (!isInt32(fee)) throw new DomainError('invalid-fee')
  if (!isIsoDate(body?.filledOn)) throw new DomainError('invalid-date')
  return { side, shares, price, fee, filledOn: body.filledOn }
}

function sharesTotal(rows: Pick<VrFillRow, 'side' | 'shares'>[]): number {
  return rows.reduce((n, f) => n + (f.side === 'buy' ? f.shares : -f.shares), 0)
}

function checkTotal(rows: Pick<VrFillRow, 'side' | 'shares'>[]): void {
  if (sharesTotal(rows) < 0) throw new DomainError('vr-negative-shares')
}

function checkFillDate(patch: VrFillPatch, deps: VrBookingDeps): void {
  if (patch.filledOn > deps.today) throw new DomainError('fill-date-in-future')
}

export async function addVrFill(run: VrRunRow, body: unknown, deps: VrBookingDeps): Promise<number> {
  const patch = parseVrFillBody(body, run.costPpm)
  checkFillDate(patch, deps)
  return withRunLock(run.id, async () => {
    checkTotal([...(await deps.repos.vrFillRepo.listForRun(run.id)), patch])
    return deps.repos.vrFillRepo.insert({ runId: run.id, ...patch, source: 'manual' })
  })
}

export async function editVrFill(run: VrRunRow, fillId: number, body: unknown, deps: VrBookingDeps): Promise<void> {
  await withRunLock(run.id, async () => {
    if (!(await deps.repos.vrFillRepo.get(run.id, fillId))) throw new VrNotFoundError()
    const patch = parseVrFillBody(body, run.costPpm)
    checkFillDate(patch, deps)
    const rows = await deps.repos.vrFillRepo.listForRun(run.id)
    checkTotal(rows.map((f) => (f.id === fillId ? patch : f)))
    await deps.repos.vrFillRepo.update(run.id, fillId, patch)
  })
}

export async function deleteVrFill(run: VrRunRow, fillId: number, deps: VrBookingDeps): Promise<void> {
  await withRunLock(run.id, async () => {
    if (!(await deps.repos.vrFillRepo.get(run.id, fillId))) throw new VrNotFoundError()
    checkTotal((await deps.repos.vrFillRepo.listForRun(run.id)).filter((f) => f.id !== fillId))
    await deps.repos.vrFillRepo.deleteById(run.id, fillId)
  })
}

function parseCashFields(kind: VrCashKind, body: any, deps: VrBookingDeps): VrCashPatch {
  const amount = body?.amountCents
  const signOk = kind === 'withdraw' ? (amount as number) < 0 : kind === 'adjust' ? amount !== 0 : (amount as number) > 0
  if (!isInt32(amount) || !signOk) throw new DomainError('invalid-amount')
  if (!isIsoDate(body?.movedOn)) throw new DomainError('invalid-date')
  if (body.movedOn > deps.today) throw new DomainError('cash-date-in-future')
  const note = body?.note
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > MAX_NOTE)) throw new DomainError('invalid-note')
  return { amountCents: amount, movedOn: body.movedOn, note: note === undefined || note === null || note === '' ? null : note }
}

export async function addVrCash(run: VrRunRow, body: unknown, deps: VrBookingDeps): Promise<number> {
  const kind = (body as any)?.kind
  if (!CASH_KINDS.includes(kind)) throw new DomainError('invalid-kind')
  const patch = parseCashFields(kind, body, deps)
  if (kind === 'open') throw new DomainError('vr-open-required')
  return withRunLock(run.id, () => deps.repos.vrCashRepo.insert({ runId: run.id, kind, ...patch, cycleId: null }))
}

export async function editVrCash(run: VrRunRow, cashId: number, body: unknown, deps: VrBookingDeps): Promise<void> {
  await withRunLock(run.id, async () => {
    const move: VrCashMoveRow | null = await deps.repos.vrCashRepo.get(run.id, cashId)
    if (!move) throw new VrNotFoundError()
    await deps.repos.vrCashRepo.update(run.id, cashId, parseCashFields(move.kind, body, deps))
  })
}

export async function deleteVrCash(run: VrRunRow, cashId: number, deps: VrBookingDeps): Promise<void> {
  await withRunLock(run.id, async () => {
    const move = await deps.repos.vrCashRepo.get(run.id, cashId)
    if (!move) throw new VrNotFoundError()
    if (move.kind === 'open') throw new DomainError('vr-open-required')
    await deps.repos.vrCashRepo.deleteById(run.id, cashId)
  })
}
