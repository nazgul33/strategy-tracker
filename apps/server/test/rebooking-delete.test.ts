import { describe, expect, test } from 'bun:test'
import { DomainError, parseUsd } from '@st/core'
import { manualFill, type FillRow } from '../src/domain/booking'
import { deleteFill, rebuildState } from '../src/domain/recompute'
import { fakeRepos } from './booking-fakes'
import {
  TODAY, adjustRows, ageOf, asJson, buyEffect, createRun, deps, expectKind, getState, scrambleListForRun, sellEffect,
} from './rebooking-fixture'

describe('deleteFill', () => {
  test('removes the newest fill and rebuilds state from the rest', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f))
    await manualFill(runId, { side: 'buy', shares: 5, price: '15.00', fee: '2.50', filledOn: '2026-01-09' }, deps(f))

    const res = await deleteFill(runId, 2, deps(f))

    expect(res.fill.id).toBe(2)
    expect(f._stores.fills).toHaveLength(1)
    expect(f._stores.fills[0].shares).toBe(10)
    const st = await getState(f, runId)
    expect(st.buckets[0]).toMatchObject({ state: 'held', shares: 10 })
    expect(st.buckets[1].state).toBe('empty')
    expect(st.cashCents).toBe(89_500)
    const adj = adjustRows(f)
    expect(adj).toHaveLength(1)
    expect(adj[0]).toMatchObject({ kind: 'adjust', amountCents: 7_750 }) // the removed buy is refunded
    expect(JSON.parse(adj[0].ref!)).toEqual({ fillId: 2, bookedOn: TODAY, reason: 'fill-delete' })
    expect(res.deltaCents).toBe(7_750)
  })

  test('deletes a bucket-last fill that is not the globally newest fill', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f)) // id 1, bucket 0
    await manualFill(runId, { side: 'buy', shares: 5, price: '15.00', fee: '2.50', filledOn: '2026-01-09' }, deps(f)) // id 2, bucket 1

    const res = await deleteFill(runId, 1, deps(f))

    expect(res.fill.id).toBe(1)
    expect(f._stores.fills.map((x) => x.id)).toEqual([2])
    const st = await getState(f, runId)
    expect(st.buckets[0].state).toBe('empty')
    expect(st.buckets[1]).toMatchObject({ state: 'held', shares: 5 })
    expect(st.cashCents).toBe(92_250) // 100_000 − buyEffect('15.00', 5, 250)
    const adj = adjustRows(f)
    expect(adj).toHaveLength(1)
    expect(adj[0]).toMatchObject({ kind: 'adjust', amountCents: 10_500 }) // the removed bucket-0 buy is refunded
    expect(JSON.parse(adj[0].ref!)).toEqual({ fillId: 1, bookedOn: TODAY, reason: 'fill-delete' })
    expect(res.deltaCents).toBe(10_500)
  })

  test('deleteFill removes a fill by id even when listForRun returns scrambled order', async () => {
    const f = fakeRepos()
    scrambleListForRun(f)
    const runId = await createRun(f, 100_000, 3)
    await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f)) // id 1
    await manualFill(runId, { side: 'buy', shares: 5, price: '15.00', fee: '2.50', filledOn: '2026-01-09' }, deps(f)) // id 2
    await manualFill(runId, { side: 'buy', shares: 2, price: '20.00', fee: '1.00', filledOn: '2026-01-09' }, deps(f)) // id 3, the true newest

    const res = await deleteFill(runId, 3, deps(f))

    expect(res.fill.id).toBe(3)
    expect(f._stores.fills.map((x) => x.id)).toEqual([1, 2])
    const st = await getState(f, runId)
    expect(st.buckets[2].state).toBe('empty')
    const adj = adjustRows(f)
    expect(adj[0]).toMatchObject({ amountCents: -buyEffect('20.00', 2, 100) }) // refunds only the id-3 buy
    expect(JSON.parse(adj[0].ref!)).toEqual({ fillId: 3, bookedOn: TODAY, reason: 'fill-delete' })
    expect(res.deltaCents).toBe(-buyEffect('20.00', 2, 100))
  })

  test('deleting the only fill returns the run to the starting pool', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f))

    const res = await deleteFill(runId, 1, deps(f))

    expect(res.fill.id).toBe(1)
    expect(res.deltaCents).toBe(10_500)
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

    const err = await expectKind(() => deleteFill(runId, 1, deps(f)))

    expect(err.kind).toBe('no-fill')
    expect((await getState(f, runId)).cashCents).toBe(100_000)
    expect(adjustRows(f)).toHaveLength(0)
  })

  test('an older fill of the same bucket is rejected as not-last, state untouched', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 8, price: '16.00', filledOn: '2026-01-08' }, deps(f)) // id 1, bucket 0
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-01-09', kind: 'sell_loc', bucketIdx: 0, limitPrice: parseUsd('17.00'), shares: 8, status: 'open' }])
    await manualFill(runId, { side: 'sell', shares: 8, price: '17.00', filledOn: '2026-01-09' }, deps(f)) // id 2, same bucket 0
    const stateBefore = asJson(await getState(f, runId))

    const err = await expectKind(() => deleteFill(runId, 1, deps(f)))

    expect(err.kind).toBe('not-last')
    expect(asJson(await getState(f, runId))).toBe(stateBefore)
    expect(f._stores.fills).toHaveLength(2)
    expect(adjustRows(f)).toHaveLength(0)
  })

  test('an unknown fillId fails with no-fill before anything is written', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 10, price: '10.00', fee: '5.00', filledOn: '2026-01-08' }, deps(f))
    const stateBefore = asJson(await getState(f, runId))

    const err = await expectKind(() => deleteFill(runId, 99, deps(f)))

    expect(err.kind).toBe('no-fill')
    expect(asJson(await getState(f, runId))).toBe(stateBefore)
    expect(f._stores.fills).toHaveLength(1)
    expect(adjustRows(f)).toHaveLength(0)
  })

  test('deleting a full-close sell reopens the bucket and leaves its order filled', async () => {
    const f = fakeRepos()
    const runId = await createRun(f, 100_000, 2)
    await manualFill(runId, { side: 'buy', shares: 8, price: '16.00', filledOn: '2026-01-08' }, deps(f))
    await f.repos.orderRepo.insertMany([{ runId, tradeDate: '2026-01-09', kind: 'sell_loc', bucketIdx: 0, limitPrice: parseUsd('17.00'), shares: 8, status: 'open' }])
    await manualFill(runId, { side: 'sell', shares: 8, price: '17.00', filledOn: '2026-01-09' }, deps(f))
    expect((await getState(f, runId)).closed).toHaveLength(1)

    const res = await deleteFill(runId, 2, deps(f))

    expect(res.fill.id).toBe(2)
    const st = await getState(f, runId)
    expect(st.buckets[0]).toMatchObject({ state: 'held', shares: 8, buyPrice: 160_000n, filledOn: '2026-01-08' })
    expect(st.closed).toHaveLength(0)
    expect(st.ages[0]).toBe(ageOf('2026-01-08'))
    expect(st.cashCents).toBe(100_000 + buyEffect('16.00', 8))
    expect(adjustRows(f)[0].amountCents).toBe(-sellEffect('17.00', 8))
    expect(res.deltaCents).toBe(-sellEffect('17.00', 8))
    const order = f._stores.orders.find((o) => o.kind === 'sell_loc')!
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
