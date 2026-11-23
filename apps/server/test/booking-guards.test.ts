import { describe, test, expect } from 'bun:test'
import { emptyState, applyBuyFill, DomainError } from '@st/core'
import { parseUsd } from '@st/core/money'
import type { ExtractResult } from '@st/ingest'
import {
  ingestCapture, confirmPendingFill, manualFill, seedRun, cancelOrder,
  type BookingDeps, type FillBookingDeps,
} from '../src/domain/booking'
import { withRunLock } from '../src/domain/run-lock'
import { fakeRepos, serializeState, silentNotifier, NO_SNAPSHOT } from './booking-fakes'

describe('booking', () => {
  test('(i) double-confirm throws and over-size sell throws', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
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
    const deps: BookingDeps = { repos: f.repos, today: '2026-11-06' }
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
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'cc', poolCents: 1_000_000, costPpm: 100, initialRunState: emptyState(2) })
    const pid1 = await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 5, price: parseUsd('10.00'), fee: null, filledOn: '2026-11-06', status: 'pending', ...NO_SNAPSHOT })
    const pid2 = await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 5, price: parseUsd('10.00'), fee: null, filledOn: '2026-11-06', status: 'pending', ...NO_SNAPSHOT })
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
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'fee', poolCents: 1000000, costPpm: 100, initialRunState: { buckets: emptyState(2).buckets, cashCents: 1000000, closed: [], ages: {} } })
    const pid = await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 5, price: parseUsd('10.00'), fee: 999, filledOn: '2026-11-06', status: 'pending', ...NO_SNAPSHOT })
    await confirmPendingFill(pid, null, deps)
    const fill = f._stores.fills[0]
    expect(fill.fee).toBe(999)
  })

  test('confirm with ticker mismatch throws and books nothing', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'mism', poolCents: 1000000, costPpm: 100, initialRunState: { buckets: emptyState(2).buckets, cashCents: 1000000, closed: [], ages: {} } })
    const stateBefore = serializeState(await f.repos.bucketRepo.loadState(runId))
    const pid = await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'buy', ticker: 'ZZZ', shares: 5, price: parseUsd('10.00'), fee: null, filledOn: '2026-11-06', status: 'pending', ...NO_SNAPSHOT })
    await expect(confirmPendingFill(pid, null, deps)).rejects.toThrow('ticker-mismatch')
    expect(f._stores.fills.length).toBe(0)
    expect(f._stores.pending[0].status).toBe('pending')
    expect(serializeState(await f.repos.bucketRepo.loadState(runId))).toBe(stateBefore)
  })

  test('fallback lowest-index multiple candidates', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
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
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
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
    const order = f._stores.orders.find((o) => o.kind === 'market_sell')!
    expect(order.status).toBe('open')
  })

  test('over-size sell with matching order stays open', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
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
    const order = f._stores.orders.find((o) => o.kind === 'sell_loc')!
    expect(order.status).toBe('open')
  })

  test('cancelOrder marks open order cancelled with reason', async () => {
    const f = fakeRepos()
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'C1', name: 'c1', poolCents: 100, costPpm: 0 })
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-11-11', kind: 'sell_loc', bucketIdx: 1, limitPrice: 200n, shares: 5, status: 'open' }])
    const id = f._stores.orders[0].id
    const order = await cancelOrder(runId, id, 'strategy-change', { repos: f.repos, today: '2026-11-11' })
    expect(order.status).toBe('cancelled')
    expect(order.cancelReason).toBe('strategy-change')
  })

  test('cancelOrder rejects unknown, foreign-run, and non-open orders', async () => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos, today: '2026-11-11' }
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
    expect(f._stores.orders[1].cancelReason).toBeNull()
  })

  test('cancelOrder rejects unknown reason', async () => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos, today: '2026-11-11' }
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
    expect(stored.cancelReason).toBeNull()
  })
})

describe('buy bucket selection', () => {
  test('manual buy after a closed cycle skips the closed bucket', async () => {
    const f = fakeRepos()
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
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
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
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
    const deps: FillBookingDeps = { repos: f.repos, today: '2026-11-06', notify: silentNotifier }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'next3', poolCents: 1000000, costPpm: 100, initialRunState: emptyState(2) })
    await seedRun(runId, { cashCents: 500, buckets: [{ shares: 5, buyPrice: '10.00', filledOn: '2026-11-03' }, { shares: 3, buyPrice: '12.00', filledOn: '2026-11-04' }] }, deps)
    const idxs = f._stores.fills.filter((x: any) => x.runId === runId).map((x: any) => x.bucketIdx)
    expect(idxs).toEqual([0, 1])
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
