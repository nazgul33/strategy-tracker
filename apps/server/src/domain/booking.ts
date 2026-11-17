import { applyBuyFill, applySellFill, nextBuyBucketIndex, parseUsd, DomainError, type ISODate, type RunState, type Bucket } from '@st/core'
import { feeCents, centsFromUsd, formatUsd } from '@st/core/money'
import { ageBuckets } from '@st/strategies'
import type { ExtractResult, RawFill } from '@st/ingest'
import { matchCapturedFills, type CaptureConflict } from './capture-dedup'
import { claimCapture } from './capture-claim'
import { recordCorrections } from './capture-corrections'
import { withRunLock } from './run-lock'
import { notifySiblingsCancelled } from './sibling-notify'
import { matchSellOrder, openSellLegs, type OrderRow } from './sell-match'
import { storeCaptureImage } from './capture-image'
import type { CorrectionRepo } from './correction-types'
import type { CaptureImageInsert, CaptureImageListing } from '../db/repos-vision'
import type { VisionReviewInsert, VisionReviewRow } from './vision-review'

// The conflict shape belongs to the dedup matcher and the order row to the sell
// matcher; re-exported so the booking surface keeps being the single place its
// consumers import from.
export type { CaptureConflict, OrderRow }

// confirmPendingFill lives in its own module (this file's size); re-exported so
// every caller keeps importing the booking surface from here.
export { confirmPendingFill, rejectPendingFill, type ConfirmOverrides } from './confirm-pending'

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
  orderRepo: { insertMany(orders: any[]): Promise<void>; listForDate(date: string): Promise<any[]>; listForRun(runId: number, date?: string): Promise<any[]>; markStale(date: string): Promise<any>; get(id: number): Promise<any | null>; setStatus(id: number, status: string, cancelReason?: string): Promise<void>; listOpenBefore(date: string): Promise<any[]> }
  fillRepo: {
    insert(fill: any): Promise<any>
    listForRun(runId: number): Promise<FillRow[]>
    // Rebook/delete history surface (Cash Model A rebuild).
    update?(runId: number, fillId: number, patch: { shares?: number; price?: bigint; fee?: number }): Promise<void>
    deleteById?(runId: number, fillId: number): Promise<void>
  }
  pendingRepo: {
    insert(p: any): Promise<number>
    listPending(): Promise<any[]>
    hasLiveForCapture(captureId: number): Promise<boolean>
    hasConfirmedForCapture(captureId: number): Promise<boolean>
    decide(id: number, status: string, edited?: any): Promise<boolean>
  }
  correctionRepo: CorrectionRepo
  captureRepo: { findByHash(runId: number, hash: string): Promise<{ id: number; status: string } | null>; setStatus(id: number, status: 'parsed' | 'unparseable'): Promise<void>; insert(c: any): Promise<{ inserted: boolean; id?: number }> }
  captureImageRepo: {
    insertIgnore(row: CaptureImageInsert): Promise<boolean>
    getBytes(captureId: number): Promise<{ mime: string; bytes: Buffer } | null>
    isKept(captureId: number): Promise<boolean>
    setKeep(captureId: number): Promise<void>
    deleteFor(captureId: number): Promise<void>
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

// notifySiblingCancelled: told, once per order, about a leg cancelled here that the operator must still pull at the broker.
export interface BookingDeps { repos: RepoSurface; today: ISODate; notifySiblingCancelled?: (runId: number, order: OrderRow) => Promise<void> }

export type CaptureOutcome =
  | 'duplicate'
  | 'rejected'
  | { pending: PendingFillRow[]; bookedEarlier?: true }
  | { pending: PendingFillRow[]; conflicts: CaptureConflict[]; bookedEarlier?: true }
  | { conflicts: CaptureConflict[] }

export interface PendingFillRow { id: number; runId: number; captureId: number | null; side: 'buy' | 'sell'; ticker: string; shares: number; price: string; fee: string | null; filledOn: ISODate; status: string }

export interface FillRow { id: number; runId: number; bucketIdx: number; side: 'buy' | 'sell'; ticker: string; shares: number; price: bigint; fee: number; filledOn: ISODate; source: string }

export interface BookInput {
  runId: number
  side: 'buy' | 'sell'
  shares: number
  priceStr: string
  feeCents: number | null  // null => compute
  filledOn: ISODate
  pendingId?: number | null
  source: 'capture' | 'manual' | 'seed'
}

// The whole decide→write span (read state → pick bucket → flip pending → saveState
// → fill → ledger → sibling cancel → order flip) must not interleave with another
// writer on the same run. Not reentrant: never call this from inside a withRunLock
// on the same run. Resolves to the ids of the sell orders cancelled because this
// fill emptied its bucket (empty when nothing was cancelled). The operator hears of
// them after the lock is released; a notifier failure never reaches the caller.
export async function runBooking(input: BookInput, deps: BookingDeps): Promise<number[]> {
  const cancelled = await withRunLock(input.runId, () => bookUnlocked(input, deps))
  await notifySiblingsCancelled(input.runId, cancelled, deps)
  return cancelled
}

// The one place a booked fill's fee is decided: the explicit cents when given,
// otherwise computed from the run's costPpm. confirmPendingFill freezes the same
// number into the review record, so the two must never diverge.
export function finalFeeCents(run: { costPpm: number }, price: bigint, shares: number, feeCentsOverride: number | null): number {
  return feeCentsOverride !== null ? feeCentsOverride : feeCents(price, shares, run.costPpm)
}

export async function bookUnlocked(input: BookInput, deps: BookingDeps): Promise<number[]> {
  const repos = deps.repos
  const run = await repos.runRepo.get(input.runId)
  const state: RunState = await repos.bucketRepo.loadState(input.runId)
  const priceBigInt = parseUsd(input.priceStr)
  const finalFee = finalFeeCents(run, priceBigInt, input.shares, input.feeCents)

  let next: RunState
  let bucketIdx: number
  let matchedOrderId: number | null = null
  let sellOrders: OrderRow[] = []

  if (input.side === 'buy') {
    const picked = nextBuyBucketIndex(state)
    if (picked === null) throw new Error('no-empty-bucket')
    bucketIdx = picked
    next = applyBuyFill(state, bucketIdx, input.shares, priceBigInt, finalFee, input.filledOn)
    next.ages[bucketIdx] = ageBuckets(next.ages, deps.today, { [bucketIdx]: input.filledOn })[bucketIdx]!
    // matching buy_loc order (lookup only; flip after ledger)
    const orders = await repos.orderRepo.listForDate(input.filledOn)
    const match = orders.find((o: any) => o.runId === input.runId && o.kind === 'buy_loc' && o.status === 'open')
    if (match) matchedOrderId = match.id
  } else {
    // Whole run: matchSellOrder narrows to filledOn, the cancel below needs later dates too.
    sellOrders = await repos.orderRepo.listForRun(input.runId)
    const matchedOrder = matchSellOrder(sellOrders, state, { runId: input.runId, filledOn: input.filledOn, shares: input.shares, price: priceBigInt })
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
    const edited: any = { side: input.side, shares: input.shares, price: priceBigInt, fee: finalFee, filledOn: input.filledOn, bucketIdx }
    const flipped = await repos.pendingRepo.decide(input.pendingId, 'confirmed', edited)
    if (flipped === false) throw new Error('pending-not-pending')
  }
  await repos.bucketRepo.saveState(input.runId, next)
  await repos.fillRepo.insert({ runId: input.runId, bucketIdx, side: input.side, ticker: run.ticker, shares: input.shares, price: priceBigInt, fee: finalFee, filledOn: input.filledOn, source: input.source })
  await repos.ledgerRepo.insert({ runId: input.runId, kind: input.side === 'buy' ? 'buy' : 'sell', amountCents: delta, ref: JSON.stringify({ bookedOn: deps.today, filledOn: input.filledOn }) })
  // A sell that empties its bucket leaves every open sell-side order of that bucket
  // with nothing to sell, however the bucket was chosen (matched order or fallback
  // guess) and whenever it was planned (see openSellLegs). A partial fill leaves
  // shares that still need both legs, so nothing is cancelled. Plain status writer,
  // not cancelOrder (re-enters the lock). The matched order flips to filled below.
  const cancelledIds: number[] = []
  if (input.side === 'sell' && next.buckets[bucketIdx]!.state === 'empty') {
    for (const o of openSellLegs(sellOrders, { runId: input.runId, bucketIdx, fromTradeDate: input.filledOn }, matchedOrderId)) {
      await repos.orderRepo.setStatus(o.id, 'cancelled', 'broker-filled')
      cancelledIds.push(o.id)
    }
  }
  if (matchedOrderId !== null) await repos.orderRepo.setStatus(matchedOrderId, 'filled')
  return cancelledIds
}

export async function ingestCapture(runId: number, image: { base64: string; mime: string }, extract: ExtractResult, deps: BookingDeps): Promise<CaptureOutcome> {
  const buf = new TextEncoder().encode(image.base64)
  const hash = await sha256(buf)
  const repos = deps.repos

  // The capture claim, dedup reads and the pending inserts are one decide→write
  // span: a concurrent capture of the same image or trades must see the first
  // one's rows, not re-book them. Runs under the per-run lock, so this must
  // never nest with another withRunLock on this runId.
  return withRunLock(runId, async () => {
    const claim = await claimCapture(repos, runId, hash, extract.ok ? 'parsed' : 'unparseable')
    if (claim === null) return 'duplicate'
    const captureId = claim.id
    if (!extract.ok) return 'rejected'

    const match = await matchCapturedFills(repos, runId, extract.fills, deps.today)
    const { fresh, conflicts: matched } = match
    if (fresh.length === 0 && matched.length === 0) return 'duplicate'
    const conflicts = await recordCorrections(repos, runId, captureId, matched)

    const pendingRows: PendingFillRow[] = []
    for (const f of fresh) {
      const feeCentsVal = f.fee != null ? centsFromUsd(parseUsd(f.fee)) : null
      const filledOn = f.date ?? deps.today
      const pendingId = await repos.pendingRepo.insert({
        runId, captureId, bucketIdx: null, side: f.side, ticker: f.ticker, shares: f.shares,
        price: parseUsd(f.price), fee: feeCentsVal, filledOn, status: 'pending',
        // Frozen vision snapshot: the extractor's own values, so a missing date stays null
        // rather than taking the filledOn substitute.
        detectedSide: f.side, detectedShares: f.shares, detectedPrice: parseUsd(f.price),
        detectedFilledOn: f.date ?? null, detectedFee: feeCentsVal, detectedAt: deps.today,
      })
      pendingRows.push({
        id: pendingId, runId, captureId, side: f.side, ticker: f.ticker, shares: f.shares,
        price: formatUsd(parseUsd(f.price)),
        fee: feeCentsVal === null ? null : formatUsd(BigInt(feeCentsVal) * 100n),
        filledOn, status: 'pending',
      })
    }
    if (pendingRows.length > 0) await storeCaptureImage(repos, captureId, image)
    if (fresh.length === 0) return { conflicts }
    const earlier = claim.bookedEarlier ? { bookedEarlier: true as const } : {}
    if (conflicts.length > 0) return { pending: pendingRows, conflicts, ...earlier }
    return { pending: pendingRows, ...earlier }
  })
}

export async function manualFill(runId: number, fill: Omit<RawFill, 'ticker' | 'date'> & { filledOn: ISODate }, deps: BookingDeps): Promise<void> {
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

export async function cancelOrder(runId: number, orderId: number, reason: string, deps: BookingDeps): Promise<OrderRow & { cancelReason: string }> {
  if (!(CANCEL_REASONS as readonly string[]).includes(reason)) throw new Error('invalid-reason')
  const repos = deps.repos
  const order: OrderRow | null = await repos.orderRepo.get(orderId)
  if (!order || order.runId !== runId) throw new Error('order-not-found')
  if (order.status !== 'open') throw new Error('order-not-open')
  await repos.orderRepo.setStatus(orderId, 'cancelled', reason)
  return { ...order, status: 'cancelled', cancelReason: reason }
}

// Seed a pre-existing run: replay operator-supplied buckets as 'seed' buy
// fills, then overwrite state.cashCents with the operator's number. That
// stored cash is authoritative for the books until the first recalc, because
// it does not derive from poolCents minus history; recalcRunState then re-
// anchors it and books the one-time difference as an 'adjust' (reason
// 'recalc'). See "Recalc and drift" in the partial-sell-history spec.
// Runs under the per-run lock (the run row must already exist).
type SeedInput = { cashCents: number; buckets: Array<{ shares: number; buyPrice: string; filledOn: ISODate }> }

export function seedRun(runId: number, seed: SeedInput, deps: BookingDeps): Promise<void> {
  return withRunLock(runId, () => seedUnlocked(runId, seed, deps))
}

async function seedUnlocked(runId: number, seed: SeedInput, deps: BookingDeps): Promise<void> {
  if (!Number.isInteger(seed.cashCents) || seed.cashCents < 0) throw new Error('invalid seed cash')
  const repos = deps.repos
  const run = await repos.runRepo.get(runId)
  let state: RunState = await repos.bucketRepo.loadState(runId)
  for (const b of seed.buckets) {
    const idx = nextBuyBucketIndex(state)
    if (idx === null) throw new Error('no-empty-bucket')
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
