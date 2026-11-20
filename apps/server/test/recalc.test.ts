import { describe, expect, test } from 'bun:test'
import { emptyState, type ISODate, type RunState } from '@st/core'
import { manualFill, type BookingDeps } from '../src/domain/booking'
import { recalcRunState } from '../src/domain/recompute'
import { fakeRepos } from './booking-fakes'

const TODAY: ISODate = '2026-11-10'
type F = ReturnType<typeof fakeRepos>

const deps = (f: F): BookingDeps => ({ repos: f.repos as any, today: TODAY })
const getState = (f: F, runId: number): Promise<RunState> => f.repos.bucketRepo.loadState(runId)
const ledgerForRun = (f: F, runId: number) => f._stores.ledger.filter((l: any) => l.runId === runId)
const adjustRows = (f: F) => f._stores.ledger.filter((l: any) => l.kind === 'adjust')
const asJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))

function createRun(f: F, poolCents = 1_000_000, bucketCount = 10): Promise<number> {
  return f.repos.runRepo.create({
    strategyKey: 'mean-reversion', ticker: 'SPY', name: 'r', poolCents, costPpm: 0,
    initialRunState: { buckets: emptyState(bucketCount).buckets, cashCents: poolCents, closed: [], ages: {} },
  })
}

// buy 300 @ 10.00 then partially sell 120 @ 11.00 -> bucket 0 holds 180, one closed tranche
async function seedBuyAndPartialSell(f: F, runId: number) {
  await manualFill(runId, { side: 'buy', shares: 300, price: '10.00', filledOn: '2026-11-03' }, deps(f))
  await manualFill(runId, { side: 'sell', shares: 120, price: '11.00', filledOn: '2026-11-05' }, deps(f))
}

describe('recalcRunState', () => {
  test('recalcRunState books nothing when cash unchanged', async () => {
    const f = fakeRepos()
    const runId = await createRun(f)
    await seedBuyAndPartialSell(f, runId)
    const before = await getState(f, runId)
    const ledgerLen = ledgerForRun(f, runId).length

    const res = await recalcRunState(runId, deps(f))

    expect(ledgerForRun(f, runId).length).toBe(ledgerLen)
    expect(adjustRows(f).length).toBe(0)
    const st = await getState(f, runId)
    expect(st.cashCents).toBe(before.cashCents)
    expect(res.state.cashCents).toBe(before.cashCents)
    expect(res.deltaCents).toBe(0)
    expect(res.fillCount).toBe(2)
    expect(st.closed.length).toBe(1)
    expect(st.closed[0]!.shares).toBe(120)
    expect(st.buckets[0]!.state).toBe('held')
    expect(st.buckets[0]!.shares).toBe(180)
  })

  test('recalcRunState repairs legacy state without touching fills', async () => {
    const f = fakeRepos()
    const runId = await createRun(f)
    await seedBuyAndPartialSell(f, runId)
    // corrupt out-of-band: drop the tranche rows and pretend the full 300 is held,
    // like a stored state written before partial sells appended rows (cash untouched)
    const stale = await getState(f, runId)
    stale.closed = []
    stale.buckets[0]!.shares = 300
    await f.repos.bucketRepo.saveState(runId, stale)
    const fillsSnap = asJson(f._stores.fills)
    const ledgerLen = ledgerForRun(f, runId).length
    const ordersLen = f._stores.orders.length
    const pendingLen = f._stores.pending.length

    const res = await recalcRunState(runId, deps(f))

    const st = await getState(f, runId)
    expect(st.closed.length).toBe(1)
    expect(st.closed[0]!.shares).toBe(120)
    expect(st.buckets[0]!.shares).toBe(180)
    expect(res.fillCount).toBe(2)
    expect(res.deltaCents).toBe(0)
    // fills, ledger, orders and pending rows are never touched by recalc
    expect(asJson(f._stores.fills)).toBe(fillsSnap)
    expect(ledgerForRun(f, runId).length).toBe(ledgerLen)
    expect(adjustRows(f).length).toBe(0)
    expect(f._stores.orders.length).toBe(ordersLen)
    expect(f._stores.pending.length).toBe(pendingLen)
  })

  test('recalcRunState books adjust on cash drift', async () => {
    const f = fakeRepos()
    const runId = await createRun(f)
    await manualFill(runId, { side: 'buy', shares: 300, price: '10.00', filledOn: '2026-11-03' }, deps(f))
    await manualFill(runId, { side: 'sell', shares: 120, price: '11.00', filledOn: '2026-11-05' }, deps(f))
    const derived = (await getState(f, runId)).cashCents
    // corrupt only the cash: someone overwrote the stored number by +500
    const drifted = await getState(f, runId)
    drifted.cashCents += 500
    await f.repos.bucketRepo.saveState(runId, drifted)
    const ledgerLen = ledgerForRun(f, runId).length

    const res = await recalcRunState(runId, deps(f))

    expect(res.state.cashCents).toBe(derived)
    expect(res.deltaCents).toBe(-500)
    expect(res.fillCount).toBe(2)
    expect((await getState(f, runId)).cashCents).toBe(derived)
    const rows = adjustRows(f)
    expect(rows.length).toBe(1)
    expect(rows[0]!.kind).toBe('adjust')
    expect(rows[0]!.amountCents).toBe(-500)
    expect(JSON.parse(rows[0]!.ref)).toEqual({ bookedOn: TODAY, reason: 'recalc' })
    expect(ledgerForRun(f, runId).length).toBe(ledgerLen + 1)
  })

  test('recalcRunState reports a positive delta when stored cash undershoots', async () => {
    const f = fakeRepos()
    const runId = await createRun(f)
    await manualFill(runId, { side: 'buy', shares: 300, price: '10.00', filledOn: '2026-11-03' }, deps(f))
    await manualFill(runId, { side: 'sell', shares: 120, price: '11.00', filledOn: '2026-11-05' }, deps(f))
    const derived = (await getState(f, runId)).cashCents
    // the mirror case: the stored number undershoots the derived cash by 500
    const drifted = await getState(f, runId)
    drifted.cashCents -= 500
    await f.repos.bucketRepo.saveState(runId, drifted)

    const res = await recalcRunState(runId, deps(f))

    expect(res.state.cashCents).toBe(derived)
    expect(res.deltaCents).toBe(500)
    expect((await getState(f, runId)).cashCents).toBe(derived)
    const rows = adjustRows(f)
    expect(rows.length).toBe(1)
    expect(rows[0]!.amountCents).toBe(500)
  })
})
