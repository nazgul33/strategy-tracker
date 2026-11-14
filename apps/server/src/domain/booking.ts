import { applyBuyFill, applySellFill, emptyState, parseUsd, DomainError, type ISODate, type RunState, type Bucket } from '@st/core'
import { feeCents, centsFromUsd, formatUsd, roundDiv } from '@st/core/money'
import { ageBuckets } from '@st/strategies'
import type { ExtractResult, RawFill } from '@st/ingest'

export async function sha256(buf: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf as any)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

export interface RepoSurface {
  runRepo: { list(): Promise<any[]>; get(id: number): Promise<any>; create(input: any): Promise<number>; updateStatus(id: number, status: string): Promise<void> }
  bucketRepo: { loadState(runId: number): Promise<RunState>; saveState(runId: number, state: RunState): Promise<void> }
  orderRepo: { insertMany(orders: any[]): Promise<void>; listForDate(date: string): Promise<any[]>; markStale(date: string): Promise<any>; get(id: number): Promise<any | null>; setStatus(id: number, status: string, cancelReason?: string): Promise<void>; listOpenBefore(date: string): Promise<any[]> }
  fillRepo: {
    insert(fill: any): Promise<any>
    // Fill-history surface used by rebook/delete (Cash Model A rebuild).
    // Optional until the db repos implement them.
    listForRun?(runId: number): Promise<FillRow[]>
    update?(runId: number, fillId: number, patch: { shares?: number; price?: bigint; fee?: number }): Promise<void>
    deleteById?(runId: number, fillId: number): Promise<void>
    deleteLast?(runId: number): Promise<void>
  }
  pendingRepo: { insert(p: any): Promise<number>; listPending(): Promise<any[]>; decide(id: number, status: string, edited?: any): Promise<boolean> }
  captureRepo: { hasHash(runId: number, hash: string): Promise<boolean>; insert(c: any): Promise<{ inserted: boolean; id?: number }> }
  ledgerRepo: { insert(l: any): Promise<any>; listForRun(runId: number): Promise<any[]> }
  notificationRepo: { insert(n: any): Promise<any> }
}

export interface BookingDeps { repos: RepoSurface; today: ISODate }

// Signed cash effect of one fill, in cents: buys spend gross + fee, sells
// receive gross - fee. Mirrors the ledger delta runBooking books per fill.
export function signedCents(f: { side: 'buy' | 'sell'; price: bigint; shares: number; fee: number }): number {
  const gross = Number(roundDiv(f.price * BigInt(f.shares), 100n))
  return f.side === 'buy' ? -(gross + f.fee) : gross - f.fee
}

export type CaptureOutcome = 'duplicate' | 'rejected' | { pending: PendingFillRow[] }

export interface PendingFillRow { id: number; runId: number; captureId: number | null; side: 'buy' | 'sell'; ticker: string; shares: number; price: string; fee: string | null; filledOn: ISODate; status: string }

export interface OrderRow { id: number; runId: number; tradeDate: string; kind: string; bucketIdx: number; limitPrice: bigint; shares: number; status: string }

export interface FillRow { id: number; runId: number; bucketIdx: number; side: 'buy' | 'sell'; ticker: string; shares: number; price: bigint; fee: number; filledOn: ISODate; source: string }

interface BookInput {
  runId: number
  side: 'buy' | 'sell'
  shares: number
  priceStr: string
  feeCents: number | null  // null => compute
  filledOn: ISODate
  pendingId?: number | null
  source: 'capture' | 'manual' | 'seed'
}

