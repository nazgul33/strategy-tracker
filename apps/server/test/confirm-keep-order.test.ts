import { describe, test, expect, spyOn } from 'bun:test'
import { emptyState } from '@st/core'
import type { ExtractResult } from '@st/ingest'
import { ingestCapture, confirmPendingFill, rejectPendingFill, type FillBookingDeps, type PendingFillRow } from '../src/domain/booking'
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

function recordOrder(f: Fakes): string[] {
  const order: string[] = []
  const setKeep = f.repos.captureImageRepo.setKeep
  f.repos.captureImageRepo.setKeep = async (id: number) => { order.push('keep'); await setKeep(id) }
  const decide = f.repos.pendingRepo.decide
  f.repos.pendingRepo.decide = async (...a: Parameters<typeof decide>) => { order.push('decide'); return decide(...a) }
  return order
}

const rowOf = (f: Fakes, id: number) => f._stores.pending.find((p: any) => p.id === id)!

describe('confirm: the keep is written before the row flips', () => {
  test('the keep is written before the row flips', async () => {
    const { f, deps, ids, captureId } = await setup(1)
    const order = recordOrder(f)
    await confirmPendingFill(ids[0]!, null, deps, { keepImage: true })
    expect(order[0]).toBe('keep')
    expect(order.indexOf('keep')).toBeLessThan(order.indexOf('decide'))
    expect(f._stores.captureImages[0]).toMatchObject({ captureId, keep: true })
  })

  test('a crash after the flip leaves the row confirmed and the image kept, never sweepable', async () => {
    const { f, deps, ids, captureId } = await setup(1)
    // fillRepo.insert runs after pendingRepo.decide inside bookUnlocked: a throw here is a crash after the flip
    f.repos.fillRepo.insert = async () => { throw new Error('crash') }
    await expect(confirmPendingFill(ids[0]!, null, deps, { keepImage: true })).rejects.toThrow('crash')
    expect(rowOf(f, ids[0]!).status).toBe('confirmed')
    expect(f._stores.captureImages[0]).toMatchObject({ captureId, keep: true })
    expect(f._stores.visionReviews).toHaveLength(0)
    expect(await f.repos.pendingRepo.hasLiveForCapture(captureId)).toBe(false)
  })

  test('a keep request survives a booking that fails before the flip', async () => {
    const { f, deps, ids, captureId } = await setup(1)
    await expect(confirmPendingFill(ids[0]!, { side: 'sell' }, deps, { keepImage: true })).rejects.toMatchObject({ kind: 'no-bucket-for-sell' })
    expect(rowOf(f, ids[0]!).status).toBe('pending')
    expect(f._stores.captureImages[0]).toMatchObject({ captureId, keep: true })
    expect(f._stores.visionReviews).toHaveLength(0)
    expect(await confirmPendingFill(ids[0]!, null, deps)).toEqual({ archived: true })
    expect(f._stores.captureImages[0]!.keep).toBe(true)
    expect(f._stores.visionReviews).toHaveLength(1)
  })

  test('a failed keep write aborts the confirm before anything is booked', async () => {
    const { f, deps, ids } = await setup(1)
    f.repos.captureImageRepo.setKeep = async () => { throw new Error('keep-down') }
    await expect(confirmPendingFill(ids[0]!, null, deps, { keepImage: true })).rejects.toThrow('keep-down')
    expect(rowOf(f, ids[0]!).status).toBe('pending')
    expect(f._stores.fills).toHaveLength(0)
  })

  test('archived: false after a failed freeze still leaves a requested keep in place', async () => {
    const { f, deps, ids, captureId } = await setup(1)
    f.repos.visionReviewRepo.insertIgnore = async () => { throw new Error('archive-down') }
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await confirmPendingFill(ids[0]!, null, deps, { keepImage: true })).toEqual({ archived: false })
    } finally { err.mockRestore() }
    expect(f._stores.captureImages[0]).toMatchObject({ captureId, keep: true })
  })

  test('a ticker mismatch keeps nothing', async () => {
    const { f, deps, ids } = await setup(1)
    rowOf(f, ids[0]!).ticker = 'MSFT'
    await expect(confirmPendingFill(ids[0]!, null, deps, { keepImage: true })).rejects.toThrow('ticker-mismatch')
    expect(f._stores.captureImages[0]!.keep).toBe(false)
    expect(rowOf(f, ids[0]!).status).toBe('pending')
  })

  test('a forced bucket that is not held leaves the row pending and keeps the image only when asked', async () => {
    const kept = await setup(1)
    await expect(confirmPendingFill(kept.ids[0]!, { side: 'sell', bucketIdx: 0 }, kept.deps, { keepImage: true })).rejects.toMatchObject({ kind: 'bucket-not-held' })
    expect(rowOf(kept.f, kept.ids[0]!).status).toBe('pending')
    expect(kept.f._stores.fills).toHaveLength(0)
    expect(kept.f._stores.captureImages[0]).toMatchObject({ captureId: kept.captureId, keep: true })

    const plain = await setup(1)
    await expect(confirmPendingFill(plain.ids[0]!, { side: 'sell', bucketIdx: 0 }, plain.deps)).rejects.toMatchObject({ kind: 'bucket-not-held' })
    expect(rowOf(plain.f, plain.ids[0]!).status).toBe('pending')
    expect(plain.f._stores.captureImages[0]!.keep).toBe(false)
  })

  test('a malformed bucketIdx (invalid-bucket) leaves the row pending and the requested keep in place', async () => {
    const { f, deps, ids, captureId } = await setup(1)
    await expect(confirmPendingFill(ids[0]!, { bucketIdx: 0 }, deps, { keepImage: true })).rejects.toThrow('invalid-bucket')
    expect(rowOf(f, ids[0]!).status).toBe('pending')
    expect(f._stores.captureImages[0]).toMatchObject({ captureId, keep: true })
  })
})

describe('reject: the keep is written before the row flips', () => {
  test('reject writes the keep before the row flips', async () => {
    const { f, deps, ids, captureId } = await setup(1)
    const order = recordOrder(f)
    expect(await rejectPendingFill(ids[0]!, deps, { keepImage: true })).toEqual({ archived: true })
    expect(order[0]).toBe('keep')
    expect(order.indexOf('keep')).toBeLessThan(order.indexOf('decide'))
    expect(f._stores.captureImages[0]).toMatchObject({ captureId, keep: true })
  })

  test('a failed freeze after the flip leaves the row rejected and the image kept', async () => {
    const { f, deps, ids, captureId } = await setup(1)
    f.repos.visionReviewRepo.insertIgnore = async () => { throw new Error('archive-down') }
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await rejectPendingFill(ids[0]!, deps, { keepImage: true })).toEqual({ archived: false })
    } finally { err.mockRestore() }
    expect(rowOf(f, ids[0]!).status).toBe('rejected')
    expect(f._stores.captureImages[0]).toMatchObject({ captureId, keep: true })
  })

  test('a failed keep write aborts the reject: the row stays pending', async () => {
    const { f, deps, ids } = await setup(1)
    f.repos.captureImageRepo.setKeep = async () => { throw new Error('keep-down') }
    await expect(rejectPendingFill(ids[0]!, deps, { keepImage: true })).rejects.toThrow('keep-down')
    expect(rowOf(f, ids[0]!).status).toBe('pending')
  })
})
