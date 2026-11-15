import { applyBuyFill, applySellFill, emptyState, DomainError, parseUsd, type ISODate, type RunState } from '@st/core'
import { feeCents, roundDiv } from '@st/core/money'
import { ageBuckets } from '@st/strategies'
import type { BookingDeps, FillRow } from './booking'

// Signed cash effect of one fill, in cents: buys spend gross + fee, sells
// receive gross - fee. Mirrors the ledger delta runBooking books per fill.
export function signedCents(f: { side: 'buy' | 'sell'; price: bigint; shares: number; fee: number }): number {
  const gross = Number(roundDiv(f.price * BigInt(f.shares), 100n))
  return f.side === 'buy' ? -(gross + f.fee) : gross - f.fee
}

// SQL listings carry no ORDER BY, so never trust row-return order: id-ascending
// is the canonical history order (matches the per-bucket MAX(id) guard in deleteFill).
const byIdAsc = <T extends { id: number }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => a.id - b.id)

// Cash Model A: the run state is fully derived from the starting pool plus the
// fill history. Pure — returns a fresh RunState and never mutates the inputs.
export function rebuildState(fills: readonly FillRow[], poolCents: number, today: ISODate, bucketCount: number): RunState {
  let state = emptyState(bucketCount)
  state.cashCents = poolCents
  for (const f of byIdAsc(fills)) {
    state = f.side === 'buy'
      ? applyBuyFill(state, f.bucketIdx, f.shares, f.price, f.fee, f.filledOn)
      : applySellFill(state, f.bucketIdx, f.shares, f.price, f.fee, f.filledOn)
    if (f.side === 'buy') {
      state.ages[f.bucketIdx] = ageBuckets(state.ages, today, { [f.bucketIdx]: f.filledOn })[f.bucketIdx]!
    }
  }
  return state
}

export interface RebookEdit { fillId: number; shares: number; priceStr: string; feeCents: number | null; filledOn?: ISODate }

// Fix the shares/price/fee of a buy fill, then re-derive the whole run state
// from history. The cash difference vs the stored state is booked as one
// 'adjust' ledger row so the books keep matching the (possibly negative) cash.
// Returns the patched row plus deltaCents: the signed cash effect of the edit
// (rebuilt cash minus previously stored cash), same amount as the adjust row.
export async function rebookFill(
  runId: number,
  edit: RebookEdit,
  deps: BookingDeps,
): Promise<{ fill: FillRow; deltaCents: number }> {
  const repos = deps.repos
  if (!repos.fillRepo.listForRun || !repos.fillRepo.update) throw new Error('fill-history-unavailable')
  const history = byIdAsc(await repos.fillRepo.listForRun(runId))
  const match = history.find((f) => f.id === edit.fillId)
  if (!match) throw new DomainError('no-fill')
  if (match.side === 'sell') throw new DomainError('immutable-field')

  let price: bigint
  try {
    price = parseUsd(edit.priceStr)
  } catch {
    throw new DomainError('invalid-fill')
  }
  if (!Number.isInteger(edit.shares) || edit.shares <= 0 || price <= 0n) throw new DomainError('invalid-fill')
  const run = await repos.runRepo.get(runId)
  const fee = edit.feeCents === null ? feeCents(price, edit.shares, run.costPpm) : edit.feeCents
  if (!Number.isInteger(fee) || fee < 0) throw new DomainError('invalid-fill')

  // Replay the patched history first: an invalid result (e.g. bucket conflicts)
  // surfaces as a DomainError before anything is written. One patch object is
  // reused for the replayed row, the stored row and the returned fill, so an
  // edited filledOn flows into the age recomputation and the database alike.
  const state = await repos.bucketRepo.loadState(runId)
  const patch = { shares: edit.shares, price, fee, ...(edit.filledOn ? { filledOn: edit.filledOn } : {}) }
  const patched = history.map((f) => (f.id === edit.fillId ? { ...f, ...patch } : f))
  const rebuilt = rebuildState(patched, run.poolCents, deps.today, state.buckets.length)

  const delta = rebuilt.cashCents - state.cashCents
  await repos.bucketRepo.saveState(runId, rebuilt)
  await repos.fillRepo.update(runId, edit.fillId, patch)
  if (delta !== 0) {
    await repos.ledgerRepo.insert({ runId, kind: 'adjust', amountCents: delta, ref: JSON.stringify({ fillId: edit.fillId, bookedOn: deps.today, reason: 'fill-edit' }) })
  }
  return { fill: { ...match, ...patch }, deltaCents: delta }
}

