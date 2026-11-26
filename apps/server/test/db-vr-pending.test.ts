import { describe, test, expect, beforeAll } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'
import type { RawFill } from '@st/ingest'
import { getDb, applyMigrations } from '../src/db/client'
import { getRepos } from '../src/db/repos'
import { CHOICE_TTL_MS } from '../src/domain/capture-choice'
import type { NewVrFill, NewVrPending, NewVrRun } from '../src/domain/vr/repo-types'

const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip

describeIf('db integration: VR pending fills and capture choices', () => {
  let db: Awaited<ReturnType<typeof getDb>>
  let repos: ReturnType<typeof getRepos>
  beforeAll(async () => {
    db = await getDb(process.env.TEST_DATABASE_URL!)
    await applyMigrations(db)
    repos = getRepos(db)
  })

  async function selectRows<T>(q: SQL): Promise<T[]> {
    const [rows] = (await db.execute(q)) as unknown as [T[], unknown]
    return rows
  }

  let seq = 0
  const uniq = () => `${Date.now()}${seq++}`
  const newVr = (over: Partial<NewVrRun> = {}): NewVrRun => {
    const u = uniq()
    return {
      ticker: 'V' + u.slice(-10), name: 'vrp-' + u, costPpm: 25,
      g: 10, formula: 'skill', bandPpm: 150_000, spendLimitPpm: 500_000, cycleDepositCents: 12_300,
      initialVCents: 1_000_000, openingCashCents: 250_000, openedOn: '2026-11-02', ...over,
    }
  }
  const newRun = () => repos.vrRunRepo.create(newVr())
  const newCapture = async (runId: number) => (await repos.captureRepo.insert({ runId, chatId: 'c', imageHash: 'h' + uniq(), status: 'parsed' })).id!
  const row = (runId: number, captureId: number, over: Partial<NewVrPending> = {}): NewVrPending =>
    ({ runId, captureId, side: 'buy', shares: 3, price: 451_500n, fee: null, filledOn: '2026-11-03', dateRead: true, dupPrice: null, orderPrice: null, ...over })
  const fill = (runId: number, over: Partial<NewVrFill> = {}): NewVrFill =>
    ({ runId, side: 'buy', shares: 3, price: 451_500n, fee: 3, filledOn: '2026-11-03', source: 'capture', ...over })

  test('pending rows round-trip and list by date then id', async () => {
    const run = await newRun()
    const other = await newRun()
    const cap = await newCapture(run)
    expect(await repos.vrPendingRepo.insertMany([])).toEqual([])
    const [late, early1, early2] = await repos.vrPendingRepo.insertMany([
      row(run, cap, { filledOn: '2026-11-09' }),
      row(run, cap, { fee: 7, dupPrice: 444_000n, orderPrice: 443_900n }),
      row(run, cap, { dateRead: false }),
    ]) as [number, number, number]
    expect(late).toBeLessThan(early1)
    expect(early1).toBeLessThan(early2)

    expect((await repos.vrPendingRepo.listForRun(run)).map((r) => r.id)).toEqual([early1, early2, late])
    const got = (await repos.vrPendingRepo.get(run, early1))!
    expect(got).toMatchObject({
      id: early1, runId: run, captureId: cap, side: 'buy', shares: 3, price: 451_500n, fee: 7,
      filledOn: '2026-11-03', dateRead: true, dupPrice: 444_000n, orderPrice: 443_900n, status: 'pending',
    })
    expect(typeof got.price).toBe('bigint')
    expect(typeof got.orderPrice).toBe('bigint')
    expect(typeof got.dupPrice).toBe('bigint')
    expect(Object.keys(got).sort()).toEqual(['captureId', 'createdAt', 'dateRead', 'dupPrice', 'fee', 'filledOn', 'id', 'orderPrice', 'price', 'runId', 'shares', 'side', 'status'])
    expect(got.createdAt).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
    expect(await repos.vrPendingRepo.get(run, early2)).toMatchObject({ fee: null, dupPrice: null, dateRead: false, orderPrice: null })

    expect(await repos.vrPendingRepo.reject(run, late)).toBe(true)
    expect((await repos.vrPendingRepo.listForRun(run, 'pending')).map((r) => r.id)).toEqual([early1, early2])
    expect((await repos.vrPendingRepo.listForRun(run, 'rejected')).map((r) => r.id)).toEqual([late])
    expect(await repos.vrPendingRepo.listForRun(run)).toHaveLength(3)
    expect(await repos.vrPendingRepo.countPending(run)).toBe(2)

    expect(await repos.vrPendingRepo.listForRun(other)).toEqual([])
    expect(await repos.vrPendingRepo.get(other, early1)).toBeNull()
    expect(await repos.vrPendingRepo.countPending(other)).toBe(0)
  })

  test('update changes a pending row and refuses a decided one', async () => {
    const run = await newRun()
    const other = await newRun()
    const [id] = await repos.vrPendingRepo.insertMany([row(run, await newCapture(run), { dateRead: false, dupPrice: 400_000n, orderPrice: 400_000n })]) as [number]
    const patch = { side: 'sell' as const, shares: 5, price: 462_500n, fee: 9, filledOn: '2026-11-04' }
    expect(await repos.vrPendingRepo.update(run, id, patch)).toBe(true)
    const after = (await repos.vrPendingRepo.get(run, id))!
    expect(after).toMatchObject({ ...patch, dateRead: false, dupPrice: 400_000n, orderPrice: 400_000n, status: 'pending' })
    expect(await repos.vrPendingRepo.update(run, id, patch)).toBe(true)

    expect(await repos.vrPendingRepo.update(other, id, { ...patch, shares: 99 })).toBe(false)
    expect(await repos.vrPendingRepo.get(run, id)).toEqual(after)

    expect(await repos.vrPendingRepo.reject(run, id)).toBe(true)
    const rejected = (await repos.vrPendingRepo.get(run, id))!
    expect(await repos.vrPendingRepo.update(run, id, { ...patch, shares: 99 })).toBe(false)
    expect(await repos.vrPendingRepo.get(run, id)).toEqual(rejected)
  })

  test('confirm marks the row and inserts the fill together', async () => {
    const run = await newRun()
    const other = await newRun()
    const cap = await newCapture(run)
    const [id, id2, id3] = await repos.vrPendingRepo.insertMany([row(run, cap), row(run, cap), row(run, cap)]) as [number, number, number]

    const fid = await repos.vrPendingRepo.confirm(run, id, fill(run, { orderPrice: 443_900n }))
    expect(typeof fid).toBe('number')
    expect(await repos.vrFillRepo.get(run, fid!)).toMatchObject({ source: 'capture', shares: 3, price: 451_500n, fee: 3, orderPrice: 443_900n })
    await repos.vrFillRepo.update(run, fid!, { side: 'buy', shares: 4, price: 451_500n, fee: 3, filledOn: '2026-11-03' })
    expect(await repos.vrFillRepo.get(run, fid!)).toMatchObject({ shares: 4, orderPrice: 443_900n })
    expect((await repos.vrPendingRepo.get(run, id))!.status).toBe('confirmed')

    const fillsBefore = await repos.vrFillRepo.listForRun(run)
    expect(fillsBefore).toHaveLength(1)
    expect(await repos.vrPendingRepo.confirm(run, id, fill(run))).toBeNull()
    expect(await repos.vrFillRepo.listForRun(run)).toHaveLength(1)

    expect(await repos.vrPendingRepo.confirm(other, id2, fill(other))).toBeNull()
    expect(await repos.vrFillRepo.listForRun(other)).toEqual([])
    expect((await repos.vrPendingRepo.get(run, id2))!.status).toBe('pending')

    await expect(repos.vrPendingRepo.confirm(run, id3, fill(run, { shares: 2 ** 31 }))).rejects.toThrow()
    expect((await repos.vrPendingRepo.get(run, id3))!.status).toBe('pending')
    expect(await repos.vrFillRepo.listForRun(run)).toEqual(fillsBefore)
    expect((await repos.vrFillRepo.get(run, await repos.vrFillRepo.insert({ ...fill(run), source: 'manual' })))!.orderPrice).toBeNull()
  })

  test('confirm refuses a fill for another run and writes nothing', async () => {
    const run = await newRun()
    const other = await newRun()
    const [id] = await repos.vrPendingRepo.insertMany([row(run, await newCapture(run))]) as [number]
    await expect(repos.vrPendingRepo.confirm(run, id, fill(other))).rejects.toThrow('fill.runId')
    expect((await repos.vrPendingRepo.get(run, id))!.status).toBe('pending')
    expect(await repos.vrFillRepo.listForRun(run)).toEqual([])
    expect(await repos.vrFillRepo.listForRun(other)).toEqual([])
  })

  test('hasAnyForCapture is true for a row in any status and false without one', async () => {
    const run = await newRun()
    const [none, pend, conf, rej] = [await newCapture(run), await newCapture(run), await newCapture(run), await newCapture(run)]
    const [, c, r] = await repos.vrPendingRepo.insertMany([row(run, pend), row(run, conf), row(run, rej)]) as [number, number, number]
    expect(await repos.vrPendingRepo.hasAnyForCapture(none)).toBe(false)
    expect(await repos.vrPendingRepo.hasAnyForCapture(pend)).toBe(true)
    await repos.vrPendingRepo.confirm(run, c, fill(run))
    await repos.vrPendingRepo.reject(run, r)
    expect(await repos.vrPendingRepo.hasAnyForCapture(conf)).toBe(true)
    expect(await repos.vrPendingRepo.hasAnyForCapture(rej)).toBe(true)
    expect(await repos.vrPendingRepo.hasAnyForCapture(pend)).toBe(true)
  })

  test('reject only moves a pending row; the capture checks follow', async () => {
    const run = await newRun()
    const cap = await newCapture(run)
    const [a, b] = await repos.vrPendingRepo.insertMany([row(run, cap), row(run, cap)]) as [number, number]
    expect(await repos.vrPendingRepo.hasPendingForCapture(cap)).toBe(true)
    expect(await repos.vrPendingRepo.hasConfirmedForCapture(cap)).toBe(false)

    expect(await repos.vrPendingRepo.confirm(run, a, fill(run))).not.toBeNull()
    expect(await repos.vrPendingRepo.reject(run, b)).toBe(true)
    expect(await repos.vrPendingRepo.hasPendingForCapture(cap)).toBe(false)
    expect(await repos.vrPendingRepo.hasConfirmedForCapture(cap)).toBe(true)

    expect(await repos.vrPendingRepo.reject(run, a)).toBe(false)
    expect((await repos.vrPendingRepo.get(run, a))!.status).toBe('confirmed')
    expect(await repos.vrPendingRepo.reject(run, b)).toBe(false)
  })

  describe('capture choices', () => {
    const fills: RawFill[] = [
      { side: 'buy', ticker: 'TQQQ', shares: 3, price: '45.15' },
      { side: 'sell', ticker: 'TQQQ', shares: 2, price: '46.00', fee: '0.12', date: '2026-11-20', orderType: 'LOC', orderPrice: '45.20', orderedShares: 5 },
    ]
    const park = (base64: string, over: { fills?: RawFill[] } = {}) => repos.captureChoiceRepo.park({
      chatId: 'chat-1', ticker: 'TQQQ', mrRunId: 11, vrRunId: 22, fills: over.fills ?? fills,
      image: { base64, mime: 'image/jpeg' }, readOn: '2026-11-26',
    })

    test('a parked question comes back with identical fills and the identical base64 text', async () => {
      const base64 = randomBytes(1024 * 1024).toString('base64')
      const id = await park(base64)
      const got = (await repos.captureChoiceRepo.get(id))!
      expect(got.fills).toStrictEqual(fills)
      expect('fee' in got.fills[0]!).toBe(false)
      expect(got.image.base64 === base64).toBe(true)
      expect(got.image.mime).toBe('image/jpeg')
      expect(got).toMatchObject({ id, chatId: 'chat-1', ticker: 'TQQQ', mrRunId: 11, vrRunId: 22, readOn: '2026-11-26', answer: null })
      expect(got.createdAt).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
      expect(await repos.captureChoiceRepo.get(999_999_999)).toBeNull()
    })

    test('answer is true for exactly one call', async () => {
      const id = await park('QUJD')
      const answeredAt = () => selectRows<{ answered_at: unknown }>(sql`SELECT answered_at FROM capture_choices WHERE id = ${id}`)
      expect((await answeredAt())[0]!.answered_at).toBeNull()
      expect(await repos.captureChoiceRepo.answer(id, 'vr')).toBe(true)
      expect(await repos.captureChoiceRepo.answer(id, 'both')).toBe(false)
      expect((await repos.captureChoiceRepo.get(id))!.answer).toBe('vr')
      expect((await answeredAt())[0]!.answered_at).not.toBeNull()
    })

    test('two answers racing on one open question: exactly one wins', async () => {
      const id = await park('QUJD')
      const results = await Promise.all([repos.captureChoiceRepo.answer(id, 'mr'), repos.captureChoiceRepo.answer(id, 'vr')])
      expect(results.filter(Boolean)).toHaveLength(1)
      expect((await repos.captureChoiceRepo.get(id))!.answer).toBe(results[0] ? 'mr' : 'vr')
    })

    test('answer empties the stored screenshot and nothing else; a losing second answer changes nothing', async () => {
      const id = await park(randomBytes(64 * 1024).toString('base64'))
      const before = (await repos.captureChoiceRepo.get(id))!
      expect(before.image.base64.length).toBeGreaterThan(0)
      expect(await repos.captureChoiceRepo.answer(id, 'vr')).toBe(true)
      const after = (await repos.captureChoiceRepo.get(id))!
      expect(after.image).toEqual({ base64: '', mime: 'image/jpeg' })
      expect(after).toEqual({ ...before, answer: 'vr', image: { base64: '', mime: 'image/jpeg' } })
      expect(await repos.captureChoiceRepo.answer(id, 'mr')).toBe(false)
      expect(await repos.captureChoiceRepo.get(id)).toEqual(after)
    })

    test('countOpenForVrRun counts an open question and not an answered, foreign or old one', async () => {
      const vrRun = 700_000_000 + Number(uniq().slice(-6))
      const mk = (runId: number) => repos.captureChoiceRepo.park({
        chatId: 'chat-1', ticker: 'TQQQ', mrRunId: 11, vrRunId: runId, fills, image: { base64: 'QUJD', mime: 'image/jpeg' }, readOn: '2026-11-26',
      })
      const cutoff = () => new Date(Date.now() - CHOICE_TTL_MS)
      expect(await repos.captureChoiceRepo.countOpenForVrRun(vrRun, cutoff())).toBe(0)
      const open = await mk(vrRun)
      expect(await repos.captureChoiceRepo.countOpenForVrRun(vrRun, cutoff())).toBe(1)
      await mk(vrRun + 1)
      expect(await repos.captureChoiceRepo.countOpenForVrRun(vrRun, cutoff())).toBe(1)
      const answered = await mk(vrRun)
      await repos.captureChoiceRepo.answer(answered, 'mr')
      expect(await repos.captureChoiceRepo.countOpenForVrRun(vrRun, cutoff())).toBe(1)
      await db.execute(sql`UPDATE capture_choices SET created_at = created_at - INTERVAL 2 DAY WHERE id = ${open}`)
      expect(await repos.captureChoiceRepo.countOpenForVrRun(vrRun, cutoff())).toBe(0)
    })

    test('deleteOlderThan removes old rows, answered or not, and keeps newer ones', async () => {
      const old1 = await park('QUJD')
      const old2 = await park('QUJD')
      const fresh = await park('QUJD')
      expect(await repos.captureChoiceRepo.answer(old1, 'mr')).toBe(true)
      await db.execute(sql`UPDATE capture_choices SET created_at = created_at - INTERVAL 2 DAY WHERE id IN (${old1}, ${old2})`)
      expect(await repos.captureChoiceRepo.deleteOlderThan(new Date(Date.now() - CHOICE_TTL_MS))).toBeGreaterThanOrEqual(2)
      expect(await repos.captureChoiceRepo.get(old1)).toBeNull()
      expect(await repos.captureChoiceRepo.get(old2)).toBeNull()
      expect(await repos.captureChoiceRepo.get(fresh)).not.toBeNull()
    })
  })
})
