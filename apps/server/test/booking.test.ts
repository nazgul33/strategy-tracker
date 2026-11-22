import { describe, test, expect, spyOn } from 'bun:test'
import { emptyState, applyBuyFill, DomainError, type ISODate } from '@st/core'
import { parseUsd, feeCents } from '@st/core/money'
import { ageBuckets } from '@st/strategies'
import type { ExtractResult, RawFill } from '@st/ingest'
import {
  ingestCapture, confirmPendingFill, manualFill, rollStale, seedRun, sha256, cancelOrder, runBooking,
  type FillBookingDeps, type PendingFillRow, type CaptureConflict, type OrderRow,
} from '../src/domain/booking'
import { withRunLock } from '../src/domain/run-lock'
import { matchSellOrder } from '../src/domain/sell-match'
import { fakeRepos, serializeState, silentNotifier } from './booking-fakes'

type BookedConflict = Extract<CaptureConflict, { matchedKind: 'booked' }>

describe('booking', () => {
  test('(a) duplicate capture', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
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
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
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
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
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
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
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
    const order = f._stores.orders.find((o: any) => o.kind === 'buy_loc')
    expect(order.status).toBe('filled')
    // no-order case: another run no throw already covered by absence; test no-order manually
  })

  test('a late buy flips a stale buy_loc dated on its fill day', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'late-buy', poolCents: 1000000, costPpm: 100, initialRunState: { buckets: emptyState(10).buckets, cashCents: 1000000, closed: [], ages: {} } })
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-05', kind: 'buy_loc', bucketIdx: 0, limitPrice: 100n, shares: 55, status: 'stale' }])
    await manualFill(runId, { side: 'buy', shares: 55, price: '340.22', filledOn: '2026-11-05' }, deps)
    expect(f._stores.orders.find((o: any) => o.kind === 'buy_loc').status).toBe('filled')
  })

  test('(c2) no-order case no throw', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
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
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
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
    const ext: ExtractResult = { ok: true, fills: [{ side: 'sell', ticker: 'AAPL', shares: 5, price: '2.00' }] }
    const out = await ingestCapture(runId, img, ext, deps) as any
    await confirmPendingFill(out.pending[0].id, { filledOn: '2026-11-06' }, deps)
    const st = await f.repos.bucketRepo.loadState(runId)
    // bucket 1 matched, partial? sold 5 of 10 -> remainder held
    expect(st.buckets[1].shares).toBe(5)
    expect(st.buckets[1].state).toBe('held')
    const order = f._stores.orders.find((o: any) => o.bucketIdx === 1 && o.kind === 'sell_loc')
    expect(order.status).toBe('open')
    // full sell closes
  })

  test('(d2) full sell closes', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
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
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
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
    const ref = JSON.parse(ledger.ref)
    expect(ref.bookedOn).toBe('2026-11-06')
    expect(ref.filledOn).toBe('2026-11-03')
  })

  test('(f) rollStale', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r6', poolCents: 1000, costPpm: 10, initialRunState: emptyState(2) })
    await f.repos.orderRepo.insertMany([
      { runId, tradeDate: '2026-11-04', kind: 'buy_loc', bucketIdx: 0, limitPrice: 100n, shares: 1, status: 'open' },
      { runId, tradeDate: '2026-11-05', kind: 'buy_loc', bucketIdx: 1, limitPrice: 100n, shares: 1, status: 'open' },
      { runId, tradeDate: '2026-11-04', kind: 'buy_loc', bucketIdx: 2, limitPrice: 100n, shares: 1, status: 'filled' },
    ])
    const before = await f.repos.bucketRepo.loadState(runId)
    const grouped = await rollStale('2026-11-05', deps)
    expect(grouped[runId].length).toBe(1)
    const o4 = f._stores.orders.find((o: any) => o.tradeDate === '2026-11-04' && o.status !== 'filled')
    expect(o4.status).toBe('stale')
    const o5 = f._stores.orders.find((o: any) => o.tradeDate === '2026-11-05')
    expect(o5.status).toBe('open')
    const ofilled = f._stores.orders.find((o: any) => o.tradeDate === '2026-11-04' && o.status === 'filled')
    expect(ofilled.status).toBe('filled')
    const after = await f.repos.bucketRepo.loadState(runId)
    expect(serializeState(after)).toBe(serializeState(before))
  })

  test('(g) seedRun', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
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
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r7b', poolCents: 1000, costPpm: 100, initialRunState: emptyState(2) })
    await expect(seedRun(runId, { cashCents: undefined as any, buckets: [] }, deps)).rejects.toThrow('invalid seed cash')
  })

  test('(h) manualFill', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r8', poolCents: 1000, costPpm: 100, initialRunState: emptyState(2) })
    const beforePending = f._stores.pending.length
    await manualFill(runId, { side: 'buy', shares: 3, price: '5.00', filledOn: '2026-11-06' }, deps)
    expect(f._stores.fills[0].source).toBe('manual')
    expect(f._stores.fills[0].ticker).toBe('AAPL')
    expect(f._stores.pending.length).toBe(beforePending)
  })

  test('manualFill ignores a stray ticker and stamps the run ticker', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r8b', poolCents: 1000, costPpm: 100, initialRunState: emptyState(2) })
    const legacy = { side: 'buy' as const, ticker: 'ZZZ', shares: 3, price: '5.00', filledOn: '2026-11-06' }
    await manualFill(runId, legacy, deps)
    expect(f._stores.fills[0].ticker).toBe('AAPL')
  })

  test('(i) double-confirm throws and over-size sell throws', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r9', poolCents: 1000000, costPpm: 100, initialRunState: emptyState(10) as any })
    const st0 = await f.repos.bucketRepo.loadState(runId); st0.cashCents = 1000000; await f.repos.bucketRepo.saveState(runId, st0)
    const img = { base64: 'IIII', mime: 'image/png' }
    const ext: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker: 'AAPL', shares: 5, price: '10.00' }] }
    const out = await ingestCapture(runId, img, ext, deps) as any
    const pid = out.pending[0].id
    await confirmPendingFill(pid, null, deps)
    // double confirm throws
    let threw = false
    try { await confirmPendingFill(pid, null, deps) } catch { threw = true }
    expect(threw).toBe(true)
    // over-size sell throws DomainError with state unchanged
    const stateBefore = await f.repos.bucketRepo.loadState(runId)
    const img2 = { base64: 'JJJJ', mime: 'image/png' }
    const ext2: ExtractResult = { ok: true, fills: [{ side: 'sell', ticker: 'AAPL', shares: 100, price: '10.00' }] }
    const out2 = await ingestCapture(runId, img2, ext2, deps) as any
    let err: any = null
    try { await confirmPendingFill(out2.pending[0].id, { filledOn: '2026-11-06' }, deps) } catch (e) { err = e }
    expect(err).toBeInstanceOf(DomainError)
    const stateAfter = await f.repos.bucketRepo.loadState(runId)
    expect(serializeState(stateAfter)).toBe(serializeState(stateBefore))
  })

  test('race path duplicate', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'race', poolCents: 1000, costPpm: 100, initialRunState: emptyState(2) })
    const img = { base64: 'RACE', mime: 'image/png' }
    const ext: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker: 'AAPL', shares: 1, price: '1.00' }] }
    await ingestCapture(runId, img, ext, deps)
    const origInsert = f.repos.captureRepo.insert
    let calls = 0
    f.repos.captureRepo.insert = async (c: any) => {
      calls++
      if (calls === 1) return { inserted: false }
      return origInsert(c)
    }
    const img2 = { base64: 'RACE2', mime: 'image/png' }
    const res = await ingestCapture(runId, img2, ext, deps)
    expect(res).toBe('duplicate')
    f.repos.captureRepo.insert = origInsert
  })

  test('concurrent confirms on one run serialize', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'cc', poolCents: 1_000_000, costPpm: 100, initialRunState: emptyState(2) })
    const pid1 = await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 5, price: parseUsd('10.00'), fee: null, filledOn: '2026-11-06', status: 'pending' })
    const pid2 = await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 5, price: parseUsd('10.00'), fee: null, filledOn: '2026-11-06', status: 'pending' })
    let inflight = 0, maxInflight = 0
    const origLoad = f.repos.bucketRepo.loadState
    f.repos.bucketRepo.loadState = async (rid: number) => {
      inflight++
      maxInflight = Math.max(maxInflight, inflight)
      await new Promise((r) => setTimeout(r, 1))
      const s = await origLoad(rid)
      inflight--
      return s
    }
    await Promise.all([confirmPendingFill(pid1, null, deps), confirmPendingFill(pid2, null, deps)])
    f.repos.bucketRepo.loadState = origLoad
    expect(maxInflight).toBe(1)
    const idxs = f._stores.fills.map((x: any) => x.bucketIdx).sort((a: number, b: number) => a - b)
    expect(idxs).toEqual([0, 1])
    const state = await f.repos.bucketRepo.loadState(runId)
    expect(state.buckets.filter((b: any) => b.state === 'held').length).toBe(2)
  })

  test('declared fee pending used verbatim', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'fee', poolCents: 1000000, costPpm: 100, initialRunState: { buckets: emptyState(2).buckets, cashCents: 1000000, closed: [], ages: {} } })
    const pid = await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 5, price: parseUsd('10.00'), fee: 999, filledOn: '2026-11-06', status: 'pending' })
    await confirmPendingFill(pid, null, deps)
    const fill = f._stores.fills[0]
    expect(fill.fee).toBe(999)
  })

  test('confirm with ticker mismatch throws and books nothing', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'mism', poolCents: 1000000, costPpm: 100, initialRunState: { buckets: emptyState(2).buckets, cashCents: 1000000, closed: [], ages: {} } })
    const stateBefore = serializeState(await f.repos.bucketRepo.loadState(runId))
    const pid = await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'buy', ticker: 'ZZZ', shares: 5, price: parseUsd('10.00'), fee: null, filledOn: '2026-11-06', status: 'pending' })
    await expect(confirmPendingFill(pid, null, deps)).rejects.toThrow('ticker-mismatch')
    expect(f._stores.fills.length).toBe(0)
    expect(f._stores.pending[0].status).toBe('pending')
    expect(serializeState(await f.repos.bucketRepo.loadState(runId))).toBe(stateBefore)
  })

  test('fallback lowest-index multiple candidates', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
    const state = emptyState(10)
    let s = applyBuyFill(state, 0, 10, 100000n, 0, '2026-11-01')
    s = applyBuyFill(s, 1, 10, 200000n, 0, '2026-11-02')
    s = applyBuyFill(s, 2, 10, 300000n, 0, '2026-11-03')
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'fallback', poolCents: 1000000, costPpm: 100, initialRunState: { buckets: s.buckets, cashCents: s.cashCents, closed: s.closed, ages: s.ages } })
    const img = { base64: 'FB', mime: 'image/png' }
    const ext: ExtractResult = { ok: true, fills: [{ side: 'sell', ticker: 'AAPL', shares: 5, price: '5.00' }] }
    const out = await ingestCapture(runId, img, ext, deps) as any
    await confirmPendingFill(out.pending[0].id, { filledOn: '2026-11-06', price: '5.00' }, deps)
    const st = await f.repos.bucketRepo.loadState(runId)
    expect(st.buckets[0].shares).toBe(5)
  })

  test('market_sell matching', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
    const state = emptyState(10)
    let s = applyBuyFill(state, 2, 10, 100000n, 0, '2026-11-01')
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'ms', poolCents: 1000000, costPpm: 100, initialRunState: { buckets: s.buckets, cashCents: s.cashCents, closed: s.closed, ages: s.ages } })
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-06', kind: 'market_sell', bucketIdx: 2, limitPrice: 0n, shares: 10, status: 'open' }])
    const img = { base64: 'MS', mime: 'image/png' }
    const ext: ExtractResult = { ok: true, fills: [{ side: 'sell', ticker: 'AAPL', shares: 4, price: '1.00' }] }
    const out = await ingestCapture(runId, img, ext, deps) as any
    await confirmPendingFill(out.pending[0].id, { filledOn: '2026-11-06', price: '1.00' }, deps)
    const st = await f.repos.bucketRepo.loadState(runId)
    expect(st.buckets[2].shares).toBe(6)
    const order = f._stores.orders.find((o: any) => o.kind === 'market_sell')
    expect(order.status).toBe('open')
  })

  test('over-size sell with matching order stays open', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
    const state = emptyState(10)
    let s = applyBuyFill(state, 0, 5, 100000n, 0, '2026-11-01')
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'os', poolCents: 1000000, costPpm: 100, initialRunState: { buckets: s.buckets, cashCents: s.cashCents, closed: s.closed, ages: s.ages } })
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-06', kind: 'sell_loc', bucketIdx: 0, limitPrice: parseUsd('1.00'), shares: 5, status: 'open' }])
    const img = { base64: 'OS', mime: 'image/png' }
    const ext: ExtractResult = { ok: true, fills: [{ side: 'sell', ticker: 'AAPL', shares: 10, price: '1.00' }] }
    const out = await ingestCapture(runId, img, ext, deps) as any
    let err: any = null
    try { await confirmPendingFill(out.pending[0].id, { filledOn: '2026-11-06', price: '1.00' }, deps) } catch (e) { err = e }
    expect(err).toBeInstanceOf(DomainError)
    const order = f._stores.orders.find((o: any) => o.kind === 'sell_loc')
    expect(order.status).toBe('open')
  })

  test('cancelOrder marks open order cancelled with reason', async () => {
    const f = fakeRepos()
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'C1', name: 'c1', poolCents: 100, costPpm: 0 })
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-11', kind: 'sell_loc', bucketIdx: 1, limitPrice: 200n, shares: 5, status: 'open' }])
    const id = f._stores.orders[0].id
    const order = await cancelOrder(runId, id, 'strategy-change', { repos: f.repos as any, today: '2026-11-11' })
    expect(order.status).toBe('cancelled')
    expect(order.cancelReason).toBe('strategy-change')
  })

  test('cancelOrder rejects unknown, foreign-run, and non-open orders', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-11', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'C2', name: 'c2', poolCents: 100, costPpm: 0 })
    const otherRunId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'C3', name: 'c3', poolCents: 100, costPpm: 0 })
    await f.repos.orderRepo.insertMany([
      { runId: otherRunId, tradeDate: '2026-11-11', kind: 'sell_loc', bucketIdx: 1, limitPrice: 200n, shares: 5, status: 'open' },
      { runId, tradeDate: '2026-11-11', kind: 'sell_loc', bucketIdx: 1, limitPrice: 200n, shares: 5, status: 'filled' },
    ])
    const foreignId = f._stores.orders[0].id
    const filledId = f._stores.orders[1].id
    await expect(cancelOrder(runId, 99999, 'other', deps)).rejects.toThrow('order-not-found')
    await expect(cancelOrder(runId, foreignId, 'other', deps)).rejects.toThrow('order-not-found')
    await expect(cancelOrder(runId, filledId, 'other', deps)).rejects.toThrow('order-not-open')
    // stored rows untouched
    expect(f._stores.orders[0].status).toBe('open')
    expect(f._stores.orders[1].status).toBe('filled')
    expect(f._stores.orders[1].cancelReason).toBeUndefined()
  })

  test('cancelOrder rejects unknown reason', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-11', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'C4', name: 'c4', poolCents: 100, costPpm: 0 })
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-11', kind: 'sell_loc', bucketIdx: 1, limitPrice: 200n, shares: 5, status: 'open' }])
    const id = f._stores.orders[0].id
    // reason is validated before any DB touch
    let getCalls = 0
    const origGet = f.repos.orderRepo.get
    f.repos.orderRepo.get = async (gid: number) => { getCalls++; return origGet(gid) }
    await expect(cancelOrder(runId, id, 'because-i-said-so', deps)).rejects.toThrow('invalid-reason')
    expect(getCalls).toBe(0)
    f.repos.orderRepo.get = origGet
    const stored = f._stores.orders[0]
    expect(stored.status).toBe('open')
    expect(stored.cancelReason).toBeUndefined()
  })
})

