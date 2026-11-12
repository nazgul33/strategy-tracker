import { describe, test, expect } from 'bun:test'
import { emptyState, applyBuyFill, DomainError, type RunState, type ISODate } from '@st/core'
import { parseUsd, feeCents } from '@st/core/money'
import { ageBuckets } from '@st/strategies'
import type { ExtractResult, RawFill } from '@st/ingest'
import {
  ingestCapture, confirmPendingFill, manualFill, rollStale, seedRun, sha256, cancelOrder,
  type BookingDeps, type PendingFillRow,
} from '../src/domain/booking'

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
  }
  const pendingRepo = {
    async insert(p: any) { const id = pendingSeq++; pending.push({ id, ...p }); return id },
    async listPending() { return pending.filter((p) => p.status === 'pending') },
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
    async hasHash(runId: number, hash: string) { return captures.some((c) => c.runId === runId && c.imageHash === hash) },
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
    repos: { runRepo, bucketRepo, orderRepo, fillRepo, pendingRepo, captureRepo, ledgerRepo },
    _stores: { runs, orders, fills, pending, captures, ledger },
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
