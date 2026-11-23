import { describe, expect, test } from 'bun:test'
import { DomainError, parseUsd } from '@st/core'
import { progressView } from '@st/strategies'
import { manualFill, type FillRow } from '../src/domain/booking'
import { rebookFill, rebuildState } from '../src/domain/recompute'
import { fakeRepos } from './booking-fakes'
import {
  TODAY, adjustRows, ageOf, asJson, bookBuy, buyEffect, createRun, deps, expectKind, getState, scrambleListForRun, sellEffect,
} from './rebooking-fixture'

test('manualFill on a missing run rejects with run-not-found', async () => {
  const f = fakeRepos()
  await expect(manualFill(42, { side: 'buy', shares: 1, price: '1.00', filledOn: '2026-11-06' }, deps(f))).rejects.toThrow('run-not-found')
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

    const res = await rebookFill(runId, { fillId: 1, shares: 12, priceStr: '18.00', feeCents: 400 }, deps(f))

    const st = await getState(f, runId)
    expect(st.cashCents).toBe(78_000) // 100_000 − (21_600 gross + 400 fee)
    expect(st.buckets[0]).toMatchObject({ state: 'held', shares: 12, buyPrice: 180_000n, buyFeeCents: 400, filledOn: '2026-01-08' })
    expect(st.ages[0]).toBe(ageOf('2026-01-08'))
    expect(f._stores.fills).toHaveLength(1)
    expect(f._stores.fills[0]).toMatchObject({ shares: 12, price: 180_000n, fee: 400, filledOn: '2026-01-08' })
    const adj = adjustRows(f)
    expect(adj).toHaveLength(1)
    expect(adj[0]).toMatchObject({ runId, kind: 'adjust', amountCents: buyEffect('18.00', 12, 400) - buyEffect('10.00', 10, 500) }) // −22_000 − (−10_500)
    expect(JSON.parse(adj[0].ref!)).toEqual({ fillId: 1, bookedOn: TODAY, reason: 'fill-edit' })
    expect(res.fill).toMatchObject({ id: 1, runId, bucketIdx: 0, side: 'buy', shares: 12, price: 180_000n, fee: 400, filledOn: '2026-01-08' })
    expect(res.deltaCents).toBe(adj[0].amountCents)
  })

  test('rebooking to the same values leaves cash and ledger untouched', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f))

    const res = await rebookFill(runId, { fillId: 1, shares: 10, priceStr: '10.00', feeCents: 500 }, deps(f))

    const st = await getState(f, runId)
    expect(st.cashCents).toBe(89_500)
    expect(st.buckets[0]).toMatchObject({ state: 'held', shares: 10, buyPrice: 100_000n })
    expect(adjustRows(f)).toHaveLength(0)
    expect(res.fill).toMatchObject({ id: 1, shares: 10, price: 100_000n, fee: 500 })
    expect(res.deltaCents).toBe(0)
  })

  test('state is derived from the whole history, so editing the first fill is safe', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f))
    await manualFill(runId, { side: 'buy', shares: 5, price: '15.00', fee: '2.50', filledOn: '2026-01-09' }, deps(f))

    const res = await rebookFill(runId, { fillId: 1, shares: 8, priceStr: '12.00', feeCents: 300 }, deps(f))

    const st = await getState(f, runId)
    expect(st.buckets[0]).toMatchObject({ state: 'held', shares: 8, buyPrice: 120_000n, buyFeeCents: 300 })
    expect(st.buckets[1]).toMatchObject({ state: 'held', shares: 5, buyPrice: 150_000n, filledOn: '2026-01-09' })
    expect(st.cashCents).toBe(100_000 + buyEffect('12.00', 8, 300) + buyEffect('15.00', 5, 250))
    const adj = adjustRows(f)
    expect(adj).toHaveLength(1)
    expect(adj[0].amountCents).toBe(buyEffect('12.00', 8, 300) - buyEffect('10.00', 10, 500))
    expect(res.deltaCents).toBe(adj[0].amountCents)
  })

  test('editing an early fill keeps later fills — unlike the old undo path', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 3, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f))
    await manualFill(runId, { side: 'buy', shares: 20, price: '20.00', fee: '1.00', filledOn: '2026-01-09' }, deps(f))
    await manualFill(runId, { side: 'sell', shares: 10, price: '21.00', fee: '0.50', filledOn: '2026-01-12' }, deps(f))

    const res = await rebookFill(runId, { fillId: 1, shares: 12, priceStr: '18.00', feeCents: 400 }, deps(f))

    const st = await getState(f, runId)
    expect(st.buckets[0]).toMatchObject({ state: 'held', shares: 12, buyPrice: 180_000n })
    expect(st.buckets[1]).toMatchObject({ state: 'held', shares: 10, buyPrice: 200_000n })
    // One ClosedBucket row per sell tranche (partial-sell-history spec): the
    // 10-share partial against the 20-share bucket-1 buy.
    expect(st.closed).toHaveLength(1)
    expect(st.closed[0]).toMatchObject({
      index: 1,
      shares: 10,
      buyPrice: 200_000n,
      soldPrice: 210_000n,
      buyFeeCents: 50, // bucket buy fee 100c * 10/20 shares, remainder stays on the bucket
      sellFeeCents: 50,
      openedOn: '2026-01-09',
      closedOn: '2026-01-12',
    })
    expect(st.ages[0]).toBe(ageOf('2026-01-08'))
    expect(st.ages[1]).toBe(ageOf('2026-01-09'))
    expect(st.cashCents).toBe(100_000 + buyEffect('18.00', 12, 400) + buyEffect('20.00', 20, 100) + sellEffect('21.00', 10, 50))
    const adj = adjustRows(f)
    expect(adj).toHaveLength(1)
    expect(adj[0].amountCents).toBe(buyEffect('18.00', 12, 400) - buyEffect('10.00', 3, 500))
    expect(JSON.parse(adj[0].ref!).reason).toBe('fill-edit')
    expect(res.deltaCents).toBe(adj[0].amountCents)
  })

  test('resolves the target fill even when listForRun returns scrambled order', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 3)
    await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f))
    await manualFill(runId, { side: 'buy', shares: 5, price: '15.00', fee: '2.50', filledOn: '2026-01-09' }, deps(f))
    scrambleListForRun(f) // listForRun now yields fills in order [2, 1]

    const res = await rebookFill(runId, { fillId: 1, shares: 8, priceStr: '12.00', feeCents: 300 }, deps(f))

    expect(f._stores.fills.find((x: any) => x.id === 1)).toMatchObject({ shares: 8, price: 120_000n, fee: 300 })
    expect(f._stores.fills.find((x: any) => x.id === 2)).toMatchObject({ shares: 5, price: 150_000n, fee: 250 })
    const st = await getState(f, runId)
    expect(st.buckets[0]).toMatchObject({ state: 'held', shares: 8, buyPrice: 120_000n, buyFeeCents: 300 })
    expect(st.buckets[1]).toMatchObject({ state: 'held', shares: 5, buyPrice: 150_000n })
    expect(st.cashCents).toBe(100_000 + buyEffect('12.00', 8, 300) + buyEffect('15.00', 5, 250))
    const adj = adjustRows(f)
    expect(adj).toHaveLength(1)
    expect(JSON.parse(adj[0].ref!)).toEqual({ fillId: 1, bookedOn: TODAY, reason: 'fill-edit' })
    expect(res.fill).toMatchObject({ id: 1, shares: 8, price: 120_000n, fee: 300 })
    expect(res.deltaCents).toBe(adj[0].amountCents)
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

    const res = await rebookFill(runId, { fillId: 1, shares: 10, priceStr: '10.00', feeCents: 900 }, deps(f))

    const st = await getState(f, runId)
    expect(st.buckets[0].state).toBe('empty')
    expect(st.closed).toHaveLength(1)
    expect(st.closed[0]).toMatchObject({ index: 0, shares: 10, buyPrice: 100_000n, soldPrice: 200_000n, buyFeeCents: 900, sellFeeCents: 0 })
    expect(progressView(st).realizedCents).toBe(10_000 - 900) // shifted by −400 from the edited buy fee
    expect(st.cashCents).toBe(100_000 + buyEffect('10.00', 10, 900) + sellEffect('20.00', 10))
    const adj = adjustRows(f)
    expect(adj).toHaveLength(1)
    expect(adj[0].amountCents).toBe(buyEffect('10.00', 10, 900) - buyEffect('10.00', 10, 500)) // −400
    expect(JSON.parse(adj[0].ref!)).toEqual({ fillId: 1, bookedOn: TODAY, reason: 'fill-edit' })
    expect(res.deltaCents).toBe(-400)
  })

  test('an upward edit that drives cash negative persists — the run keeps going', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 2_000, 2)
    await manualFill(runId, { side: 'buy', shares: 1, price: '10.00', filledOn: '2026-01-08' }, deps(f))

    const res = await rebookFill(runId, { fillId: 1, shares: 100, priceStr: '100.00', feeCents: 0 }, deps(f))

    const st = await getState(f, runId)
    expect(st.cashCents).toBe(2_000 + buyEffect('100.00', 100))
    expect(st.cashCents).toBeLessThan(0)
    expect(f._stores.fills[0].shares).toBe(100)
    expect(adjustRows(f)).toHaveLength(1)
    expect(res.deltaCents).toBe(buyEffect('100.00', 100) - buyEffect('10.00', 1))
  })

  test('editing a sell price and fee rebuilds closed history and books one adjust', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await bookBuy(f, runId, { idx: 1, shares: 8, price: '16.00', filledOn: '2026-01-08' })
    await manualFill(runId, { side: 'sell', shares: 8, price: '17.00', fee: '0.30', filledOn: '2026-01-09' }, deps(f))

    const sell = f._stores.fills.find((x) => x.side === 'sell')!
    const res = await rebookFill(runId, { fillId: sell.id, shares: 8, priceStr: '15.00', feeCents: 25 }, deps(f))

    expect(f._stores.fills.find((x: any) => x.id === sell.id)).toMatchObject({ price: parseUsd('15.00'), fee: 25 })
    const st = await getState(f, runId)
    const closed = st.closed.find((c) => c.index === 1)
    expect(closed?.soldPrice).toBe(parseUsd('15.00'))
    const adj = adjustRows(f)
    expect(adj).toHaveLength(1)
    expect(JSON.parse(adj[0].ref!).reason).toBe('fill-edit')
    expect(res.deltaCents).toBe(sellEffect('15.00', 8, 25) - sellEffect('17.00', 8, 30))
    expect(adj[0].amountCents).toBe(res.deltaCents)
  })

  test('a sell qty above what the bucket holds is rejected, nothing persisted', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await bookBuy(f, runId, { idx: 1, shares: 8, price: '16.00', filledOn: '2026-01-08' })
    await manualFill(runId, { side: 'sell', shares: 8, price: '17.00', fee: '0.30', filledOn: '2026-01-09' }, deps(f))

    const stateBefore = asJson(await getState(f, runId))
    const sell = f._stores.fills.find((x) => x.side === 'sell')!
    const sellBefore = asJson(sell)
    const err = await expectKind(() => rebookFill(runId, { fillId: sell.id, shares: 9, priceStr: '17.00', feeCents: 30 }, deps(f)))

    expect(err).toBeInstanceOf(DomainError)
    expect(err.kind).not.toBe('immutable-field')
    expect(asJson(await getState(f, runId))).toBe(stateBefore)
    expect(adjustRows(f)).toHaveLength(0)
    expect(asJson(f._stores.fills.find((x: any) => x.id === sell.id))).toBe(sellBefore)
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

  test('rebooking the trade date recomputes bucket age and persists the date', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await bookBuy(f, runId, { idx: 0, shares: 10, price: '10.00', feeCents: 500, filledOn: '2026-01-14' })
    expect((await getState(f, runId)).ages[0]).toBe(ageOf('2026-01-14'))
    const res = await rebookFill(runId, { fillId: 1, shares: 10, priceStr: '10.00', feeCents: 500, filledOn: '2026-01-08' }, deps(f))
    expect(res.fill.filledOn).toBe('2026-01-08')
    expect(res.deltaCents).toBe(0) // same shares/price/fee: cash effect is only the age shift
    expect(f._stores.fills.find((x: any) => x.id === 1)).toMatchObject({ filledOn: '2026-01-08', shares: 10 })
    const st = await getState(f, runId)
    expect(st.ages[0]).toBe(ageOf('2026-01-08'))
    expect(ageOf('2026-01-08')).toBeGreaterThan(ageOf('2026-01-14')) // the age really moved
  })
})
