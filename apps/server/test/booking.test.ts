import { describe, test, expect } from 'bun:test'
import { emptyState, applyBuyFill, DomainError, type RunState, type ISODate } from '@st/core'
import { parseUsd, feeCents } from '@st/core/money'
import { ageBuckets } from '@st/strategies'
import type { ExtractResult, RawFill } from '@st/ingest'
import {
  ingestCapture, confirmPendingFill, manualFill, rollStale, seedRun, sha256, cancelOrder,
  type BookingDeps, type PendingFillRow, type CaptureConflict,
} from '../src/domain/booking'
import { withRunLock } from '../src/domain/run-lock'
import { fakeCorrectionRepo } from './fake-corrections'

type BookedConflict = Extract<CaptureConflict, { matchedKind: 'booked' }>

function serializeState(state: RunState): string {
  return JSON.stringify(state, (_, v) => typeof v === 'bigint' ? v.toString() : v)
}
function rehydrate(raw: any): RunState {
  const ages: Record<number, number> = {}
  for (const k of Object.keys(raw.ages ?? {})) ages[Number(k)] = raw.ages[k]
  return {
    buckets: (raw.buckets ?? []).map((b: any) => ({ ...b, buyPrice: BigInt(b.buyPrice ?? 0) })),
    cashCents: raw.cashCents,
    closed: (raw.closed ?? []).map((c: any) => ({ ...c, buyPrice: BigInt(c.buyPrice), soldPrice: BigInt(c.soldPrice) })),
    ages,
  }
}

export function fakeRepos() {
  const runs = new Map<number, any>()
  const buckets: any[] = []
  const orders: any[] = []
  const fills: any[] = []
  const pending: any[] = []
  const captures: any[] = []
  const ledger: any[] = []
  const corrections = fakeCorrectionRepo()
  let runSeq = 1, orderSeq = 1, fillSeq = 1, pendingSeq = 1, captureSeq = 1, ledgerSeq = 1

  const runRepo = {
    async list() { return [...runs.values()] },
    async get(id: number) { return runs.get(id) ?? null },
    async create(input: any) {
      const id = runSeq++
      const state = input.initialRunState ?? { buckets: [], cashCents: input.poolCents, closed: [], ages: {} }
      const run = { id, strategyKey: input.strategyKey, ticker: input.ticker, name: input.name, poolCents: input.poolCents, costPpm: input.costPpm, status: 'active', stateJson: serializeState(state) }
      runs.set(id, run)
      if (input.initialRunState) await bucketRepo.saveState(id, input.initialRunState)
      return id
    },
    async updateStatus(id: number, status: string) { const r = runs.get(id); if (r) r.status = status },
  }
  const bucketRepo = {
    async saveState(runId: number, state: RunState) {
      const run = runs.get(runId); if (run) run.stateJson = serializeState(state)
    },
    async loadState(runId: number): Promise<RunState> {
      const run = runs.get(runId)
      return rehydrate(JSON.parse(run.stateJson))
    },
  }
  const orderRepo = {
    async insertMany(os: any[]) { for (const o of os) { orders.push({ id: orderSeq++, ...o }) } },
    async listForDate(date: string) { return orders.filter((o) => o.tradeDate === date) },
    async get(id: number) { return orders.find((x) => x.id === id) ?? null },
    async markStale(date: string) {
      let cnt = 0
      for (const o of orders) { if (o.status === 'open' && o.tradeDate < date) { o.status = 'stale'; cnt++ } }
      return cnt
    },
    async setStatus(id: number, status: string, cancelReason?: string) {
      const o = orders.find((x) => x.id === id)
      if (o) { o.status = status; if (cancelReason !== undefined) o.cancelReason = cancelReason }
    },
    async listOpenBefore(date: string) { return orders.filter((o) => o.status === 'open' && o.tradeDate < date) },
  }
  const fillRepo = {
    async insert(fill: any) { fills.push({ id: fillSeq++, ...fill }) },
    async listForRun(runId: number) {
      return fills.filter((f) => f.runId === runId).map((f) => ({ ...f })).sort((a, b) => a.id - b.id)
    },
    async update(runId: number, fillId: number, patch: any) {
      const f = fills.find((x) => x.runId === runId && x.id === fillId)
      if (f) Object.assign(f, patch)
    },
    async deleteById(runId: number, fillId: number) {
      const gi = fills.findIndex((f) => f.runId === runId && f.id === fillId)
      if (gi >= 0) fills.splice(gi, 1)
    },
  }
  const pendingRepo = {
    async insert(p: any) { const id = pendingSeq++; pending.push({ id, ...p }); return id },
    async listPending() { return pending.filter((p) => p.status === 'pending') },
    async hasLiveForCapture(captureId: number) { return pending.some((p) => p.captureId === captureId && p.status === 'pending') },
    async hasConfirmedForCapture(captureId: number) { return pending.some((p) => p.captureId === captureId && p.status === 'confirmed') },
    async decide(id: number, status: string, edited?: any): Promise<boolean> {
      const p = pending.find((x) => x.id === id)
      if (!p) throw new Error('not found')
      if (p.status !== 'pending') throw new Error('not pending')
      p.status = status
      if (edited) Object.assign(p, edited)
      return true
    },
  }
  const captureRepo = {
    async findByHash(runId: number, hash: string) {
      const c = captures.find((x) => x.runId === runId && x.imageHash === hash)
      return c ? { id: c.id as number, status: c.status as string } : null
    },
    async setStatus(id: number, status: string) { const c = captures.find((x) => x.id === id); if (c) c.status = status },
    async insert(c: any) {
      const dup = captures.some((x) => x.runId === c.runId && x.imageHash === c.imageHash)
      if (dup) return { inserted: false }
      const id = captureSeq++
      captures.push({ id, ...c })
      return { inserted: true, id }
    },
  }
  const ledgerRepo = {
    async insert(l: any) { ledger.push({ id: ledgerSeq++, ...l }) },
    async listForRun(runId: number) { return ledger.filter((l) => l.runId === runId) },
  }
  return {
    repos: { runRepo, bucketRepo, orderRepo, fillRepo, pendingRepo, correctionRepo: corrections.repo, captureRepo, ledgerRepo },
    _stores: { runs, orders, fills, pending, captures, ledger, corrections: corrections.store },
  }
}

