import { applyBuyFill, applySellFill, DomainError, nextBuyBucketIndex, parseUsd, type ISODate, type RunState } from '@st/core'
import { feeCents, centsFromUsd, formatUsd } from '@st/core/money'
import { ageBuckets } from '@st/strategies'
import type { ExtractResult, RawFill } from '@st/ingest'
import { matchCapturedFills, type CaptureConflict } from './capture-dedup'
import { claimCapture } from './capture-claim'
import { recordCorrections } from './capture-corrections'
import { withRunLock } from './run-lock'
import { notifyBookingOutcome, type BookingNotifier, type BookedOutcome } from './booking-notify'
import { attributeSell } from './sell-attribute'
import type { OrderEvidence } from './order-type'
import type { OrderRow, SellAttribution } from './sell-match'
import { emptiedBuckets, retireLegs } from './retire-legs'
import { storeCaptureImage } from './capture-image'
import type { FeeOverrideKind, FillSource, PendingDecisionPatch, RepoSurface } from './repo-types'
import { requireRun } from './require-run'

// The conflict shape belongs to the dedup matcher, the order row to the sell
// matcher and the repository surface to repo-types; re-exported here for the
// consumers that import the booking surface from this module.
export type { CaptureConflict, OrderRow, BookingNotifier, BookedOutcome, SellAttribution }
export type { RepoSurface, PendingDecisionPatch, FillRow, LedgerRow } from './repo-types'

// confirmPendingFill lives in its own module (this file's size); re-exported so
// every caller keeps importing the booking surface from here.
export { confirmPendingFill, rejectPendingFill, type ConfirmOverrides } from './confirm-pending'
// rollStale and cancelOrder live in order-ops (this file's size); re-exported for the same reason.
export { rollStale, cancelOrder, CANCEL_REASONS } from './order-ops'

export async function sha256(buf: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf as any)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

export interface BookingDeps { repos: RepoSurface; today: ISODate }
// Every function that books a fill takes a notifier, so the operator is always told about a cancelled leg or an ambiguous attribution.
export interface FillBookingDeps extends BookingDeps { notify: BookingNotifier }

export type CaptureOutcome =
  | 'duplicate'
  | 'rejected'
  | { pending: PendingFillRow[]; bookedEarlier?: true }
  | { pending: PendingFillRow[]; conflicts: CaptureConflict[]; bookedEarlier?: true }
  | { conflicts: CaptureConflict[] }

export interface PendingFillRow { id: number; runId: number; captureId: number | null; side: 'buy' | 'sell'; ticker: string; shares: number; price: string; fee: string | null; filledOn: ISODate; detectedFilledOn: ISODate | null; status: string }

export interface BookInput {
  runId: number
  side: 'buy' | 'sell'
  shares: number
  priceStr: string
  feeCents: number | null  // null => compute
  filledOn: ISODate
  pendingId?: number | null
  source: FillSource
  bucketIdx?: number | null  // sell only: the operator's bucket; null/undefined = automatic
  order?: OrderEvidence  // sell only: what the screenshot said about the order; absent = no evidence
  feeOverride?: FeeOverrideKind  // the KIND of fee override, stored on the pending row; read only with pendingId, absent = 'none'
}

// The whole decide→write span (read state → pick bucket → flip pending → saveState
// → fill → ledger → sibling cancel → order flip) must not interleave with another
// writer on the same run. Not reentrant: never call this from inside a withRunLock
// on the same run. Resolves to the ids of the sell orders cancelled because this
// fill emptied its bucket (empty when nothing was cancelled) and the attribution
// of an ambiguous sell. The operator hears of both after the lock is released; a
// notifier failure never reaches the caller.
export async function runBooking(input: BookInput, deps: FillBookingDeps): Promise<BookedOutcome> {
  const outcome = await withRunLock(input.runId, () => bookUnlocked(input, deps))
  await notifyBookingOutcome(input.runId, outcome, deps)
  return outcome
}

// The one place a booked fill's fee is decided: the explicit cents when given,
// otherwise computed from the run's costPpm. confirmPendingFill freezes the same
// number into the review record, so the two must never diverge.
export function finalFeeCents(run: { costPpm: number }, price: bigint, shares: number, feeCentsOverride: number | null): number {
  return feeCentsOverride !== null ? feeCentsOverride : feeCents(price, shares, run.costPpm)
}