async function runBooking(input: BookInput, deps: BookingDeps): Promise<void> {
  const repos = deps.repos
  const run = await repos.runRepo.get(input.runId)
  const state: RunState = await repos.bucketRepo.loadState(input.runId)
  const priceBigInt = parseUsd(input.priceStr)
  const finalFee = input.feeCents !== null ? input.feeCents : feeCents(priceBigInt, input.shares, run.costPpm)

  let next: RunState
  let bucketIdx: number
  let matchedOrderId: number | null = null

  if (input.side === 'buy') {
    const empties = state.buckets.filter((b: Bucket) => b.state === 'empty').map((b: Bucket) => b.index).sort((a: number, b: number) => a - b)
    if (!empties.length) throw new Error('no-empty-bucket')
    bucketIdx = empties[0]!
    next = applyBuyFill(state, bucketIdx, input.shares, priceBigInt, finalFee, input.filledOn)
    next.ages[bucketIdx] = ageBuckets(next.ages, deps.today, { [bucketIdx]: input.filledOn })[bucketIdx]!
    // matching buy_loc order (lookup only; flip after ledger)
    const orders = await repos.orderRepo.listForDate(input.filledOn)
    const match = orders.find((o: any) => o.runId === input.runId && o.kind === 'buy_loc' && o.status === 'open')
    if (match) matchedOrderId = match.id
  } else {
    // sell bucket matching
    const orders = await repos.orderRepo.listForDate(input.filledOn)
    // priority 1a: sell_loc strict price equality
    let matchedOrder = orders.find((o: any) => o.runId === input.runId && o.kind === 'sell_loc' && o.status === 'open' && o.limitPrice === priceBigInt)
    // priority 1b: market_sell ignores price; prefer bucketIdx non-empty with shares >= fill
    if (!matchedOrder) {
      const msCandidates = orders.filter((o: any) => o.runId === input.runId && o.kind === 'market_sell' && o.status === 'open' && o.tradeDate === input.filledOn)
      // prefer one whose bucketIdx is a non-empty bucket with shares >= fill.shares
      const preferred = msCandidates.find((o: any) => {
        const b = state.buckets.find((x: Bucket) => x.index === o.bucketIdx)
        return !!b && b.state !== 'empty' && b.shares >= input.shares
      })
      matchedOrder = preferred ?? msCandidates[0]
    }
    let idx: number | undefined
    if (matchedOrder) {
      idx = matchedOrder.bucketIdx
      matchedOrderId = matchedOrder.id
    } else {
      const candidates = state.buckets
        .filter((b: Bucket) => b.state !== 'empty' && b.shares >= input.shares)
        .sort((a: Bucket, b: Bucket) => a.index - b.index)
      if (candidates.length) idx = candidates[0]!.index
    }
    if (idx === undefined) throw new DomainError('no-bucket-for-sell')
    bucketIdx = idx
    next = applySellFill(state, bucketIdx, input.shares, priceBigInt, finalFee, input.filledOn)
  }

  const prevCash = state.cashCents
  const delta = next.cashCents - prevCash

  // persist order: decide -> saveState -> fill -> ledger -> order flip (R15: flip last, only after ledger)
  if (input.pendingId != null) {
    const edited: any = { shares: input.shares, price: priceBigInt, fee: finalFee, filledOn: input.filledOn, bucketIdx }
    const flipped = await repos.pendingRepo.decide(input.pendingId, 'confirmed', edited)
    if (flipped === false) throw new Error('pending-not-pending')
  }
  await repos.bucketRepo.saveState(input.runId, next)
  await repos.fillRepo.insert({ runId: input.runId, bucketIdx, side: input.side, ticker: run.ticker, shares: input.shares, price: priceBigInt, fee: finalFee, filledOn: input.filledOn, source: input.source })
  await repos.ledgerRepo.insert({ runId: input.runId, kind: input.side === 'buy' ? 'buy' : 'sell', amountCents: delta, ref: JSON.stringify({ bookedOn: deps.today, filledOn: input.filledOn }) })
  if (matchedOrderId !== null) await repos.orderRepo.setStatus(matchedOrderId, 'filled')
}

