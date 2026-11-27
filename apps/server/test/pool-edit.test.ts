import { describe, expect, spyOn, test } from 'bun:test'
import { emptyState, type ISODate, type Run } from '@st/core'
import { computeOrders, DEFAULT_MR_PARAMS } from '@st/strategies'
import { manualFill, seedRun } from '../src/domain/booking'
import { setRunPool } from '../src/domain/pool-edit'
import { rebuildState, recalcRunState } from '../src/domain/recompute'
import { withRunLock } from '../src/domain/run-lock'
import { fakeRepos, silentNotifier } from './booking-fakes'

const TODAY: ISODate = '2026-11-15'
const tick = () => new Promise<void>((r) => setTimeout(r, 5))
const bigintSafe = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((r) => { release = r })
  return { promise, release }
}

function setup() {
  const f = fakeRepos()
  const edits: { runId: number; poolCents: number }[] = []
  const repos = {
    ...f.repos,
    runRepo: { ...f.repos.runRepo, async updatePool(id: number, p: number) { const r = f._stores.runs.get(id); if (r) r.poolCents = p } },
    poolEditRepo: { async insert(e: { runId: number; poolCents: number }) { edits.push(e) } },
  }
  const deps = { repos, today: TODAY, notify: silentNotifier }
  return { f, repos, deps, edits }
}
type S = ReturnType<typeof setup>

async function newRun(s: S) {
  return s.repos.runRepo.create({
    strategyKey: 'mean-reversion', ticker: 'SPY', name: 'r', poolCents: 1_000_000, costPpm: 0,
    initialRunState: { buckets: emptyState(10).buckets, cashCents: 1_000_000, closed: [], ages: {} },
  })
}

// pool 1_000_000, one buy of 10 @ 150.00 with no fee: cash 850_000
async function heldRun(s: S) {
  const id = await newRun(s)
  await manualFill(id, { side: 'buy', shares: 10, price: '150.00', fee: '0.00', filledOn: '2026-11-10' }, s.deps)
  return id
}

const cash = async (s: S, id: number) => (await s.repos.bucketRepo.loadState(id)).cashCents
const poolRows = (s: S, id: number) => s.f._stores.ledger.filter((l) => l.runId === id && l.kind === 'adjust' && JSON.parse(l.ref!).reason === 'pool-edit')
const poolOf = (s: S, id: number) => s.f._stores.runs.get(id)!.poolCents