export async function bookUnlocked(input: BookInput, deps: BookingDeps): Promise<BookedOutcome> {
  if (input.bucketIdx != null) {
    const usable = input.side === 'sell' && Number.isInteger(input.bucketIdx) && input.bucketIdx >= 0
    if (!usable) throw new Error('invalid-bucket')
  }
  if (input.filledOn > deps.today) throw new DomainError('fill-date-in-future')
  const repos = deps.repos
  const run = await requireRun(repos, input.runId)
  const state: RunState = await repos.bucketRepo.loadState(input.runId)
  const priceBigInt = parseUsd(input.priceStr)
  const finalFee = finalFeeCents(run, priceBigInt, input.shares, input.feeCents)

  let next: RunState
  let bucketIdx: number
  let matchedOrderId: number | null = null
  let sellOrders: OrderRow[] = []
  let attribution: SellAttribution | null = null

  if (input.side === 'buy') {
    const picked = nextBuyBucketIndex(state)
    if (picked === null) throw new Error('no-empty-bucket')
    bucketIdx = picked
    next = applyBuyFill(state, bucketIdx, input.shares, priceBigInt, finalFee, input.filledOn)
    next.ages[bucketIdx] = ageBuckets(next.ages, deps.today, { [bucketIdx]: input.filledOn })[bucketIdx]!
    // matching buy_loc order (lookup only; flip after ledger)
    const orders = await repos.orderRepo.listForDate(input.filledOn)
    const match = orders.find((o) => o.runId === input.runId && o.kind === 'buy_loc' && (o.status === 'open' || o.status === 'stale'))
    if (match) matchedOrderId = match.id
  } else {
    // From the fill date onwards: matching narrows to filledOn, the cancel below needs later dates too.
    sellOrders = await repos.orderRepo.listForRunFrom(input.runId, input.filledOn)
    const pick = attributeSell(sellOrders, state, { runId: input.runId, filledOn: input.filledOn, shares: input.shares, price: priceBigInt, bucketIdx: input.bucketIdx, evidence: input.order })
    bucketIdx = pick.bucketIdx
    matchedOrderId = pick.orderId
    attribution = pick.attribution
    next = applySellFill(state, bucketIdx, input.shares, priceBigInt, finalFee, input.filledOn)
  }

  const prevCash = state.cashCents
  const delta = next.cashCents - prevCash

  // persist order: decide -> saveState -> fill -> ledger -> order flip (R15: flip last, only after ledger)
  if (input.pendingId != null) {
    const edited: PendingDecisionPatch = { side: input.side, shares: input.shares, price: priceBigInt, fee: finalFee, filledOn: input.filledOn, bucketIdx, feeOverride: input.feeOverride ?? 'none' }
    const flipped = await repos.pendingRepo.decide(input.pendingId, 'confirmed', edited)
    if (flipped === false) throw new Error('pending-not-pending')
  }
  await repos.bucketRepo.saveState(input.runId, next)
  await repos.fillRepo.insert({ runId: input.runId, bucketIdx, side: input.side, ticker: run.ticker, shares: input.shares, price: priceBigInt, fee: finalFee, filledOn: input.filledOn, source: input.source })
  await repos.ledgerRepo.insert({ runId: input.runId, kind: input.side === 'buy' ? 'buy' : 'sell', amountCents: delta, ref: JSON.stringify({ bookedOn: deps.today, filledOn: input.filledOn }) })
  // A sell that empties its bucket retires that bucket's sell legs and flips its matched
  // order (retireLegs). A partial fill cancels nothing and leaves the matched order as it
  // was, so its rest stays a candidate. A buy flips its matched buy_loc.
  let cancelledIds: number[] = []
  if (input.side === 'sell' && emptiedBuckets(state, next).includes(bucketIdx)) {
    cancelledIds = await retireLegs(repos, sellOrders, { runId: input.runId, bucketIdx }, { kind: 'sold', filledOn: input.filledOn, legId: matchedOrderId })
  } else if (input.side === 'buy' && matchedOrderId !== null) {
    await repos.orderRepo.setStatus(matchedOrderId, 'filled')
  }
  return { cancelledIds, attribution }
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
        detectedOrderType: f.orderType ?? null,
        detectedOrderPrice: f.orderPrice != null ? parseUsd(f.orderPrice) : null,
        detectedOrderedShares: f.orderedShares ?? null,
      })
      pendingRows.push({
        id: pendingId, runId, captureId, side: f.side, ticker: f.ticker, shares: f.shares,
        price: formatUsd(parseUsd(f.price)),
        fee: feeCentsVal === null ? null : formatUsd(BigInt(feeCentsVal) * 100n),
        filledOn, detectedFilledOn: f.date ?? null, status: 'pending',
      })
    }
    if (pendingRows.length > 0) await storeCaptureImage(repos, captureId, image)
    if (fresh.length === 0) return { conflicts }
    const earlier = claim.bookedEarlier ? { bookedEarlier: true as const } : {}
    if (conflicts.length > 0) return { pending: pendingRows, conflicts, ...earlier }
    return { pending: pendingRows, ...earlier }
  })
}

export async function manualFill(runId: number, fill: Omit<RawFill, 'ticker' | 'date'> & { filledOn: ISODate; bucketIdx?: number | null }, deps: FillBookingDeps): Promise<void> {
  await runBooking({
    runId,
    side: fill.side,
    shares: fill.shares,
    priceStr: fill.price,
    feeCents: fill.fee != null ? centsFromUsd(parseUsd(fill.fee)) : null,
    filledOn: fill.filledOn,
    pendingId: null,
    source: 'manual',
    bucketIdx: fill.bucketIdx,
  }, deps)
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
  if (seed.buckets.some((b) => b.filledOn > deps.today)) throw new DomainError('fill-date-in-future')
  const repos = deps.repos
  const run = await requireRun(repos, runId)
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