describe('booking', () => {
  test('(a) duplicate capture', async () => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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

  test('(c2) no-order case no throw', async () => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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
    expect(order.status).toBe('filled')
    // full sell closes
  })

  test('(d2) full sell closes', async () => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r7b', poolCents: 1000, costPpm: 100, initialRunState: emptyState(2) })
    await expect(seedRun(runId, { cashCents: undefined as any, buckets: [] }, deps)).rejects.toThrow('invalid seed cash')
  })

  test('(h) manualFill', async () => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r8', poolCents: 1000, costPpm: 100, initialRunState: emptyState(2) })
    const beforePending = f._stores.pending.length
    await manualFill(runId, { side: 'buy', shares: 3, price: '5.00', filledOn: '2026-11-06' }, deps)
    expect(f._stores.fills[0].source).toBe('manual')
    expect(f._stores.fills[0].ticker).toBe('AAPL')
    expect(f._stores.pending.length).toBe(beforePending)
  })

  test('manualFill ignores a stray ticker and stamps the run ticker', async () => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'r8b', poolCents: 1000, costPpm: 100, initialRunState: emptyState(2) })
    const legacy = { side: 'buy' as const, ticker: 'ZZZ', shares: 3, price: '5.00', filledOn: '2026-11-06' }
    await manualFill(runId, legacy, deps)
    expect(f._stores.fills[0].ticker).toBe('AAPL')
  })

  test('(i) double-confirm throws and over-size sell throws', async () => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'fee', poolCents: 1000000, costPpm: 100, initialRunState: { buckets: emptyState(2).buckets, cashCents: 1000000, closed: [], ages: {} } })
    const pid = await f.repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 5, price: parseUsd('10.00'), fee: 999, filledOn: '2026-11-06', status: 'pending' })
    await confirmPendingFill(pid, null, deps)
    const fill = f._stores.fills[0]
    expect(fill.fee).toBe(999)
  })

  test('confirm with ticker mismatch throws and books nothing', async () => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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
    expect(order.status).toBe('filled')
  })

  test('over-size sell with matching order stays open', async () => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-11' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-11' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-06' }
    const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'next3', poolCents: 1000000, costPpm: 100, initialRunState: emptyState(2) })
    await seedRun(runId, { cashCents: 500, buckets: [{ shares: 5, buyPrice: '10.00', filledOn: '2026-11-03' }, { shares: 3, buyPrice: '12.00', filledOn: '2026-11-04' }] }, deps)
    const idxs = f._stores.fills.filter((x: any) => x.runId === runId).map((x: any) => x.bucketIdx)
    expect(idxs).toEqual([0, 1])
  })
})

describe('capture dedup against booked fills and pending rows', () => {
  const setup = async (name: string) => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-15' }
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
})

describe('capture re-upload', () => {
  const setup = async (name: string) => {
    const f = fakeRepos()
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-15' }
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
    const deps: BookingDeps = { repos: f.repos as any, today: '2026-11-15' }
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
