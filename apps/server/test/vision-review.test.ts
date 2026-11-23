import { describe, test, expect } from 'bun:test'
import { parseUsd } from '@st/core/money'
import { confirmPendingFill } from '../src/domain/booking'
import { isEdited, resolveReview } from '../src/domain/vision-review'
import { fakeRepos } from './booking-fakes'
import { detected, final, legacyRow, setup, NO_FEE, FEE, RECOMPUTE } from './vision-review-fixture'

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
    await resolveReview(f.repos, { pendingRow: row, captureId: 7, outcome: 'rejected', final: null, keepImage: true })
    expect(f._stores.visionReviews).toHaveLength(1)
    expect(f._stores.visionReviews[0]!.edited).toBe(false)
  })
})

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
    const row = f._stores.pending.find((p) => p.id === ids[0])!
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
    await resolveReview(f.repos, { pendingRow: { ...legacyRow(), id: 1 }, captureId: null, outcome: 'confirmed', final: final(), keepImage: true })
    expect(f._stores.visionReviews).toHaveLength(0)
    expect(f._stores.captureImages).toHaveLength(0)
  })

  test('a legacy row resolved with a capture freezes edited false', async () => {
    const f = fakeRepos()
    await f.repos.captureImageRepo.insertIgnore({ captureId: 7, mime: 'image/png', bytes: Buffer.from('x'), byteLen: 1 })
    await resolveReview(f.repos, { pendingRow: { ...legacyRow(), id: 2 }, captureId: 7, outcome: 'confirmed', final: final({ shares: 99 }), keepImage: true, feeOverride: undefined })
    expect(f._stores.visionReviews).toHaveLength(1)
    expect(f._stores.visionReviews[0]!.edited).toBe(false)
    expect(f._stores.visionReviews[0]!.detectedShares).toBeNull()
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
})