// Delete any fill that is the newest in its bucket (MAX(id) within bucketIdx).
// Deletes by id and rebuilds state from the remaining history; orders are never
// reopened. Returns the deleted row plus deltaCents: the signed cash effect of
// the removal (rebuilt cash minus previously stored cash), same amount as the
// compensating 'adjust' that gets booked.
export async function deleteFill(
  runId: number,
  fillId: number,
  deps: BookingDeps,
): Promise<{ fill: FillRow; deltaCents: number }> {
  const repos = deps.repos
  if (!repos.fillRepo.listForRun || !repos.fillRepo.deleteById) throw new Error('fill-history-unavailable')
  const history = byIdAsc(await repos.fillRepo.listForRun(runId))
  const fill = history.find((f) => f.id === fillId)
  if (!fill) throw new DomainError('no-fill')
  const bucketLast = history.reduce((m, f) => (f.bucketIdx === fill.bucketIdx && f.id > m ? f.id : m), -1)
  if (fill.id !== bucketLast) throw new DomainError('not-last')

  const run = await repos.runRepo.get(runId)
  const state = await repos.bucketRepo.loadState(runId)
  const rebuilt = rebuildState(history.filter((f) => f.id !== fillId), run.poolCents, deps.today, state.buckets.length)

  const delta = rebuilt.cashCents - state.cashCents
  await repos.bucketRepo.saveState(runId, rebuilt)
  await repos.fillRepo.deleteById(runId, fillId)
  if (delta !== 0) {
    await repos.ledgerRepo.insert({ runId, kind: 'adjust', amountCents: delta, ref: JSON.stringify({ fillId, bookedOn: deps.today, reason: 'fill-delete' }) })
  }
  return { fill, deltaCents: delta }
}

// Re-derive the run state from the full fill history (Cash Model A) and store
// it, without touching fills, orders or pending rows. Repairs state corrupted
// out-of-band (e.g. legacy rows predating partial-sell tranches). If the stored
// cash drifted from the derived cash, book one compensating 'adjust' row so the
// ledger keeps matching reality. Returns the rebuilt state, deltaCents (rebuilt
// cash minus previously stored cash — 0 when the books were already straight)
// and fillCount, the size of the history the state was derived from.
// Drift is expected on seeded or pool-edited runs, where one Update books a
// single large adjust: see "Recalc and drift" in the partial-sell-history spec.
export async function recalcRunState(
  runId: number,
  deps: BookingDeps,
): Promise<{ state: RunState; deltaCents: number; fillCount: number }> {
  const repos = deps.repos
  if (!repos.fillRepo.listForRun) throw new Error('fill-history-unavailable')
  const history = byIdAsc(await repos.fillRepo.listForRun(runId))
  const run = await repos.runRepo.get(runId)
  const state = await repos.bucketRepo.loadState(runId)
  const rebuilt = rebuildState(history, run.poolCents, deps.today, state.buckets.length)

  const delta = rebuilt.cashCents - state.cashCents
  await repos.bucketRepo.saveState(runId, rebuilt)
  if (delta !== 0) {
    await repos.ledgerRepo.insert({ runId, kind: 'adjust', amountCents: delta, ref: JSON.stringify({ bookedOn: deps.today, reason: 'recalc' }) })
  }
  return { state: rebuilt, deltaCents: delta, fillCount: history.length }
}
