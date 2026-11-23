import { describe, test, expect, spyOn } from 'bun:test'
import { emptyState } from '@st/core'
import { parseUsd } from '@st/core/money'
import type { ExtractResult } from '@st/ingest'
import { ingestCapture, confirmPendingFill, type FillBookingDeps, type PendingFillRow } from '../src/domain/booking'
import { resolveReview } from '../src/domain/vision-review'
import { fakeRepos, silentNotifier } from './booking-fakes'
import { PNG, TODAY, setup } from './vision-review-fixture'

describe('freeze, keep, sweep', () => {

  test('a feeless capture confirmed as-is is not edited, and records the booked fee', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: TODAY, notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'nf', poolCents: 10_000_000, costPpm: 100, initialRunState: emptyState(6) })
    const ext: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker: 'AAPL', shares: 10, price: '100.00', date: '2026-11-04' }] }
    const out = await ingestCapture(runId, PNG, ext, deps) as { pending: PendingFillRow[] }
    await confirmPendingFill(out.pending[0]!.id, null, deps, { keepImage: true })
    const row = f._stores.visionReviews[0]!
    expect(row.detectedFee).toBeNull()
    expect(row.finalFee).toBeGreaterThan(0)
    expect(row.edited).toBe(false)
  })

  test('a feeless capture confirmed with feeCents null is not edited, and records the recomputed fee', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: TODAY, notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'nf3', poolCents: 10_000_000, costPpm: 100, initialRunState: emptyState(6) })
    const ext: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker: 'AAPL', shares: 10, price: '100.00', date: '2026-11-04' }] }
    const out = await ingestCapture(runId, PNG, ext, deps) as { pending: PendingFillRow[] }
    await confirmPendingFill(out.pending[0]!.id, { feeCents: null }, deps, { keepImage: true })
    const row = f._stores.visionReviews[0]!
    expect(row.detectedFee).toBeNull()
    expect(row.finalFee).toBeGreaterThan(0)
    expect(row.edited).toBe(false)
  })

  // fee_overridden is the bit the review tab needs: `edited` alone cannot say whether a differing
  // fee is the operator's or the one the system derived.
  async function feelessCapture() {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: TODAY, notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'fo', poolCents: 10_000_000, costPpm: 100, initialRunState: emptyState(6) })
    const ext: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker: 'AAPL', shares: 10, price: '100.00', date: '2026-11-04' }] }
    const out = await ingestCapture(runId, PNG, ext, deps) as { pending: PendingFillRow[] }
    return { f, deps, id: out.pending[0]!.id }
  }

  test('fee_overridden is false when the confirm carried no feeCents, even with another field edited', async () => {
    const plain = await feelessCapture()
    await confirmPendingFill(plain.id, null, plain.deps, { keepImage: true })
    expect(plain.f._stores.visionReviews[0]).toMatchObject({ edited: false, feeOverridden: false })

    const other = await feelessCapture()
    await confirmPendingFill(other.id, { shares: 11 }, other.deps, { keepImage: true })
    const row = other.f._stores.visionReviews[0]!
    expect(row.detectedFee).toBeNull()
    expect(row.finalFee).toBeGreaterThan(0)
    expect(row).toMatchObject({ edited: true, feeOverridden: false })
  })

  test('fee_overridden is true whenever the confirm carried a feeCents, null included', async () => {
    const typed = await feelessCapture()
    await confirmPendingFill(typed.id, { feeCents: 999 }, typed.deps, { keepImage: true })
    expect(typed.f._stores.visionReviews[0]).toMatchObject({ edited: true, feeOverridden: true })

    const recompute = await feelessCapture()
    await confirmPendingFill(recompute.id, { feeCents: null }, recompute.deps, { keepImage: true })
    expect(recompute.f._stores.visionReviews[0]).toMatchObject({ edited: false, feeOverridden: true })
  })

  test('fee_overridden is false for a reject', async () => {
    const { f, deps, ids, captureId } = await setup(1)
    const row = f._stores.pending.find((p) => p.id === ids[0])!
    await f.repos.pendingRepo.decide(ids[0]!, 'rejected')
    await resolveReview(deps.repos, { pendingRow: row, captureId, outcome: 'rejected', final: null, keepImage: true })
    expect(f._stores.visionReviews[0]!.feeOverridden).toBe(false)
  })

  test('a fee-bearing capture confirmed with feeCents null is edited when the recomputed fee differs', async () => {
    const { f, deps, ids } = await setup(1)
    await confirmPendingFill(ids[0]!, { feeCents: null }, deps, { keepImage: true })
    const row = f._stores.visionReviews[0]!
    expect(row.detectedFee).toBe(5)
    expect(row.finalFee).not.toBe(5)
    expect(row.edited).toBe(true)
    expect(row.feeOverridden).toBe(true)
  })

  test('a feeless capture confirmed with an explicit differing fee is edited', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: TODAY, notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'nf2', poolCents: 10_000_000, costPpm: 100, initialRunState: emptyState(6) })
    const ext: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker: 'AAPL', shares: 10, price: '100.00', date: '2026-11-04' }] }
    const out = await ingestCapture(runId, PNG, ext, deps) as { pending: PendingFillRow[] }
    await confirmPendingFill(out.pending[0]!.id, { feeCents: 999 }, deps, { keepImage: true })
    const row = f._stores.visionReviews[0]!
    expect(row.detectedFee).toBeNull()
    expect(row.finalFee).toBe(999)
    expect(row.edited).toBe(true)
  })

  // A held bucket, a capture holding the sell that empties it, and the two open
  // legs of that bucket: confirming the sell pulls the stop leg.
  async function sellEmptyingBucket() {
    const f = fakeRepos()
    const notified: number[] = []
    const deps: FillBookingDeps = { repos: f.repos, today: TODAY, notify: { ...silentNotifier, siblingCancelled: async (_r, o) => { notified.push(o.id) } } }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'nt', poolCents: 10_000_000, costPpm: 100, initialRunState: emptyState(4) })
    const ext: ExtractResult = { ok: true, fills: [
      { side: 'buy', ticker: 'AAPL', shares: 10, price: '100.00', date: TODAY },
      { side: 'sell', ticker: 'AAPL', shares: 10, price: '103.00', date: TODAY },
    ] }
    const out = await ingestCapture(runId, PNG, ext, deps) as { pending: PendingFillRow[] }
    await confirmPendingFill(out.pending[0]!.id, null, deps)
    await f.repos.orderRepo.insertMany([
      { runId, tradeDate: TODAY, kind: 'sell_loc', bucketIdx: 0, limitPrice: parseUsd('103.00'), shares: 10, status: 'open' },
      { runId, tradeDate: TODAY, kind: 'stop_sell', bucketIdx: 0, limitPrice: parseUsd('97.00'), shares: 10, status: 'open' },
    ])
    return { f, deps, notified, sellId: out.pending[1]!.id }
  }

  test('the sibling-cancel notification still fires after the archive write', async () => {
    const { f, deps, notified, sellId } = await sellEmptyingBucket()
    expect(await confirmPendingFill(sellId, null, deps, { keepImage: true })).toEqual({ archived: true })
    expect(f._stores.orders.map((o: any) => o.status)).toEqual(['filled', 'cancelled'])
    expect(notified).toEqual([f._stores.orders[1]!.id])
    expect(f._stores.visionReviews).toHaveLength(2)
  })

  test('an archive failure after booking is logged, not thrown, and the sibling-cancel notification still fires', async () => {
    const { f, deps, notified, sellId } = await sellEmptyingBucket()
    f.repos.visionReviewRepo.insertIgnore = async () => { throw new Error('archive-down') }
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await confirmPendingFill(sellId, null, deps, { keepImage: true })).toEqual({ archived: false })
      expect(err).toHaveBeenCalledTimes(1)
      expect(String(err.mock.calls[0]!.join(' '))).toContain('archive-down')
    } finally {
      err.mockRestore()
    }
    expect(f._stores.fills).toHaveLength(2)
    expect(f._stores.pending.find((p: any) => p.id === sellId)!.status).toBe('confirmed')
    expect(f._stores.orders.map((o: any) => o.status)).toEqual(['filled', 'cancelled'])
    expect(notified).toEqual([f._stores.orders[1]!.id])
  })
})
