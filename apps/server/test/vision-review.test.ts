import { describe, test, expect } from 'bun:test'
import { emptyState } from '@st/core'
import { parseUsd } from '@st/core/money'
import type { ExtractResult } from '@st/ingest'
import { ingestCapture, confirmPendingFill, type BookingDeps, type PendingFillRow } from '../src/domain/booking'
import { isEdited, resolveReview, type DetectedValues, type FinalValues } from '../src/domain/vision-review'
import { createApp } from '../src/http/app'
import { fakeRepos } from './booking.test'
import { makeFakes, makeDeps, loginAs, createRun } from './http-fakes'

const TODAY = '2026-11-06'
const PNG = { base64: Buffer.from('fake-png-bytes').toString('base64'), mime: 'image/png' }

const detected = (over: Partial<DetectedValues> = {}): DetectedValues => ({
  side: 'buy', shares: 10, price: parseUsd('180.50'), filledOn: '2026-11-04', fee: 12, detectedAt: '2026-11-06 09:00:00', ...over,
})
const final = (over: Partial<FinalValues> = {}): FinalValues => ({
  side: 'buy', shares: 10, price: parseUsd('180.50'), filledOn: '2026-11-04', fee: 12, ...over,
})

describe('isEdited', () => {
  test('identical values are not edited', () => {
    expect(isEdited(detected(), final())).toBe(false)
  })

  test('a changed share count, price, side, date or fee is edited', () => {
    expect(isEdited(detected(), final({ shares: 11 }))).toBe(true)
    expect(isEdited(detected(), final({ price: parseUsd('180.51') }))).toBe(true)
    expect(isEdited(detected(), final({ side: 'sell' }))).toBe(true)
    expect(isEdited(detected(), final({ filledOn: '2026-11-05' }))).toBe(true)
    expect(isEdited(detected(), final({ fee: 13 }))).toBe(true)
  })

  test('prices compare as numbers, not as spelled strings', () => {
    expect(isEdited(detected({ price: parseUsd('180.5') }), final({ price: parseUsd('180.50') }))).toBe(false)
  })

  test('a null detected value with a non-null final is edited', () => {
    expect(isEdited(detected({ filledOn: null }), final())).toBe(true)
    expect(isEdited(detected({ fee: null }), final())).toBe(true)
    expect(isEdited(detected({ price: null }), final())).toBe(true)
  })

  test('a legacy row (detectedAt null) is never edited', () => {
    const legacy = detected({ side: null, shares: null, price: null, filledOn: null, fee: null, detectedAt: null })
    expect(isEdited(legacy, final())).toBe(false)
    expect(isEdited(detected({ detectedAt: null }), final({ shares: 99 }))).toBe(false)
  })

  test('a rejected fill (final null) is not edited but is still archivable', async () => {
    expect(isEdited(detected(), null)).toBe(false)
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
  const deps: BookingDeps = { repos: f.repos as any, today: TODAY }
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

  test('the sibling-cancel notification still fires after the archive write', async () => {
    const f = fakeRepos()
    const notified: number[] = []
    const deps: BookingDeps = { repos: f.repos as any, today: TODAY, notifySiblingCancelled: async (_r, o) => { notified.push(o.id) } }
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
    await confirmPendingFill(out.pending[1]!.id, null, deps, { keepImage: true })
    expect(f._stores.orders.map((o: any) => o.status)).toEqual(['filled', 'cancelled'])
    expect(notified).toEqual([f._stores.orders[1]!.id])
    expect(f._stores.visionReviews).toHaveLength(2)
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