describe('buy bucket selection', () => {
  test('manual buy after a closed cycle skips the closed bucket', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'next1', poolCents: 1000000, costPpm: 100, initialRunState: emptyState(3) })
    // Full cycle in bucket 0: buy then full-size sell (fallback matching) closes it.
    await manualFill(runId, { side: 'buy', shares: 5, price: '5.00', filledOn: '2026-11-02' }, deps)
    await manualFill(runId, { side: 'sell', shares: 5, price: '6.00', filledOn: '2026-11-03' }, deps)
    let state = await f.repos.bucketRepo.loadState(runId)
    expect(state.buckets[0].state).toBe('empty')
    expect(state.closed.length).toBe(1)
    // Next buy must skip closed bucket 0 and take the fresh slot 1.
    await manualFill(runId, { side: 'buy', shares: 5, price: '5.00', filledOn: '2026-11-04' }, deps)
    state = await f.repos.bucketRepo.loadState(runId)
    expect(state.buckets[1].state).toBe('held')
    expect(state.buckets[0].state).toBe('empty')
    expect(state.closed.length).toBe(1)
  })

  test('manual buy reuses lowest closed bucket when all buckets closed', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'next2', poolCents: 1000000, costPpm: 100, initialRunState: emptyState(2) })
    // Close both buckets: 0, then the never-used 1 (new allocation order).
    await manualFill(runId, { side: 'buy', shares: 5, price: '5.00', filledOn: '2026-11-02' }, deps)
    await manualFill(runId, { side: 'sell', shares: 5, price: '6.00', filledOn: '2026-11-03' }, deps)
    await manualFill(runId, { side: 'buy', shares: 5, price: '5.00', filledOn: '2026-11-03' }, deps)
    await manualFill(runId, { side: 'sell', shares: 5, price: '6.00', filledOn: '2026-11-04' }, deps)
    let state = await f.repos.bucketRepo.loadState(runId)
    expect(state.closed.map((c: any) => c.index).sort((a: number, b: number) => a - b)).toEqual([0, 1])
    // No never-used empty left: reuse the lowest closed index, 0.
    await manualFill(runId, { side: 'buy', shares: 5, price: '5.00', filledOn: '2026-11-05' }, deps)
    state = await f.repos.bucketRepo.loadState(runId)
    expect(state.buckets[0].state).toBe('held')
    expect(f._stores.fills[f._stores.fills.length - 1]!.bucketIdx).toBe(0)
  })

  test('seedRun fills 0,1 in order', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'next3', poolCents: 1000000, costPpm: 100, initialRunState: emptyState(2) })
    await seedRun(runId, { cashCents: 500, buckets: [{ shares: 5, buyPrice: '10.00', filledOn: '2026-11-03' }, { shares: 3, buyPrice: '12.00', filledOn: '2026-11-04' }] }, deps)
    const idxs = f._stores.fills.filter((x: any) => x.runId === runId).map((x: any) => x.bucketIdx)
    expect(idxs).toEqual([0, 1])
  })
})

