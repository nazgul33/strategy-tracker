import { describe, test, expect, spyOn } from 'bun:test'
import { applyBuyFill, parseUsd } from '@st/core'
import { manualFill } from '../src/domain/booking'
import { rebookFill } from '../src/domain/recompute'
import { D, Y, sellAt, orderOf, heldRun, lastFillId, type Ord } from './sell-fixture'
import { expectKind } from './rebooking-fixture'

const BUY = { shares: 10, price: '100.00', filledOn: '2026-11-01' } as const
const BUY_2 = { shares: 10, price: '100.00', filledOn: '2026-11-02' } as const // a different day, so it takes its own bucket
const LEGS: Ord[] = [{ idx: 0, kind: 'sell_loc', price: '103.00' }, { idx: 0, kind: 'stop_sell', price: '97.00' }]
const STALE_104: Ord = { idx: 0, kind: 'sell_loc', price: '104.00', status: 'stale' }

const edit = (shares: number, priceStr: string) => ({ shares, priceStr, feeCents: 0 })
const statuses = (f: Awaited<ReturnType<typeof heldRun>>['f']) => f._stores.orders.map((o) => [o.id, o.status, o.cancelReason])

async function partialSell(ords: Ord[], sellOn = D) {
  const run = await heldRun([BUY], ords)
  await sellAt(run.runId, 6, '96.50', run.deps, sellOn)
  return { ...run, sellId: lastFillId(run.f) }
}

const LEGS_1: Ord[] = [{ idx: 1, kind: 'sell_loc', price: '103.00' }, { idx: 1, kind: 'stop_sell', price: '97.00' }]

// Buckets 0 and 1 held through real buys; bucket 1 is sold out (its newest fill is a sell), then the stored state is
// drifted so bucket 1 is held again with no fill behind it, and bucket 1 gets open legs. A partial sell books on bucket 0.
async function driftedRun(bucket0Legs: Ord[]) {
  const run = await heldRun([BUY, BUY_2], bucket0Legs)
  const { f, deps, runId } = run
  await manualFill(runId, { side: 'sell', shares: 10, price: '103.00', filledOn: D, bucketIdx: 1 }, deps)
  const drifted = applyBuyFill(await f.repos.bucketRepo.loadState(runId), 1, 10, parseUsd('100.00'), 0, BUY_2.filledOn)
  await f.repos.bucketRepo.saveState(runId, drifted)
  await f.repos.orderRepo.insertMany(LEGS_1.map((o) => ({
    runId, tradeDate: D, kind: o.kind, bucketIdx: o.idx, limitPrice: parseUsd(o.price!), shares: 10, status: 'open' as const,
  })))
  await manualFill(runId, { side: 'sell', shares: 6, price: '96.50', filledOn: D, bucketIdx: 0 }, deps)
  return { ...run, sellId: lastFillId(f) }
}

describe('rebookFill retires only the edited fill\'s bucket', () => {
  test('an edit leaves another bucket\'s legs alone when the rebuild empties that bucket through drift', async () => {
    const { f, deps, rec, runId, sellId } = await driftedRun([])

    await rebookFill(runId, { fillId: sellId, ...edit(6, '96.40') }, deps)

    expect((await f.repos.bucketRepo.loadState(runId)).buckets[1]!.state).toBe('empty')
    for (const kind of ['sell_loc', 'stop_sell']) {
      expect(orderOf(f, 1, kind)).toMatchObject({ status: 'open', cancelReason: null })
    }
    expect(rec.siblings).toEqual([])
    expect(rec.attributions).toEqual([])
  })

  test('the edited bucket still retires its own legs under drift elsewhere', async () => {
    const { f, deps, rec, runId, sellId } = await driftedRun(LEGS)

    await rebookFill(runId, { fillId: sellId, ...edit(10, '96.50') }, deps)

    expect(orderOf(f, 0, 'stop_sell').status).toBe('filled')
    expect(orderOf(f, 0, 'sell_loc')).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(rec.siblings.map((s) => s.order.id)).toEqual([orderOf(f, 0, 'sell_loc').id])
    expect(orderOf(f, 1, 'sell_loc').status).toBe('open')
    expect(orderOf(f, 1, 'stop_sell').status).toBe('open')
  })
})

