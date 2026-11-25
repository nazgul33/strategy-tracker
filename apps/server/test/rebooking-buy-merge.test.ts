import { describe, expect, test } from 'bun:test'
import { roundDiv } from '@st/core'
import type { FillRow } from '../src/domain/booking'
import { deleteFill, rebuildState, recalcRunState } from '../src/domain/recompute'
import { fakeRepos } from './booking-fakes'
import { TODAY, adjustRows, ageOf, createRun, deps, getState } from './rebooking-fixture'

const D = '2026-11-24'
const rungs = [
  { shares: 26, price: 378500n, fee: 69 },
  { shares: 26, price: 371000n, fee: 68 },
  { shares: 94, price: 319896n, fee: 210 },
]
const rows = (): FillRow[] =>
  rungs.map((r, i) => ({ id: i + 1, runId: 1, bucketIdx: 5, side: 'buy', ticker: 'SPY', filledOn: D, source: 'seed', ...r }) as FillRow)
const c = (p: bigint, n: bigint) => Number(roundDiv(p * n, 100n))

async function seed() {
  const f = fakeRepos()
  const runId = await createRun(f, 5_000_000, 10)
  for (const r of rungs) {
    await f.repos.fillRepo.insert({ runId, bucketIdx: 5, side: 'buy', ticker: 'SPY', filledOn: D, source: 'seed', ...r })
  }
  const history = await f.repos.fillRepo.listForRun(runId)
  await f.repos.bucketRepo.saveState(runId, rebuildState(history, 5_000_000, TODAY, 10))
  return { f, runId }
}

describe('rebuildState with merged buys', () => {
  test('rebuildState replays three buys in one bucket as one merged bucket', () => {
    const s = rebuildState(rows(), 5_000_000, TODAY, 10)
    const bk = s.buckets[5]!
    expect(bk).toMatchObject({ shares: 146, buyPrice: 339433n, buyFeeCents: 347, filledOn: D, state: 'held' })
    expect(s.cashCents).toBe(5_000_000 - (c(378500n, 26n) + 69) - (c(371000n, 26n) + 68) - (c(319896n, 94n) + 210))
  })

  test('deleting the newest buy of a merged bucket restores the pre-merge bucket', async () => {
    const { f, runId } = await seed()
    const res = await deleteFill(runId, 3, deps(f))
    const bk = (await getState(f, runId)).buckets[5]!
    expect(bk).toMatchObject({ shares: 52, buyPrice: 374750n, buyFeeCents: 137, state: 'held' })
    expect(res.deltaCents).toBe(c(319896n, 94n) + 210)
    expect(f._stores.orders.filter((o: any) => o.status !== 'open')).toHaveLength(0)
  })

  test('recalc of a merged bucket books no adjust', async () => {
    const { f, runId } = await seed()
    const res = await recalcRunState(runId, deps(f))
    expect(res.deltaCents).toBe(0)
    expect(adjustRows(f)).toHaveLength(0)
  })

  test('history of buy, partial sell, buy into the same bucket rebuilds without refusing', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 5_000_000, 10)
    const base = { runId, bucketIdx: 5, ticker: 'SPY', source: 'seed' as const }
    await f.repos.fillRepo.insert({ ...base, side: 'buy', filledOn: '2026-01-05', shares: 26, price: 378500n, fee: 69 })
    await f.repos.fillRepo.insert({ ...base, side: 'sell', filledOn: '2026-01-06', shares: 10, price: 390000n, fee: 20 })
    await f.repos.fillRepo.insert({ ...base, side: 'buy', filledOn: '2026-01-07', shares: 26, price: 371000n, fee: 68 })
    await recalcRunState(runId, deps(f))
    const st = await getState(f, runId)
    expect(st.buckets[5]).toMatchObject({ shares: 42, state: 'held', filledOn: '2026-01-05' })
    expect(st.ages[5]).toBe(ageOf('2026-01-05'))
    expect(ageOf('2026-01-05')).toBeGreaterThan(0)
  })
})
