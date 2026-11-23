import { describe, test, expect } from 'bun:test'
import type { ExtractResult } from '@st/ingest'
import { ingestCapture, type BookingDeps } from '../src/domain/booking'
import { fakeRepos } from './booking-fakes'

describe('ingestCapture order columns', () => {
  test('ingestCapture stores the order columns', async () => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos, today: '2026-11-15' }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'SOXL', name: 'order-cols', poolCents: 1_000_000, costPpm: 100 })
    const ext: ExtractResult = {
      ok: true,
      fills: [
        { side: 'sell', ticker: 'SOXL', shares: 1, price: '64.07', date: '2026-11-12', orderType: '매도/STOP(시장가)', orderPrice: '0.0000', orderedShares: 1 },
        { side: 'buy', ticker: 'SOXL', shares: 88, price: '56.06', date: '2026-11-10' },
      ],
    }
    await ingestCapture(runId, { base64: 'ORDER-COLS', mime: 'image/png' }, ext, deps)
    expect(f._stores.pending[0]).toMatchObject({ side: 'sell', detectedOrderType: '매도/STOP(시장가)', detectedOrderPrice: 0n, detectedOrderedShares: 1 })
    expect(f._stores.pending[1]).toMatchObject({ side: 'buy', detectedOrderType: null, detectedOrderPrice: null, detectedOrderedShares: null })
  })
})
