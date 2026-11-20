import { describe, test, expect, spyOn } from 'bun:test'
import { emptyState } from '@st/core'
import { parseUsd } from '@st/core/money'
import type { ExtractResult } from '@st/ingest'
import { ingestCapture, confirmPendingFill, rejectPendingFill, type FillBookingDeps, type PendingFillRow } from '../src/domain/booking'
import { isEdited, resolveReview, type DetectedValues, type FinalValues } from '../src/domain/vision-review'
import { createApp } from '../src/http/app'
import { makeCaptureHandlers } from '../src/wire/capture'
import { t } from '@st/telegram/i18n'
import { fakeRepos, silentNotifier } from './booking-fakes'
import { makeFakes, makeDeps, loginAs, createRun } from './http-fakes'

const TODAY = '2026-11-06'
const PNG = { base64: Buffer.from('fake-png-bytes').toString('base64'), mime: 'image/png' }

const detected = (over: Partial<DetectedValues> = {}): DetectedValues => ({
  side: 'buy', shares: 10, price: parseUsd('180.50'), filledOn: '2026-11-04', fee: 12, detectedAt: '2026-11-06 09:00:00', ...over,
})
const final = (over: Partial<FinalValues> = {}): FinalValues => ({
  side: 'buy', shares: 10, price: parseUsd('180.50'), filledOn: '2026-11-04', fee: 12, ...over,
})

const NO_FEE = { feeOverride: undefined }
const FEE = { feeOverride: 7 }
const RECOMPUTE = { feeOverride: null }

describe('isEdited', () => {
  test('identical values are not edited', () => {
    expect(isEdited(detected(), final(), NO_FEE)).toBe(false)
  })

  test('a changed share count, price, side, date or fee is edited', () => {
    expect(isEdited(detected(), final({ shares: 11 }), NO_FEE)).toBe(true)
    expect(isEdited(detected(), final({ price: parseUsd('180.51') }), NO_FEE)).toBe(true)
    expect(isEdited(detected(), final({ side: 'sell' }), NO_FEE)).toBe(true)
    expect(isEdited(detected(), final({ filledOn: '2026-11-05' }), NO_FEE)).toBe(true)
    expect(isEdited(detected(), final({ fee: 13 }), FEE)).toBe(true)
  })

  test('prices compare as numbers, not as spelled strings', () => {
    expect(isEdited(detected({ price: parseUsd('180.5') }), final({ price: parseUsd('180.50') }), NO_FEE)).toBe(false)
  })

  test('a null detected value with a non-null final is edited', () => {
    expect(isEdited(detected({ filledOn: null }), final(), NO_FEE)).toBe(true)
    expect(isEdited(detected({ price: null }), final(), NO_FEE)).toBe(true)
  })

  test('a derived fee is not an edit: detected fee null, no fee override, booked fee computed', () => {
    expect(isEdited(detected({ fee: null }), final({ fee: 7 }), NO_FEE)).toBe(false)
    expect(isEdited(detected({ fee: null }), final({ fee: 7, shares: 11 }), NO_FEE)).toBe(true)
  })

  test('an explicit fee override that differs from a null detected fee is an edit', () => {
    expect(isEdited(detected({ fee: null }), final({ fee: 7 }), FEE)).toBe(true)
  })

  test('feeCents null on a null detected fee discards nothing: not an edit', () => {
    expect(isEdited(detected({ fee: null }), final({ fee: 7 }), RECOMPUTE)).toBe(false)
    expect(isEdited(detected({ fee: null }), final({ fee: 7, shares: 11 }), RECOMPUTE)).toBe(true)
  })

  test('feeCents null on a detected fee is compared by value against the recomputed fee', () => {
    expect(isEdited(detected({ fee: 12 }), final({ fee: 7 }), RECOMPUTE)).toBe(true)
    expect(isEdited(detected({ fee: 12 }), final({ fee: 12 }), RECOMPUTE)).toBe(false)
  })

  test('a fee override equal to the detected fee is not an edit', () => {
    expect(isEdited(detected(), final(), FEE)).toBe(false)
  })

  test('a legacy row (detectedAt null) is never edited', () => {
    const legacy = detected({ side: null, shares: null, price: null, filledOn: null, fee: null, detectedAt: null })
    expect(isEdited(legacy, final(), FEE)).toBe(false)
    expect(isEdited(detected({ detectedAt: null }), final({ shares: 99 }), FEE)).toBe(false)
  })

  test('a rejected fill (final null) is not edited but is still archivable', async () => {
    expect(isEdited(detected(), null, FEE)).toBe(false)
    const f = fakeRepos()
    f._stores.captureImages.push({ captureId: 7, mime: 'image/png', bytes: Buffer.from('x'), byteLen: 1, keep: false })
    const row = { id: 1, runId: 1, captureId: 7, ticker: 'AAPL', detectedSide: 'buy', detectedShares: 10, detectedPrice: parseUsd('180.50'), detectedFilledOn: '2026-11-04', detectedFee: 12, detectedAt: '2026-11-06 09:00:00' }
    await resolveReview(f.repos as any, { pendingRow: row, captureId: 7, outcome: 'rejected', final: null, keepImage: true })
    expect(f._stores.visionReviews).toHaveLength(1)
    expect(f._stores.visionReviews[0]!.edited).toBe(false)
  })
})

