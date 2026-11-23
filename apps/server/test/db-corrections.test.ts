import { describe, test, expect, beforeAll } from 'bun:test'
import { sql, type SQL } from 'drizzle-orm'
import { emptyState, parseUsd } from '@st/core'
import type { ExtractResult } from '@st/ingest'
import { getDb, applyMigrations } from '../src/db/client'
import type { Db } from '../src/db/db-type'
import { getRepos } from '../src/db/repos'
import { ingestCapture, manualFill, type FillBookingDeps } from '../src/domain/booking'
import { listOpenCorrections, applyCorrection } from '../src/domain/corrections'
import { silentNotifier } from './booking-fakes'

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

    const row = (await repos.correctionRepo.get(id))!
    expect(row).toMatchObject({ id, ...input, status: 'open' })
    expect(typeof row.bookedPrice).toBe('bigint')
    expect(typeof row.proposedPrice).toBe('bigint')
    expect(typeof row.createdAt).toBe('string')
    expect((await repos.correctionRepo.listOpen()).some((c) => c.id === id)).toBe(true)

    expect((await repos.correctionRepo.listBlocking(fillId, parseUsd('64.07'))).map((c) => c.id)).toEqual([id])
    expect(await repos.correctionRepo.listBlocking(fillId, parseUsd('64.70'))).toEqual([])
    expect(await repos.correctionRepo.hasOpenForCapture(captureId)).toBe(true)

    expect(await repos.correctionRepo.decide(id, 'dismissed')).toBe(true)
    const blocking = await repos.correctionRepo.listBlocking(fillId, parseUsd('64.07'))
    expect(blocking.map((c) => [c.id, c.status])).toEqual([[id, 'dismissed']])
    const id3 = await repos.correctionRepo.insert(input)
    expect((await repos.correctionRepo.listBlocking(fillId, parseUsd('64.07'))).map((c) => [c.id, c.status])).toEqual([[id, 'dismissed'], [id3, 'open']])
    expect(await repos.correctionRepo.decide(id3, 'applied')).toBe(true)
    expect(await repos.correctionRepo.hasOpenForCapture(captureId)).toBe(false)
    expect((await repos.correctionRepo.listOpen()).some((c) => c.id === id)).toBe(false)
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
    const deps: FillBookingDeps = { repos, today: '2026-11-15', notify: silentNotifier }

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
    const sell1111 = after.find((f) => f.side === 'sell' && f.filledOn === '2026-11-11')!
    expect(sell1111).toBeDefined()
    expect(sell1111.price).toBe(parseUsd('64.07'))
    const buy1110 = after.find((f) => f.side === 'buy' && f.filledOn === '2026-11-10')!
    expect(buy1110).toBeDefined()
    expect(buy1110.price).toBe(parseUsd('56.06'))
    const sell1112 = after.find((f) => f.side === 'sell' && f.filledOn === '2026-11-12')!
    expect(sell1112).toBeDefined()
    expect(sell1112.price).toBe(parseUsd('65.53'))
    expect((await repos.correctionRepo.get(correctionId))!.status).toBe('applied')

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
