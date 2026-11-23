import { describe, test, expect } from 'bun:test'
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
    expect([...(await rowsNeedingBucket(f.repos, runId, [row(1, '96.50')]))]).toEqual([1])
  })

  test('the same sell typed as a stop does not', async () => {
    const { f, runId } = await sellSetup(held43, book43())
    expect((await rowsNeedingBucket(f.repos, runId, [row(1, '96.50', STOP)])).size).toBe(0)
  })

  test('a buy row is never in the set', async () => {
    const { f, runId } = await sellSetup(held43, book43())
    expect((await rowsNeedingBucket(f.repos, runId, [row(1, '96.50', NO_EVIDENCE, 'buy')])).size).toBe(0)
  })

  test('a sell no bucket can cover is not in the set and does not throw', async () => {
    const { f, runId } = await sellSetup(held43, book43())
    expect((await rowsNeedingBucket(f.repos, runId, [row(1, '96.50', NO_EVIDENCE, 'sell', 11)])).size).toBe(0)
  })

  test('one state load and one order read cover every row of the run', async () => {
    const { f, runId } = await sellSetup(held43, book43())
    let loads = 0
    let reads = 0
    const loadState = f.repos.bucketRepo.loadState.bind(f.repos.bucketRepo)
    const listForRunFrom = f.repos.orderRepo.listForRunFrom.bind(f.repos.orderRepo)
    f.repos.bucketRepo.loadState = async (id: number) => { loads++; return loadState(id) }
    f.repos.orderRepo.listForRunFrom = async (id: number, from: string) => { reads++; return listForRunFrom(id, from) }
    const set = await rowsNeedingBucket(f.repos, runId, [row(1, '96.50'), row(2, '96.50', STOP), row(3, '96.50')])
    expect([...set].sort()).toEqual([1, 3])
    expect([loads, reads]).toEqual([1, 1])
  })

  test('no rows, or no sell rows, read nothing', async () => {
    const { f, runId } = await sellSetup(held43, book43())
    f.repos.bucketRepo.loadState = async () => { throw new Error('loadState called') }
    f.repos.orderRepo.listForRunFrom = async () => { throw new Error('listForRunFrom called') }
    expect((await rowsNeedingBucket(f.repos, runId, [])).size).toBe(0)
    expect((await rowsNeedingBucket(f.repos, runId, [row(1, '96.50', NO_EVIDENCE, 'buy')])).size).toBe(0)
  })
})
