import { emptyState } from '@st/core'
import { parseUsd } from '@st/core/money'
import type { ExtractResult } from '@st/ingest'
import { ingestCapture, type FillBookingDeps, type PendingDecisionPatch, type PendingFillRow } from '../src/domain/booking'
import type { DetectedValues, FinalValues, ReviewedPendingRow } from '../src/domain/vision-review'
import type { mrPendingFills } from '../src/db/schema'
import { fakeRepos, silentNotifier } from './booking-fakes'

export const TODAY = '2026-11-06'
export const PNG = { base64: Buffer.from('fake-png-bytes').toString('base64'), mime: 'image/png' }

export const detected = (over: Partial<DetectedValues> = {}): DetectedValues => ({
  side: 'buy', shares: 10, price: parseUsd('180.50'), filledOn: '2026-11-04', fee: 12, detectedAt: '2026-11-06 09:00:00', ...over,
})
export const final = (over: Partial<FinalValues> = {}): FinalValues => ({
  side: 'buy', shares: 10, price: parseUsd('180.50'), filledOn: '2026-11-04', fee: 12, ...over,
})

// An mr_pending_fills row must carry every column resolveReview reads; a rename fails tsc here.
export const asReviewed = (r: typeof mrPendingFills.$inferSelect): ReviewedPendingRow => r

// Every key the confirm patch writes must be a mr_pending_fills column; a rename fails tsc here.
export const asPatch = (p: PendingDecisionPatch): Pick<typeof mrPendingFills.$inferInsert, keyof PendingDecisionPatch> => p

export const legacyRow = (): ReviewedPendingRow => ({
  id: 1, runId: 1, ticker: 'AAPL', detectedSide: null, detectedShares: null, detectedPrice: null,
  detectedFilledOn: null, detectedFee: null, detectedAt: null,
})

export const NO_FEE = { feeOverride: undefined }
export const FEE = { feeOverride: 7 }
export const RECOMPUTE = { feeOverride: null }

export async function setup(fills: number) {
  const f = fakeRepos()
  const deps: FillBookingDeps = { repos: f.repos, today: TODAY, notify: silentNotifier }
  const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'vr', poolCents: 10_000_000, costPpm: 100, initialRunState: emptyState(6) })
  const ext: ExtractResult = { ok: true, fills: Array.from({ length: fills }, (_, i) => ({ side: 'buy' as const, ticker: 'AAPL', shares: 1 + i, price: `${10 + i}.00`, fee: '0.05', date: '2026-11-04' })) }
  const out = await ingestCapture(runId, PNG, ext, deps) as { pending: PendingFillRow[] }
  return { f, deps, runId, ids: out.pending.map((p) => p.id), captureId: out.pending[0]!.captureId! }
}