describe('rebookFill retires the legs of a bucket it empties', () => {
  test('a sell edited up to the whole bucket flips its leg and retires the others', async () => {
    const { f, deps, rec, runId, sellId } = await partialSell([...LEGS, STALE_104])
    const target = orderOf(f, 0, 'sell_loc')
    expect(rec.siblings).toEqual([])

    await rebookFill(runId, { fillId: sellId, ...edit(10, '96.50') }, deps)

    expect(orderOf(f, 0, 'stop_sell').status).toBe('filled')
    expect(target).toMatchObject({ limitPrice: 1030000n, status: 'cancelled', cancelReason: 'broker-filled' })
    const stale = f._stores.orders.find((o) => o.limitPrice === 1040000n)!
    expect(stale).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(rec.siblings.map((s) => s.order.id)).toEqual([target.id])
    expect(rec.attributions).toEqual([])
  })

  test('a failing order read fails the edit before anything is stored', async () => {
    const { f, deps, rec, runId, sellId } = await partialSell([...LEGS, STALE_104])
    const run = f._stores.runs.get(runId)!
    const before = { state: run.stateJson, fills: structuredClone(f._stores.fills), ledger: structuredClone(f._stores.ledger), orders: statuses(f) }
    f.repos.orderRepo.listForRunFrom = async () => { throw new Error('db-down') }

    await expect(rebookFill(runId, { fillId: sellId, ...edit(10, '96.50') }, deps)).rejects.toThrow('db-down')

    expect(run.stateJson).toBe(before.state)
    expect(f._stores.fills).toEqual(before.fills)
    expect(f._stores.fills.find((x) => x.id === sellId)!.shares).toBe(6)
    expect(f._stores.ledger).toEqual(before.ledger)
    expect(statuses(f)).toEqual(before.orders)
    expect([rec.siblings, rec.attributions, rec.orphans]).toEqual([[], [], []])
  })

  test('a buy edited down to what was sold empties the bucket the same way', async () => {
    const { f, deps, rec, runId } = await partialSell(LEGS)
    const buyId = f._stores.fills.find((x) => x.side === 'buy')!.id

    await rebookFill(runId, { fillId: buyId, ...edit(6, '100.00') }, deps)

    expect(orderOf(f, 0, 'stop_sell').status).toBe('filled')
    expect(orderOf(f, 0, 'sell_loc')).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(rec.siblings.map((s) => s.order.id)).toEqual([orderOf(f, 0, 'sell_loc').id])
  })

  test('an old sell edited later cancels today\'s legs and announces them', async () => {
    const ords: Ord[] = [
      { idx: 0, kind: 'sell_loc', price: '103.00', tradeDate: Y, status: 'stale' },
      { idx: 0, kind: 'stop_sell', price: '97.00', tradeDate: Y, status: 'stale' },
      ...LEGS,
    ]
    const { f, deps, rec, runId, sellId } = await partialSell(ords, Y)

    await rebookFill(runId, { fillId: sellId, ...edit(10, '96.50') }, deps)

    expect(orderOf(f, 0, 'stop_sell', Y).status).toBe('filled')
    expect(orderOf(f, 0, 'sell_loc', Y)).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    const today = [orderOf(f, 0, 'sell_loc'), orderOf(f, 0, 'stop_sell')]
    for (const o of today) expect(o).toMatchObject({ status: 'cancelled', cancelReason: 'broker-filled' })
    expect(rec.siblings.map((s) => s.order.id)).toEqual(today.map((o) => o.id))
  })

  test('an edit that does not empty the bucket changes no order', async () => {
    const { f, deps, rec, runId, sellId } = await partialSell(LEGS)
    const before = statuses(f)

    await rebookFill(runId, { fillId: sellId, ...edit(7, '96.50') }, deps)

    expect(statuses(f)).toEqual(before)
    expect(rec.siblings).toEqual([])
  })

  test('a refused edit changes no order', async () => {
    const { f, deps, rec, runId, sellId } = await partialSell(LEGS)
    const before = statuses(f)

    const err = await expectKind(() => rebookFill(runId, { fillId: sellId, ...edit(11, '96.50') }, deps))

    expect(err.kind).toBe('too-many-shares')
    expect(statuses(f)).toEqual(before)
    expect(rec.siblings).toEqual([])
  })

  test('editing the price of an emptying sell again sends no second notice', async () => {
    const { deps, rec, runId, sellId } = await partialSell(LEGS)
    await rebookFill(runId, { fillId: sellId, ...edit(10, '96.50') }, deps)
    expect(rec.siblings).toHaveLength(1)

    await rebookFill(runId, { fillId: sellId, ...edit(10, '96.40') }, deps)

    expect(rec.siblings).toHaveLength(1)
  })

  test('an emptying edit on a bucket with no orders succeeds quietly', async () => {
    const { deps, rec, runId, sellId } = await partialSell([])

    await rebookFill(runId, { fillId: sellId, ...edit(10, '96.50') }, deps)

    expect(rec.siblings).toEqual([])
  })

  test('a notifier that throws does not fail the edit', async () => {
    const { f, deps, runId, sellId } = await partialSell(LEGS)
    deps.notify.siblingCancelled = async () => { throw new Error('telegram-down') }
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await rebookFill(runId, { fillId: sellId, ...edit(10, '96.50') }, deps)
      expect(orderOf(f, 0, 'sell_loc').status).toBe('cancelled')
      expect(errors).toHaveBeenCalled()
    } finally { errors.mockRestore() }
  })
})
