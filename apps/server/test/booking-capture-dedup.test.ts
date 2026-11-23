import { describe, test, expect } from 'bun:test'
import { parseUsd } from '@st/core/money'
import type { ExtractResult, RawFill } from '@st/ingest'
import { ingestCapture, type BookingDeps, type CaptureConflict } from '../src/domain/booking'
import { fakeRepos, NO_SNAPSHOT } from './booking-fakes'

type BookedConflict = Extract<CaptureConflict, { matchedKind: 'booked' }>

describe('capture dedup against booked fills and pending rows', () => {
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
  const trade = (side: 'buy' | 'sell', shares: number, price: string, date?: string): RawFill =>
    date === undefined ? { side, ticker: 'SOXL', shares, price } : { side, ticker: 'SOXL', shares, price, date }

  test('fully overlapping range -> duplicate', async () => {
    const { f, deps, runId } = await setup('dedup1')
    await seedFill(f, runId, 'buy', 88, '56.0600', '2026-11-10')
    await seedFill(f, runId, 'sell', 44, '64.0700', '2026-11-11')
    const out = await ingestCapture(runId, img('DEDUP1'), ext(
      trade('buy', 88, '56.06', '2026-11-10'),
      trade('sell', 44, '64.07', '2026-11-11'),
    ), deps)
    expect(out).toBe('duplicate')
    expect(f._stores.pending.length).toBe(0)
    expect(f._stores.captures.some((c: any) => c.status === 'parsed')).toBe(true)
  })

  test('partial overlap keeps only the new trade', async () => {
    const { f, deps, runId } = await setup('dedup2')
    await seedFill(f, runId, 'buy', 88, '56.0600', '2026-11-10')
    const out = await ingestCapture(runId, img('DEDUP2'), ext(
      trade('buy', 88, '56.06', '2026-11-10'),
      trade('buy', 78, '58.32', '2026-11-13'),
    ), deps) as any
    expect(out.pending.length).toBe(1)
    expect(out.pending[0].shares).toBe(78)
    expect(out.pending[0].filledOn).toBe('2026-11-13')
  })

  test('still-pending rows suppress a repeat capture', async () => {
    const { f, deps, runId } = await setup('dedup3')
    const first = await ingestCapture(runId, img('DEDUP3A'), ext(trade('buy', 88, '56.06', '2026-11-10')), deps) as any
    expect(first.pending.length).toBe(1)
    const second = await ingestCapture(runId, img('DEDUP3B'), ext(trade('buy', 88, '56.06', '2026-11-10')), deps)
    expect(second).toBe('duplicate')
    expect(f._stores.pending.length).toBe(1)
  })

  test('price spelling: extracted 58.32 matches booked 58.3200', async () => {
    const { f, deps, runId } = await setup('dedup4')
    await seedFill(f, runId, 'buy', 78, '58.3200', '2026-11-13')
    const out = await ingestCapture(runId, img('DEDUP4'), ext(trade('buy', 78, '58.32', '2026-11-13')), deps)
    expect(out).toBe('duplicate')
    expect(f._stores.pending.length).toBe(0)
  })

  test('multiset: booked trade repeated twice in one image leaves one pending', async () => {
    const { f, deps, runId } = await setup('dedup5')
    await seedFill(f, runId, 'buy', 88, '56.0600', '2026-11-10')
    const out = await ingestCapture(runId, img('DEDUP5'), ext(
      trade('buy', 88, '56.06', '2026-11-10'),
      trade('buy', 88, '56.06', '2026-11-10'),
    ), deps) as any
    expect(out.pending.length).toBe(1)
    expect(f._stores.pending.length).toBe(1)
  })

  test('near-misses are not deduped', async () => {
    const { f, deps, runId } = await setup('dedup6')
    await seedFill(f, runId, 'buy', 88, '56.0600', '2026-11-10')
    const out = await ingestCapture(runId, img('DEDUP6'), ext(
      trade('buy', 88, '56.06', '2026-11-10'),
      trade('sell', 88, '56.06', '2026-11-10'),
      trade('buy', 89, '56.06', '2026-11-10'),
      trade('buy', 88, '56.07', '2026-11-10'),
      trade('buy', 88, '56.06', '2026-11-11'),
      trade('buy', 88, '56.06'),
    ), deps) as any
    expect(out.pending.length).toBe(5)
  })

  test('concurrent identical captures serialize: second returns duplicate', async () => {
    const { f, deps, runId } = await setup('race1')
    const slow = (obj: any, keys: string[]) => { for (const k of keys) { const orig = obj[k]; obj[k] = (...a: any[]) => new Promise((res) => setTimeout(() => res(orig(...a)), 1)) } }
    slow(f.repos.pendingRepo, ['insert', 'listPending'])
    slow(f.repos.fillRepo, ['listForRun', 'insert'])
    const out = await Promise.all([
      ingestCapture(runId, img('RACE-A'), ext(trade('buy', 10, '58.32', '2026-11-15')), deps),
      ingestCapture(runId, img('RACE-B'), ext(trade('buy', 10, '58.32', '2026-11-15')), deps),
    ])
    expect(out[0]).not.toBe('duplicate')   // distinct hashes: both pass the hash check
    expect(out[1]).toBe('duplicate')       // second sees the first's pending row
    expect(f._stores.pending.length).toBe(1)
  })

  test('conflict: price-only diff vs a booked fill books nothing and cites the booked fill', async () => {
    const { f, deps, runId } = await setup('cap-c1')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    const out = await ingestCapture(runId, img('CONF-1'),
      ext({ side: 'sell', ticker: 'SOXL', shares: 44, price: '64.07', date: '2026-11-11' }), deps)
    const conflicts = (out as { conflicts: CaptureConflict[] }).conflicts
    expect(conflicts.length).toBe(1)
    expect(conflicts[0]).toEqual({
      side: 'sell', ticker: 'SOXL', shares: 44, extractedPrice: '64.07', filledOn: '2026-11-11',
      matchedKind: 'booked', bookedId: f._stores.fills[0]!.id, bookedPrice: '66.03',
      extractedFee: null, correction: { id: f._stores.corrections[0]!.id, status: 'open' },
    })
    expect(f._stores.pending.length).toBe(0)
  })

  test('conflict: price-only diff vs a pending row cites the pending row', async () => {
    const { f, deps, runId } = await setup('cap-c2')
    await seedPending(f, runId, 'buy', 78, '58.32', '2026-11-13')
    const out = await ingestCapture(runId, img('CONF-2'),
      ext({ side: 'buy', ticker: 'SOXL', shares: 78, price: '58.99', date: '2026-11-13' }), deps)
    const conflicts = (out as { conflicts: CaptureConflict[] }).conflicts
    expect(conflicts[0]).toEqual({
      side: 'buy', ticker: 'SOXL', shares: 78, extractedPrice: '58.99', filledOn: '2026-11-13',
      matchedKind: 'pending', pendingId: f._stores.pending[0]!.id, pendingPrice: '58.32',
      extractedFee: null,
    })
    expect(f._stores.pending.length).toBe(1)
  })

  test('all-conflict capture is NOT reported as duplicate and stores no pending rows', async () => {
    const { f, deps, runId } = await setup('cap-c3')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    const out = await ingestCapture(runId, img('CONF-3'),
      ext({ side: 'sell', ticker: 'SOXL', shares: 44, price: '64.07', date: '2026-11-11' }), deps)
    expect(typeof out).toBe('object')
    expect((out as { pending?: unknown }).pending).toBeUndefined()
    expect((out as { conflicts: unknown[] }).conflicts.length).toBe(1)
    expect(f._stores.pending.length).toBe(0)
    expect(f._stores.captures.some((c: { status: string }) => c.status === 'parsed')).toBe(true)
  })

  test('different trade date is a different trade: fresh pending row, no conflict', async () => {
    const { f, deps, runId } = await setup('cap-c4')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    const out = await ingestCapture(runId, img('CONF-4'),
      ext({ side: 'sell', ticker: 'SOXL', shares: 44, price: '66.03', date: '2026-11-12' }), deps)
    expect((out as { pending: unknown[] }).pending.length).toBe(1)
    expect((out as { conflicts?: unknown[] }).conflicts).toBeUndefined()
  })

  test('order independence: an exact pending match is consumed before a loose booked match steals it (silent duplicate)', async () => {
    const { f, deps, runId } = await setup('cap-c5')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11') // loose twin, wrong price
    await seedPending(f, runId, 'sell', 44, '64.07', '2026-11-11') // exact twin
    const out = await ingestCapture(runId, img('CONF-5'),
      ext({ side: 'sell', ticker: 'SOXL', shares: 44, price: '64.07', date: '2026-11-11' }), deps)
    expect(out).toBe('duplicate')
    expect(f._stores.pending.length).toBe(1)
  })

  test('mixed capture: exact-duplicate + conflict + fresh returns pending rows and conflicts together', async () => {
    const { f, deps, runId } = await setup('cap-c6')
    await seedPending(f, runId, 'buy', 10, '50.00', '2026-11-11') // exact dup below
    await seedFill(f, runId, 'sell', 20, '70.00', '2026-11-12') // loose twin below
    const out = await ingestCapture(runId, img('CONF-6'), ext(
      { side: 'buy', ticker: 'SOXL', shares: 10, price: '50.00', date: '2026-11-11' },
      { side: 'sell', ticker: 'SOXL', shares: 20, price: '69.10', date: '2026-11-12' },
      { side: 'buy', ticker: 'SOXL', shares: 30, price: '40.00', date: '2026-11-13' },
    ), deps)
    const o = out as { pending: { shares: number }[]; conflicts: CaptureConflict[] }
    expect(o.pending.length).toBe(1)
    expect(o.pending[0]!.shares).toBe(30)
    expect(o.conflicts.length).toBe(1)
    expect(o.conflicts[0]).toMatchObject({ matchedKind: 'booked', bookedPrice: '70.00' })
    expect(f._stores.pending.length).toBe(2) // original + the fresh row only
  })

  test('two loose twins of ONE booked fill: the first conflicts, the second is fresh (one loose entry, consumed once)', async () => {
    const { f, deps, runId } = await setup('cap-c7')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    const out = await ingestCapture(runId, img('CONF-7'), ext(
      { side: 'sell', ticker: 'SOXL', shares: 44, price: '64.07', date: '2026-11-11' },
      { side: 'sell', ticker: 'SOXL', shares: 44, price: '63.00', date: '2026-11-11' },
    ), deps) as { pending: { shares: number; price: string }[]; conflicts: CaptureConflict[] }
    expect(out.conflicts.length).toBe(1)
    expect(out.conflicts[0]).toMatchObject({ matchedKind: 'booked', extractedPrice: '64.07', bookedPrice: '66.03' })
    expect(out.pending.length).toBe(1)
    expect(out.pending[0]).toMatchObject({ shares: 44, price: '63.00' })
    expect(f._stores.pending.length).toBe(1)
  })

  test('two loose entries under one key are consumed in order, each by one extracted fill; the surplus is fresh', async () => {
    const { f, deps, runId } = await setup('cap-c8')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    await seedFill(f, runId, 'sell', 44, '65.00', '2026-11-11')
    const out = await ingestCapture(runId, img('CONF-8'), ext(
      { side: 'sell', ticker: 'SOXL', shares: 44, price: '64.07', date: '2026-11-11' },
      { side: 'sell', ticker: 'SOXL', shares: 44, price: '63.00', date: '2026-11-11' },
      { side: 'sell', ticker: 'SOXL', shares: 44, price: '62.00', date: '2026-11-11' },
    ), deps) as { pending: { price: string }[]; conflicts: BookedConflict[] }
    expect(out.conflicts.map((c) => [c.bookedId, c.bookedPrice, c.extractedPrice])).toEqual([
      [f._stores.fills[0]!.id, '66.03', '64.07'],
      [f._stores.fills[1]!.id, '65.00', '63.00'],
    ])
    expect(out.pending.map((p) => p.price)).toEqual(['62.00'])
  })

  test('booked and pending loose twins under one key: booked is cited first, pending second', async () => {
    const { f, deps, runId } = await setup('cap-c9')
    await seedPending(f, runId, 'sell', 44, '65.00', '2026-11-11')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    const out = await ingestCapture(runId, img('CONF-9'), ext(
      { side: 'sell', ticker: 'SOXL', shares: 44, price: '64.07', date: '2026-11-11' },
      { side: 'sell', ticker: 'SOXL', shares: 44, price: '63.00', date: '2026-11-11' },
    ), deps) as { conflicts: CaptureConflict[] }
    expect(out.conflicts.map((c) => c.matchedKind)).toEqual(['booked', 'pending'])
    expect(out.conflicts[1]).toMatchObject({ pendingId: f._stores.pending[0]!.id, pendingPrice: '65.00', extractedPrice: '63.00' })
  })
})