export async function ingestCapture(runId: number, image: { base64: string; mime: string }, extract: ExtractResult, deps: BookingDeps): Promise<CaptureOutcome> {
  const buf = new TextEncoder().encode(image.base64)
  const hash = await sha256(buf)
  const repos = deps.repos

  if (await repos.captureRepo.hasHash(runId, hash)) {
    await repos.captureRepo.insert({ runId, chatId: null, imageHash: hash, status: 'duplicate' })
    return 'duplicate'
  }

  if (!extract.ok) {
    await repos.captureRepo.insert({ runId, chatId: null, imageHash: hash, status: 'unparseable' })
    return 'rejected'
  }

  const res = await repos.captureRepo.insert({ runId, chatId: null, imageHash: hash, status: 'parsed' })
  if (!res.inserted) return 'duplicate'
  const captureId = res.id!

  const pendingRows: PendingFillRow[] = []
  for (const f of extract.fills) {
    const feeCentsVal = f.fee != null ? centsFromUsd(parseUsd(f.fee)) : null
    const pendingId = await repos.pendingRepo.insert({
      runId, captureId, bucketIdx: null, side: f.side, ticker: f.ticker, shares: f.shares,
      price: parseUsd(f.price), fee: feeCentsVal, filledOn: deps.today, status: 'pending',
    })
    pendingRows.push({
      id: pendingId, runId, captureId, side: f.side, ticker: f.ticker, shares: f.shares,
      price: formatUsd(parseUsd(f.price)),
      fee: feeCentsVal === null ? null : formatUsd(BigInt(feeCentsVal) * 100n),
      filledOn: deps.today, status: 'pending',
    })
  }
  return { pending: pendingRows }
}

export async function confirmPendingFill(pendingId: number, overrides: { shares?: number; price?: string; filledOn?: ISODate } | null, deps: BookingDeps): Promise<void> {
  const repos = deps.repos
  const pendingList = await repos.pendingRepo.listPending()
  const pending = pendingList.find((p: any) => p.id === pendingId)
  if (!pending) throw new Error('pending-not-found-or-not-pending')

  const run = await repos.runRepo.get(pending.runId)
  if (pending.ticker !== run.ticker) throw new Error('ticker-mismatch')
  const priceStr = overrides?.price ?? formatUsd(pending.price)
  const shares = overrides?.shares ?? pending.shares
  const filledOn = overrides?.filledOn ?? pending.filledOn

  await runBooking({
    runId: pending.runId,
    side: pending.side,
    shares,
    priceStr,
    feeCents: pending.fee,
    filledOn,
    pendingId,
    source: 'capture',
  }, deps)
}

export async function manualFill(runId: number, fill: Omit<RawFill, 'ticker'> & { filledOn: ISODate }, deps: BookingDeps): Promise<void> {
  await runBooking({
    runId,
    side: fill.side,
    shares: fill.shares,
    priceStr: fill.price,
    feeCents: fill.fee != null ? centsFromUsd(parseUsd(fill.fee)) : null,
    filledOn: fill.filledOn,
    pendingId: null,
    source: 'manual',
  }, deps)
}

export async function rollStale(tradeDate: ISODate, deps: BookingDeps): Promise<Record<number, OrderRow[]>> {
  const repos = deps.repos
  const rows = await repos.orderRepo.listOpenBefore(tradeDate)
  if (rows.length) await repos.orderRepo.markStale(tradeDate)
  const grouped: Record<number, OrderRow[]> = {}
  for (const r of rows) {
    if (!grouped[r.runId]) grouped[r.runId] = []
    grouped[r.runId]!.push(r)
  }
  return grouped
}

export const CANCEL_REASONS = ['broker-filled', 'strategy-change', 'stale-price', 'other'] as const

export async function cancelOrder(runId: number, orderId: number, reason: string, deps: BookingDeps): Promise<any> {
  if (!(CANCEL_REASONS as readonly string[]).includes(reason)) throw new Error('invalid-reason')
  const repos = deps.repos
  const order = await repos.orderRepo.get(orderId)
  if (!order || order.runId !== runId) throw new Error('order-not-found')
  if (order.status !== 'open') throw new Error('order-not-open')
  await repos.orderRepo.setStatus(orderId, 'cancelled', reason)
  return { ...order, status: 'cancelled', cancelReason: reason }
}