describe('setRunPool', () => {
  test('raising the pool moves the cash by the difference and books one adjust row', async () => {
    const s = setup()
    const id = await heldRun(s)
    expect(await cash(s, id)).toBe(850_000)
    const before = await s.repos.bucketRepo.loadState(id)
    const ledgerBefore = s.f._stores.ledger.length

    const res = await setRunPool(id, 1_500_000, s.deps)

    expect(res).toEqual({ deltaCents: 500_000 })
    expect(await cash(s, id)).toBe(1_350_000)
    const after = await s.repos.bucketRepo.loadState(id)
    expect(bigintSafe({ ...after, cashCents: 0 })).toBe(bigintSafe({ ...before, cashCents: 0 }))
    expect(after.buckets[0]).toMatchObject({ state: 'held', shares: 10, buyPrice: 1_500_000n })
    expect(s.f._stores.ledger.length).toBe(ledgerBefore + 1)
    const rows = poolRows(s, id)
    expect(rows.length).toBe(1)
    expect(rows[0]!.amountCents).toBe(500_000)
    expect(JSON.parse(rows[0]!.ref!)).toEqual({ bookedOn: TODAY, reason: 'pool-edit', poolCents: 1_500_000 })
    expect(s.edits).toEqual([{ runId: id, poolCents: 1_500_000 }])
    expect(poolOf(s, id)).toBe(1_500_000)
  })

  test('a recalc afterwards finds the books straight and books nothing', async () => {
    const s = setup()
    const id = await heldRun(s)
    await setRunPool(id, 1_500_000, s.deps)
    const ledgerBefore = s.f._stores.ledger.length

    const res = await recalcRunState(id, s.deps)

    expect(res.deltaCents).toBe(0)
    expect(s.f._stores.ledger.length).toBe(ledgerBefore)
    expect(await cash(s, id)).toBe(1_350_000)
  })

  test('lowering the pool lowers the cash and books a negative adjust row', async () => {
    const s = setup()
    const id = await heldRun(s)

    const res = await setRunPool(id, 900_000, s.deps)

    expect(res).toEqual({ deltaCents: -100_000 })
    expect(await cash(s, id)).toBe(750_000)
    expect(poolRows(s, id).map((r) => r.amountCents)).toEqual([-100_000])
    expect((await recalcRunState(id, s.deps)).deltaCents).toBe(0)
  })

  test('the same pool again saves no state and books no ledger row, but still records the edit', async () => {
    const s = setup()
    const id = await heldRun(s)
    const save = spyOn(s.repos.bucketRepo, 'saveState')
    const ledgerBefore = s.f._stores.ledger.length

    const res = await setRunPool(id, 1_000_000, s.deps)

    expect(res).toEqual({ deltaCents: 0 })
    expect(save).not.toHaveBeenCalled()
    expect(s.f._stores.ledger.length).toBe(ledgerBefore)
    expect(await cash(s, id)).toBe(850_000)
    expect(s.edits).toEqual([{ runId: id, poolCents: 1_000_000 }])
    save.mockRestore()
  })

  test('a seeded run keeps the difference it already had', async () => {
    const s = setup()
    const id = await newRun(s)
    await seedRun(id, { cashCents: 700_000, buckets: [{ shares: 10, buyPrice: '150.00', filledOn: '2026-11-10' }] }, s.deps)
    const drift = async () => {
      const run = s.f._stores.runs.get(id)!
      const fills = await s.repos.fillRepo.listForRun(id)
      return rebuildState(fills, run.poolCents, TODAY, 10).cashCents - (await cash(s, id))
    }
    expect(await cash(s, id)).toBe(700_000)
    expect(await drift()).toBe(150_000)

    await setRunPool(id, 1_500_000, s.deps)

    expect(await cash(s, id)).toBe(1_200_000)
    expect(await drift()).toBe(150_000)
    expect((await recalcRunState(id, s.deps)).deltaCents).toBe(150_000)
  })

  test('an unknown run answers null and writes nothing', async () => {
    const s = setup()
    await heldRun(s)
    const ledgerBefore = s.f._stores.ledger.length

    expect(await setRunPool(999, 1_500_000, s.deps)).toBeNull()

    expect(s.edits).toEqual([])
    expect(s.f._stores.ledger.length).toBe(ledgerBefore)
  })

  test('two edits started together are applied one after the other', async () => {
    const s = setup()
    const id = await heldRun(s)

    await Promise.all([setRunPool(id, 1_500_000, s.deps), setRunPool(id, 1_200_000, s.deps)])

    expect(poolOf(s, id)).toBe(1_200_000)
    expect(await cash(s, id)).toBe(850_000 + (1_200_000 - 1_000_000))
    const amounts = poolRows(s, id).map((r) => r.amountCents)
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(200_000)
    expect(amounts).toEqual([500_000, -300_000])
    expect((await recalcRunState(id, s.deps)).deltaCents).toBe(0)
  })

  test('waits for a held run lock, then moves the cash', async () => {
    const s = setup()
    const id = await heldRun(s)
    const gate = deferred()
    const holder = withRunLock(id, () => gate.promise)
    let settled = false
    const writer = setRunPool(id, 1_500_000, s.deps).finally(() => { settled = true })
    try {
      await tick()
      expect(settled).toBe(false)
      expect(poolOf(s, id)).toBe(1_000_000)
      expect(await cash(s, id)).toBe(850_000)
      expect(s.edits).toEqual([])
    } finally {
      gate.release()
    }
    await holder
    await writer
    expect(await cash(s, id)).toBe(1_350_000)
    expect(poolOf(s, id)).toBe(1_500_000)
  })

  test('order sizing uses the pool and does not depend on the stored cash', async () => {
    const s = setup()
    const id = await heldRun(s)
    await setRunPool(id, 1_500_000, s.deps)
    const row = s.f._stores.runs.get(id)!
    const run: Run = { id, name: row.name, ticker: row.ticker, strategyKey: 'mean-reversion', costPpm: row.costPpm, buyGapPpm: 0, sellGapPpm: 0, cutLossPpm: 0, poolCents: row.poolCents, status: 'active' }
    const moved = await s.repos.bucketRepo.loadState(id)
    expect(moved.cashCents).toBe(1_350_000)

    const withMoved = computeOrders(run, moved, { lastClose: 1_500_000n }, DEFAULT_MR_PARAMS)
    const withOld = computeOrders(run, { ...moved, cashCents: 850_000 }, { lastClose: 1_500_000n }, DEFAULT_MR_PARAMS)

    expect(bigintSafe(withMoved)).toBe(bigintSafe(withOld))
    const buy = withMoved.orders.find((o) => o.kind === 'buy_loc')
    expect(buy).toEqual({ kind: 'buy_loc', bucketIndex: 1, limitPrice: 1_499_900n, shares: 10 })
    const oldPoolBuy = computeOrders({ ...run, poolCents: 1_000_000 }, moved, { lastClose: 1_500_000n }, DEFAULT_MR_PARAMS).orders.find((o) => o.kind === 'buy_loc')
    expect(oldPoolBuy).toMatchObject({ shares: 6 })
  })
})