describe('capture dedup against booked fills and pending rows', () => {
  const setup = async (name: string) => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-15', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'SOXL', name, poolCents: 1_000_000, costPpm: 100 })
    return { f, deps, runId }
  }
  const img = (b64: string) => ({ base64: b64, mime: 'image/png' })
  const ext = (...fills: RawFill[]): ExtractResult => ({ ok: true, fills })
  const seedFill = async (f: any, runId: number, side: 'buy' | 'sell', shares: number, price: string, filledOn: string) => {
    await f.repos.fillRepo.insert({ runId, bucketIdx: 0, side, ticker: 'SOXL', shares, price: parseUsd(price), fee: 0, filledOn, source: 'capture' })
  }
  const seedPending = async (f: any, runId: number, side: 'buy' | 'sell', shares: number, price: string, filledOn: string) => {
    await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side, ticker: 'SOXL', shares, price: parseUsd(price), fee: null, filledOn, status: 'pending' })
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

describe('capture re-upload', () => {
  const setup = async (name: string) => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-15', notify: silentNotifier }
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

describe('capture corrections', () => {
  const setup = async (name: string) => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: '2026-11-15', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'SOXL', name, poolCents: 1_000_000, costPpm: 100 })
    return { f, deps, runId }
  }
  const img = (b64: string) => ({ base64: b64, mime: 'image/png' })
  const ext = (...fills: RawFill[]): ExtractResult => ({ ok: true, fills })
  const seedFill = async (f: any, runId: number, side: 'buy' | 'sell', shares: number, price: string, filledOn: string) => {
    await f.repos.fillRepo.insert({ runId, bucketIdx: 0, side, ticker: 'SOXL', shares, price: parseUsd(price), fee: 0, filledOn, source: 'capture' })
  }
  const seedPending = async (f: any, runId: number, side: 'buy' | 'sell', shares: number, price: string, filledOn: string) => {
    await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side, ticker: 'SOXL', shares, price: parseUsd(price), fee: null, filledOn, status: 'pending' })
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

