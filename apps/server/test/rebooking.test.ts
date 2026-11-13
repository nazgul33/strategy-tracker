import { describe, expect, test } from 'bun:test'
import { applyBuyFill, DomainError, emptyState, parseUsd, roundDiv, type ISODate, type RunState } from '@st/core'
import { ageBuckets, progressView } from '@st/strategies'
import { deleteLastFill, manualFill, rebookFill, rebuildState, signedCents, type BookingDeps, type FillRow } from '../src/domain/booking'
import { fakeRepos } from './booking.test'

const TODAY: ISODate = '2026-01-15'
type F = ReturnType<typeof fakeRepos>

const deps = (f: F): BookingDeps => ({ repos: f.repos as any, today: TODAY })
const getState = (f: F, runId: number): Promise<RunState> => f.repos.bucketRepo.loadState(runId)
const adjustRows = (f: F) => f._stores.ledger.filter((l: any) => l.kind === 'adjust')
const asJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))

// Mimics the real SQL listing, which has no ORDER BY: the fake returns the run's
// fills rotated (neither id-ascending nor id-descending).
function scrambleListForRun(f: F) {
  const real = f.repos.fillRepo.listForRun
  f.repos.fillRepo.listForRun = async (runId: number) => {
    const rows = await real(runId)
    return rows.length > 1 ? [...rows.slice(1), rows[0]] : rows
  }
}

function createRun(f: F, poolCents = 100_000, bucketCount = 10): Promise<number> {
  return f.repos.runRepo.create({
    strategyKey: 'mean-reversion', ticker: 'SPY', name: 'r', poolCents, costPpm: 0,
    initialRunState: { buckets: emptyState(bucketCount).buckets, cashCents: poolCents, closed: [], ages: {} },
  })
}

// Seed a held bucket directly through the core applier (no ledger row), so tests
// can assert the adjust rows that rebook/delete add.
async function bookBuy(f: F, runId: number, o: { idx: number; shares: number; price: string; feeCents?: number; filledOn: ISODate }) {
  const st = await getState(f, runId)
  const price = parseUsd(o.price)
  const fee = o.feeCents ?? 0
  const next = applyBuyFill(st, o.idx, o.shares, price, fee, o.filledOn)
  next.ages[o.idx] = ageBuckets(next.ages, TODAY, { [o.idx]: o.filledOn })[o.idx]!
  await f.repos.bucketRepo.saveState(runId, next)
  await f.repos.fillRepo.insert({ runId, bucketIdx: o.idx, side: 'buy', ticker: 'SPY', shares: o.shares, price, fee, filledOn: o.filledOn, source: 'seed' })
}

const gross = (price: string, shares: number) => Number(roundDiv(parseUsd(price) * BigInt(shares), 100n))
const buyEffect = (price: string, shares: number, fee = 0) => -(gross(price, shares) + fee)
const sellEffect = (price: string, shares: number, fee = 0) => gross(price, shares) - fee
const ageOf = (filledOn: ISODate) => ageBuckets({}, TODAY, { 0: filledOn })[0]!

async function expectKind(fn: () => Promise<unknown>): Promise<DomainError> {
  try {
    await fn()
  } catch (e) {
    return e as DomainError
  }
  throw new Error('expected a DomainError, but the call resolved')
}

describe('signedCents', () => {
  test('buy charges gross + fee, sell credits gross − fee', () => {
    expect(signedCents({ side: 'buy', price: 1_800_000n, shares: 12, fee: 400 })).toBe(-216_400)
    expect(signedCents({ side: 'sell', price: 1_800_000n, shares: 12, fee: 400 })).toBe(215_600)
    expect(signedCents({ side: 'buy', price: 15_000_000n, shares: 8, fee: 0 })).toBe(-1_200_000)
  })
})

