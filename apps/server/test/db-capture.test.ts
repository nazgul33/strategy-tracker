import { describe, test, expect, beforeAll } from 'bun:test'
import { sql, type SQL } from 'drizzle-orm'
import { parseUsd } from '@st/core'
import type { ExtractResult } from '@st/ingest'
import { getDb, applyMigrations } from '../src/db/client'
import type { Db } from '../src/db/db-type'
import { getRepos } from '../src/db/repos'
import { ingestCapture, type BookingDeps } from '../src/domain/booking'
import type { NewPending } from '../src/domain/repo-types'
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

  test('ingestCapture dedups against real booked fills and pending rows', async () => {
    const ticker = 'DD' + Date.now()
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: 'dedup-' + Date.now(), poolCents: 1_000_000, costPpm: 10 })
    // one booked buy (bigint myriadths price) + one pending sell, as the real repos store them
    await repos.fillRepo.insert({ runId, bucketIdx: 0, side: 'buy', ticker, shares: 11, price: parseUsd('218.55'), fee: 0, filledOn: '2026-11-12', source: 'capture' })
    await repos.pendingRepo.insert({ runId, captureId: null, bucketIdx: null, side: 'sell', ticker, shares: 270, price: parseUsd('65.53'), fee: 345, filledOn: '2026-11-12', status: 'pending', ...NO_SNAPSHOT })

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
    expect(rows.filter((r) => r.runId === runId).length).toBe(1) // the seeded row only

    const capRows = await selectRows<{ status: string }>(sql`SELECT status FROM captures WHERE run_id = ${runId}`)
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
    const mine = rows.filter((r) => r.runId === runId)
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
    const [bookedRow] = await repos.fillRepo.listForRun(runId)
    expect(conflicts[0]).toMatchObject({
      matchedKind: 'booked', side: 'sell', ticker, shares: 44, filledOn: '2026-11-11',
      extractedPrice: '64.07', bookedPrice: '66.03', bookedId: bookedRow!.id,
    })
    expect('pendingId' in conflicts[0]!).toBe(false)
    const left = (await repos.pendingRepo.listPending()).filter((p) => p.runId === runId)
    expect(left.length).toBe(0)

    const capRows = await selectRows<{ status: string }>(sql`SELECT status FROM captures WHERE run_id = ${runId}`)
    expect(capRows.length).toBe(1)
    expect(capRows[0].status).toBe('parsed')
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

    const capRows = await selectRows<{ id: number; status: string }>(sql`SELECT id, status FROM captures WHERE run_id = ${runId}`)
    expect(capRows.length).toBe(1)
    expect(capRows[0].status).toBe('parsed')
    const captureId = capRows[0].id

    const pendRows = await selectRows<{ capture_id: number; status: string }>(sql`SELECT capture_id, status FROM mr_pending_fills WHERE run_id = ${runId} ORDER BY id`)
    expect(pendRows.map((r) => ({ capture_id: r.capture_id, status: r.status }))).toEqual([
      { capture_id: captureId, status: 'rejected' },
      { capture_id: captureId, status: 'pending' },
    ])
  })

  test('pending repo: hasLiveForCapture / hasConfirmedForCapture look at one capture and one status', async () => {
    const uniq = Date.now()
    const ticker = 'HL' + uniq
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: 'haslive-' + uniq, poolCents: 1_000_000, costPpm: 10 })
    const row = (captureId: number | null): NewPending => ({ runId, captureId, bucketIdx: null, side: 'buy', ticker, shares: 1, price: 100n, fee: null, filledOn: '2026-11-12', status: 'pending', ...NO_SNAPSHOT })
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

  test('the order columns round-trip', async () => {
    const uniq = Date.now()
    const ticker = 'OC' + uniq
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: 'order-cols-' + uniq, poolCents: 1_000_000, costPpm: 10 })
    await repos.pendingRepo.insert({
      runId, captureId: null, bucketIdx: null, side: 'sell', ticker, shares: 44, price: parseUsd('64.07'), fee: null, filledOn: '2026-11-12', status: 'pending',
      ...NO_SNAPSHOT, detectedOrderType: '매도/STOP(시장가)', detectedOrderPrice: 0n, detectedOrderedShares: 44,
    })
    const [row] = (await repos.pendingRepo.listPending()).filter((r) => r.runId === runId)
    expect(row.detectedOrderType).toBe('매도/STOP(시장가)')
    expect(row.detectedOrderPrice).toBe(0n)
    expect(row.detectedOrderedShares).toBe(44)
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
})