async function setup(fills: number) {
  const f = fakeRepos()
  const deps: FillBookingDeps = { repos: f.repos as any, today: TODAY, notify: silentNotifier }
  const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'vr', poolCents: 10_000_000, costPpm: 100, initialRunState: emptyState(6) })
  const ext: ExtractResult = { ok: true, fills: Array.from({ length: fills }, (_, i) => ({ side: 'buy' as const, ticker: 'AAPL', shares: 1 + i, price: `${10 + i}.00`, fee: '0.05', date: '2026-11-04' })) }
  const out = await ingestCapture(runId, PNG, ext, deps) as { pending: PendingFillRow[] }
  return { f, deps, runId, ids: out.pending.map((p) => p.id), captureId: out.pending[0]!.captureId! }
}

describe('freeze, keep, sweep', () => {
  test('confirming a fill freezes a vision_reviews row even when nothing is kept', async () => {
    const { f, deps, ids, captureId } = await setup(2)
    await confirmPendingFill(ids[0]!, null, deps)
    expect(f._stores.visionReviews).toHaveLength(1)
    const r = f._stores.visionReviews[0]!
    expect(r).toMatchObject({
      pendingFillId: ids[0], captureId, outcome: 'confirmed', edited: false, ticker: 'AAPL',
      detectedSide: 'buy', detectedShares: 1, detectedFilledOn: '2026-11-04',
      finalSide: 'buy', finalShares: 1, finalFilledOn: '2026-11-04',
    })
    expect(r.finalPrice).toBe(parseUsd('10.00'))
    expect(r.detectedPrice).toBe(parseUsd('10.00'))
    expect(r.detectedFee).toBe(5)
    expect(r.finalFee).toBe(5)
  })

  test('operator corrections freeze the detected values next to the final ones and count as edited', async () => {
    const { f, deps, ids } = await setup(2)
    await confirmPendingFill(ids[0]!, { shares: 5, price: '10.50', feeCents: null }, deps)
    expect(f._stores.fills[0]!.fee).not.toBe(5)
    const r = f._stores.visionReviews[0]!
    expect(r).toMatchObject({ detectedShares: 1, finalShares: 5, edited: true })
    expect(r.detectedPrice).toBe(parseUsd('10.00'))
    expect(r.finalPrice).toBe(parseUsd('10.50'))
    expect(r.finalFee).toBe(f._stores.fills[0]!.fee)
  })

  test('the sweep deletes the bytes and the frozen rows once the last fill resolves unkept', async () => {
    const { f, deps, ids, captureId } = await setup(2)
    await confirmPendingFill(ids[0]!, null, deps)
    expect(f._stores.captureImages.some((i: any) => i.captureId === captureId)).toBe(true)
    expect(f._stores.visionReviews).toHaveLength(1)
    await confirmPendingFill(ids[1]!, null, deps)
    expect(f._stores.captureImages).toHaveLength(0)
    expect(f._stores.visionReviews).toHaveLength(0)
  })

  test('keepImage on any fill keeps the bytes and all frozen rows of that capture', async () => {
    const { f, deps, ids, captureId } = await setup(3)
    await confirmPendingFill(ids[0]!, null, deps)
    await confirmPendingFill(ids[1]!, null, deps)
    await confirmPendingFill(ids[2]!, null, deps, { keepImage: true })
    expect(f._stores.captureImages).toHaveLength(1)
    expect(f._stores.captureImages[0]).toMatchObject({ captureId, keep: true })
    expect(f._stores.visionReviews.map((r: any) => r.pendingFillId)).toEqual(ids)
  })

  test('keep is sticky: discarding on a sibling after a keep changes nothing', async () => {
    const { f, deps, ids } = await setup(2)
    await confirmPendingFill(ids[0]!, null, deps, { keepImage: true })
    await confirmPendingFill(ids[1]!, null, deps, { keepImage: false })
    expect(f._stores.captureImages).toHaveLength(1)
    expect(f._stores.captureImages[0]!.keep).toBe(true)
    expect(f._stores.visionReviews).toHaveLength(2)
  })

  test('rejecting with keepImage archives the fill with null finals', async () => {
    const { f, deps, ids, captureId } = await setup(1)
    const row = f._stores.pending.find((p: any) => p.id === ids[0])
    await f.repos.pendingRepo.decide(ids[0]!, 'rejected')
    await resolveReview(deps.repos, { pendingRow: row, captureId, outcome: 'rejected', final: null, keepImage: true })
    expect(f._stores.captureImages[0]).toMatchObject({ captureId, keep: true })
    expect(f._stores.visionReviews).toHaveLength(1)
    expect(f._stores.visionReviews[0]).toMatchObject({
      outcome: 'rejected', edited: false, detectedShares: 1,
      finalSide: null, finalShares: null, finalPrice: null, finalFilledOn: null, finalFee: null,
    })
  })

  test('a capture with a fill still pending keeps its bytes indefinitely', async () => {
    const { f, deps, ids, captureId } = await setup(2)
    await confirmPendingFill(ids[0]!, null, deps, { keepImage: false })
    expect(f._stores.captureImages.some((i: any) => i.captureId === captureId)).toBe(true)
    expect(await f.repos.pendingRepo.hasLiveForCapture(captureId)).toBe(true)
  })

  test('a manual row (no capture) is a no-op', async () => {
    const f = fakeRepos()
    await resolveReview(f.repos as any, { pendingRow: { id: 1, runId: 1, ticker: 'AAPL' }, captureId: null, outcome: 'confirmed', final: final(), keepImage: true })
    expect(f._stores.visionReviews).toHaveLength(0)
    expect(f._stores.captureImages).toHaveLength(0)
  })

  test('a booking that fails late archives nothing, and the retry archives exactly once', async () => {
    const { f, deps, ids, captureId } = await setup(1)
    await expect(confirmPendingFill(ids[0]!, { side: 'sell' }, deps)).rejects.toThrow()
    expect(f._stores.visionReviews).toHaveLength(0)
    expect(f._stores.pending.find((p: any) => p.id === ids[0])!.status).toBe('pending')
    await confirmPendingFill(ids[0]!, null, deps, { keepImage: true })
    expect(f._stores.visionReviews).toHaveLength(1)
    expect(f._stores.captureImages[0]).toMatchObject({ captureId, keep: true })
  })

  test('a feeless capture confirmed as-is is not edited, and records the booked fee', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: TODAY, notify: silentNotifier }
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
    const deps: FillBookingDeps = { repos: f.repos as any, today: TODAY, notify: silentNotifier }
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
    const deps: FillBookingDeps = { repos: f.repos as any, today: TODAY, notify: silentNotifier }
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
    const row = f._stores.pending.find((p: any) => p.id === ids[0])
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
    const deps: FillBookingDeps = { repos: f.repos as any, today: TODAY, notify: silentNotifier }
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
    const deps: FillBookingDeps = { repos: f.repos as any, today: TODAY, notify: { ...silentNotifier, siblingCancelled: async (_r, o) => { notified.push(o.id) } } }
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

describe('rejectPendingFill', () => {
  test('resolves null for a missing or already handled row and writes nothing', async () => {
    const { f, deps, ids } = await setup(2)
    expect(await rejectPendingFill(999, deps)).toBeNull()
    expect(await rejectPendingFill(ids[0]!, deps)).toEqual({ archived: true })
    expect(await rejectPendingFill(ids[0]!, deps)).toBeNull()
    expect(f._stores.visionReviews).toHaveLength(1)
  })

  test('an archive failure after the reject took effect is logged, not thrown', async () => {
    const { f, deps, ids } = await setup(1)
    f.repos.visionReviewRepo.insertIgnore = async () => { throw new Error('archive-down') }
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await rejectPendingFill(ids[0]!, deps)).toEqual({ archived: false })
      expect(String(err.mock.calls[0]!.join(' '))).toContain('archive-down')
    } finally {
      err.mockRestore()
    }
    expect(f._stores.pending.find((p: any) => p.id === ids[0])!.status).toBe('rejected')
  })
})

