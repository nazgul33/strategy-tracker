import { addBuyFill, applyBuyFill, applySellFill, emptyState, DomainError, parseUsd, type ISODate, type RunState } from '@st/core'
import { feeCents } from '@st/core/money'
import { ageBuckets } from '@st/strategies'
import type { BookingDeps, FillBookingDeps, FillRow } from './booking'
import { notifyBookingOutcome } from './booking-notify'
import { emptiedBuckets, retireLegs, type EmptyCause } from './retire-legs'
import { matchForcedLeg, type OrderRow } from './sell-match'
import { withRunLock } from './run-lock'
import { requireRun } from './require-run'

// SQL listings carry no ORDER BY, so never trust row-return order: id-ascending
// is the canonical history order (matches the per-bucket MAX(id) guard in deleteFill).
const byIdAsc = <T extends { id: number }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => a.id - b.id)

// Cash Model A: the run state is fully derived from the starting pool plus the
// fill history. Pure — returns a fresh RunState and never mutates the inputs.
export function rebuildState(fills: readonly FillRow[], poolCents: number, today: ISODate, bucketCount: number): RunState {
  let state = emptyState(bucketCount)
  state.cashCents = poolCents
  for (const f of byIdAsc(fills)) {
    if (f.side === 'sell') {
      state = applySellFill(state, f.bucketIdx, f.shares, f.price, f.fee, f.filledOn)
    } else if ((state.buckets[f.bucketIdx]?.state ?? 'empty') !== 'empty') {
      // A buy into a held bucket merges at the weighted average and keeps the
      // bucket's age (the first buy's filledOn).
      state = addBuyFill(state, f.bucketIdx, f.shares, f.price, f.fee, { checkMergeable: false })
    } else {
      state = applyBuyFill(state, f.bucketIdx, f.shares, f.price, f.fee, f.filledOn)
      state.ages[f.bucketIdx] = ageBuckets(state.ages, today, { [f.bucketIdx]: f.filledOn })[f.bucketIdx]!
    }
  }
  return state
}

export interface RebookEdit { fillId: number; shares: number; priceStr: string; feeCents: number | null; filledOn?: ISODate }

// Fix the shares/price/fee of a fill (buy or sell), then re-derive the whole run state
// from history. The cash difference vs the stored state is booked as one
// 'adjust' ledger row so the books keep matching the (possibly negative) cash.
// Returns the patched row plus deltaCents: the signed cash effect of the edit
// (rebuilt cash minus previously stored cash), same amount as the adjust row.
// `audit` labels the adjust row's ref; the correction id is omitted when absent.
// Runs under the per-run lock. Callers already inside withRunLock(runId) must
// use rebookFillUnlocked instead: the lock is not reentrant.
// Rebuilding state never reopens orders (applies to deleteFill too): a sell
// fill's sibling-cancelled leg stays cancelled after that sell is edited away or
// deleted, so a re-held bucket has no live protection until the next morning's
// re-plan places its legs again. An edit that empties a bucket does retire that
// bucket's legs, as a new bucket-emptying sell does (retireLegs); the operator is
// told which open legs to pull once the lock is released.
export async function rebookFill(
  runId: number,
  edit: RebookEdit,
  deps: FillBookingDeps,
  audit: { reason: string; correctionId?: number } = { reason: 'fill-edit' },
): Promise<{ fill: FillRow; deltaCents: number }> {
  const { fill, deltaCents, cancelledIds } = await withRunLock(runId, () => rebookFillUnlocked(runId, edit, deps, audit))
  await notifyBookingOutcome(runId, { cancelledIds, attribution: null }, deps)
  return { fill, deltaCents }
}

// Never notifies: it runs inside a lock. Its callers pass cancelledIds to
// notifyBookingOutcome once their own lock is released.
export async function rebookFillUnlocked(
  runId: number,
  edit: RebookEdit,
  deps: BookingDeps,
  audit: { reason: string; correctionId?: number } = { reason: 'fill-edit' },
): Promise<{ fill: FillRow; deltaCents: number; cancelledIds: number[] }> {
  const repos = deps.repos
  if (!repos.fillRepo.update) throw new Error('fill-history-unavailable')
  const history = byIdAsc(await repos.fillRepo.listForRun(runId))
  const match = history.find((f) => f.id === edit.fillId)
  if (!match) throw new DomainError('no-fill')
  if (edit.filledOn !== undefined && edit.filledOn !== match.filledOn && edit.filledOn > deps.today) throw new DomainError('fill-date-in-future')

  let price: bigint
  try {
    price = parseUsd(edit.priceStr)
  } catch {
    throw new DomainError('invalid-fill')
  }
  if (!Number.isInteger(edit.shares) || edit.shares <= 0 || price <= 0n) throw new DomainError('invalid-fill')
  const run = await requireRun(repos, runId)
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

  // Read what the retirements need before the first write: a failing read then
  // fails the edit with nothing stored, so a retry can simply repeat it. Only the
  // edited fill's own bucket is looked at: a bucket the rebuild empties because the
  // stored state had drifted from the history is repaired without touching its
  // orders, as recalc does.
  const retirements: Array<{ orders: OrderRow[]; bucketIdx: number; cause: EmptyCause }> = []
  for (const bucketIdx of emptiedBuckets(state, rebuilt).filter((i) => i === match.bucketIdx)) {
    const last = patched.filter((f) => f.bucketIdx === bucketIdx).at(-1)
    if (last?.side !== 'sell') continue
    const orders = await repos.orderRepo.listForRunFrom(runId, last.filledOn)
    const leg = matchForcedLeg(orders, { runId, filledOn: last.filledOn, shares: last.shares, price: last.price, bucketIdx })
    retirements.push({ orders, bucketIdx, cause: { kind: 'sold', filledOn: last.filledOn, legId: leg?.id ?? null } })
  }

  const delta = rebuilt.cashCents - state.cashCents
  await repos.bucketRepo.saveState(runId, rebuilt)
  await repos.fillRepo.update(runId, edit.fillId, patch)
  if (delta !== 0) {
    const ref = {
      fillId: edit.fillId,
      bookedOn: deps.today,
      reason: audit.reason,
      ...(audit.correctionId !== undefined ? { correctionId: audit.correctionId } : {}),
    }
    await repos.ledgerRepo.insert({ runId, kind: 'adjust', amountCents: delta, ref: JSON.stringify(ref) })
  }
  const cancelledIds: number[] = []
  for (const r of retirements) cancelledIds.push(...await retireLegs(repos, r.orders, { runId, bucketIdx: r.bucketIdx }, r.cause))
  return { fill: { ...match, ...patch }, deltaCents: delta, cancelledIds }
}

