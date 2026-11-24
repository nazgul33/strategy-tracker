import { describe, test, expect, beforeAll } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { sql, type SQL } from 'drizzle-orm'
import { getDb, applyMigrations } from '../src/db/client'
import type { Db } from '../src/db/db-type'
import { getRepos } from '../src/db/repos'
import type { PendingDecisionPatch } from '../src/domain/booking'
import type { NewOrder, OrderStatus } from '../src/domain/repo-types'
import { NO_SNAPSHOT } from './booking-fakes'

const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip

describeIf('db integration', () => {
  let db: Db
  let repos: ReturnType<typeof getRepos>
  beforeAll(async () => {
    db = await getDb(process.env.TEST_DATABASE_URL!)
    await applyMigrations(db)
    repos = getRepos(db)
  })

  // The driver returns [rows, fields] for a SELECT; drizzle types raw execute as the write header.
  async function selectRows<T>(q: SQL): Promise<T[]> {
    const [rows] = (await db.execute(q)) as unknown as [T[], unknown]
    return rows
  }

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
    expect(await repos.captureRepo.findByHash(runId, hash)).toBeNull()
    await repos.captureRepo.insert({ runId, chatId: 'c', imageHash: hash, status: 'pending' })
    const found = await repos.captureRepo.findByHash(runId, hash)
    expect(found).toEqual({ id: expect.any(Number), status: 'pending' })
    await repos.captureRepo.setStatus(found!.id, 'parsed')
    expect((await repos.captureRepo.findByHash(runId, hash))!.status).toBe('parsed')
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
    const id = await repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: 0, side: 'buy', ticker: 'Y', shares: 5, price: 100n, fee: 1, filledOn: '2026-02-10', status: 'pending', ...NO_SNAPSHOT })
    const inserted = (await repos.pendingRepo.get(id))!
    const patch: PendingDecisionPatch = { side: inserted.side, shares: 7, price: inserted.price, fee: inserted.fee ?? 0, filledOn: inserted.filledOn, bucketIdx: inserted.bucketIdx ?? 0 }
    const first = await repos.pendingRepo.decide(id, 'confirmed', patch)
    expect(first).toBe(true)
    const rows = await repos.pendingRepo.listPending()
    // the decided row must no longer be pending for this run
    expect(rows.filter((r) => r.runId === runId).length).toBe(0)
    // second decide (any status) is a no-op: atomic pending-state guard
    const second = await repos.pendingRepo.decide(id, 'rejected')
    expect(second).toBe(false)
    const after = await repos.pendingRepo.get(id)
    expect(after!.status).toBe('confirmed')
    expect(Number(after!.shares)).toBe(7)
  })

  test('pendingRepo.insert returns the new row id', async () => {
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'P' + Date.now(), name: 'run-pid-' + Date.now(), poolCents: 1000, costPpm: 10 })
    const id = await repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: 0, side: 'buy', ticker: 'P', shares: 5, price: 100n, fee: 1, filledOn: '2026-02-10', status: 'pending', ...NO_SNAPSHOT })
    expect(Number.isInteger(id) && id > 0).toBe(true)
    expect((await repos.pendingRepo.get(id))!.id).toBe(id)
  })

  test('runRepo.updateStatusMany returns the number of rows it moved', async () => {
    const mk = (n: string) => repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'M' + Date.now(), name: `run-many-${n}-${Date.now()}`, poolCents: 1000, costPpm: 10 })
    const a = await mk('a')
    const b = await mk('b')
    expect(await repos.runRepo.updateStatusMany([a, b, 999999999], ['active'], 'paused')).toBe(2)
    expect(await repos.runRepo.updateStatusMany([a, b, 999999999], ['active'], 'paused')).toBe(0)
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
    expect((raw as unknown) instanceof Date).toBe(false)
    const wire = JSON.parse(JSON.stringify({ filledOn: raw })).filledOn
    expect(typeof wire).toBe('string')
    expect(wire).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('0002 migration rewrites done rows before shrinking the enum', async () => {
    // widen back to the legacy enum so a `done` row is insertable again
    await db.execute(sql.raw(`ALTER TABLE strategy_runs MODIFY status enum('active','paused','closed','done') NOT NULL DEFAULT 'active'`))
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'M', name: 'done-' + Date.now(), poolCents: 100, costPpm: 10 })
    await db.execute(sql.raw(`UPDATE strategy_runs SET status = 'done' WHERE id = ${runId}`))
    const migrationsDir = new URL('../db/migrations/', import.meta.url)
    const candidates: string[] = []
    for await (const path of new Bun.Glob('0002_*.sql').scan({ cwd: fileURLToPath(migrationsDir) })) {
      candidates.push(path)
    }
    const fileName = candidates.sort()[0] // deterministic: earliest 0002_* tag wins
    expect(fileName).toBeDefined()
    // replay exactly the chunks drizzle's migrator executes: statements separated by `--> statement-breakpoint`
    const text = await Bun.file(new URL(fileName!, migrationsDir)).text()
    for (const chunk of text.split('--> statement-breakpoint')) {
      const stmt = chunk.trim()
      if (stmt === '') continue
      await db.execute(sql.raw(stmt))
    }
    expect((await repos.runRepo.get(runId))!.status).toBe('closed')
    // enum is really narrower again: writing `done` must now be rejected
    let rejected = false
    try { await db.execute(sql.raw(`UPDATE strategy_runs SET status = 'done' WHERE id = ${runId}`)) } catch { rejected = true }
    expect(rejected).toBe(true)
  })

  test('price history: upsert is idempotent, listForTicker merges runs', async () => {
    const ticker = 'PH' + Date.now()
    const first = await repos.priceHistoryRepo.upsertMany([
      { ticker, tradeDate: '2026-02-10', close: 11000000n },
      { ticker, tradeDate: '2026-02-11', close: 11100000n },
    ])
    expect(first).toBe(2)
    const second = await repos.priceHistoryRepo.upsertMany([
      { ticker, tradeDate: '2026-02-10', close: 11050000n }, // revised close
      { ticker, tradeDate: '2026-02-11', close: 11100000n },
    ])
    expect(second).toBe(2)

    let rows = await repos.priceHistoryRepo.listForTicker(ticker)
    expect(rows.map((r) => r.tradeDate)).toEqual(['2026-02-10', '2026-02-11'])
    expect(rows[0].close).toBe(11050000n)

    const other = await repos.priceHistoryRepo.listForTicker(ticker, '2026-02-11')
    expect(other.length).toBe(1)
    expect(other[0].tradeDate).toBe('2026-02-11')
    expect(await repos.priceHistoryRepo.listForTicker('NOPE' + Date.now())).toEqual([])

    // DATE column must arrive as a plain ISO string, never a Date instance
    expect((rows[0].tradeDate as unknown) instanceof Date).toBe(false)
  })

  test('order cancel reason round trip', async () => {
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'RT' + Date.now(), name: `rt-cancel-${Date.now()}`, poolCents: 1000, costPpm: 10 })
    await repos.orderRepo.insertMany([{
      runId, tradeDate: '2026-11-11', kind: 'sell_loc', bucketIdx: 0,
      limitPrice: 35000000n, shares: 5, status: 'open',
    }])
    const rows = await repos.orderRepo.listForDate('2026-11-11')
    const open = rows.find((o) => o.runId === runId)!
    expect(open).toBeTruthy()
    expect(open!.cancelReason).toBeNull()

    const fetched = await repos.orderRepo.get(open.id)
    expect(fetched!.id).toBe(open.id)
    expect(await repos.orderRepo.get(999999999)).toBeNull()

    await repos.orderRepo.setStatus(open.id, 'cancelled', 'stale-price')
    const after = await repos.orderRepo.get(open.id)
    expect(after!.status).toBe('cancelled')
    expect(after!.cancelReason).toBe('stale-price')

    await repos.orderRepo.setStatus(open.id, 'open') // legacy call: must not clear nor set a reason
    expect((await repos.orderRepo.get(open.id))!.cancelReason).toBe('stale-price')
  })

  test('orderRepo.listForRunFrom bounds by trade date and run', async () => {
    const uniq = Date.now()
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'LF' + uniq, name: 'from-' + uniq, poolCents: 1000, costPpm: 10 })
    const otherId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'LG' + uniq, name: 'from-other-' + uniq, poolCents: 1000, costPpm: 10 })
    const mk = (id: number, tradeDate: string, status: OrderStatus): NewOrder => ({ runId: id, tradeDate, kind: 'sell_loc', bucketIdx: 0, limitPrice: 35000000n, shares: 5, status })
    await repos.orderRepo.insertMany([
      mk(runId, '2026-11-11', 'open'), mk(runId, '2026-11-09', 'open'), mk(runId, '2026-11-10', 'cancelled'), mk(otherId, '2026-11-10', 'open'),
    ])
    const rows = await repos.orderRepo.listForRunFrom(runId, '2026-11-10')
    expect(rows.map((o) => o.tradeDate).sort()).toEqual(['2026-11-10', '2026-11-11'])
    expect(rows.every((o) => o.runId === runId)).toBe(true)
    expect(rows.map((o) => o.id)).toEqual([...rows.map((o) => o.id)].sort((a, b) => a - b))
  })

  test('fillRepo: update is run-scoped, listForRun is id-ascending, deleteById is run-scoped', async () => {
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'FE' + Date.now(), name: 'fill-edit-' + Date.now(), poolCents: 1000, costPpm: 10 })
    const otherId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'FX' + Date.now(), name: 'fill-edit-other-' + Date.now(), poolCents: 1000, costPpm: 10 })
    await repos.fillRepo.insert({ runId, bucketIdx: 0, side: 'buy', ticker: 'F', shares: 10, price: 1000000n, fee: 5, filledOn: '2026-01-05', source: 'manual' })
    await repos.fillRepo.insert({ runId, bucketIdx: 1, side: 'buy', ticker: 'F', shares: 20, price: 2000000n, fee: 7, filledOn: '2026-01-06', source: 'manual' })
    await repos.fillRepo.insert({ runId: otherId, bucketIdx: 0, side: 'buy', ticker: 'F', shares: 30, price: 3000000n, fee: 9, filledOn: '2026-01-07', source: 'manual' })

    let fills = await repos.fillRepo.listForRun(runId)
    expect(fills.length).toBe(2)
    expect(fills.map((f) => f.shares)).toEqual([10, 20])

    // update the older fill's shares/price/fee — price is bigint myriadths
    const olderId = fills[0].id
    await repos.fillRepo.update(runId, olderId, { shares: 12, price: 1800000n, fee: 400 })
    fills = await repos.fillRepo.listForRun(runId)
    const updated = fills.find((f) => f.id === olderId)!
    expect(updated.shares).toBe(12)
    expect(updated.price).toBe(1800000n)
    expect(typeof updated.price).toBe('bigint')
    expect(updated.fee).toBe(400)
    const untouched = fills.find((f) => f.id !== olderId)!
    expect(untouched.shares).toBe(20)
    expect(untouched.price).toBe(2000000n)
    expect(untouched.fee).toBe(7)

    // a fillId from a different run must not be touched
    const foreignId = (await repos.fillRepo.listForRun(otherId))[0].id
    await repos.fillRepo.update(runId, foreignId, { shares: 999 })
    const foreignAfter = await repos.fillRepo.listForRun(otherId)
    expect(foreignAfter.length).toBe(1)
    expect(foreignAfter[0].shares).toBe(30)
    expect((await repos.fillRepo.listForRun(runId)).length).toBe(2)

    // ascending id order is guaranteed by SQL, not by insertion luck: shove
    // the older row's id past the newer row's and re-read
    const before = await repos.fillRepo.listForRun(runId)
    const lo = before[0].id
    const hi = before[1].id
    await db.execute(sql.raw(`UPDATE mr_fills SET id = ${hi + 10} WHERE id = ${lo}`))
    const shuffled = await repos.fillRepo.listForRun(runId)
    expect(shuffled.map((f) => f.id)).toEqual([hi, hi + 10])
    expect(shuffled.map((f) => f.shares)).toEqual([20, 12])

    // deleteById is run-scoped: a foreign id must not touch either run
    await repos.fillRepo.deleteById(runId, foreignId)
    expect((await repos.fillRepo.listForRun(runId)).map((f) => f.id)).toEqual([hi, hi + 10])
    expect((await repos.fillRepo.listForRun(otherId)).length).toBe(1)

    // own id deletes exactly that row, not merely the newest
    await repos.fillRepo.deleteById(runId, hi)
    let after = await repos.fillRepo.listForRun(runId)
    expect(after.length).toBe(1)
    expect(after[0].id).toBe(hi + 10)
    expect(after[0].shares).toBe(12)
    expect((await repos.fillRepo.listForRun(otherId)).length).toBe(1)

    // a not-present id is a harmless no-op
    await repos.fillRepo.deleteById(runId, 99999999)
    expect((await repos.fillRepo.listForRun(runId)).map((f) => f.id)).toEqual([hi + 10])

    // empties the run, and a repeat call on the now-empty run is a no-op
    await repos.fillRepo.deleteById(runId, hi + 10)
    expect(await repos.fillRepo.listForRun(runId)).toEqual([])
    await repos.fillRepo.deleteById(runId, hi + 10)
    expect(await repos.fillRepo.listForRun(runId)).toEqual([])
  })
})
