import { describe, test, expect } from 'bun:test'
import { emptyState, applyBuyFill } from '@st/core'
import { parseUsd } from '@st/core/money'
import type { ExtractResult } from '@st/ingest'
import {
  ingestCapture, confirmPendingFill, manualFill, rollStale, seedRun,
  type BookingDeps, type FillBookingDeps, type PendingFillRow,
} from '../src/domain/booking'
import { fakeRepos, serializeState, silentNotifier } from './booking-fakes'

describe('booking', () => {
  test('(a) duplicate capture', async () => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos, today: '2026-11-06' }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r1', poolCents: 1000, costPpm: 100, initialRunState: emptyState(2) })
    const img = { base64: 'AAAA', mime: 'image/png' }
    const ext: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker: 'AAPL', shares: 1, price: '10.00' }] }
    const first = await ingestCapture(runId, img, ext, deps)
    expect(typeof first).toBe('object')
    const second = await ingestCapture(runId, img, ext, deps)
    expect(second).toBe('duplicate')
    expect(f._stores.pending.length).toBe(1)
  })

  test('capture with extracted dates books pendings on the screenshot date', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'rd', poolCents: 100000, costPpm: 100, initialRunState: emptyState(2) })
    const ext: ExtractResult = { ok: true, fills: [
      { side: 'buy', ticker: 'AAPL', shares: 5, price: '10.00', date: '2026-11-04' },
      { side: 'buy', ticker: 'AAPL', shares: 2, price: '9.00' },
    ] }
    const out = await ingestCapture(runId, { base64: 'AAAA', mime: 'image/png' }, ext, deps) as { pending: PendingFillRow[] }
    expect(out).not.toBe('duplicate')
    expect(out.pending.map((p) => p.filledOn)).toEqual(['2026-11-04', '2026-11-06'])
    expect(f._stores.pending.map((p: any) => p.filledOn)).toEqual(['2026-11-04', '2026-11-06'])
    // and confirmation carries the pending date through to the booked fill
    await confirmPendingFill(out.pending[0]!.id, null, deps)
    expect(f._stores.fills[0]!.filledOn).toBe('2026-11-04')
  })

  test('(b) rejected', async () => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos, today: '2026-11-06' }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r2', poolCents: 1000, costPpm: 100, initialRunState: emptyState(2) })
    const img = { base64: 'BBBB', mime: 'image/png' }
    const ext: ExtractResult = { ok: false, reason: 'unparseable', detail: 'bad' }
    const res = await ingestCapture(runId, img, ext, deps)
    expect(res).toBe('rejected')
    expect(f._stores.captures.some((c) => c.status === 'unparseable')).toBe(true)
    expect(f._stores.pending.length).toBe(0)
  })

  test('(c) buy confirm', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r3', poolCents: 1000000, costPpm: 100, initialRunState: { buckets: emptyState(10).buckets, cashCents: 1000000, closed: [], ages: {} } })
    // pending buy
    const img = { base64: 'CCCC', mime: 'image/png' }
    const ext: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker: 'AAPL', shares: 55, price: '340.22' }] }
    const out = await ingestCapture(runId, img, ext, deps) as any
    const pendingId = out.pending[0].id
    // matching buy_loc order for filledOn today
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-06', kind: 'buy_loc', bucketIdx: 0, limitPrice: 100n, shares: 55, status: 'open' }])
    await confirmPendingFill(pendingId, null, deps)
    const state = await f.repos.bucketRepo.loadState(runId)
    expect(state.buckets[0].state).toBe('held')
    expect(state.buckets[0].buyPrice).toBe(3402200n)
    expect(typeof state.buckets[0].buyPrice).toBe('bigint')
    expect(state.cashCents).toBe(-871397)
    const fill = f._stores.fills[0]
    expect(fill.bucketIdx).toBe(0)
    expect(fill.ticker).toBe('AAPL')
    expect(typeof fill.price).toBe('bigint')
    const ledger = f._stores.ledger[0]
    expect(ledger.amountCents).toBe(state.cashCents - 1000000)
    const order = f._stores.orders.find((o) => o.kind === 'buy_loc')!
    expect(order.status).toBe('filled')
    // no-order case: another run no throw already covered by absence; test no-order manually
  })

  test('a late buy flips a stale buy_loc dated on its fill day', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'late-buy', poolCents: 1000000, costPpm: 100, initialRunState: { buckets: emptyState(10).buckets, cashCents: 1000000, closed: [], ages: {} } })
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-05', kind: 'buy_loc', bucketIdx: 0, limitPrice: 100n, shares: 55, status: 'stale' }])
    await manualFill(runId, { side: 'buy', shares: 55, price: '340.22', filledOn: '2026-11-05' }, deps)
    expect(f._stores.orders.find((o) => o.kind === 'buy_loc')!.status).toBe('filled')
  })

  test('(c2) no-order case no throw', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r3b', poolCents: 1000000, costPpm: 100, initialRunState: { buckets: emptyState(10).buckets, cashCents: 1000000, closed: [], ages: {} } })
    const img = { base64: 'CCCC2', mime: 'image/png' }
    const ext: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker: 'AAPL', shares: 55, price: '340.22' }] }
    const out = await ingestCapture(runId, img, ext, deps) as any
    await confirmPendingFill(out.pending[0].id, null, deps)
    const fills = f._stores.fills
    expect(fills.length).toBe(1)
    expect(fills[0].source).toBe('capture')
  })

  test('(d) sell', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
    const state = emptyState(10)
    // pre-held buckets
    let s = applyBuyFill(state, 0, 10, 100000n, 0, '2026-11-01')
    s = applyBuyFill(s, 1, 10, 200000n, 0, '2026-11-02')
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r4', poolCents: 1000000, costPpm: 100, initialRunState: { buckets: s.buckets, cashCents: s.cashCents, closed: s.closed, ages: s.ages } })
    // sell_loc order matching bucket 1
    await f.repos.orderRepo.insertMany([
      { runId, tradeDate: '2026-11-06', kind: 'sell_loc', bucketIdx: 1, limitPrice: parseUsd('2.00'), shares: 5, status: 'open' },
      { runId, tradeDate: '2026-11-06', kind: 'sell_loc', bucketIdx: 0, limitPrice: parseUsd('1.00'), shares: 10, status: 'open' },
    ])
    // pending sell partial 5 shares @ 2.00
    const img = { base64: 'DDDD', mime: 'image/png' }
    const ext: ExtractResult = { ok: true, fills: [{ side: 'sell', ticker: 'AAPL', shares: 5, price: '2.00', orderType: '매도/LOC', orderPrice: '2.00' }] }
    const out = await ingestCapture(runId, img, ext, deps) as any
    await confirmPendingFill(out.pending[0].id, { filledOn: '2026-11-06' }, deps)
    const st = await f.repos.bucketRepo.loadState(runId)
    // bucket 1 matched, partial? sold 5 of 10 -> remainder held
    expect(st.buckets[1].shares).toBe(5)
    expect(st.buckets[1].state).toBe('held')
    const order = f._stores.orders.find((o) => o.bucketIdx === 1 && o.kind === 'sell_loc')!
    expect(order.status).toBe('open')
    // full sell closes
  })

  test('(d2) full sell closes', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
    const state = emptyState(10)
    let s = applyBuyFill(state, 0, 10, 100000n, 0, '2026-11-01')
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r4b', poolCents: 1000000, costPpm: 100, initialRunState: { buckets: s.buckets, cashCents: s.cashCents, closed: s.closed, ages: s.ages } })
    const img = { base64: 'DDDD2', mime: 'image/png' }
    const ext: ExtractResult = { ok: true, fills: [{ side: 'sell', ticker: 'AAPL', shares: 10, price: '1.00' }] }
    const out = await ingestCapture(runId, img, ext, deps) as any
    await confirmPendingFill(out.pending[0].id, { filledOn: '2026-11-06', price: '1.00' }, deps)
    const st = await f.repos.bucketRepo.loadState(runId)
    expect(st.buckets[0].state).toBe('empty')
    expect(st.closed.length).toBe(1)
    expect(st.closed[0].openedOn).toBe('2026-11-01')
    expect(st.closed[0].closedOn).toBe('2026-11-06')
  })

  test('(e) late booking pin 3', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r5', poolCents: 1000000, costPpm: 100, initialRunState: emptyState(10) as any })
    // adjust cash
    const st0 = await f.repos.bucketRepo.loadState(runId)
    st0.cashCents = 1000000
    await f.repos.bucketRepo.saveState(runId, st0)
    const img = { base64: 'EEEE', mime: 'image/png' }
    const ext: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker: 'AAPL', shares: 5, price: '10.00' }] }
    const out = await ingestCapture(runId, img, ext, deps) as any
    await confirmPendingFill(out.pending[0].id, { filledOn: '2026-11-03' }, deps)
    const state = await f.repos.bucketRepo.loadState(runId)
    const heldIdx = state.buckets.findIndex((b: any) => b.state === 'held')
    expect(state.buckets[heldIdx].filledOn).toBe('2026-11-03')
    expect(state.ages[heldIdx]).toBe(3)
    const ledger = f._stores.ledger[0]
    const ref = JSON.parse(ledger.ref!)
    expect(ref.bookedOn).toBe('2026-11-06')
    expect(ref.filledOn).toBe('2026-11-03')
  })

  test('(f) rollStale', async () => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos, today: '2026-11-06' }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r6', poolCents: 1000, costPpm: 10, initialRunState: emptyState(2) })
    await f.repos.orderRepo.insertMany([
      { runId, tradeDate: '2026-11-04', kind: 'buy_loc', bucketIdx: 0, limitPrice: 100n, shares: 1, status: 'open' },
      { runId, tradeDate: '2026-11-05', kind: 'buy_loc', bucketIdx: 1, limitPrice: 100n, shares: 1, status: 'open' },
      { runId, tradeDate: '2026-11-04', kind: 'buy_loc', bucketIdx: 2, limitPrice: 100n, shares: 1, status: 'filled' },
    ])
    const before = await f.repos.bucketRepo.loadState(runId)
    const flipped = await rollStale('2026-11-05', deps)
    expect(flipped).toBe(1)
    const o4 = f._stores.orders.find((o) => o.tradeDate === '2026-11-04' && o.status !== 'filled')!
    expect(o4.status).toBe('stale')
    const o5 = f._stores.orders.find((o) => o.tradeDate === '2026-11-05')!
    expect(o5.status).toBe('open')
    const ofilled = f._stores.orders.find((o) => o.tradeDate === '2026-11-04' && o.status === 'filled')!
    expect(ofilled.status).toBe('filled')
    const after = await f.repos.bucketRepo.loadState(runId)
    expect(serializeState(after)).toBe(serializeState(before))
  })

  test('(g) seedRun', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r7', poolCents: 1000, costPpm: 100, initialRunState: emptyState(3) })
    await seedRun(runId, { cashCents: 500, buckets: [{ shares: 5, buyPrice: '10.00', filledOn: '2026-11-03' }, { shares: 3, buyPrice: '12.00', filledOn: '2026-11-04' }] }, deps)
    const state = await f.repos.bucketRepo.loadState(runId)
    expect(state.buckets[0].state).toBe('held')
    expect(state.cashCents).toBe(500)
    const idx = state.buckets.findIndex((b: any) => b.state === 'held')
    expect(state.ages[idx]).toBe(3)
    expect(f._stores.fills[0].source).toBe('seed')
    expect(f._stores.ledger[0].kind).toBe('seed')
    expect(f._stores.ledger[0].amountCents).toBeLessThan(0)
  })

  test('(g2) seedRun guards missing cash (defense in depth)', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r7b', poolCents: 1000, costPpm: 100, initialRunState: emptyState(2) })
    await expect(seedRun(runId, { cashCents: undefined as any, buckets: [] }, deps)).rejects.toThrow('invalid seed cash')
  })

  test('(h) manualFill', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r8', poolCents: 1000, costPpm: 100, initialRunState: emptyState(2) })
    const beforePending = f._stores.pending.length
    await manualFill(runId, { side: 'buy', shares: 3, price: '5.00', filledOn: '2026-11-06' }, deps)
    expect(f._stores.fills[0].source).toBe('manual')
    expect(f._stores.fills[0].ticker).toBe('AAPL')
    expect(f._stores.pending.length).toBe(beforePending)
  })

  test('manualFill ignores a stray ticker and stamps the run ticker', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r8b', poolCents: 1000, costPpm: 100, initialRunState: emptyState(2) })
    const legacy = { side: 'buy' as const, ticker: 'ZZZ', shares: 3, price: '5.00', filledOn: '2026-11-06' }
    await manualFill(runId, legacy, deps)
    expect(f._stores.fills[0].ticker).toBe('AAPL')
  })
})