describe('confirmPendingFill validation order', () => {
  test('a malformed override on an already handled row answers not-pending first', async () => {
    const { deps, ids } = await setup(1)
    await rejectPendingFill(ids[0]!, deps)
    await expect(confirmPendingFill(ids[0]!, { side: 'hold' as any }, deps)).rejects.toThrow('pending-not-found-or-not-pending')
    await expect(confirmPendingFill(ids[0]!, { feeCents: -1 }, deps)).rejects.toThrow('pending-not-found-or-not-pending')
  })
})

describe('Telegram reject', () => {
  async function telegram() {
    const s = await setup(2)
    const sent: string[] = []
    const repos = { ...s.f.repos, pendingRepo: { ...s.f.repos.pendingRepo, get: async (id: number) => s.f._stores.pending.find((p: any) => p.id === id) ?? null } }
    const handlers = makeCaptureHandlers({
      repos: repos as any, vision: { baseUrl: 'http://x', model: 'm' }, getVisionApiKey: async () => 'k',
      today: () => TODAY, send: async (_chat, text) => { sent.push(text) },
    })
    return { ...s, sent, handlers }
  }

  test('rejecting the last pending fill of a capture freezes its row and sweeps the bytes', async () => {
    const { f, ids, sent, handlers } = await telegram()
    await handlers.onConfirm(`no:${ids[0]}`, false)
    expect(f._stores.captureImages).toHaveLength(1)
    expect(f._stores.visionReviews).toHaveLength(1)
    expect(f._stores.visionReviews[0]).toMatchObject({ pendingFillId: ids[0], outcome: 'rejected', finalShares: null, edited: false })

    await handlers.onConfirm(`no:${ids[1]}`, false)
    expect(f._stores.captureImages).toHaveLength(0)
    expect(f._stores.visionReviews).toHaveLength(0)
    expect(sent).toEqual([t('rejected-line', 'en'), t('rejected-line', 'en')])
  })

  test('a repeat reject sends the duplicate message and archives nothing more', async () => {
    const { f, ids, sent, handlers } = await telegram()
    await handlers.onConfirm(`no:${ids[0]}`, false)
    await handlers.onConfirm(`no:${ids[0]}`, false)
    expect(sent).toEqual([t('rejected-line', 'en'), t('duplicate-capture', 'en')])
    expect(f._stores.visionReviews).toHaveLength(1)
  })
})

