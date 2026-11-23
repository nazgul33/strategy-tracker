import { describe, test, expect } from 'bun:test'
import { parseUsd } from '@st/core/money'
import type { ExtractResult, RawFill } from '@st/ingest'
import { ingestCapture, type BookingDeps, type CaptureConflict } from '../src/domain/booking'
import { fakeRepos, NO_SNAPSHOT } from './booking-fakes'

type BookedConflict = Extract<CaptureConflict, { matchedKind: 'booked' }>

describe('capture corrections', () => {
  const setup = async (name: string) => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos, today: '2026-11-15' }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'SOXL', name, poolCents: 1_000_000, costPpm: 100 })
    return { f, deps, runId }
  }
  const img = (b64: string) => ({ base64: b64, mime: 'image/png' })
  const ext = (...fills: RawFill[]): ExtractResult => ({ ok: true, fills })
  const seedFill = async (f: any, runId: number, side: 'buy' | 'sell', shares: number, price: string, filledOn: string) => {
    await f.repos.fillRepo.insert({ runId, bucketIdx: 0, side, ticker: 'SOXL', shares, price: parseUsd(price), fee: 0, filledOn, source: 'capture' })
  }
  const seedPending = async (f: any, runId: number, side: 'buy' | 'sell', shares: number, price: string, filledOn: string) => {
    await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side, ticker: 'SOXL', shares, price: parseUsd(price), fee: null, filledOn, status: 'pending', ...NO_SNAPSHOT })
  }
  const corrId = (c: BookedConflict): number => {
    if (c.correction?.id == null) throw new Error('conflict has no correction id')
    return c.correction.id
  }
  const sell44 = (price: string, fee?: string): RawFill =>
    fee === undefined
      ? { side: 'sell', ticker: 'SOXL', shares: 44, price, date: '2026-11-11' }
      : { side: 'sell', ticker: 'SOXL', shares: 44, price, fee, date: '2026-11-11' }

  test('booked-fill conflict creates one open correction with a full snapshot', async () => {
    const { f, deps, runId } = await setup('corr1')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    const out = await ingestCapture(runId, img('CORR-1'), ext(sell44('64.07', '2.03')), deps) as { conflicts: BookedConflict[] }
    expect(f._stores.corrections.length).toBe(1)
    const row = f._stores.corrections[0]!
    expect(row).toMatchObject({
      runId, fillId: f._stores.fills[0]!.id, side: 'sell', ticker: 'SOXL', bookedShares: 44, bookedFilledOn: '2026-11-11',
      bookedPrice: parseUsd('66.03'), bookedFee: 0, proposedPrice: parseUsd('64.07'), proposedFee: 203,
      captureId: f._stores.captures[0]!.id, status: 'open',
    })
    expect(out.conflicts[0]!.correction).toEqual({ id: row.id, status: 'open' })
    expect(out.conflicts[0]!.extractedFee).toBe('2.03')
  })

  test('a second screenshot with the same conflict reuses the open correction', async () => {
    const { f, deps, runId } = await setup('corr2')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    const a = await ingestCapture(runId, img('CORR-2A'), ext(sell44('64.07')), deps) as { conflicts: BookedConflict[] }
    const b = await ingestCapture(runId, img('CORR-2B'), ext(sell44('64.07')), deps) as { conflicts: BookedConflict[] }
    expect(f._stores.corrections.length).toBe(1)
    expect(b.conflicts[0]!.correction).toEqual({ id: corrId(a.conflicts[0]!), status: 'open' })
  })

  test('dismissed correction is never re-proposed for the same price', async () => {
    const { f, deps, runId } = await setup('corr3')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    const a = await ingestCapture(runId, img('CORR-3A'), ext(sell44('64.07')), deps) as { conflicts: BookedConflict[] }
    const id = corrId(a.conflicts[0]!)
    expect(await f.repos.correctionRepo.decide(id, 'dismissed')).toBe(true)
    const b = await ingestCapture(runId, img('CORR-3B'), ext(sell44('64.07')), deps) as { conflicts: BookedConflict[] }
    expect(f._stores.corrections.length).toBe(1)
    expect(b.conflicts[0]!.correction).toEqual({ id, status: 'dismissed' })
  })

  test('a different price after dismiss creates a new correction', async () => {
    const { f, deps, runId } = await setup('corr4')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    const a = await ingestCapture(runId, img('CORR-4A'), ext(sell44('64.07')), deps) as { conflicts: BookedConflict[] }
    const firstId = corrId(a.conflicts[0]!)
    await f.repos.correctionRepo.decide(firstId, 'dismissed')
    const b = await ingestCapture(runId, img('CORR-4B'), ext(sell44('64.70')), deps) as { conflicts: BookedConflict[] }
    expect(f._stores.corrections.length).toBe(2)
    const createdId = corrId(b.conflicts[0]!)
    expect(createdId).not.toBe(firstId)
    expect(b.conflicts[0]!.correction!.status).toBe('open')
    expect(f._stores.corrections.find((c) => c.id === createdId)!.proposedPrice).toBe(parseUsd('64.70'))
  })

  test('a stale open correction is not reused', async () => {
    const { f, deps, runId } = await setup('corr10')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    const a = await ingestCapture(runId, img('CORR-10A'), ext(sell44('64.07')), deps) as { conflicts: BookedConflict[] }
    const firstId = corrId(a.conflicts[0]!)
    await f.repos.fillRepo.update(runId, f._stores.fills[0]!.id, { price: parseUsd('64.70') })
    const b = await ingestCapture(runId, img('CORR-10B'), ext(sell44('64.07')), deps) as { conflicts: BookedConflict[] }
    expect(f._stores.corrections.length).toBe(2)
    const createdId = corrId(b.conflicts[0]!)
    expect(createdId).not.toBe(firstId)
    expect(b.conflicts[0]!.correction!.status).toBe('open')
    expect(f._stores.corrections.find((c) => c.id === createdId)).toMatchObject({ bookedPrice: parseUsd('64.70'), proposedPrice: parseUsd('64.07'), status: 'open' })
  })

  test('a dismissal stops applying after the fill is hand-edited', async () => {
    const { f, deps, runId } = await setup('corr11')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    const a = await ingestCapture(runId, img('CORR-11A'), ext(sell44('64.07')), deps) as { conflicts: BookedConflict[] }
    const firstId = corrId(a.conflicts[0]!)
    expect(await f.repos.correctionRepo.decide(firstId, 'dismissed')).toBe(true)
    await f.repos.fillRepo.update(runId, f._stores.fills[0]!.id, { price: parseUsd('64.70') })
    const b = await ingestCapture(runId, img('CORR-11B'), ext(sell44('64.07')), deps) as { conflicts: BookedConflict[] }
    expect(f._stores.corrections.length).toBe(2)
    expect(corrId(b.conflicts[0]!)).not.toBe(firstId)
    expect(b.conflicts[0]!.correction!.status).toBe('open')
  })

  test('a fresh open correction wins over a stale dismissed one for the same fill and price', async () => {
    const { f, deps, runId } = await setup('corr12')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    const a = await ingestCapture(runId, img('CORR-12A'), ext(sell44('64.07')), deps) as { conflicts: BookedConflict[] }
    await f.repos.correctionRepo.decide(corrId(a.conflicts[0]!), 'dismissed')
    await f.repos.fillRepo.update(runId, f._stores.fills[0]!.id, { price: parseUsd('64.70') })
    const b = await ingestCapture(runId, img('CORR-12B'), ext(sell44('64.07')), deps) as { conflicts: BookedConflict[] }
    const c = await ingestCapture(runId, img('CORR-12C'), ext(sell44('64.07')), deps) as { conflicts: BookedConflict[] }
    expect(f._stores.corrections.length).toBe(2)
    expect(c.conflicts[0]!.correction).toEqual(b.conflicts[0]!.correction)
  })

  test('a fresh open correction wins over a fresh dismissed one', async () => {
    const { f, deps, runId } = await setup('corr14')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    const fill = f._stores.fills[0]!
    const snapshot = {
      runId, fillId: fill.id, captureId: null, side: 'sell' as const, ticker: 'SOXL', bookedShares: 44,
      bookedFilledOn: '2026-11-11', bookedPrice: parseUsd('66.03'), bookedFee: 0, proposedPrice: parseUsd('64.07'), proposedFee: null,
    }
    const dismissedId = await f.repos.correctionRepo.insert(snapshot)
    expect(await f.repos.correctionRepo.decide(dismissedId, 'dismissed')).toBe(true)
    const openId = await f.repos.correctionRepo.insert(snapshot)
    const out = await ingestCapture(runId, img('CORR-14'), ext(sell44('64.07')), deps) as { conflicts: BookedConflict[] }
    expect(out.conflicts[0]!.correction).toEqual({ id: openId, status: 'open' })
    expect(corrId(out.conflicts[0]!)).not.toBe(dismissedId)
    expect(f._stores.corrections.length).toBe(2)
  })

  test('an applied correction does not suppress a new one', async () => {
    const { f, deps, runId } = await setup('corr5')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    const a = await ingestCapture(runId, img('CORR-5A'), ext(sell44('64.07')), deps) as { conflicts: BookedConflict[] }
    const firstId = corrId(a.conflicts[0]!)
    await f.repos.correctionRepo.decide(firstId, 'applied')
    const b = await ingestCapture(runId, img('CORR-5B'), ext(sell44('64.07')), deps) as { conflicts: BookedConflict[] }
    expect(f._stores.corrections.length).toBe(2)
    expect(corrId(b.conflicts[0]!)).not.toBe(firstId)
    expect(b.conflicts[0]!.correction!.status).toBe('open')
  })

  test('pending-row conflict creates no correction', async () => {
    const { f, deps, runId } = await setup('corr6')
    await seedPending(f, runId, 'buy', 78, '58.32', '2026-11-13')
    const out = await ingestCapture(runId, img('CORR-6'),
      ext({ side: 'buy', ticker: 'SOXL', shares: 78, price: '58.99', date: '2026-11-13' }), deps) as { conflicts: CaptureConflict[] }
    expect(f._stores.corrections.length).toBe(0)
    expect(out.conflicts[0]!.matchedKind).toBe('pending')
    expect('correction' in out.conflicts[0]!).toBe(false)
  })

  test('a conflict whose booked fill vanished reports fill-gone and records nothing', async () => {
    const { f, deps, runId } = await setup('corr13')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    // The matcher reads the list first; every later read (the recorder's) sees the fill gone.
    const real = f.repos.fillRepo.listForRun.bind(f.repos.fillRepo)
    let calls = 0
    f.repos.fillRepo.listForRun = async (id: number) => (calls++ === 0 ? real(id) : [])
    const out = await ingestCapture(runId, img('CORR-13'), ext(sell44('64.07')), deps) as { conflicts: BookedConflict[] }
    expect(out.conflicts[0]!.correction).toEqual({ id: null, status: 'fill-gone' })
    expect(f._stores.corrections.length).toBe(0)
  })

  test('fee-only difference creates no correction', async () => {
    const { f, deps, runId } = await setup('corr7')
    await seedFill(f, runId, 'sell', 44, '64.07', '2026-11-11')
    const out = await ingestCapture(runId, img('CORR-7'), ext(sell44('64.07', '2.03')), deps)
    expect(out).toBe('duplicate')
    expect(f._stores.corrections.length).toBe(0)
  })

  test('two conflicts create two corrections', async () => {
    const { f, deps, runId } = await setup('corr8')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    await seedFill(f, runId, 'buy', 88, '56.60', '2026-11-10')
    const out = await ingestCapture(runId, img('CORR-8'), ext(
      sell44('64.07'),
      { side: 'buy', ticker: 'SOXL', shares: 88, price: '56.06', date: '2026-11-10' },
    ), deps) as { conflicts: BookedConflict[] }
    expect(out.conflicts.length).toBe(2)
    expect(f._stores.corrections.length).toBe(2)
    const [sellFill, buyFill] = f._stores.fills
    expect(f._stores.corrections.map((c) => [c.fillId, c.status])).toEqual([[sellFill!.id, 'open'], [buyFill!.id, 'open']])
    expect(out.conflicts.map((c) => c.correction!.status)).toEqual(['open', 'open'])
  })

  test('same image re-sent while its correction is open is a duplicate; after dismiss it is re-read', async () => {
    const { f, deps, runId } = await setup('corr9')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    const a = await ingestCapture(runId, img('CORR-9'), ext(sell44('64.07')), deps) as { conflicts: BookedConflict[] }
    const id = corrId(a.conflicts[0]!)
    expect(await ingestCapture(runId, img('CORR-9'), ext(sell44('64.07')), deps)).toBe('duplicate')
    await f.repos.correctionRepo.decide(id, 'dismissed')
    const again = await ingestCapture(runId, img('CORR-9'), ext(sell44('64.07')), deps) as { conflicts: BookedConflict[] }
    expect(again.conflicts[0]!.correction).toEqual({ id, status: 'dismissed' })
    expect(f._stores.corrections.length).toBe(1)
    expect(f._stores.captures.length).toBe(1)
  })
})