// Delete any fill that is the newest in its bucket (MAX(id) within bucketIdx).
// Deletes by id and rebuilds state from the remaining history; orders are never
// reopened. Returns the deleted row plus deltaCents: the signed cash effect of
// the removal (rebuilt cash minus previously stored cash), same amount as the
// compensating 'adjust' that gets booked. Runs under the per-run lock.
// Deleting a buy that empties its bucket retires that bucket's sell legs (retireLegs);
// the operator is told which open legs to pull once the lock is released.
export async function deleteFill(
  runId: number,
  fillId: number,
  deps: FillBookingDeps,
): Promise<{ fill: FillRow; deltaCents: number }> {
  const { fill, deltaCents, orphanedIds } = await withRunLock(runId, () => deleteFillUnlocked(runId, fillId, deps))
  await notifyBookingOutcome(runId, { cancelledIds: [], attribution: null, orphanedIds }, deps)
  return { fill, deltaCents }
}

async function deleteFillUnlocked(
  runId: number,
  fillId: number,
  deps: BookingDeps,
): Promise<{ fill: FillRow; deltaCents: number; orphanedIds: number[] }> {
  const repos = deps.repos
  if (!repos.fillRepo.deleteById) throw new Error('fill-history-unavailable')
  const history = byIdAsc(await repos.fillRepo.listForRun(runId))
  const fill = history.find((f) => f.id === fillId)
  if (!fill) throw new DomainError('no-fill')
  const bucketLast = history.reduce((m, f) => (f.bucketIdx === fill.bucketIdx && f.id > m ? f.id : m), -1)
  if (fill.id !== bucketLast) throw new DomainError('not-last')

  const run = await requireRun(repos, runId)
  const state = await repos.bucketRepo.loadState(runId)
  const rebuilt = rebuildState(history.filter((f) => f.id !== fillId), run.poolCents, deps.today, state.buckets.length)

  // As in rebookFillUnlocked: read the orders before the first write.
  const retiring = fill.side === 'buy' && emptiedBuckets(state, rebuilt).includes(fill.bucketIdx)
  const orders = retiring ? await repos.orderRepo.listForRunFrom(runId, fill.filledOn) : []

  const delta = rebuilt.cashCents - state.cashCents
  await repos.bucketRepo.saveState(runId, rebuilt)
  await repos.fillRepo.deleteById(runId, fillId)
  if (delta !== 0) {
    await repos.ledgerRepo.insert({ runId, kind: 'adjust', amountCents: delta, ref: JSON.stringify({ fillId, bookedOn: deps.today, reason: 'fill-delete' }) })
  }
  let orphanedIds: number[] = []
  if (retiring) {
    orphanedIds = await retireLegs(repos, orders, { runId, bucketIdx: fill.bucketIdx }, { kind: 'buy-removed', filledOn: fill.filledOn })
  }
  return { fill, deltaCents: delta, orphanedIds }
}

// Re-derive the run state from the full fill history (Cash Model A) and store
// it, without touching fills, orders or pending rows. Repairs state corrupted
// out-of-band (e.g. legacy rows predating partial-sell tranches). If the stored
// cash drifted from the derived cash, book one compensating 'adjust' row so the
// ledger keeps matching reality. Returns the rebuilt state, deltaCents (rebuilt
// cash minus previously stored cash — 0 when the books were already straight)
// and fillCount, the size of the history the state was derived from.
// Drift is expected on seeded runs, where one Update books a single large
// adjust. A pool edit moves the stored cash with the pool (domain/pool-edit.ts), so
// it adds no drift; a run whose pool was edited before that change still carries the
// old difference until its first Update books it, once. See "Recalc and drift" in the
// partial-sell-history spec.
// Runs under the per-run lock.
export function recalcRunState(
  runId: number,
  deps: BookingDeps,
): Promise<{ state: RunState; deltaCents: number; fillCount: number }> {
  return withRunLock(runId, () => recalcUnlocked(runId, deps))
}

async function recalcUnlocked(
  runId: number,
  deps: BookingDeps,
): Promise<{ state: RunState; deltaCents: number; fillCount: number }> {
  const repos = deps.repos
  const history = byIdAsc(await repos.fillRepo.listForRun(runId))
  const run = await requireRun(repos, runId)
  const state = await repos.bucketRepo.loadState(runId)
  const rebuilt = rebuildState(history, run.poolCents, deps.today, state.buckets.length)

  const delta = rebuilt.cashCents - state.cashCents
  await repos.bucketRepo.saveState(runId, rebuilt)
  if (delta !== 0) {
    await repos.ledgerRepo.insert({ runId, kind: 'adjust', amountCents: delta, ref: JSON.stringify({ bookedOn: deps.today, reason: 'recalc' }) })
  }
  return { state: rebuilt, deltaCents: delta, fillCount: history.length }
}