export async function seedRun(runId: number, seed: { cashCents: number; buckets: Array<{ shares: number; buyPrice: string; filledOn: ISODate }> }, deps: BookingDeps): Promise<void> {
  if (!Number.isInteger(seed.cashCents) || seed.cashCents < 0) throw new Error('invalid seed cash')
  const repos = deps.repos
  const run = await repos.runRepo.get(runId)
  let state: RunState = await repos.bucketRepo.loadState(runId)
  for (const b of seed.buckets) {
    const empties = state.buckets.filter((x: Bucket) => x.state === 'empty').map((x: Bucket) => x.index).sort((a: number, c: number) => a - c)
    if (!empties.length) throw new Error('no-empty-bucket')
    const idx = empties[0]!
    const priceBigInt = parseUsd(b.buyPrice)
    const prevCash = state.cashCents
    let next = applyBuyFill(state, idx, b.shares, priceBigInt, 0, b.filledOn)
    next.ages[idx] = ageBuckets(next.ages, deps.today, { [idx]: b.filledOn })[idx]!
    const delta = next.cashCents - prevCash
    state = next
    await repos.fillRepo.insert({ runId, bucketIdx: idx, side: 'buy', ticker: run.ticker, shares: b.shares, price: priceBigInt, fee: 0, filledOn: b.filledOn, source: 'seed' })
    await repos.ledgerRepo.insert({ runId, kind: 'seed', amountCents: delta, ref: JSON.stringify({ bookedOn: deps.today, filledOn: b.filledOn }) })
  }
  state.cashCents = seed.cashCents
  await repos.bucketRepo.saveState(runId, state)
}

// SQL listings carry no ORDER BY, so never trust row-return order: id-ascending
// is the canonical history order (matches the MAX(id) delete in fillRepo).
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

export interface RebookEdit { fillId: number; shares: number; priceStr: string; feeCents: number | null }

// Fix the shares/price/fee of a buy fill, then re-derive the whole run state
// from history. The cash difference vs the stored state is booked as one
// 'adjust' ledger row so the books keep matching the (possibly negative) cash.
export async function rebookFill(runId: number, edit: RebookEdit, deps: BookingDeps): Promise<FillRow> {
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
  // surfaces as a DomainError before anything is written.
  const state = await repos.bucketRepo.loadState(runId)
  const patched = history.map((f) => (f.id === edit.fillId ? { ...f, shares: edit.shares, price, fee } : f))
  const rebuilt = rebuildState(patched, run.poolCents, deps.today, state.buckets.length)

  const delta = rebuilt.cashCents - state.cashCents
  await repos.bucketRepo.saveState(runId, rebuilt)
  await repos.fillRepo.update(runId, edit.fillId, { shares: edit.shares, price, fee })
  if (delta !== 0) {
    await repos.ledgerRepo.insert({ runId, kind: 'adjust', amountCents: delta, ref: JSON.stringify({ fillId: edit.fillId, bookedOn: deps.today, reason: 'fill-edit' }) })
  }
  return { ...match, shares: edit.shares, price, fee }
}

// Remove the newest fill and rebuild state from the remaining history. Orders
// are never reopened. Returns the deleted row; books a compensating 'adjust'.
export async function deleteLastFill(runId: number, deps: BookingDeps): Promise<FillRow> {
  const repos = deps.repos
  if (!repos.fillRepo.listForRun || !repos.fillRepo.deleteLast) throw new Error('fill-history-unavailable')
  const history = byIdAsc(await repos.fillRepo.listForRun(runId))
  const last = history[history.length - 1]
  if (!last) throw new DomainError('no-fill')

  const run = await repos.runRepo.get(runId)
  const state = await repos.bucketRepo.loadState(runId)
  const rebuilt = rebuildState(history.slice(0, -1), run.poolCents, deps.today, state.buckets.length)

  const delta = rebuilt.cashCents - state.cashCents
  await repos.bucketRepo.saveState(runId, rebuilt)
  await repos.fillRepo.deleteLast(runId)
  if (delta !== 0) {
    await repos.ledgerRepo.insert({ runId, kind: 'adjust', amountCents: delta, ref: JSON.stringify({ fillId: last.id, bookedOn: deps.today, reason: 'fill-delete' }) })
  }
  return last
}
