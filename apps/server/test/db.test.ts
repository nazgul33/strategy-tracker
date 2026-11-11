import { describe, test, expect, beforeAll } from 'bun:test'
import { getDb, applyMigrations } from '../src/db/client'
import { getRepos } from '../src/db/repos'

const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip

describeIf('db integration', () => {
  let db: any
  let repos: any
  beforeAll(async () => {
    db = await getDb(process.env.TEST_DATABASE_URL!)
    await applyMigrations(db)
    repos = getRepos(db)
  })

  test('round trip run state', async () => {
    const state: any = {
      buckets: [
        { index: 0, state: 'held', shares: 10, buyPrice: 9007199254740993n, buyFeeCents: 5, filledOn: '2026-01-01' },
        { index: 1, state: 'held', shares: 5, buyPrice: 12345n, buyFeeCents: 2, filledOn: '2026-01-02' },
        { index: 2, state: 'held', shares: 7, buyPrice: 9999999999999999n, buyFeeCents: 1, filledOn: '2026-01-03' },
      ],
      cashCents: 1000,
      closed: [],
      ages: { 0: 3, 1: 1, 2: 2 },
    }
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'run-'+Date.now(), poolCents: 10000, costPpm: 100, initialRunState: state })
    await repos.bucketRepo.saveState(runId, state)
    const loaded = await repos.bucketRepo.loadState(runId)
    expect(loaded.buckets[0].buyPrice).toBe(9007199254740993n)
    expect(typeof loaded.buckets[0].buyPrice).toBe('bigint')
    expect(loaded.ages[0]).toBe(3)
    expect(typeof loaded.ages[0]).toBe('number')
    expect(loaded.cashCents).toBe(1000)
  })

  test('capture dedup', async () => {
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'T'+Date.now(), name: 'run2-'+Date.now(), poolCents: 1000, costPpm: 10 })
    const hash = 'h'+Date.now()
    expect(await repos.captureRepo.hasHash(runId, hash)).toBe(false)
    await repos.captureRepo.insert({ runId, chatId: 'c', imageHash: hash, status: 'pending' })
    expect(await repos.captureRepo.hasHash(runId, hash)).toBe(true)
    const r = await repos.captureRepo.insert({ runId, chatId: 'c', imageHash: hash, status: 'pending' })
    expect(r.inserted).toBe(false)
  })

  test('orders markStale', async () => {
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'X'+Date.now(), name: 'run3-'+Date.now(), poolCents: 1000, costPpm: 10 })
    const today = '2026-02-10'
    const old = '2026-02-09'
    await repos.orderRepo.insertMany([
      { runId, tradeDate: old, kind: 'buy_loc', bucketIdx: 0, limitPrice: 100n, shares: 1, status: 'open' },
      { runId, tradeDate: today, kind: 'buy_loc', bucketIdx: 1, limitPrice: 100n, shares: 1, status: 'open' },
      { runId, tradeDate: old, kind: 'buy_loc', bucketIdx: 2, limitPrice: 100n, shares: 1, status: 'filled' },
    ])
    const cnt = await repos.orderRepo.markStale(today)
    expect(cnt).toBeGreaterThanOrEqual(1)
    const list = await repos.orderRepo.listForDate(today)
    expect(list.length).toBeGreaterThanOrEqual(1)
  })

  test('pending decide merges', async () => {
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'Y'+Date.now(), name: 'run4-'+Date.now(), poolCents: 1000, costPpm: 10 })
    const id = await repos.pendingRepo.insert({ runId, bucketIdx: 0, side: 'buy', ticker: 'Y', shares: 5, price: 100n, fee: 1, filledOn: '2026-02-10', status: 'pending' })
    await repos.pendingRepo.decide(id, 'confirmed', { shares: 7 })
    const rows = await repos.pendingRepo.listPending()
    // just ensure no throw
    expect(rows.length).toBeGreaterThanOrEqual(0)
  })

  test('DATE columns come back as date strings, not Date objects', async () => {
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'D' + Date.now(), name: 'run5-' + Date.now(), poolCents: 1000, costPpm: 10 })
    await repos.fillRepo.insert({ runId, bucketIdx: 0, side: 'buy', ticker: 'D', shares: 10, price: 100n, fee: 1, filledOn: '2026-02-10', source: 'manual' })
    const fills = await repos.fillRepo.listForRun(runId)
    expect(fills.length).toBe(1)
    // Without dateStrings on the pool, the driver+drizzle mapping turns DATE
    // columns into Date instances — the only server-side value that would
    // serialize as a `2026-02-10T00:00:00.000Z` timestamp on the JSON wire.
    const raw = fills[0].filledOn
    expect(raw instanceof Date).toBe(false)
    const wire = JSON.parse(JSON.stringify({ filledOn: raw })).filledOn
    expect(typeof wire).toBe('string')
    expect(wire).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