describe('rebuildState', () => {
  test('replays fills on top of the pool and is pure', () => {
    const buy: FillRow = {
      id: 1, runId: 1, bucketIdx: 0, side: 'buy', ticker: 'SPY', shares: 10,
      price: 150_150_000n, fee: 500, filledOn: '2026-01-08', source: 'manual',
    }
    const snapshot = asJson(buy)
    const s1 = rebuildState([buy], 1_000_000, TODAY, 1)
    const s2 = rebuildState([buy], 2_000_000, TODAY, 1)
    expect(s1.cashCents).toBe(1_000_000 + buyEffect('15015.00', 10, 500))
    expect(s2.cashCents - s1.cashCents).toBe(1_000_000)
    expect(s1).not.toBe(s2)
    expect(asJson(buy)).toBe(snapshot) // input fills never mutated
    expect(s1.buckets[0]!.state).toBe('held')
    expect(s1.buckets[0]!.shares).toBe(10)
    expect(s1.ages[0]).toBe(ageOf('2026-01-08'))
  })
})

describe('rebookFill', () => {
  test('changing quantity recomputes state and logs a ledger adjust', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f))
    expect((await getState(f, runId)).cashCents).toBe(89_500)

    await rebookFill(runId, { fillId: 1, shares: 12, priceStr: '18.00', feeCents: 400 }, deps(f))

    const st = await getState(f, runId)
    expect(st.cashCents).toBe(78_000) // 100_000 − (21_600 gross + 400 fee)
    expect(st.buckets[0]).toMatchObject({ state: 'held', shares: 12, buyPrice: 180_000n, buyFeeCents: 400, filledOn: '2026-01-08' })
    expect(st.ages[0]).toBe(ageOf('2026-01-08'))
    expect(f._stores.fills).toHaveLength(1)
    expect(f._stores.fills[0]).toMatchObject({ shares: 12, price: 180_000n, fee: 400, filledOn: '2026-01-08' })
    const adj = adjustRows(f)
    expect(adj).toHaveLength(1)
    expect(adj[0]).toMatchObject({ runId, kind: 'adjust', amountCents: buyEffect('18.00', 12, 400) - buyEffect('10.00', 10, 500) }) // −22_000 − (−10_500)
    expect(JSON.parse(adj[0].ref)).toEqual({ fillId: 1, bookedOn: TODAY, reason: 'fill-edit' })
  })

  test('rebooking to the same values leaves cash and ledger untouched', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f))

    await rebookFill(runId, { fillId: 1, shares: 10, priceStr: '10.00', feeCents: 500 }, deps(f))

    const st = await getState(f, runId)
    expect(st.cashCents).toBe(89_500)
    expect(st.buckets[0]).toMatchObject({ state: 'held', shares: 10, buyPrice: 100_000n })
    expect(adjustRows(f)).toHaveLength(0)
  })

  test('state is derived from the whole history, so editing the first fill is safe', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f))
    await manualFill(runId, { side: 'buy', shares: 5, price: '15.00', fee: '2.50', filledOn: '2026-01-09' }, deps(f))

    await rebookFill(runId, { fillId: 1, shares: 8, priceStr: '12.00', feeCents: 300 }, deps(f))

    const st = await getState(f, runId)
    expect(st.buckets[0]).toMatchObject({ state: 'held', shares: 8, buyPrice: 120_000n, buyFeeCents: 300 })
    expect(st.buckets[1]).toMatchObject({ state: 'held', shares: 5, buyPrice: 150_000n, filledOn: '2026-01-09' })
    expect(st.cashCents).toBe(100_000 + buyEffect('12.00', 8, 300) + buyEffect('15.00', 5, 250))
    const adj = adjustRows(f)
    expect(adj).toHaveLength(1)
    expect(adj[0].amountCents).toBe(buyEffect('12.00', 8, 300) - buyEffect('10.00', 10, 500))
  })

  test('editing an early fill keeps later fills — unlike the old undo path', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 3, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f))
    await manualFill(runId, { side: 'buy', shares: 20, price: '20.00', fee: '1.00', filledOn: '2026-01-09' }, deps(f))
    await manualFill(runId, { side: 'sell', shares: 10, price: '21.00', fee: '0.50', filledOn: '2026-01-12' }, deps(f))

    await rebookFill(runId, { fillId: 1, shares: 12, priceStr: '18.00', feeCents: 400 }, deps(f))

    const st = await getState(f, runId)
    expect(st.buckets[0]).toMatchObject({ state: 'held', shares: 12, buyPrice: 180_000n })
    expect(st.buckets[1]).toMatchObject({ state: 'held', shares: 10, buyPrice: 200_000n })
    expect(st.closed).toHaveLength(0)
    expect(st.ages[0]).toBe(ageOf('2026-01-08'))
    expect(st.ages[1]).toBe(ageOf('2026-01-09'))
    expect(st.cashCents).toBe(100_000 + buyEffect('18.00', 12, 400) + buyEffect('20.00', 20, 100) + sellEffect('21.00', 10, 50))
    const adj = adjustRows(f)
    expect(adj).toHaveLength(1)
    expect(adj[0].amountCents).toBe(buyEffect('18.00', 12, 400) - buyEffect('10.00', 3, 500))
    expect(JSON.parse(adj[0].ref).reason).toBe('fill-edit')
  })

  test('resolves the target fill even when listForRun returns scrambled order', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 3)
    await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f))
    await manualFill(runId, { side: 'buy', shares: 5, price: '15.00', fee: '2.50', filledOn: '2026-01-09' }, deps(f))
    scrambleListForRun(f) // listForRun now yields fills in order [2, 1]

    await rebookFill(runId, { fillId: 1, shares: 8, priceStr: '12.00', feeCents: 300 }, deps(f))

    expect(f._stores.fills.find((x: any) => x.id === 1)).toMatchObject({ shares: 8, price: 120_000n, fee: 300 })
    expect(f._stores.fills.find((x: any) => x.id === 2)).toMatchObject({ shares: 5, price: 150_000n, fee: 250 })
    const st = await getState(f, runId)
    expect(st.buckets[0]).toMatchObject({ state: 'held', shares: 8, buyPrice: 120_000n, buyFeeCents: 300 })
    expect(st.buckets[1]).toMatchObject({ state: 'held', shares: 5, buyPrice: 150_000n })
    expect(st.cashCents).toBe(100_000 + buyEffect('12.00', 8, 300) + buyEffect('15.00', 5, 250))
    const adj = adjustRows(f)
    expect(adj).toHaveLength(1)
    expect(JSON.parse(adj[0].ref)).toEqual({ fillId: 1, bookedOn: TODAY, reason: 'fill-edit' })
  })

  test('rebooking a buy whose bucket was later sold keeps closed and realized consistent', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f))
    await manualFill(runId, { side: 'sell', shares: 10, price: '20.00', filledOn: '2026-01-09' }, deps(f))

    const before = await getState(f, runId)
    expect(before.closed).toHaveLength(1)
    expect(before.closed[0]).toMatchObject({ index: 0, buyFeeCents: 500, sellFeeCents: 0 })
    expect(progressView(before).realizedCents).toBe(10_000 - 500)

    await rebookFill(runId, { fillId: 1, shares: 10, priceStr: '10.00', feeCents: 900 }, deps(f))

    const st = await getState(f, runId)
    expect(st.buckets[0].state).toBe('empty')
    expect(st.closed).toHaveLength(1)
    expect(st.closed[0]).toMatchObject({ index: 0, shares: 10, buyPrice: 100_000n, soldPrice: 200_000n, buyFeeCents: 900, sellFeeCents: 0 })
    expect(progressView(st).realizedCents).toBe(10_000 - 900) // shifted by −400 from the edited buy fee
    expect(st.cashCents).toBe(100_000 + buyEffect('10.00', 10, 900) + sellEffect('20.00', 10))
    const adj = adjustRows(f)
    expect(adj).toHaveLength(1)
    expect(adj[0].amountCents).toBe(buyEffect('10.00', 10, 900) - buyEffect('10.00', 10, 500)) // −400
    expect(JSON.parse(adj[0].ref)).toEqual({ fillId: 1, bookedOn: TODAY, reason: 'fill-edit' })
  })

  test('an upward edit that drives cash negative persists — the run keeps going', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 2_000, 2)
    await manualFill(runId, { side: 'buy', shares: 1, price: '10.00', filledOn: '2026-01-08' }, deps(f))

    await rebookFill(runId, { fillId: 1, shares: 100, priceStr: '100.00', feeCents: 0 }, deps(f))

    const st = await getState(f, runId)
    expect(st.cashCents).toBe(2_000 + buyEffect('100.00', 100))
    expect(st.cashCents).toBeLessThan(0)
    expect(f._stores.fills[0].shares).toBe(100)
    expect(adjustRows(f)).toHaveLength(1)
  })

  test('editing a sell is rejected as immutable, state untouched', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await bookBuy(f, runId, { idx: 1, shares: 8, price: '16.00', filledOn: '2026-01-08' })
    await manualFill(runId, { side: 'sell', shares: 8, price: '17.00', fee: '0.30', filledOn: '2026-01-09' }, deps(f))

    const stateBefore = asJson(await getState(f, runId))
    const sell = f._stores.fills.find((x: any) => x.side === 'sell')
    const err = await expectKind(() => rebookFill(runId, { fillId: sell.id, shares: 4, priceStr: '15.00', feeCents: 300 }, deps(f)))

    expect(err).toBeInstanceOf(DomainError)
    expect(err.kind).toBe('immutable-field')
    expect(asJson(await getState(f, runId))).toBe(stateBefore)
    expect(adjustRows(f)).toHaveLength(0)
  })

  test('an unknown fillId fails before anything is written', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f))
    const stateBefore = asJson(await getState(f, runId))

    const err = await expectKind(() => rebookFill(runId, { fillId: 999, shares: 4, priceStr: '10.00', feeCents: 0 }, deps(f)))

    expect(err.kind).toBe('no-fill')
    expect(asJson(await getState(f, runId))).toBe(stateBefore)
    expect(adjustRows(f)).toHaveLength(0)
  })

  test('invalid edit values are rejected as an invalid fill', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f))
    const cases = [
      { shares: 0, priceStr: '10.00', feeCents: 0 },
      { shares: -3, priceStr: '10.00', feeCents: 0 },
      { shares: 1.5, priceStr: '10.00', feeCents: 0 },
      { shares: 10, priceStr: 'abc', feeCents: 0 },
      { shares: 10, priceStr: '-1.00', feeCents: 0 },
      { shares: 10, priceStr: '10.00', feeCents: -1 },
    ]
    for (const c of cases) {
      const err = await expectKind(() => rebookFill(runId, { fillId: 1, ...c }, deps(f)))
      expect(err.kind).toBe('invalid-fill')
    }
    const st = await getState(f, runId)
    expect(st.cashCents).toBe(89_500)
    expect(f._stores.fills[0].shares).toBe(10)
    expect(adjustRows(f)).toHaveLength(0)
  })
})

