import { describe, test, expect, beforeAll } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { emptyState, parseUsd } from '@st/core'
import type { ExtractResult } from '@st/ingest'
import { getDb, applyMigrations } from '../src/db/client'
import { getRepos } from '../src/db/repos'
import { ingestCapture, manualFill, type BookingDeps } from '../src/domain/booking'
import { listOpenCorrections, applyCorrection } from '../src/domain/corrections'

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
    const id = await repos.pendingRepo.insert({ runId, bucketIdx: 0, side: 'buy', ticker: 'Y', shares: 5, price: 100n, fee: 1, filledOn: '2026-02-10', status: 'pending' })
    const first = await repos.pendingRepo.decide(id, 'confirmed', { shares: 7 })
    expect(first).toBe(true)
    const rows = await repos.pendingRepo.listPending()
    // the decided row must no longer be pending for this run
    expect(rows.filter((r: any) => r.runId === runId).length).toBe(0)
    // second decide (any status) is a no-op: atomic pending-state guard
    const second = await repos.pendingRepo.decide(id, 'rejected')
    expect(second).toBe(false)
    const after = await repos.pendingRepo.get(id)
    expect(after.status).toBe('confirmed')
    expect(Number(after.shares)).toBe(7)
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
    expect((await repos.runRepo.get(runId)).status).toBe('closed')
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
    expect(rows.map((r: any) => r.tradeDate)).toEqual(['2026-02-10', '2026-02-11'])
    expect(rows[0].close).toBe(11050000n)

    const other = await repos.priceHistoryRepo.listForTicker(ticker, '2026-02-11')
    expect(other.length).toBe(1)
    expect(other[0].tradeDate).toBe('2026-02-11')
    expect(await repos.priceHistoryRepo.listForTicker('NOPE' + Date.now())).toEqual([])

    // DATE column must arrive as a plain ISO string, never a Date instance
    expect(rows[0].tradeDate instanceof Date).toBe(false)
  })

  test('order cancel reason round trip', async () => {
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'RT' + Date.now(), name: `rt-cancel-${Date.now()}`, poolCents: 1000, costPpm: 10 })
    await repos.orderRepo.insertMany([{
      runId, tradeDate: '2026-11-11', kind: 'sell_loc', bucketIdx: 0,
      limitPrice: 35000000n, shares: 5, status: 'open',
    }])
    const rows = await repos.orderRepo.listForDate('2026-11-11')
    const open = rows.find((o: any) => o.runId === runId)
    expect(open).toBeTruthy()
    expect(open.cancelReason).toBeNull()

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

  test('fillRepo: update is run-scoped, listForRun is id-ascending, deleteById is run-scoped', async () => {
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'FE' + Date.now(), name: 'fill-edit-' + Date.now(), poolCents: 1000, costPpm: 10 })
    const otherId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'FX' + Date.now(), name: 'fill-edit-other-' + Date.now(), poolCents: 1000, costPpm: 10 })
    await repos.fillRepo.insert({ runId, bucketIdx: 0, side: 'buy', ticker: 'F', shares: 10, price: 1000000n, fee: 5, filledOn: '2026-01-05', source: 'manual' })
    await repos.fillRepo.insert({ runId, bucketIdx: 1, side: 'buy', ticker: 'F', shares: 20, price: 2000000n, fee: 7, filledOn: '2026-01-06', source: 'manual' })
    await repos.fillRepo.insert({ runId: otherId, bucketIdx: 0, side: 'buy', ticker: 'F', shares: 30, price: 3000000n, fee: 9, filledOn: '2026-01-07', source: 'manual' })

    let fills = await repos.fillRepo.listForRun(runId)
    expect(fills.length).toBe(2)
    expect(fills.map((f: any) => f.shares)).toEqual([10, 20])

    // update the older fill's shares/price/fee — price is bigint myriadths
    const olderId = fills[0].id
    await repos.fillRepo.update(runId, olderId, { shares: 12, price: 1800000n, fee: 400 })
    fills = await repos.fillRepo.listForRun(runId)
    const updated = fills.find((f: any) => f.id === olderId)
    expect(updated.shares).toBe(12)
    expect(updated.price).toBe(1800000n)
    expect(typeof updated.price).toBe('bigint')
    expect(updated.fee).toBe(400)
    const untouched = fills.find((f: any) => f.id !== olderId)
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
    await db.execute(sql.raw(`UPDATE fills SET id = ${hi + 10} WHERE id = ${lo}`))
    const shuffled = await repos.fillRepo.listForRun(runId)
    expect(shuffled.map((f: any) => f.id)).toEqual([hi, hi + 10])
    expect(shuffled.map((f: any) => f.shares)).toEqual([20, 12])

    // deleteById is run-scoped: a foreign id must not touch either run
    await repos.fillRepo.deleteById(runId, foreignId)
    expect((await repos.fillRepo.listForRun(runId)).map((f: any) => f.id)).toEqual([hi, hi + 10])
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
    expect((await repos.fillRepo.listForRun(runId)).map((f: any) => f.id)).toEqual([hi + 10])

    // empties the run, and a repeat call on the now-empty run is a no-op
    await repos.fillRepo.deleteById(runId, hi + 10)
    expect(await repos.fillRepo.listForRun(runId)).toEqual([])
    await repos.fillRepo.deleteById(runId, hi + 10)
    expect(await repos.fillRepo.listForRun(runId)).toEqual([])
  })

  test('ingestCapture dedups against real booked fills and pending rows', async () => {
    const ticker = 'DD' + Date.now()
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: 'dedup-' + Date.now(), poolCents: 1_000_000, costPpm: 10 })
    // one booked buy (bigint myriadths price) + one pending sell, as the real repos store them
    await repos.fillRepo.insert({ runId, bucketIdx: 0, side: 'buy', ticker, shares: 11, price: parseUsd('218.55'), fee: 0, filledOn: '2026-11-12', source: 'capture' })
    await repos.pendingRepo.insert({ runId, bucketIdx: null, side: 'sell', ticker, shares: 270, price: parseUsd('65.53'), fee: 345, filledOn: '2026-11-12', status: 'pending' })

    const deps: BookingDeps = { repos, today: '2026-11-15' }
    // extraction spells the same two trades with string prices — the dedup key
    // must canonicalize across the DB bigint and the extract string
    const ext: ExtractResult = {
      ok: true,
      fills: [
        { side: 'buy', ticker, shares: 11, price: '218.55', date: '2026-11-12' },
        { side: 'sell', ticker, shares: 270, price: '65.53', date: '2026-11-12' },
      ],
    }
    const out = await ingestCapture(runId, { base64: 'DEDUP-REAL-' + Date.now(), mime: 'image/png' }, ext, deps)
    expect(out).toBe('duplicate')

    const rows = await repos.pendingRepo.listPending()
    expect(rows.filter((r: any) => r.runId === runId).length).toBe(1) // the seeded row only

    const [capRows] = await db.execute(sql`SELECT status FROM captures WHERE run_id = ${runId}`)
    expect(capRows.length).toBe(1)
    expect(capRows[0].status).toBe('parsed')
  })

  test('mixed capture stores only the fresh fill as pending', async () => {
    const ticker = 'MX' + Date.now()
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: 'dedup-mixed-' + Date.now(), poolCents: 1_000_000, costPpm: 10 })
    await repos.fillRepo.insert({ runId, bucketIdx: 0, side: 'buy', ticker, shares: 11, price: parseUsd('218.55'), fee: 0, filledOn: '2026-11-12', source: 'capture' })

    const deps: BookingDeps = { repos, today: '2026-11-15' }
    const ext: ExtractResult = {
      ok: true,
      fills: [
        { side: 'buy', ticker, shares: 11, price: '218.55', date: '2026-11-12' }, // already booked → dropped
        { side: 'sell', ticker, shares: 270, price: '65.53', date: '2026-11-12' }, // fresh → stored
      ],
    }
    const out: any = await ingestCapture(runId, { base64: 'DEDUP-MIXED-' + Date.now(), mime: 'image/png' }, ext, deps)
    expect(Array.isArray(out.pending)).toBe(true)
    expect(out.pending.length).toBe(1)
    expect(out.pending[0].side).toBe('sell')
    expect(out.pending[0].shares).toBe(270)
    expect(out.pending[0].price).toBe('65.53')

    const rows = await repos.pendingRepo.listPending()
    const mine = rows.filter((r: any) => r.runId === runId)
    expect(mine.length).toBe(1)
    expect(mine[0].side).toBe('sell')
    expect(Number(mine[0].shares)).toBe(270)
    expect(mine[0].filledOn).toBe('2026-11-12')
  })

  test('ingestCapture reports a conflict when a re-detected fill matches a booked fill except for price', async () => {
    const ticker = 'CF' + Date.now()
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: 'conflict-' + Date.now(), poolCents: 1_000_000, costPpm: 10 })
    // booked sell carrying a price typo, stored as bigint myriadths like every real fill
    await repos.fillRepo.insert({ runId, bucketIdx: 0, side: 'sell', ticker, shares: 44, price: parseUsd('66.03'), fee: 0, filledOn: '2026-11-11', source: 'manual' })

    const deps: BookingDeps = { repos, today: '2026-11-15' }
    const ext: ExtractResult = { ok: true, fills: [{ side: 'sell', ticker, shares: 44, price: '64.07', date: '2026-11-11' }] }
    const out: any = await ingestCapture(runId, { base64: 'CONFLICT-REAL-' + Date.now(), mime: 'image/png' }, ext, deps)

    const conflicts: Array<Record<string, unknown>> = out.conflicts
    expect(conflicts.length).toBe(1)
    expect(conflicts[0]!.extractedPrice).toBe('64.07')
    expect(conflicts[0]!.bookedPrice).toBe('66.03')
    expect(typeof conflicts[0]!.bookedId).toBe('number')
    expect(conflicts[0]!.pendingId).toBeNull()
    const left = (await repos.pendingRepo.listPending()).filter((p: any) => p.runId === runId)
    expect(left.length).toBe(0)
  })

  test('ingestCapture re-reads a seen image after its fill was rejected', async () => {
    const ticker = 'RU' + Date.now()
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: 'reupload-' + Date.now(), poolCents: 1_000_000, costPpm: 10 })
    const deps: BookingDeps = { repos, today: '2026-11-15' }
    const ext: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker, shares: 11, price: '218.55', date: '2026-11-12' }] }
    const image = { base64: 'REUP-REAL-' + Date.now(), mime: 'image/png' }

    const first: any = await ingestCapture(runId, image, ext, deps)
    expect(first.pending.length).toBe(1)
    expect(await repos.pendingRepo.decide(first.pending[0].id, 'rejected')).toBe(true)

    const second: any = await ingestCapture(runId, image, ext, deps)
    expect(second.pending.length).toBe(1)

    const [capRows] = await db.execute(sql`SELECT id, status FROM captures WHERE run_id = ${runId}`)
    expect(capRows.length).toBe(1)
    expect(capRows[0].status).toBe('parsed')
    const captureId = capRows[0].id

    const [pendRows] = await db.execute(sql`SELECT capture_id, status FROM pending_fills WHERE run_id = ${runId} ORDER BY id`)
    expect(pendRows.map((r: any) => ({ capture_id: r.capture_id, status: r.status }))).toEqual([
      { capture_id: captureId, status: 'rejected' },
      { capture_id: captureId, status: 'pending' },
    ])
  })

  test('pending repo: hasLiveForCapture / hasConfirmedForCapture look at one capture and one status', async () => {
    const uniq = Date.now()
    const ticker = 'HL' + uniq
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: 'haslive-' + uniq, poolCents: 1_000_000, costPpm: 10 })
    const row = (captureId: number | null) => ({ runId, captureId, bucketIdx: null, side: 'buy', ticker, shares: 1, price: 100n, fee: null, filledOn: '2026-11-12', status: 'pending' })
    // real capture rows: auto-increment ids are fresh on every run, so a confirmed row left behind in st_test can never collide
    const newCapture = async (tag: string) => (await repos.captureRepo.insert({ runId, chatId: null, imageHash: `HL-${tag}-${uniq}`, status: 'parsed' })).id as number
    const capA = await newCapture('a')
    const capB = await newCapture('b')
    expect(await repos.pendingRepo.hasLiveForCapture(capA)).toBe(false)
    expect(await repos.pendingRepo.hasConfirmedForCapture(capA)).toBe(false)

    const idA = await repos.pendingRepo.insert(row(capA))
    await repos.pendingRepo.insert(row(null))
    expect(await repos.pendingRepo.hasLiveForCapture(capA)).toBe(true)
    expect(await repos.pendingRepo.hasConfirmedForCapture(capA)).toBe(false)
    expect(await repos.pendingRepo.hasLiveForCapture(capB)).toBe(false)

    expect(await repos.pendingRepo.decide(idA, 'confirmed')).toBe(true)
    expect(await repos.pendingRepo.hasLiveForCapture(capA)).toBe(false)
    expect(await repos.pendingRepo.hasConfirmedForCapture(capA)).toBe(true)

    const idB = await repos.pendingRepo.insert(row(capB))
    expect(await repos.pendingRepo.decide(idB, 'rejected')).toBe(true)
    expect(await repos.pendingRepo.hasLiveForCapture(capB)).toBe(false)
    expect(await repos.pendingRepo.hasConfirmedForCapture(capB)).toBe(false)
  })

  test('ingestCapture flags a re-read of a capture that already has a confirmed row', async () => {
    const ticker = 'BE' + Date.now()
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: 'booked-earlier-' + Date.now(), poolCents: 1_000_000, costPpm: 10 })
    const deps: BookingDeps = { repos, today: '2026-11-15' }
    const image = { base64: 'BOOKED-EARLIER-' + Date.now(), mime: 'image/png' }
    const dated: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker, shares: 11, price: '218.55', date: '2026-11-12' }] }
    const undated: ExtractResult = { ok: true, fills: [{ side: 'buy', ticker, shares: 11, price: '218.55' }] }

    const first: any = await ingestCapture(runId, image, dated, deps)
    expect(first.bookedEarlier).toBeUndefined()
    expect(await repos.pendingRepo.decide(first.pending[0].id, 'confirmed')).toBe(true)

    // the date went missing on the re-read, so the matcher cannot recognise the trade
    const second: any = await ingestCapture(runId, image, undated, deps)
    expect(second.pending.length).toBe(1)
    expect(second.bookedEarlier).toBe(true)
  })

  test('correction repo: insert, listBlocking, decide, hasOpenForCapture', async () => {
    const uniq = Date.now()
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'CR' + uniq, name: 'corr-' + uniq, poolCents: 1_000_000, costPpm: 10 })
    const fillId = 1000 + (uniq % 1_000_000)
    const captureId = 2000 + (uniq % 1_000_000)
    const input = {
      runId, fillId, captureId, side: 'sell' as const, ticker: 'CR' + uniq,
      bookedShares: 270, bookedFilledOn: '2026-11-12', bookedPrice: parseUsd('64.70'), bookedFee: 345,
      proposedPrice: parseUsd('64.07'), proposedFee: 340,
    }
    const id = await repos.correctionRepo.insert(input)
    expect(typeof id).toBe('number')

    const row = await repos.correctionRepo.get(id)
    expect(row).toMatchObject({ id, ...input, status: 'open' })
    expect(typeof row.bookedPrice).toBe('bigint')
    expect(typeof row.proposedPrice).toBe('bigint')
    expect(typeof row.createdAt).toBe('string')
    expect((await repos.correctionRepo.listOpen()).some((c: any) => c.id === id)).toBe(true)

    expect((await repos.correctionRepo.listBlocking(fillId, parseUsd('64.07'))).map((c: any) => c.id)).toEqual([id])
    expect(await repos.correctionRepo.listBlocking(fillId, parseUsd('64.70'))).toEqual([])
    expect(await repos.correctionRepo.hasOpenForCapture(captureId)).toBe(true)

    expect(await repos.correctionRepo.decide(id, 'dismissed')).toBe(true)
    const blocking = await repos.correctionRepo.listBlocking(fillId, parseUsd('64.07'))
    expect(blocking.map((c: any) => [c.id, c.status])).toEqual([[id, 'dismissed']])
    const id3 = await repos.correctionRepo.insert(input)
    expect((await repos.correctionRepo.listBlocking(fillId, parseUsd('64.07'))).map((c: any) => [c.id, c.status])).toEqual([[id, 'dismissed'], [id3, 'open']])
    expect(await repos.correctionRepo.decide(id3, 'applied')).toBe(true)
    expect(await repos.correctionRepo.hasOpenForCapture(captureId)).toBe(false)
    expect((await repos.correctionRepo.listOpen()).some((c: any) => c.id === id)).toBe(false)
    expect(await repos.correctionRepo.decide(id, 'applied')).toBe(false)

    const id2 = await repos.correctionRepo.insert({ ...input, captureId: null, proposedPrice: parseUsd('63.50'), proposedFee: null })
    expect((await repos.correctionRepo.get(id2))?.proposedFee).toBeNull()
    expect((await repos.correctionRepo.get(id2))?.captureId).toBeNull()
    expect(await repos.correctionRepo.decide(id2, 'applied')).toBe(true)
    expect(await repos.correctionRepo.listBlocking(fillId, parseUsd('63.50'))).toEqual([])
  })

  test('capture conflict becomes a correction that fixes the booked sell', async () => {
    const uniq = Date.now()
    const ticker = 'FC' + uniq
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: 'fillcorr-' + uniq, poolCents: 1_000_000, costPpm: 10,
      initialRunState: { buckets: emptyState(10).buckets, cashCents: 1_000_000, closed: [], ages: {} } })
    const deps: BookingDeps = { repos, today: '2026-11-15' }

    await manualFill(runId, { side: 'buy', shares: 88, price: '56.06', filledOn: '2026-11-10' }, deps)
    await manualFill(runId, { side: 'sell', shares: 44, price: '66.03', fee: '2.03', filledOn: '2026-11-11' }, deps)
    await manualFill(runId, { side: 'sell', shares: 44, price: '65.53', fee: '2.07', filledOn: '2026-11-12' }, deps)
    const bookedBefore = await repos.fillRepo.listForRun(runId)
    expect(bookedBefore.length).toBe(3)

    const ext: ExtractResult = {
      ok: true,
      fills: [
        { side: 'buy', ticker, shares: 88, price: '56.06', fee: '3.45', date: '2026-11-10' },
        { side: 'sell', ticker, shares: 44, price: '64.07', fee: '2.03', date: '2026-11-11' },
        { side: 'sell', ticker, shares: 44, price: '65.53', fee: '2.07', date: '2026-11-12' },
        { side: 'buy', ticker, shares: 78, price: '58.32', fee: '3.18', date: '2026-11-13' },
      ],
    }
    const image = { base64: 'FC-REAL-' + uniq, mime: 'image/png' }
    const first: any = await ingestCapture(runId, image, ext, deps)
    expect(first.pending.length).toBe(1)
    expect(first.pending[0].side).toBe('buy')
    expect(first.pending[0].shares).toBe(78)
    expect(first.conflicts.length).toBe(1)
    expect(first.conflicts[0].bookedPrice).toBe('66.03')
    expect(first.conflicts[0].extractedPrice).toBe('64.07')
    expect(first.conflicts[0].correction.status).toBe('open')
    const correctionId: number = first.conflicts[0].correction.id

    const open = (await listOpenCorrections(deps)).filter((c) => c.runId === runId)
    expect(open.length).toBe(1)
    expect(open[0]!.id).toBe(correctionId)
    expect(open[0]!.stale).toBe(false)

    await applyCorrection(correctionId, deps)
    const after = await repos.fillRepo.listForRun(runId)
    expect(after.length).toBe(bookedBefore.length)
    const sell1111 = after.find((f: any) => f.side === 'sell' && f.filledOn === '2026-11-11')
    expect(sell1111).toBeDefined()
    expect(sell1111.price).toBe(parseUsd('64.07'))
    const buy1110 = after.find((f: any) => f.side === 'buy' && f.filledOn === '2026-11-10')
    expect(buy1110).toBeDefined()
    expect(buy1110.price).toBe(parseUsd('56.06'))
    const sell1112 = after.find((f: any) => f.side === 'sell' && f.filledOn === '2026-11-12')
    expect(sell1112).toBeDefined()
    expect(sell1112.price).toBe(parseUsd('65.53'))
    expect((await repos.correctionRepo.get(correctionId)).status).toBe('applied')

    // the capture is no longer live: correction applied, its pending buy rejected
    const pendingBuy = first.pending[0]
    expect(await repos.pendingRepo.decide(pendingBuy.id, 'rejected')).toBe(true)
    const second: any = await ingestCapture(runId, image, ext, deps)
    expect(second).not.toBe('duplicate')
    expect(second.pending.length).toBe(1)
    expect(second.pending[0].side).toBe('buy')
    expect(second.pending[0].shares).toBe(78)
    expect(second.conflicts).toBeUndefined()
  })
})