describe('withRunLock', () => {
  test('serializes by key and survives rejections', async () => {
    const log: string[] = []
    const slow = (s: string, ms: number) => withRunLock(1, async () => { log.push(s + 's'); await new Promise((r) => setTimeout(r, ms)); log.push(s + 'e') })
    const a = slow('a', 5)
    const b = withRunLock(1, async () => { throw new Error('boom') })
    const c = slow('c', 1)
    await Promise.allSettled([a, b, c])
    expect(log).toEqual(['as', 'ae', 'cs', 'ce'])
    await expect(b).rejects.toThrow('boom')
  })

  test('does not serialize across keys', async () => {
    let active = 0, max = 0
    const j = (id: number) => withRunLock(id, async () => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 2)); active-- })
    await Promise.all([j(1), j(2)])
    expect(max).toBe(2)
  })
})

describe('sell matching with target and stop legs', () => {
  const D: ISODate = '2026-11-12'
  type Held = { idx: number; shares: number; buy: string }
  type Ord = { idx: number; kind: 'sell_loc' | 'stop_sell' | 'market_sell'; price: string; status?: string; shares?: number; runId?: number; tradeDate?: string }

  async function setup(held: Held[], ords: Ord[]) {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: D, notify: silentNotifier }
    let s = emptyState(10)
    for (const h of held) s = applyBuyFill(s, h.idx, h.shares, parseUsd(h.buy), 0, '2026-11-01')
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'stops', poolCents: 1000000, costPpm: 0, initialRunState: { buckets: s.buckets, cashCents: s.cashCents, closed: s.closed, ages: s.ages } })
    await f.repos.orderRepo.insertMany(ords.map((o) => ({
      runId: o.runId ?? runId, tradeDate: o.tradeDate ?? D, kind: o.kind, bucketIdx: o.idx,
      limitPrice: o.kind === 'market_sell' ? 0n : parseUsd(o.price), shares: o.shares ?? 10, status: o.status ?? 'open',
    })))
    return { f, deps, runId }
  }
  const sell = (runId: number, shares: number, price: string, deps: FillBookingDeps) =>
    manualFill(runId, { side: 'sell', shares, price, filledOn: D }, deps)
  const order = (f: ReturnType<typeof fakeRepos>, idx: number, kind: string) =>
    f._stores.orders.find((o: any) => o.bucketIdx === idx && o.kind === kind)
  const lastFill = (f: ReturnType<typeof fakeRepos>) => f._stores.fills[f._stores.fills.length - 1]
  const bookInput = (runId: number, shares: number, priceStr: string) =>
    ({ runId, side: 'sell' as const, shares, priceStr, feeCents: null, filledOn: D, pendingId: null, source: 'manual' as const })
  const pair: Ord[] = [{ idx: 1, kind: 'sell_loc', price: '103.00' }, { idx: 1, kind: 'stop_sell', price: '97.00' }]
  const held1: Held[] = [{ idx: 1, shares: 10, buy: '100.00' }]

  test('exact target match still wins', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 1, shares: 10, buy: '90.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
        { idx: 1, kind: 'sell_loc', price: '92.00' }, { idx: 1, kind: 'stop_sell', price: '87.00' },
      ],
    )
    await sell(runId, 10, '103.00', deps)
    expect(lastFill(f).bucketIdx).toBe(0)
    expect(order(f, 0, 'sell_loc').status).toBe('filled')
    expect(order(f, 1, 'sell_loc').status).toBe('open')
  })

  test('an exact target match with impossible shares fails loudly instead of landing elsewhere', async () => {
    // Bucket 0 holds 10 but its target prints 103.00 for 15 shares: the only honest
    // answer is a 422 the operator resolves, never a silent booking into bucket 1
    // (whose 92.00 target also qualifies at 103.00) plus a cancel of bucket 1's legs.
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 1, shares: 15, buy: '90.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
        { idx: 1, kind: 'sell_loc', price: '92.00' }, { idx: 1, kind: 'stop_sell', price: '87.00' },
      ],
    )
    await expect(runBooking(bookInput(runId, 15, '103.00'), deps)).rejects.toMatchObject({ kind: 'too-many-shares' })
    expect(f._stores.fills).toHaveLength(0)
    expect(f._stores.orders.every((o: any) => o.status === 'open')).toBe(true)
    const st = await f.repos.bucketRepo.loadState(runId)
    expect(st.buckets.map((b: any) => b.shares)).toEqual([10, 15, ...Array(8).fill(0)])
  })

  test('a target fill above its limit books to the nearest leg, not a loose stop', async () => {
    // bucket 0: buy 100.00, stop trigger 97.00; bucket 9: buy 90.00, target limit 91.00. 91.50 is also <= 97.00.
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 9, shares: 10, buy: '90.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
        { idx: 9, kind: 'sell_loc', price: '91.00' }, { idx: 9, kind: 'stop_sell', price: '87.00' },
      ],
    )
    await sell(runId, 10, '91.50', deps)
    expect(lastFill(f).bucketIdx).toBe(9)
    expect(order(f, 9, 'sell_loc').status).toBe('filled')
    expect(order(f, 0, 'stop_sell').status).toBe('open')
    expect(order(f, 0, 'sell_loc').status).toBe('open')
  })

  test('with several targets at or below the fill price, the highest limit wins', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '80.00' }, { idx: 1, shares: 10, buy: '90.00' }, { idx: 2, shares: 10, buy: '95.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '82.00' },
        { idx: 1, kind: 'sell_loc', price: '92.00' },
        { idx: 2, kind: 'sell_loc', price: '97.00' },
      ],
    )
    await sell(runId, 10, '93.00', deps)
    expect(lastFill(f).bucketIdx).toBe(1)
  })

  test('a fill that no bucket target reaches matches no target', async () => {
    // 94.00 is below bucket 1's 103.00 target limit, so it is not a target fill; it is at or under the 95.00 stop trigger, so the stop takes it.
    const { f, deps, runId } = await setup(
      [{ idx: 1, shares: 10, buy: '100.00' }],
      [{ idx: 1, kind: 'sell_loc', price: '103.00' }, { idx: 1, kind: 'stop_sell', price: '95.00' }],
    )
    await sell(runId, 10, '94.00', deps)
    expect(order(f, 1, 'stop_sell').status).toBe('filled')
    expect(order(f, 1, 'sell_loc').status).toBe('cancelled')
  })

  test('a stop fill books to the closest trigger at or above it', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 3, shares: 10, buy: '96.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
        { idx: 3, kind: 'sell_loc', price: '99.00' }, { idx: 3, kind: 'stop_sell', price: '93.00' },
      ],
    )
    await sell(runId, 10, '92.50', deps)
    expect(lastFill(f).bucketIdx).toBe(3)
    expect(order(f, 3, 'stop_sell').status).toBe('filled')
    expect(order(f, 0, 'stop_sell').status).toBe('open')
  })

  test('identical triggers resolve to the lowest bucket index', async () => {
    // Inserted high bucket first so insertion order cannot be what decides it.
    const { f, deps, runId } = await setup(
      [{ idx: 2, shares: 10, buy: '100.00' }, { idx: 5, shares: 10, buy: '100.00' }, { idx: 7, shares: 10, buy: '100.00' }],
      [
        { idx: 7, kind: 'stop_sell', price: '97.00' },
        { idx: 5, kind: 'stop_sell', price: '97.00' },
        { idx: 2, kind: 'stop_sell', price: '97.00' },
      ],
    )
    await sell(runId, 10, '96.00', deps)
    expect(lastFill(f).bucketIdx).toBe(2)
    expect(order(f, 2, 'stop_sell').status).toBe('filled')
    expect(order(f, 5, 'stop_sell').status).toBe('open')
  })

  test('identical target limits resolve to the lowest bucket index', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 4, shares: 10, buy: '90.00' }, { idx: 6, shares: 10, buy: '90.00' }],
      [{ idx: 6, kind: 'sell_loc', price: '92.00' }, { idx: 4, kind: 'sell_loc', price: '92.00' }],
    )
    await sell(runId, 10, '92.50', deps)
    expect(lastFill(f).bucketIdx).toBe(4)
  })

  test('a stale stop dated on the fill day matches like an open one', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 3, shares: 10, buy: '96.00' }],
      [{ idx: 3, kind: 'stop_sell', price: '93.00', status: 'stale' }],
    )
    await sell(runId, 10, '92.50', deps)
    expect(lastFill(f).bucketIdx).toBe(3)
    expect(order(f, 3, 'stop_sell').status).toBe('filled')
  })

  test('orders of another run or another trade date never match', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 3, shares: 10, buy: '96.00' }],
      [
        { idx: 3, kind: 'stop_sell', price: '93.00', runId: 999 },
        { idx: 3, kind: 'sell_loc', price: '92.00', tradeDate: '2026-11-11' },
      ],
    )
    await sell(runId, 10, '92.50', deps)
    expect(lastFill(f).bucketIdx).toBe(0)
    expect(f._stores.orders.every((o: any) => o.status === 'open')).toBe(true)
  })

  test('a candidate whose bucket holds fewer shares than the fill is skipped', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 1, shares: 5, buy: '100.00' }, { idx: 2, shares: 10, buy: '100.00' }],
      [{ idx: 1, kind: 'stop_sell', price: '97.00', shares: 5 }, { idx: 2, kind: 'stop_sell', price: '97.00' }],
    )
    await sell(runId, 10, '96.00', deps)
    expect(lastFill(f).bucketIdx).toBe(2)
  })

  test('market_sell still matches at any price', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 2, shares: 10, buy: '100.00' }],
      [{ idx: 2, kind: 'market_sell', price: '0' }],
    )
    await sell(runId, 10, '50.00', deps)
    expect(lastFill(f).bucketIdx).toBe(2)
    expect(order(f, 2, 'market_sell').status).toBe('filled')
  })

  test('a target nearer the fill outranks a looser stop', async () => {
    // Bucket 0's stop trigger (105.00) is looser than bucket 1's target (92.00); a 93.00 fill must be read as the target.
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '110.00' }, { idx: 1, shares: 10, buy: '90.00' }],
      [{ idx: 0, kind: 'stop_sell', price: '105.00' }, { idx: 1, kind: 'sell_loc', price: '92.00' }],
    )
    await sell(runId, 10, '93.00', deps)
    expect(lastFill(f).bucketIdx).toBe(1)
  })

  test('a bucket-emptying stop fill cancels the sibling sell_loc', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }],
      [{ idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' }],
    )
    const { cancelledIds } = await runBooking(bookInput(runId, 10, '96.50'), deps)
    const sibling = order(f, 0, 'sell_loc')
    expect(sibling.status).toBe('cancelled')
    expect(sibling.cancelReason).toBe('broker-filled')
    expect(cancelledIds).toEqual([sibling.id])
    expect(order(f, 0, 'stop_sell').status).toBe('filled')
    expect(order(f, 0, 'stop_sell').cancelReason).toBeUndefined()
  })

  test('a bucket-emptying target fill cancels the sibling stop_sell', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }],
      [{ idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' }],
    )
    const { cancelledIds } = await runBooking(bookInput(runId, 10, '103.00'), deps)
    const sibling = order(f, 0, 'stop_sell')
    expect(sibling.status).toBe('cancelled')
    expect(sibling.cancelReason).toBe('broker-filled')
    expect(cancelledIds).toEqual([sibling.id])
    expect(order(f, 0, 'sell_loc').status).toBe('filled')
  })

  test('a bucket-emptying market_sell fill cancels nothing when no other leg is open', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }],
      [{ idx: 0, kind: 'market_sell', price: '0' }],
    )
    const { cancelledIds } = await runBooking(bookInput(runId, 10, '99.00'), deps)
    expect(cancelledIds).toEqual([])
    expect(order(f, 0, 'market_sell').status).toBe('filled')
  })

  test('the sibling cancel only touches the filled bucket, its own trade date and open orders', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 1, shares: 10, buy: '100.00' }],
      [
        { idx: 0, kind: 'stop_sell', price: '97.00' },
        { idx: 0, kind: 'sell_loc', price: '103.00', status: 'stale', tradeDate: '2026-11-11' },
        // Same bucket, same trade date, but already filled: not open, so left alone.
        { idx: 0, kind: 'sell_loc', price: '103.00', status: 'filled' },
        { idx: 1, kind: 'sell_loc', price: '103.00' },
        { idx: 1, kind: 'stop_sell', price: '97.00' },
      ],
    )
    expect((await runBooking(bookInput(runId, 10, '96.00'), deps)).cancelledIds).toEqual([])
    expect(f._stores.orders.filter((o: any) => o.status === 'cancelled')).toEqual([])
    const filledLeg = f._stores.orders.find((o: any) => o.bucketIdx === 0 && o.kind === 'sell_loc' && o.tradeDate === D)
    expect(filledLeg.status).toBe('filled')
    expect(filledLeg.cancelReason).toBeUndefined()
    expect(order(f, 1, 'sell_loc').status).toBe('open')
    expect(order(f, 1, 'stop_sell').status).toBe('open')
  })

  test('a partial stop fill cancels nothing and leaves its own order open', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }],
      [{ idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' }],
    )
    const { cancelledIds } = await runBooking(bookInput(runId, 4, '96.50'), deps)
    expect(cancelledIds).toEqual([])
    const sibling = order(f, 0, 'sell_loc')
    expect(sibling.status).toBe('open')
    expect(sibling.cancelReason).toBeUndefined()
    expect(order(f, 0, 'stop_sell').status).toBe('open')
    const st = await f.repos.bucketRepo.loadState(runId)
    expect(st.buckets[0]!.shares).toBe(6)
    expect(st.buckets[0]!.state).toBe('held')
  })

  test('a sell between every trigger and every limit reaches the old fallback', async () => {
    // Buckets 4 and 6 carry live pairs (97/103); 100.00 is neither <= a trigger nor >= a limit.
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 4, shares: 10, buy: '100.00' }, { idx: 6, shares: 10, buy: '100.00' }],
      [
        { idx: 4, kind: 'sell_loc', price: '103.00' }, { idx: 4, kind: 'stop_sell', price: '97.00' },
        { idx: 6, kind: 'sell_loc', price: '103.00' }, { idx: 6, kind: 'stop_sell', price: '97.00' },
      ],
    )
    const { cancelledIds } = await runBooking(bookInput(runId, 10, '100.00'), deps)
    expect(lastFill(f).bucketIdx).toBe(0)
    expect(cancelledIds).toEqual([])
    expect(f._stores.orders.every((o: any) => o.status === 'open')).toBe(true)
  })

  test('a fallback fill that empties its bucket cancels every open sell leg of that bucket', async () => {
    // 100.00 sits in the gap (97 < 100 < 103): nothing matches, the guess lands on bucket 0 and empties it.
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 4, shares: 10, buy: '100.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
        { idx: 4, kind: 'sell_loc', price: '103.00' }, { idx: 4, kind: 'stop_sell', price: '97.00' },
      ],
    )
    const { cancelledIds } = await runBooking(bookInput(runId, 10, '100.00'), deps)
    expect(lastFill(f).bucketIdx).toBe(0)
    const legs = [order(f, 0, 'sell_loc'), order(f, 0, 'stop_sell')]
    expect(cancelledIds).toEqual(legs.map((o: any) => o.id))
    for (const o of legs) { expect(o.status).toBe('cancelled'); expect(o.cancelReason).toBe('broker-filled') }
    expect(order(f, 4, 'sell_loc').status).toBe('open')
    expect(order(f, 4, 'stop_sell').status).toBe('open')
  })

  test('a partial fallback fill cancels nothing', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }],
      [{ idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' }],
    )
    expect((await runBooking(bookInput(runId, 4, '100.00'), deps)).cancelledIds).toEqual([])
    expect(f._stores.orders.map((o: any) => o.status)).toEqual(['open', 'open'])
  })

  test('a matched fill that empties its bucket also cancels every other open leg, not just one', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }],
      [
        { idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' },
        { idx: 0, kind: 'market_sell', price: '0' },
      ],
    )
    const { cancelledIds } = await runBooking(bookInput(runId, 10, '103.00'), deps)
    expect(order(f, 0, 'sell_loc').status).toBe('filled')
    expect(cancelledIds).toEqual([order(f, 0, 'stop_sell').id, order(f, 0, 'market_sell').id])
    expect(f._stores.orders.filter((o: any) => o.status === 'cancelled').length).toBe(2)
  })

  test('a failed fill insert cancels nothing and leaves the matched order open', async () => {
    const { f, deps, runId } = await setup(
      [{ idx: 0, shares: 10, buy: '100.00' }],
      [{ idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' }],
    )
    f.repos.fillRepo.insert = async () => { throw new Error('db-exploded') }
    await expect(sell(runId, 10, '96.50', deps)).rejects.toThrow('db-exploded')
    expect(f._stores.orders.map((o: any) => o.status)).toEqual(['open', 'open'])
  })

  test('a sell reads only the orders from its fill date onwards', async () => {
    const { f, deps, runId } = await setup(held1, [...pair, { idx: 1, kind: 'sell_loc', price: '103.00', tradeDate: '2026-11-11' }])
    const calls: [number, string][] = []
    const returned: any[] = []
    const orderRepo = f.repos.orderRepo
    f.repos.orderRepo = {
      ...orderRepo,
      listForRun: async () => { throw new Error('unbounded-read') },
      listForRunFrom: async (id: number, fromDate: string) => { calls.push([id, fromDate]); const rows = await orderRepo.listForRunFrom(id, fromDate); returned.push(...rows); return rows },
    }
    await sell(runId, 10, '96.50', deps)
    expect(calls).toEqual([[runId, D]])
    expect(returned.length).toBeGreaterThan(0)
    expect(returned.every((o: any) => o.tradeDate >= D)).toBe(true)
    expect(f._stores.orders.find((o: any) => o.tradeDate === '2026-11-11')!.status).toBe('open')
    expect(lastFill(f).bucketIdx).toBe(1)
  })

  describe('notifying the operator of the cancelled leg', () => {
    type Notified = { runId: number; order: OrderRow }
    const withNotifier = (deps: FillBookingDeps, notified: Notified[]): FillBookingDeps => ({
      ...deps,
      notify: { ...silentNotifier, siblingCancelled: async (runId, order) => { notified.push({ runId, order: { ...order } }) } },
    })

    test('a bucket-emptying stop fill notifies once, naming the pulled leg', async () => {
      const { f, deps, runId } = await setup(held1, pair)
      const notified: Notified[] = []
      await manualFill(runId, { side: 'sell', shares: 10, price: '96.50', filledOn: D }, withNotifier(deps, notified))
      expect(notified).toHaveLength(1)
      expect(notified[0]!.runId).toBe(runId)
      expect(notified[0]!.order).toMatchObject({ id: order(f, 1, 'sell_loc').id, kind: 'sell_loc', bucketIdx: 1, limitPrice: parseUsd('103.00') })
    })

    test('every cancelled leg gets its own notification, lowest id first', async () => {
      const { f, deps, runId } = await setup(held1, [...pair, { idx: 1, kind: 'market_sell', price: '0' }])
      const notified: Notified[] = []
      await runBooking(bookInput(runId, 10, '103.00'), withNotifier(deps, notified))
      expect(notified.map((n) => n.order.kind)).toEqual(['stop_sell', 'market_sell'])
      expect(notified.map((n) => n.order.id)).toEqual([order(f, 1, 'stop_sell').id, order(f, 1, 'market_sell').id])
    })

    // A screenshot of yesterday's fills, confirmed today after the morning re-plan:
    // today's legs are live at the broker against shares the operator no longer holds.
    test('a prior-day fill that empties the bucket also pulls and announces today legs', async () => {
      const yesterday: ISODate = '2026-11-11'
      const { f, deps, runId } = await setup(
        [{ idx: 1, shares: 10, buy: '100.00' }, { idx: 2, shares: 10, buy: '100.00' }],
        [
          { idx: 1, kind: 'sell_loc', price: '103.00', tradeDate: yesterday },
          { idx: 1, kind: 'stop_sell', price: '97.00', tradeDate: yesterday },
          { idx: 1, kind: 'sell_loc', price: '103.00' },
          { idx: 1, kind: 'stop_sell', price: '97.00' },
          { idx: 2, kind: 'sell_loc', price: '103.00' },
          { idx: 2, kind: 'stop_sell', price: '97.00' },
        ],
      )
      const notified: Notified[] = []
      const legs = (idx: number, tradeDate: string) => f._stores.orders.filter((o: any) => o.bucketIdx === idx && o.tradeDate === tradeDate)
      const matched = legs(1, yesterday).find((o: any) => o.kind === 'stop_sell')
      const { cancelledIds: cancelled } = await runBooking(
        { ...bookInput(runId, 10, '96.50'), filledOn: yesterday },
        withNotifier(deps, notified),
      )
      expect(matched.status).toBe('filled')
      const expectedIds = [...legs(1, yesterday).filter((o: any) => o.id !== matched.id), ...legs(1, D)].map((o: any) => o.id)
      expect(cancelled).toEqual(expectedIds)
      for (const o of [...legs(1, yesterday), ...legs(1, D)]) {
        if (o.id !== matched.id) expect(o).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
      }
      expect(notified.map((n) => n.order.id)).toEqual(expectedIds)
      expect(legs(2, D).every((o: any) => o.status === 'open')).toBe(true)
    })

    test('a partial fill notifies nobody', async () => {
      const { deps, runId } = await setup(held1, pair)
      const notified: Notified[] = []
      await manualFill(runId, { side: 'sell', shares: 4, price: '96.50', filledOn: D }, withNotifier(deps, notified))
      expect(notified).toHaveLength(0)
    })

    test('a buy, and an emptying sell with no other open leg, notify nobody', async () => {
      const { deps, runId } = await setup(held1, [{ idx: 1, kind: 'market_sell', price: '0' }])
      const notified: Notified[] = []
      const d = withNotifier(deps, notified)
      await manualFill(runId, { side: 'buy', shares: 5, price: '50.00', filledOn: D }, d)
      await manualFill(runId, { side: 'sell', shares: 10, price: '99.00', filledOn: D }, d)
      expect(notified).toHaveLength(0)
    })

    test('confirming a pending sell notifies too', async () => {
      const { f, deps, runId } = await setup(held1, pair)
      const notified: Notified[] = []
      const pid = await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'sell', ticker: 'AAPL', shares: 10, price: parseUsd('96.50'), fee: null, filledOn: D, status: 'pending' })
      await confirmPendingFill(pid, null, withNotifier(deps, notified))
      expect(notified).toHaveLength(1)
      expect(notified[0]!.order).toMatchObject({ kind: 'sell_loc', bucketIdx: 1 })
      expect(notified[0]!.runId).toBe(runId)
    })

    test('the notifier runs after the run lock is released', async () => {
      const { deps, runId } = await setup(held1, pair)
      let seen = 'never called'
      // withRunLock is not reentrant: a probe queued from inside the lock can only wait, so it loses the race.
      const d: FillBookingDeps = {
        ...deps,
        notify: {
          ...silentNotifier,
          siblingCancelled: async (rid) => {
            seen = await Promise.race([withRunLock(rid, async () => 'free'), new Promise<string>((r) => setTimeout(() => r('held'), 100))])
          },
        },
      }
      await manualFill(runId, { side: 'sell', shares: 10, price: '96.50', filledOn: D }, d)
      expect(seen).toBe('free')
    })

    test('a failing notifier never fails the booking: fill, ledger row and cancel are all persisted', async () => {
      const { f, deps, runId } = await setup(held1, pair)
      const errors = spyOn(console, 'error').mockImplementation(() => {})
      try {
        const d: FillBookingDeps = { ...deps, notify: { ...silentNotifier, siblingCancelled: async () => { throw new Error('telegram-down') } } }
        const { cancelledIds: cancelled } = await runBooking(bookInput(runId, 10, '96.50'), d)
        expect(f._stores.fills).toHaveLength(1)
        expect(f._stores.fills[0]).toMatchObject({ runId, bucketIdx: 1, side: 'sell', shares: 10 })
        expect(f._stores.ledger).toHaveLength(1)
        expect(f._stores.ledger[0].kind).toBe('sell')
        expect(order(f, 1, 'sell_loc')).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
        expect(order(f, 1, 'stop_sell').status).toBe('filled')
        expect((await f.repos.bucketRepo.loadState(runId)).buckets[1]!.state).toBe('empty')
        expect(cancelled).toEqual([order(f, 1, 'sell_loc').id])
        expect(errors).toHaveBeenCalledTimes(1)
      } finally { errors.mockRestore() }
    })

    test('a notifier that throws synchronously is swallowed too', async () => {
      const { f, deps, runId } = await setup(held1, pair)
      const errors = spyOn(console, 'error').mockImplementation(() => {})
      try {
        const d: FillBookingDeps = { ...deps, notify: { ...silentNotifier, siblingCancelled: () => { throw new Error('boom') } } }
        await expect(manualFill(runId, { side: 'sell', shares: 10, price: '96.50', filledOn: D }, d)).resolves.toBeUndefined()
        expect(f._stores.fills).toHaveLength(1)
      } finally { errors.mockRestore() }
    })

    test('a failing notification does not stop the next cancelled leg from being notified', async () => {
      const { f, deps, runId } = await setup(held1, [...pair, { idx: 1, kind: 'market_sell', price: '0' }])
      const errors = spyOn(console, 'error').mockImplementation(() => {})
      try {
        const attempts: number[] = []
        const d: FillBookingDeps = {
          ...deps,
          notify: { ...silentNotifier, siblingCancelled: async (_rid, o) => { attempts.push(o.id); if (attempts.length === 1) throw new Error('flaky') } },
        }
        await runBooking(bookInput(runId, 10, '103.00'), d)
        expect(attempts).toEqual([order(f, 1, 'stop_sell').id, order(f, 1, 'market_sell').id])
        expect(errors).toHaveBeenCalledTimes(1)
      } finally { errors.mockRestore() }
    })

    test('a booking that throws notifies nobody', async () => {
      const { f, deps, runId } = await setup(held1, pair)
      const notified: Notified[] = []
      f.repos.fillRepo.insert = async () => { throw new Error('db-exploded') }
      await expect(manualFill(runId, { side: 'sell', shares: 10, price: '96.50', filledOn: D }, withNotifier(deps, notified))).rejects.toThrow('db-exploded')
      expect(notified).toHaveLength(0)
    })
  })
})