describe('deleteLastFill', () => {
  test('removes the newest fill and rebuilds state from the rest', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f))
    await manualFill(runId, { side: 'buy', shares: 5, price: '15.00', fee: '2.50', filledOn: '2026-01-09' }, deps(f))

    const deleted = await deleteLastFill(runId, deps(f))

    expect(deleted.id).toBe(2)
    expect(f._stores.fills).toHaveLength(1)
    expect(f._stores.fills[0].shares).toBe(10)
    const st = await getState(f, runId)
    expect(st.buckets[0]).toMatchObject({ state: 'held', shares: 10 })
    expect(st.buckets[1].state).toBe('empty')
    expect(st.cashCents).toBe(89_500)
    const adj = adjustRows(f)
    expect(adj).toHaveLength(1)
    expect(adj[0]).toMatchObject({ kind: 'adjust', amountCents: 7_750 }) // the removed buy is refunded
    expect(JSON.parse(adj[0].ref)).toEqual({ fillId: 2, bookedOn: TODAY, reason: 'fill-delete' })
  })

  test('deleteLastFill removes the newest by id even when listForRun returns scrambled order', async () => {
    const f = fakeRepos()
    scrambleListForRun(f)
    const runId = await createRun(f, 100_000, 3)
    await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f)) // id 1
    await manualFill(runId, { side: 'buy', shares: 5, price: '15.00', fee: '2.50', filledOn: '2026-01-09' }, deps(f)) // id 2
    await manualFill(runId, { side: 'buy', shares: 2, price: '20.00', fee: '1.00', filledOn: '2026-01-09' }, deps(f)) // id 3, the true newest

    const deleted = await deleteLastFill(runId, deps(f))

    expect(deleted.id).toBe(3)
    expect(f._stores.fills.map((x) => x.id)).toEqual([1, 2])
    const st = await getState(f, runId)
    expect(st.buckets[2].state).toBe('empty')
    const adj = adjustRows(f)
    expect(adj[0]).toMatchObject({ amountCents: -buyEffect('20.00', 2, 100) }) // refunds only the id-3 buy
    expect(JSON.parse(adj[0].ref)).toEqual({ fillId: 3, bookedOn: TODAY, reason: 'fill-delete' })
  })

  test('deleting the only fill returns the run to the starting pool', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f))

    await deleteLastFill(runId, deps(f))

    expect(f._stores.fills).toHaveLength(0)
    const st = await getState(f, runId)
    expect(st.cashCents).toBe(100_000)
    expect(st.buckets[0].state).toBe('empty')
    // the ledger nets back to zero: the original buy row plus a compensating adjust
    expect(f._stores.ledger.map((l: any) => [l.kind, l.amountCents])).toEqual([['buy', -10_500], ['adjust', 10_500]])
  })

  test('deleting from a run with no fills fails with no-fill', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)

    const err = await expectKind(() => deleteLastFill(runId, deps(f)))

    expect(err.kind).toBe('no-fill')
    expect((await getState(f, runId)).cashCents).toBe(100_000)
    expect(adjustRows(f)).toHaveLength(0)
  })

  test('deleting a full-close sell reopens the bucket and leaves its order filled', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 8, price: '16.00', filledOn: '2026-01-08' }, deps(f))
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-01-09', kind: 'sell_loc', bucketIdx: 0, limitPrice: parseUsd('17.00'), shares: 8, status: 'open' }])
    await manualFill(runId, { side: 'sell', shares: 8, price: '17.00', filledOn: '2026-01-09' }, deps(f))
    expect((await getState(f, runId)).closed).toHaveLength(1)

    await deleteLastFill(runId, deps(f))

    const st = await getState(f, runId)
    expect(st.buckets[0]).toMatchObject({ state: 'held', shares: 8, buyPrice: 160_000n, filledOn: '2026-01-08' })
    expect(st.closed).toHaveLength(0)
    expect(st.ages[0]).toBe(ageOf('2026-01-08'))
    expect(st.cashCents).toBe(100_000 + buyEffect('16.00', 8))
    expect(adjustRows(f)[0].amountCents).toBe(-sellEffect('17.00', 8))
    const order = f._stores.orders.find((o: any) => o.kind === 'sell_loc')
    expect(order.status).toBe('filled') // orders never reopen on delete
  })

  test('rebuildState fails loudly on a history that sells more than the bucket holds', () => {
    const buy: FillRow = {
      id: 1, runId: 1, bucketIdx: 0, side: 'buy', ticker: 'SPY', shares: 5,
      price: 160_000n, fee: 0, filledOn: '2026-01-08', source: 'manual',
    }
    const sell: FillRow = {
      id: 2, runId: 1, bucketIdx: 0, side: 'sell', ticker: 'SPY', shares: 8,
      price: 170_000n, fee: 0, filledOn: '2026-01-09', source: 'manual',
    }
    // A corrupted history (sell larger than its bucket) must not rebuild silently.
    expect(() => rebuildState([buy, sell], 100_000, TODAY, 2)).toThrow(DomainError)
    try {
      rebuildState([buy, sell], 100_000, TODAY, 2)
    } catch (e) {
      expect((e as DomainError).kind).toBe('too-many-shares')
    }
  })
})