describe('reject route', () => {
  test('rejecting the last unkept fill sweeps the bytes; a rejected fill with a pending sibling keeps them', async () => {
    const fakes = makeFakes()
    const app = createApp(makeDeps(fakes))
    const auth = await loginAs(app)
    const runId = await createRun(app, auth, { strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'rj', poolCents: 1_000_000, costPpm: 100 })
    const base = { runId, captureId: 5, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 1, price: parseUsd('10.00'), fee: null, filledOn: '2026-11-10', status: 'pending', detectedSide: 'buy', detectedShares: 1, detectedPrice: parseUsd('10.00'), detectedFilledOn: null, detectedFee: null, detectedAt: '2026-11-10 09:00:00' }
    const a = await fakes.repos.pendingRepo.insert({ ...base })
    const b = await fakes.repos.pendingRepo.insert({ ...base })
    await fakes.repos.captureImageRepo.insertIgnore({ captureId: 5, mime: 'image/png', bytes: Buffer.from('x'), byteLen: 1 })

    expect((await app.request(`/api/pending/${a}/reject`, { method: 'POST', headers: auth })).status).toBe(200)
    expect(fakes.captureImages).toHaveLength(1)
    expect(fakes.visionReviews).toHaveLength(1)
    expect(fakes.visionReviews[0]).toMatchObject({ pendingFillId: a, outcome: 'rejected', finalShares: null })

    expect((await app.request(`/api/pending/${b}/reject`, { method: 'POST', headers: auth })).status).toBe(200)
    expect(fakes.captureImages).toHaveLength(0)
    expect(fakes.visionReviews).toHaveLength(0)
  })
})
