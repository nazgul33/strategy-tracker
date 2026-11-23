import { describe, test, expect, spyOn } from 'bun:test'
import { emptyState } from '@st/core'
import type { ExtractResult } from '@st/ingest'
import { ingestCapture, confirmPendingFill, rejectPendingFill, type FillBookingDeps, type PendingFillRow } from '../src/domain/booking'
import { refreezeKept } from '../src/domain/vision-review'
import { fakeRepos, silentNotifier } from './booking-fakes'

const TODAY = '2026-11-06'
const PNG = { base64: Buffer.from('fake-png-bytes').toString('base64'), mime: 'image/png' }

async function setup(fills: number) {
  const f = fakeRepos()
  const deps: FillBookingDeps = { repos: f.repos, today: TODAY, notify: silentNotifier }
  const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'ko', poolCents: 10_000_000, costPpm: 100, initialRunState: emptyState(6) })
  const ext: ExtractResult = { ok: true, fills: Array.from({ length: fills }, (_, i) => ({ side: 'buy' as const, ticker: 'AAPL', shares: 1 + i, price: `${10 + i}.00`, fee: '0.05', date: '2026-11-04' })) }
  const out = await ingestCapture(runId, PNG, ext, deps) as { pending: PendingFillRow[] }
  return { f, deps, runId, ids: out.pending.map((p) => p.id), captureId: out.pending[0]!.captureId! }
}

type Fakes = Awaited<ReturnType<typeof setup>>['f']

// fillRepo.insert runs after pendingRepo.decide inside bookUnlocked: a throw there is a crash after the flip
async function crashConfirm(f: Fakes, deps: FillBookingDeps, id: number, overrides: { shares?: number } | null) {
  const insert = f.repos.fillRepo.insert
  f.repos.fillRepo.insert = async () => { throw new Error('crash') }
  try {
    await expect(confirmPendingFill(id, overrides, deps, { keepImage: true })).rejects.toThrow('crash')
  } finally {
    f.repos.fillRepo.insert = insert
  }
}

describe('refreezeKept', () => {
  test('a crash after the flip is repaired: the kept image gets its frozen record from the pending row', async () => {
    const { f, deps, ids, captureId } = await setup(1)
    await crashConfirm(f, deps, ids[0]!, { shares: 4 })
    expect(f._stores.visionReviews).toHaveLength(0)
    expect(await refreezeKept(f.repos)).toEqual([ids[0]])
    expect(f._stores.visionReviews).toHaveLength(1)
    expect(f._stores.visionReviews[0]).toMatchObject({
      pendingFillId: ids[0], captureId, outcome: 'confirmed', ticker: 'AAPL',
      detectedShares: 1, finalShares: 4, edited: true, feeOverridden: false,
    })
    expect(await refreezeKept(f.repos)).toEqual([])
  })

  test('re-freezes a resolved fill whose sibling is still pending', async () => {
    const { f, deps, ids } = await setup(2)
    await crashConfirm(f, deps, ids[0]!, null)
    expect(await refreezeKept(f.repos)).toEqual([ids[0]])
    expect(f._stores.visionReviews).toHaveLength(1)
    expect(f._stores.visionReviews[0]).toMatchObject({ pendingFillId: ids[0], outcome: 'confirmed', edited: false })
    expect(f._stores.pending.find((p: any) => p.id === ids[1])!.status).toBe('pending')
  })

  test('a rejected fill is rebuilt with null finals', async () => {
    const { f, deps, ids, captureId } = await setup(1)
    const insertIgnore = f.repos.visionReviewRepo.insertIgnore
    f.repos.visionReviewRepo.insertIgnore = async () => { throw new Error('archive-down') }
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await rejectPendingFill(ids[0]!, deps, { keepImage: true })).toEqual({ archived: false })
    } finally { err.mockRestore() }
    f.repos.visionReviewRepo.insertIgnore = insertIgnore
    expect(f._stores.visionReviews).toHaveLength(0)
    expect(await refreezeKept(f.repos)).toEqual([ids[0]])
    expect(f._stores.visionReviews).toHaveLength(1)
    expect(f._stores.visionReviews[0]).toMatchObject({
      pendingFillId: ids[0], captureId, outcome: 'rejected', finalShares: null, finalSide: null, finalPrice: null, edited: false,
    })
  })

  test('an unkept image and a row that already has its record are left alone', async () => {
    const { f, deps, ids } = await setup(2)
    await confirmPendingFill(ids[0]!, null, deps)
    await confirmPendingFill(ids[1]!, null, deps, { keepImage: true })
    expect(f._stores.visionReviews).toHaveLength(2)
    expect(await refreezeKept(f.repos)).toEqual([])
    expect(f._stores.visionReviews).toHaveLength(2)
  })

  test('an unkept image whose resolved row has no record is left to the janitor', async () => {
    const { f, ids } = await setup(2)
    f._stores.pending.find((p: any) => p.id === ids[0])!.status = 'confirmed'
    expect(await refreezeKept(f.repos)).toEqual([])
    expect(f._stores.visionReviews).toHaveLength(0)
  })
})

describe('a lost decide race with keepImage', () => {
  // the row was handled by someone else between the peek and the decide
  test('confirm: the screenshot stays kept and the not-pending answer is unchanged', async () => {
    const { f, deps, ids, captureId } = await setup(1)
    f.repos.pendingRepo.decide = async () => false
    await expect(confirmPendingFill(ids[0]!, null, deps, { keepImage: true })).rejects.toThrow('pending-not-pending')
    expect(f._stores.captureImages[0]).toMatchObject({ captureId, keep: true })
    expect(f._stores.visionReviews).toHaveLength(0)
  })

  test('reject: the screenshot stays kept and the answer is null', async () => {
    const { f, deps, ids, captureId } = await setup(1)
    f.repos.pendingRepo.decide = async () => false
    expect(await rejectPendingFill(ids[0]!, deps, { keepImage: true })).toBeNull()
    expect(f._stores.captureImages[0]).toMatchObject({ captureId, keep: true })
    expect(f._stores.visionReviews).toHaveLength(0)
  })
})