describe('matchSellOrder', () => {
  const state = (() => {
    let s = emptyState(4)
    s = applyBuyFill(s, 1, 10, parseUsd('100.00'), 0, '2026-11-01')
    return s
  })()
  const o = (over: Partial<OrderRow>): OrderRow => ({ id: 1, runId: 1, tradeDate: '2026-11-12', kind: 'sell_loc', bucketIdx: 1, limitPrice: parseUsd('103.00'), shares: 10, status: 'open', ...over })
  const input = { runId: 1, filledOn: '2026-11-12' as ISODate, shares: 10, price: parseUsd('103.00') }

  test('returns null for an empty bucket, a wrong run, a wrong date and a filled or cancelled status', () => {
    // 100.00 is under the 103.00 fill price, so this is a price-distance candidate and the gate applies.
    expect(matchSellOrder([o({ bucketIdx: 0, limitPrice: parseUsd('100.00') })], state, input)).toBeNull()
    expect(matchSellOrder([o({ runId: 2 })], state, input)).toBeNull()
    expect(matchSellOrder([o({ tradeDate: '2026-11-11' })], state, input)).toBeNull()
    expect(matchSellOrder([o({ status: 'filled' })], state, input)).toBeNull()
    expect(matchSellOrder([o({ status: 'cancelled' })], state, input)).toBeNull()
  })

  test('returns a stale order dated on the fill day, never a filled or cancelled one', () => {
    expect(matchSellOrder([o({ status: 'stale' })], state, input)?.order.id).toBe(1)
    expect(matchSellOrder([o({ status: 'filled' })], state, input)).toBeNull()
    expect(matchSellOrder([o({ status: 'cancelled' })], state, input)).toBeNull()
  })

  test('returns the order on the happy path and ignores buy_loc', () => {
    expect(matchSellOrder([o({ kind: 'buy_loc' })], state, input)).toBeNull()
    expect(matchSellOrder([o({})], state, input)?.order.id).toBe(1)
  })

  // The exact-price rung alone ignores the shares/emptiness gate: the booking must fail loudly
  // rather than attribute an exact-price print to some other bucket.
  test('an exact-price target is returned even when its bucket cannot cover the fill', () => {
    expect(matchSellOrder([o({ bucketIdx: 0 })], state, input)?.order.bucketIdx).toBe(0)
    expect(matchSellOrder([o({ bucketIdx: 0, status: 'stale' })], state, input)).toBeNull()
    expect(matchSellOrder([o({})], state, { ...input, shares: 99 })?.order.id).toBe(1)
    // the gate still applies to every other rung
    expect(matchSellOrder([o({ kind: 'stop_sell', limitPrice: parseUsd('110.00') })], state, { ...input, shares: 99 })).toBeNull()
  })
})

