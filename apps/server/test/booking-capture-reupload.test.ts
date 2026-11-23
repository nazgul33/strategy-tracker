import { describe, test, expect } from 'bun:test'
import { emptyState } from '@st/core'
import { parseUsd } from '@st/core/money'
import type { ExtractResult, RawFill } from '@st/ingest'
import { ingestCapture, confirmPendingFill, type FillBookingDeps } from '../src/domain/booking'
import { fakeRepos, silentNotifier } from './booking-fakes'

describe('capture re-upload', () => {
  const setup = async (name: string) => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-15', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'SOXL', name, poolCents: 1_000_000, costPpm: 100 })
    return { f, deps, runId }
  }
  const img = (b64: string) => ({ base64: b64, mime: 'image/png' })
  const ext = (...fills: RawFill[]): ExtractResult => ({ ok: true, fills })
  const seedFill = async (f: any, runId: number, side: 'buy' | 'sell', shares: number, price: string, filledOn: string) => {
    await f.repos.fillRepo.insert({ runId, bucketIdx: 0, side, ticker: 'SOXL', shares, price: parseUsd(price), fee: 0, filledOn, source: 'capture' })
  }
  const trade = (side: 'buy' | 'sell', shares: number, price: string, date?: string): RawFill =>
    date === undefined ? { side, ticker: 'SOXL', shares, price } : { side, ticker: 'SOXL', shares, price, date }

  test('reupload after reject: re-reads onto the same capture row', async () => {
    const { f, deps, runId } = await setup('re1')
    const first: any = await ingestCapture(runId, img('RE1'), ext(trade('buy', 78, '58.32', '2026-11-13')), deps)
    await f.repos.pendingRepo.decide(first.pending[0].id, 'rejected')
    const again: any = await ingestCapture(runId, img('RE1'), ext(trade('buy', 78, '58.32', '2026-11-13')), deps)
    expect(again.pending.length).toBe(1)
    expect(f._stores.captures.length).toBe(1)
    expect(f._stores.captures[0].status).toBe('parsed')
    expect(f._stores.pending.map((p: any) => [p.captureId, p.status]))
      .toEqual([[f._stores.captures[0].id, 'rejected'], [f._stores.captures[0].id, 'pending']])
  })

  test('reupload: one row still pending blocks', async () => {
    const { f, deps, runId } = await setup('re2')
    const both = ext(trade('buy', 78, '58.32', '2026-11-13'), trade('buy', 10, '50.00', '2026-11-12'))
    const first: any = await ingestCapture(runId, img('RE2'), both, deps)
    expect(first.pending.length).toBe(2)
    await f.repos.pendingRepo.decide(first.pending[0].id, 'rejected')
    const again = await ingestCapture(runId, img('RE2'), both, deps)
    expect(again).toBe('duplicate')
    expect(f._stores.pending.length).toBe(2)
    expect(f._stores.captures.length).toBe(1)
  })

  test('reupload after confirm: booked fill dedups to duplicate', async () => {
    const { f, deps, runId } = await setup('re3')
    await f.repos.bucketRepo.saveState(runId, { ...emptyState(2), cashCents: 1_000_000 })
    const first: any = await ingestCapture(runId, img('RE3'), ext(trade('buy', 78, '58.32', '2026-11-13')), deps)
    await confirmPendingFill(first.pending[0].id, null, deps)
    expect(f._stores.fills.length).toBe(1)
    const again = await ingestCapture(runId, img('RE3'), ext(trade('buy', 78, '58.32', '2026-11-13')), deps)
    expect(again).toBe('duplicate')
    expect(f._stores.fills.length).toBe(1)
  })

  test('reupload after confirm with the date lost: fresh row carries bookedEarlier', async () => {
    const { f, deps, runId } = await setup('re3b')
    await f.repos.bucketRepo.saveState(runId, { ...emptyState(2), cashCents: 1_000_000 })
    const first: any = await ingestCapture(runId, img('RE3B'), ext(trade('buy', 78, '58.32', '2026-11-13')), deps)
    expect(first.bookedEarlier).toBeUndefined()
    await confirmPendingFill(first.pending[0].id, null, deps)
    const again: any = await ingestCapture(runId, img('RE3B'), ext(trade('buy', 78, '58.32')), deps)
    expect(again.pending.length).toBe(1)
    expect(again.bookedEarlier).toBe(true)
  })

  test('reupload after reject only: no bookedEarlier', async () => {
    const { f, deps, runId } = await setup('re3c')
    const first: any = await ingestCapture(runId, img('RE3C'), ext(trade('buy', 78, '58.32', '2026-11-13')), deps)
    await f.repos.pendingRepo.decide(first.pending[0].id, 'rejected')
    const again: any = await ingestCapture(runId, img('RE3C'), ext(trade('buy', 78, '58.32', '2026-11-13')), deps)
    expect(again.pending.length).toBe(1)
    expect('bookedEarlier' in again).toBe(false)
  })

  test('reupload: failed re-read', async () => {
    const { f, deps, runId } = await setup('re4')
    const first: any = await ingestCapture(runId, img('RE4'), ext(trade('buy', 78, '58.32', '2026-11-13')), deps)
    await f.repos.pendingRepo.decide(first.pending[0].id, 'rejected')
    const again = await ingestCapture(runId, img('RE4'), { ok: false, reason: 'unparseable', detail: 'x' }, deps)
    expect(again).toBe('rejected')
    expect(f._stores.captures[0].status).toBe('unparseable')
    expect(f._stores.pending.length).toBe(1)
  })

  test('reupload of an unparseable capture with a good extract', async () => {
    const { f, deps, runId } = await setup('re5')
    const first = await ingestCapture(runId, img('RE5'), { ok: false, reason: 'http', detail: 'http 500' }, deps)
    expect(first).toBe('rejected')
    expect(f._stores.captures[0].status).toBe('unparseable')
    const again: any = await ingestCapture(runId, img('RE5'), ext(trade('buy', 78, '58.32', '2026-11-13')), deps)
    expect(again.pending.length).toBe(1)
    expect(f._stores.captures.length).toBe(1)
    expect(f._stores.captures[0].status).toBe('parsed')
  })

  test('reupload: IMG_2109 after rejecting both rows', async () => {
    const { f, deps, runId } = await setup('re6')
    await seedFill(f, runId, 'buy', 88, '56.0600', '2026-11-10')
    await seedFill(f, runId, 'sell', 44, '66.03', '2026-11-11')
    await seedFill(f, runId, 'sell', 44, '65.5300', '2026-11-12')
    const shot = ext(
      trade('buy', 88, '56.06', '2026-11-10'),
      trade('sell', 44, '64.07', '2026-11-11'),
      trade('sell', 44, '65.53', '2026-11-12'),
      trade('buy', 78, '58.32', '2026-11-13'),
    )
    const first: any = await ingestCapture(runId, img('IMG_2109'), shot, deps)
    expect(first.conflicts.length).toBe(1)
    expect(first.pending.length).toBe(1)
    await f.repos.pendingRepo.decide(first.pending[0].id, 'rejected')
    // the open correction proposed from this capture keeps it live
    expect(await ingestCapture(runId, img('IMG_2109'), shot, deps)).toBe('duplicate')
    await f.repos.correctionRepo.decide(first.conflicts[0].correction.id, 'dismissed')
    const out: any = await ingestCapture(runId, img('IMG_2109'), shot, deps)
    expect(out.conflicts.length).toBe(1)
    expect(out.conflicts[0].bookedPrice).toBe('66.03')
    expect(out.conflicts[0].correction).toEqual({ id: first.conflicts[0].correction.id, status: 'dismissed' })
    expect(out.pending.length).toBe(1)
    expect(out.pending[0].shares).toBe(78)
    expect(out.pending[0].filledOn).toBe('2026-11-13')
    expect(f._stores.captures.length).toBe(1)
  })

  test('reupload: hash is per run', async () => {
    const { f, deps, runId } = await setup('re7a')
    const runB = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'SOXL', name: 're7b', poolCents: 1_000_000, costPpm: 100 })
    const a: any = await ingestCapture(runId, img('RE7'), ext(trade('buy', 78, '58.32', '2026-11-13')), deps)
    expect(a.pending.length).toBe(1)
    const b: any = await ingestCapture(runB, img('RE7'), ext(trade('buy', 78, '58.32', '2026-11-13')), deps)
    expect(b.pending.length).toBe(1)
    expect(f._stores.captures.length).toBe(2)
  })

  test('reupload: concurrent re-sends book once', async () => {
    const { f, deps, runId } = await setup('re8')
    const one = ext(trade('buy', 10, '58.32', '2026-11-15'))
    const first: any = await ingestCapture(runId, img('RE8'), one, deps)
    await f.repos.pendingRepo.decide(first.pending[0].id, 'rejected')
    const slow = (obj: any, keys: string[]) => { for (const k of keys) { const orig = obj[k]; obj[k] = (...a: any[]) => new Promise((res) => setTimeout(() => res(orig(...a)), 1)) } }
    slow(f.repos.pendingRepo, ['insert', 'listPending', 'hasLiveForCapture', 'hasConfirmedForCapture'])
    slow(f.repos.fillRepo, ['listForRun', 'insert'])
    slow(f.repos.captureRepo, ['findByHash', 'setStatus'])
    const out = await Promise.all([
      ingestCapture(runId, img('RE8'), one, deps),
      ingestCapture(runId, img('RE8'), one, deps),
    ])
    const objs = out.filter((o) => typeof o === 'object') as any[]
    expect(objs.length).toBe(1)
    expect(objs[0].pending.length).toBe(1)
    expect(out.filter((o) => o === 'duplicate').length).toBe(1)
    expect(f._stores.pending.filter((p: any) => p.status === 'pending').length).toBe(1)
    expect(f._stores.captures.length).toBe(1)
  })
})
