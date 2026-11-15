import { DomainError } from '@st/core'
import { formatUsd } from '@st/core/money'
import type { BookingDeps, FillRow } from './booking'
import { isCorrectionStale, type CorrectionRow } from './correction-types'
import { rebookFill } from './recompute'
import { withRunLock } from './run-lock'

export interface CorrectionView extends CorrectionRow { stale: boolean }

export async function listOpenCorrections(deps: BookingDeps): Promise<CorrectionView[]> {
  const rows = await deps.repos.correctionRepo.listOpen()
  const fillsByRun = new Map<number, FillRow[]>()
  const views: CorrectionView[] = []
  for (const row of rows) {
    if (!fillsByRun.has(row.runId)) fillsByRun.set(row.runId, await deps.repos.fillRepo.listForRun(row.runId))
    const fill = fillsByRun.get(row.runId)!.find((f) => f.id === row.fillId)
    views.push({ ...row, stale: isCorrectionStale(row, fill) })
  }
  return views
}

// Patch only the correction's target fill (never books a new one). The whole
// sequence runs under the run lock, so a concurrent second apply waits and then
// fails the open check; rebook-then-decide is therefore safe.
export async function applyCorrection(id: number, deps: BookingDeps): Promise<{ deltaCents: number }> {
  const repo = deps.repos.correctionRepo
  const first = await repo.get(id)
  if (!first) throw new DomainError('correction-not-found')
  return withRunLock(first.runId, async () => {
    const row = await repo.get(id)
    if (!row) throw new DomainError('correction-not-found')
    if (row.status !== 'open') throw new DomainError('correction-not-open')
    const fill = (await deps.repos.fillRepo.listForRun(row.runId)).find((f) => f.id === row.fillId)
    if (!fill || isCorrectionStale(row, fill)) throw new DomainError('correction-stale')
    const { deltaCents } = await rebookFill(row.runId, {
      fillId: fill.id,
      shares: fill.shares,
      priceStr: formatUsd(row.proposedPrice),
      feeCents: row.proposedFee ?? fill.fee,
      filledOn: fill.filledOn,
    }, deps, { reason: 'capture-correction', correctionId: id })
    if (!(await repo.decide(id, 'applied'))) throw new DomainError('correction-not-open')
    return { deltaCents }
  })
}

export async function dismissCorrection(id: number, deps: BookingDeps): Promise<void> {
  const repo = deps.repos.correctionRepo
  const first = await repo.get(id)
  if (!first) throw new DomainError('correction-not-found')
  await withRunLock(first.runId, async () => {
    if (!(await repo.decide(id, 'dismissed'))) throw new DomainError('correction-not-open')
  })
}