describe('confirmPendingFill side and fee overrides', () => {
  const D: ISODate = '2026-11-12'

  async function setup(held: Array<{ idx: number; shares: number; buy: string }>, pend: { side?: 'buy' | 'sell'; shares?: number; price?: string; fee?: number | null } = {}, costPpm = 100) {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos as any, today: D, notify: silentNotifier }
    let s = emptyState(10)
    for (const h of held) s = applyBuyFill(s, h.idx, h.shares, parseUsd(h.buy), 0, '2026-11-01')
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'ov', poolCents: 1_000_000, costPpm, initialRunState: { buckets: s.buckets, cashCents: s.cashCents, closed: s.closed, ages: s.ages } })
    const pid = await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: pend.side ?? 'buy', ticker: 'AAPL', shares: pend.shares ?? 10, price: parseUsd(pend.price ?? '10.00'), fee: pend.fee ?? null, filledOn: D, status: 'pending' })
    return { f, deps, runId, pid }
  }

  test('confirming with side: "sell" books a sell against a held bucket', async () => {
    const { f, deps, runId, pid } = await setup([{ idx: 0, shares: 10, buy: '10.00' }])
    await confirmPendingFill(pid, { side: 'sell' }, deps)
    expect(f._stores.fills).toHaveLength(1)
    expect(f._stores.fills[0]).toMatchObject({ side: 'sell', bucketIdx: 0, shares: 10 })
    expect((await f.repos.bucketRepo.loadState(runId)).buckets[0]!.state).toBe('empty')
    expect(f._stores.ledger[0]!.kind).toBe('sell')
  })

  test('a side override to sell with no held bucket throws no-bucket-for-sell and leaves the row pending', async () => {
    const { f, deps, pid } = await setup([])
    await expect(confirmPendingFill(pid, { side: 'sell' }, deps)).rejects.toMatchObject({ kind: 'no-bucket-for-sell' })
    expect(f._stores.pending[0]!.status).toBe('pending')
    expect(f._stores.pending[0]!.side).toBe('buy')
    expect(f._stores.fills).toHaveLength(0)
  })

  test('a sell override that empties a bucket still cancels and notifies the sibling order', async () => {
    const { f, deps, runId, pid } = await setup([{ idx: 1, shares: 10, buy: '100.00' }], { price: '96.50' })
    await f.repos.orderRepo.insertMany([
      { runId, tradeDate: D, kind: 'sell_loc', bucketIdx: 1, limitPrice: parseUsd('103.00'), shares: 10, status: 'open' },
      { runId, tradeDate: D, kind: 'stop_sell', bucketIdx: 1, limitPrice: parseUsd('97.00'), shares: 10, status: 'open' },
    ])
    const notified: Array<{ runId: number; order: OrderRow }> = []
    const d: FillBookingDeps = { ...deps, notify: { ...silentNotifier, siblingCancelled: async (rid, o) => { notified.push({ runId: rid, order: { ...o } }) } } }
    await confirmPendingFill(pid, { side: 'sell' }, d)
    const target = f._stores.orders.find((o: any) => o.kind === 'sell_loc')
    expect(f._stores.orders.find((o: any) => o.kind === 'stop_sell').status).toBe('filled')
    expect(target).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(notified.map((n) => n.order.id)).toEqual([target.id])
    expect(notified[0]!.runId).toBe(runId)
  })

  test('side joins the edited patch written to the pending row on confirm', async () => {
    const { f, deps, pid } = await setup([{ idx: 0, shares: 10, buy: '10.00' }])
    await confirmPendingFill(pid, { side: 'sell' }, deps)
    expect(f._stores.pending[0]).toMatchObject({ status: 'confirmed', side: 'sell' })
  })

  test('no side override keeps the pending side', async () => {
    const { f, deps, pid } = await setup([], { side: 'buy' })
    await confirmPendingFill(pid, { shares: 4 }, deps)
    expect(f._stores.fills[0]).toMatchObject({ side: 'buy', shares: 4 })
    expect(f._stores.pending[0]!.side).toBe('buy')
  })

  test('feeCents: null recomputes the fee from the run cost ppm', async () => {
    const { f, deps, pid } = await setup([], { fee: 999, shares: 5 }, 2500)
    await confirmPendingFill(pid, { price: '20.00', feeCents: null }, deps)
    const expected = feeCents(parseUsd('20.00'), 5, 2500)
    expect(expected).not.toBe(999)
    expect(f._stores.fills[0]!.fee).toBe(expected)
    expect(f._stores.pending[0]!.fee).toBe(expected)
  })

  test('feeCents: 0 books a zero fee', async () => {
    const { f, deps, pid } = await setup([], { fee: 999 }, 2500)
    await confirmPendingFill(pid, { feeCents: 0 }, deps)
    expect(f._stores.fills[0]!.fee).toBe(0)
  })

  test('feeCents: a positive integer overrides the pending fee', async () => {
    const { f, deps, pid } = await setup([], { fee: 999 })
    await confirmPendingFill(pid, { feeCents: 17 }, deps)
    expect(f._stores.fills[0]!.fee).toBe(17)
  })

  test('an invalid side override throws invalid-side and books nothing', async () => {
    for (const side of ['SELL', '', 'hold', 1, null]) {
      const { f, deps, pid } = await setup([{ idx: 0, shares: 10, buy: '10.00' }])
      await expect(confirmPendingFill(pid, { side: side as any }, deps)).rejects.toThrow('invalid-side')
      expect(f._stores.fills).toHaveLength(0)
      expect(f._stores.pending[0]!.status).toBe('pending')
    }
  })

  test('an invalid fee override throws invalid-fee and books nothing', async () => {
    for (const fee of [-1, 1.5, NaN, '5', Infinity]) {
      const { f, deps, pid } = await setup([])
      await expect(confirmPendingFill(pid, { feeCents: fee as any }, deps)).rejects.toThrow('invalid-fee')
      expect(f._stores.fills).toHaveLength(0)
      expect(f._stores.pending[0]!.status).toBe('pending')
    }
  })
})
