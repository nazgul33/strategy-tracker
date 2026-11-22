import { describe, test, expect, spyOn } from 'bun:test'
import { emptyState } from '@st/core'
import { parseUsd } from '@st/core/money'
import type { ExtractResult } from '@st/ingest'
import { ingestCapture, type BookingDeps, type CaptureConflict, type PendingFillRow } from '../src/domain/booking'
import { MAX_IMAGE_BYTES, storeCaptureImage } from '../src/domain/capture-image'
import { fakeRepos } from './booking-fakes'

const TODAY = '2026-11-06'
const PNG = { base64: Buffer.from('fake-png-bytes').toString('base64'), mime: 'image/png' }

async function setup() {
  const f = fakeRepos()
  const deps: BookingDeps = { repos: f.repos, today: TODAY }
  const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'ci', poolCents: 1_000_000, costPpm: 100, initialRunState: emptyState(4) })
  return { f, deps, runId }
}

describe('capture image storage at ingest', () => {
  test('ingestCapture stores the image bytes for a capture that produced pending fills', async () => {
    const { f, deps, runId } = await setup()
    const ext: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker: 'AAPL', shares: 1, price: '10.00' }] }
    await ingestCapture(runId, PNG, ext, deps)
    expect(f._stores.captureImages.length).toBe(1)
    const img = f._stores.captureImages[0]!
    expect(img.captureId).toBe(f._stores.pending[0]!.captureId)
    expect(img.mime).toBe('image/png')
    expect(img.byteLen).toBeGreaterThan(0)
    expect(img.byteLen).toBe(img.bytes.length)
  })

  test('an unparseable extract stores no image (it returns before the store gate)', async () => {
    const { f, deps, runId } = await setup()
    const ext: ExtractResult = { ok: false, reason: 'unparseable', detail: 'bad' }
    expect(await ingestCapture(runId, PNG, ext, deps)).toBe('rejected')
    expect(f._stores.captureImages.length).toBe(0)
  })

  test('a conflicts-only capture stores no image', async () => {
    const { f, deps, runId } = await setup()
    await f.repos.fillRepo.insert({ runId, bucketIdx: 0, side: 'buy', ticker: 'AAPL', shares: 1, price: parseUsd('10.00'), fee: 0, filledOn: '2026-11-05', source: 'manual' })
    const ext: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker: 'AAPL', shares: 1, price: '10.50', date: '2026-11-05' }] }
    const out = await ingestCapture(runId, PNG, ext, deps) as { conflicts: CaptureConflict[] }
    expect(out.conflicts.length).toBe(1)
    expect('pending' in out).toBe(false)
    expect(f._stores.captures.length).toBe(1) // the claim ran, so the extract did not return early
    expect(f._stores.pending.length).toBe(0)
    expect(f._stores.captureImages.length).toBe(0)
  })

  test('ingestCapture freezes the detected snapshot on each pending row', async () => {
    const { f, deps, runId } = await setup()
    const ext: ExtractResult = { ok: true, fills: [
      { side: 'buy', ticker: 'AAPL', shares: 5, price: '10.00', date: '2026-11-04' },
      { side: 'buy', ticker: 'AAPL', shares: 2, price: '9.00' },
    ] }
    await ingestCapture(runId, PNG, ext, deps)
    const [a, b] = f._stores.pending
    expect(a!.detectedSide).toBe('buy')
    expect(a!.detectedShares).toBe(5)
    expect(a!.detectedPrice).toBe(parseUsd('10.00'))
    expect(a!.detectedFilledOn).toBe('2026-11-04')
    expect(a!.detectedAt).toBe(TODAY)
    expect(b!.filledOn).toBe(TODAY)
    expect(b!.detectedFilledOn).toBeNull()
  })

  test('ingestCapture snapshots a missing fee as null and a present fee as cents', async () => {
    const { f, deps, runId } = await setup()
    const ext: ExtractResult = { ok: true, fills: [
      { side: 'buy', ticker: 'AAPL', shares: 5, price: '10.00', fee: '0.21' },
      { side: 'buy', ticker: 'AAPL', shares: 2, price: '9.00' },
    ] }
    await ingestCapture(runId, PNG, ext, deps)
    expect(f._stores.pending.map((p: any) => p.detectedFee)).toEqual([21, null])
  })

  test('an image over the cap books its fills and stores no bytes', async () => {
    const { f, deps, runId } = await setup()
    const big = { base64: Buffer.alloc(MAX_IMAGE_BYTES + 1, 1).toString('base64'), mime: 'image/png' }
    const ext: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker: 'AAPL', shares: 1, price: '10.00' }] }
    const out = await ingestCapture(runId, big, ext, deps) as { pending: PendingFillRow[] }
    expect(out.pending.length).toBe(1)
    expect(f._stores.captureImages.length).toBe(0)
  })

  test('a failing image write is logged and the capture still books its fills', async () => {
    const { f, deps, runId } = await setup()
    f.repos.captureImageRepo.insertIgnore = async () => { throw new Error('packet too large') }
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ext: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker: 'AAPL', shares: 1, price: '10.00' }] }
      const out = await ingestCapture(runId, PNG, ext, deps) as { pending: PendingFillRow[] }
      expect(out.pending.length).toBe(1)
      expect(f._stores.pending.length).toBe(1)
      expect(f._stores.captureImages.length).toBe(0)
      expect(errSpy).toHaveBeenCalledTimes(1)
      expect(String(errSpy.mock.calls[0]!.join(' '))).toContain('packet too large')
      expect(await storeCaptureImage(f.repos, 1, PNG)).toBe(false)
    } finally {
      errSpy.mockRestore()
    }
  })

  test('an image exactly at the cap is stored', async () => {
    const { f } = await setup()
    const at = { base64: Buffer.alloc(MAX_IMAGE_BYTES, 1).toString('base64'), mime: 'image/png' }
    expect(await storeCaptureImage(f.repos, 1, at)).toBe(true)
    expect(f._stores.captureImages[0]!.byteLen).toBe(MAX_IMAGE_BYTES)
  })

  test('an unexpected mime is stored as image/jpeg; an allowed one is kept', async () => {
    const { f } = await setup()
    const base64 = Buffer.from('x').toString('base64')
    await storeCaptureImage(f.repos, 1, { base64, mime: 'text/html; charset=utf-8; ' + 'x'.repeat(64) })
    await storeCaptureImage(f.repos, 2, { base64, mime: 'image/webp' })
    expect(f._stores.captureImages.map((i: any) => i.mime)).toEqual(['image/jpeg', 'image/webp'])
  })

  test('re-ingesting a screenshot whose image was kept after a reject does not throw and reuses the bytes', async () => {
    const { f, deps, runId } = await setup()
    const ext: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker: 'AAPL', shares: 1, price: '10.00' }] }
    await ingestCapture(runId, PNG, ext, deps)
    const first = f._stores.pending[0]!
    await f.repos.pendingRepo.decide(first.id, 'rejected')
    await f.repos.captureImageRepo.setKeep(first.captureId)
    const originalBytes = f._stores.captureImages[0]!.bytes

    const again = await ingestCapture(runId, PNG, ext, deps) as { pending: PendingFillRow[] }
    expect(again.pending.length).toBe(1)
    expect(f._stores.pending.length).toBe(2)
    expect(f._stores.captureImages.length).toBe(1)
    expect(f._stores.captureImages[0]!.bytes).toBe(originalBytes)
    expect(f._stores.captureImages[0]!.keep).toBe(true)
  })
})
