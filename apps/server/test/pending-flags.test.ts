import { describe, test, expect, spyOn } from 'bun:test'
import { parseUsd } from '@st/core/money'
import { rowsNeedingBucket } from '../src/domain/pending-flags'
import { NO_EVIDENCE, type OrderEvidence } from '../src/domain/order-type'
import { book43, D, held43, sellSetup } from './sell-fixture'

const STOP: OrderEvidence = { type: 'stop', orderPrice: null, orderedShares: null }
const row = (id: number, price: string, evidence: OrderEvidence = NO_EVIDENCE, side: 'buy' | 'sell' = 'sell', shares = 10) =>
  ({ id, side, shares, price: parseUsd(price), filledOn: D, evidence })

describe('rowsNeedingBucket', () => {
  test('an untyped sell that two buckets could have made needs a choice', async () => {
    const { f, runId } = await sellSetup(held43, book43())
    expect([...(await rowsNeedingBucket(f.repos, runId, [row(1, '96.50')], D))]).toEqual([1])
  })

  test('the same sell typed as a stop does not', async () => {
    const { f, runId } = await sellSetup(held43, book43())
    expect((await rowsNeedingBucket(f.repos, runId, [row(1, '96.50', STOP)], D)).size).toBe(0)
  })

  test('a buy row is never in the set', async () => {
    const { f, runId } = await sellSetup(held43, book43())
    expect((await rowsNeedingBucket(f.repos, runId, [row(1, '96.50', NO_EVIDENCE, 'buy')], D)).size).toBe(0)
  })

  test('a sell no bucket can cover is not in the set and does not throw', async () => {
    const { f, runId } = await sellSetup(held43, book43())
    expect((await rowsNeedingBucket(f.repos, runId, [row(1, '96.50', NO_EVIDENCE, 'sell', 11)], D)).size).toBe(0)
  })

  test('one state load and one order read cover every row of the run', async () => {
    const { f, runId } = await sellSetup(held43, book43())
    let loads = 0
    let reads = 0
    const loadState = f.repos.bucketRepo.loadState.bind(f.repos.bucketRepo)
    const listForRunFrom = f.repos.orderRepo.listForRunFrom.bind(f.repos.orderRepo)
    f.repos.bucketRepo.loadState = async (id: number) => { loads++; return loadState(id) }
    f.repos.orderRepo.listForRunFrom = async (id: number, from: string) => { reads++; return listForRunFrom(id, from) }
    const set = await rowsNeedingBucket(f.repos, runId, [row(1, '96.50'), row(2, '96.50', STOP), row(3, '96.50')], D)
    expect([...set].sort()).toEqual([1, 3])
    expect([loads, reads]).toEqual([1, 1])
  })

  test('a state passed in is used and loadState is not called', async () => {
    const { f, runId } = await sellSetup(held43, book43())
    const rows = [row(1, '96.50'), row(2, '96.50', STOP)]
    const without = await rowsNeedingBucket(f.repos, runId, rows, D)
    const state = await f.repos.bucketRepo.loadState(runId)
    f.repos.bucketRepo.loadState = async () => { throw new Error('loadState called') }
    const withState = await rowsNeedingBucket(f.repos, runId, rows, D, state)
    expect([...withState]).toEqual([...without])
    expect([...withState]).toEqual([1])
  })

  test('no rows, or no sell rows, read nothing', async () => {
    const { f, runId } = await sellSetup(held43, book43())
    f.repos.bucketRepo.loadState = async () => { throw new Error('loadState called') }
    f.repos.orderRepo.listForRunFrom = async () => { throw new Error('listForRunFrom called') }
    expect((await rowsNeedingBucket(f.repos, runId, [], D)).size).toBe(0)
    expect((await rowsNeedingBucket(f.repos, runId, [row(1, '96.50', NO_EVIDENCE, 'buy')], D)).size).toBe(0)
  })

  test('a sell dated after today is never in the set and reads nothing', async () => {
    const { f, runId } = await sellSetup(held43, book43())
    f.repos.bucketRepo.loadState = async () => { throw new Error('loadState called') }
    f.repos.orderRepo.listForRunFrom = async () => { throw new Error('listForRunFrom called') }
    expect((await rowsNeedingBucket(f.repos, runId, [{ ...row(1, '96.50'), filledOn: '2026-11-13' }], D)).size).toBe(0)
  })

  test('a future-dated row does not hide the others', async () => {
    const { f, runId } = await sellSetup(held43, book43())
    const set = await rowsNeedingBucket(f.repos, runId, [{ ...row(1, '96.50'), filledOn: '2026-11-13' }, row(2, '96.50')], D)
    expect([...set]).toEqual([2])
  })

  test('a failing read is logged and means no row needs a bucket', async () => {
    const { f, runId } = await sellSetup(held43, book43())
    f.repos.orderRepo.listForRunFrom = async () => { throw new Error('db down') }
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await rowsNeedingBucket(f.repos, runId, [row(1, '96.50')], D)).size).toBe(0)
      expect(logged).toHaveBeenCalledTimes(1)
    } finally {
      logged.mockRestore()
    }
  })
})
