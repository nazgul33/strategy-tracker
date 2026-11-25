import { describe, test, expect, spyOn } from 'bun:test'
import type { ExtractResult } from '@st/ingest'
import { ingestCapture, type BookingDeps, type PendingFillRow } from '../src/domain/booking'
import { fakeRepos } from './booking-fakes'
import { book43, D, held43, sellSetup } from './sell-fixture'

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

describe('ingestCapture row flags', () => {
  async function ingest(fills: Extract<ExtractResult, { ok: true }>['fills'], image: string) {
    const { f, deps, runId } = await sellSetup(held43, book43())
    const outcome = await ingestCapture(runId, { base64: image, mime: 'image/png' }, { ok: true, fills }, deps)
    return { f, pending: (outcome as { pending: PendingFillRow[] }).pending }
  }
  const sell = { side: 'sell' as const, ticker: 'AAPL', shares: 10, price: '96.50', date: D }

  test('needsBucket is true for an untyped sell among two possible buckets and false for the typed one', async () => {
    const untyped = await ingest([sell], 'FLAG-UNTYPED')
    expect(untyped.pending[0]).toMatchObject({ needsBucket: true, dateAfterToday: false })
    const typed = await ingest([{ ...sell, orderType: '매도/STOP(시장가)', orderPrice: '0.0000' }], 'FLAG-TYPED')
    expect(typed.pending[0]).toMatchObject({ needsBucket: false, dateAfterToday: false })
  })

  test('a buy is never flagged as needing a bucket', async () => {
    const { pending } = await ingest([{ ...sell, side: 'buy' }], 'FLAG-BUY')
    expect(pending[0]).toMatchObject({ needsBucket: false })
  })

  test('a fill dated after today is flagged and keeps its date as read', async () => {
    const { f, pending } = await ingest([{ side: 'buy', ticker: 'AAPL', shares: 3, price: '50.00', date: '2026-11-13' }], 'FLAG-FUTURE')
    expect(pending[0]).toMatchObject({ dateAfterToday: true, filledOn: '2026-11-13', detectedFilledOn: '2026-11-13' })
    expect(f._stores.pending[0]).toMatchObject({ filledOn: '2026-11-13', detectedFilledOn: '2026-11-13' })
  })

  test('a fill dated today is not after today', async () => {
    const { pending } = await ingest([{ side: 'buy', ticker: 'AAPL', shares: 3, price: '50.00', date: D }], 'FLAG-TODAY')
    expect(pending[0]).toMatchObject({ dateAfterToday: false })
  })

  test('a sell dated after today is flagged for its date only, never for a bucket', async () => {
    const { pending } = await ingest([{ ...sell, date: '2026-11-13' }], 'FLAG-FUTURE-SELL')
    expect(pending[0]).toMatchObject({ dateAfterToday: true, needsBucket: false })
  })

  test('a failing bucket hint still stores the screenshot and returns the rows unflagged', async () => {
    const { f, deps, runId } = await sellSetup(held43, book43())
    f.repos.orderRepo.listForRunFrom = async () => { throw new Error('db down') }
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const outcome = await ingestCapture(runId, { base64: 'FLAG-HINT-FAILS', mime: 'image/png' }, { ok: true, fills: [sell] }, deps)
      expect((outcome as { pending: PendingFillRow[] }).pending[0]).toMatchObject({ needsBucket: false })
      expect(f._stores.pending).toHaveLength(1)
      expect(f._stores.captureImages).toHaveLength(1)
      expect(logged).toHaveBeenCalledTimes(1)
    } finally {
      logged.mockRestore()
    }
  })

  test('mergeHint marks every buy of a capture holding two buys on one date, and not the sell', async () => {
    const buyOn = (shares: number) => ({ side: 'buy' as const, ticker: 'AAPL', shares, price: '50.00', date: '2026-11-10' })
    const { pending } = await ingest([buyOn(3), buyOn(4), sell], 'HINT-SAME-DAY')
    expect(pending.map(r => [r.side, r.mergeHint])).toEqual([['buy', true], ['buy', true], ['sell', false]])
  })

  test('mergeHint marks buys on different dates too', async () => {
    const { pending } = await ingest([
      { side: 'buy', ticker: 'AAPL', shares: 3, price: '50.00', date: '2026-11-09' },
      { side: 'buy', ticker: 'AAPL', shares: 4, price: '51.00', date: '2026-11-10' },
    ], 'HINT-DIFF-DAY')
    expect(pending.map(r => r.mergeHint)).toEqual([true, true])
  })

  test('a single buy has no mergeHint', async () => {
    const { pending } = await ingest([{ side: 'buy', ticker: 'AAPL', shares: 3, price: '50.00', date: D }], 'HINT-ONE')
    expect(pending[0]).toMatchObject({ mergeHint: false })
  })
})
