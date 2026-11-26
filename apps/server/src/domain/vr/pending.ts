import { DomainError, type ISODate } from '@st/core'
import { formatUsd } from '@st/core/money'
import { withRunLock } from '../run-lock'
import { checkNewVrFill, parseVrFillBody, VrNotFoundError } from './booking'
import type { VrPendingRow, VrRepos, VrRunRow } from './repo-types'

export interface VrPendingDeps {
  repos: Pick<VrRepos, 'vrPendingRepo' | 'vrFillRepo' | 'vrCashRepo'> & {
    captureImageRepo: { deleteFor(captureId: number): Promise<void>; existingIds(ids: number[]): Promise<Set<number>> }
  }
  today: ISODate
}

export interface VrPendingView extends Omit<VrPendingRow, 'runId' | 'status'> { dateAfterToday: boolean; hasImage: boolean }

export interface VrConfirmAllResult { confirmed: number; refused: { id: number; error: string }[]; skippedDuplicates: number; skippedUndated: number }

async function loadPending(run: VrRunRow, id: number, deps: VrPendingDeps): Promise<VrPendingRow> {
  const row = await deps.repos.vrPendingRepo.get(run.id, id)
  if (!row) throw new VrNotFoundError()
  if (row.status !== 'pending') throw new DomainError('vr-not-pending')
  return row
}

// The decision is committed already, so any failure here is only logged: the screenshot sweep removes an orphan at the next start.
async function dropImageIfDone(captureId: number, deps: VrPendingDeps): Promise<void> {
  try {
    if (await deps.repos.vrPendingRepo.hasPendingForCapture(captureId)) return
    await deps.repos.captureImageRepo.deleteFor(captureId)
  } catch (e) {
    console.error('capture image delete failed:', captureId, String(e))
  }
}

export async function listVrPending(run: VrRunRow, deps: VrPendingDeps): Promise<VrPendingView[]> {
  const rows = await deps.repos.vrPendingRepo.listForRun(run.id, 'pending')
  const withImage = await deps.repos.captureImageRepo.existingIds([...new Set(rows.map((r) => r.captureId))])
  return rows.map((r) => ({
    id: r.id, captureId: r.captureId, side: r.side, shares: r.shares, price: r.price, fee: r.fee, filledOn: r.filledOn, dateRead: r.dateRead,
    dateAfterToday: r.filledOn > deps.today, dupPrice: r.dupPrice, hasImage: withImage.has(r.captureId), createdAt: r.createdAt,
  }))
}

export function editVrPending(run: VrRunRow, id: number, body: any, deps: VrPendingDeps): Promise<void> {
  return withRunLock(run.id, async () => {
    await loadPending(run, id, deps)
    const noFee = body?.fee === undefined || body.fee === null || body.fee === ''
    const p = parseVrFillBody(noFee ? { ...body, fee: undefined } : body, run.costPpm)
    const patch = { side: p.side, shares: p.shares, price: p.price, fee: noFee ? null : p.fee, filledOn: p.filledOn }
    if (!(await deps.repos.vrPendingRepo.update(run.id, id, patch))) throw new DomainError('vr-not-pending')
  })
}

export function confirmVrPending(run: VrRunRow, id: number, deps: VrPendingDeps): Promise<number> {
  return withRunLock(run.id, async () => {
    const row = await loadPending(run, id, deps)
    // The row passes the format checks of a typed fill: the read may be a price of 0 or a fee beyond the INT range.
    const patch = parseVrFillBody({
      side: row.side, shares: row.shares, price: formatUsd(row.price), fee: row.fee === null ? undefined : formatUsd(BigInt(row.fee) * 100n), filledOn: row.filledOn,
    }, run.costPpm)
    await checkNewVrFill(run.id, patch, deps)
    const fillId = await deps.repos.vrPendingRepo.confirm(run.id, id, { runId: run.id, ...patch, source: 'capture' })
    if (fillId === null) throw new DomainError('vr-not-pending')
    await dropImageIfDone(row.captureId, deps)
    return fillId
  })
}

export function rejectVrPending(run: VrRunRow, id: number, deps: VrPendingDeps): Promise<void> {
  return withRunLock(run.id, async () => {
    const row = await loadPending(run, id, deps)
    if (!(await deps.repos.vrPendingRepo.reject(run.id, id))) throw new DomainError('vr-not-pending')
    await dropImageIfDone(row.captureId, deps)
  })
}

/** Rows that may duplicate an entry, and rows whose date was only guessed, stay waiting; the rest go in buys first, so a same-day buy and sell both book. The lock is taken per row. */
export async function confirmAllVrPending(run: VrRunRow, deps: VrPendingDeps): Promise<VrConfirmAllResult> {
  const rows = await deps.repos.vrPendingRepo.listForRun(run.id, 'pending')
  const notDuplicate = rows.filter((r) => r.dupPrice === null)
  const result: VrConfirmAllResult = { confirmed: 0, refused: [], skippedDuplicates: rows.length - notDuplicate.length, skippedUndated: notDuplicate.filter((r) => !r.dateRead).length }
  const side = (r: VrPendingRow) => (r.side === 'buy' ? 0 : 1)
  const order = notDuplicate.filter((r) => r.dateRead)
    .sort((a, b) => side(a) - side(b) || (a.filledOn < b.filledOn ? -1 : a.filledOn > b.filledOn ? 1 : 0) || a.id - b.id)
  for (const r of order) {
    try {
      await confirmVrPending(run, r.id, deps)
      result.confirmed++
    } catch (e) {
      if (e instanceof DomainError) result.refused.push({ id: r.id, error: e.kind })
      else if (e instanceof VrNotFoundError) result.refused.push({ id: r.id, error: 'vr-not-pending' })
      else throw e
    }
  }
  return result
}
