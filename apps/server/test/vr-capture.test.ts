import { describe, test, expect } from 'bun:test'
import { DEFAULT_VR_SETTINGS } from '@st/strategies/value-rebalancing'
import type { RawFill } from '@st/ingest'
import { dropExactMatches } from '../src/domain/capture-dedup'
import { ingestVrCapture } from '../src/domain/vr/capture'
import { confirmVrPending, rejectVrPending } from '../src/domain/vr/pending'
import { fakeRepos } from './booking-fakes'
import { makeFakes } from './http-fakes'

const TODAY = '2026-11-10'
const img = (n: number) => ({ base64: Buffer.from(`screenshot-${n}`).toString('base64'), mime: 'image/png' })
const fill = (over: Partial<RawFill> = {}): RawFill => ({ side: 'buy', ticker: 'TQQQ', shares: 3, price: '44.39', date: '2026-11-09', ...over })

async function setup() {
  const h = makeFakes()
  const b = fakeRepos()
  const repos = { ...h.repos, captureRepo: b.repos.captureRepo }
  const runId = await repos.vrRunRepo.create({ ticker: 'TQQQ', name: 'vr', costPpm: 700, initialVCents: 500_000, openingCashCents: 1_000_000, openedOn: '2026-11-01', ...DEFAULT_VR_SETTINGS })
  const run = (await repos.vrRunRepo.get(runId))!
  const deps = { repos, today: TODAY }
  const take = (image: ReturnType<typeof img>, fills: RawFill[]) => ingestVrCapture(run, image, fills, deps)
  const rows = (status?: 'pending' | 'confirmed' | 'rejected') => repos.vrPendingRepo.listForRun(runId, status)
  const book = (side: 'buy' | 'sell', shares: number, price: bigint, filledOn: string) =>
    repos.vrFillRepo.insert({ runId, side, shares, price, fee: 0, filledOn, source: 'manual' })
  return { h, b, repos, run, runId, deps, take, rows, book }
}

describe('ingestVrCapture: first take-in', () => {
  test('three fills become three waiting rows with fee, date and dateRead, and the image is stored', async () => {
    const s = await setup()
    const out = await s.take(img(1), [
      fill({ price: '45.15', fee: '0.32', date: '2026-11-09' }),
      fill({ price: '44.39' }),
      fill({ side: 'sell', shares: 2, price: '61.10', date: undefined }),
    ])
    expect(out).toEqual({ waiting: 3, dropped: 0, possibleDuplicates: 0 })
    const rows = await s.rows('pending')
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => ({ side: r.side, shares: r.shares, price: r.price, fee: r.fee, filledOn: r.filledOn, dateRead: r.dateRead, dupPrice: r.dupPrice, runId: r.runId }))).toEqual([
      { side: 'buy', shares: 3, price: 451_500n, fee: 32, filledOn: '2026-11-09', dateRead: true, dupPrice: null, runId: s.runId },
      { side: 'buy', shares: 3, price: 443_900n, fee: null, filledOn: '2026-11-09', dateRead: true, dupPrice: null, runId: s.runId },
      { side: 'sell', shares: 2, price: 611_000n, fee: null, filledOn: TODAY, dateRead: false, dupPrice: null, runId: s.runId },
    ])
    expect(new Set(rows.map((r) => r.captureId)).size).toBe(1)
    expect(s.h.captureImages).toHaveLength(1)
    expect(s.h.captureImages[0]!.captureId).toBe(rows[0]!.captureId)
  })

  test('a fill dated after today keeps its date, read as such', async () => {
    const s = await setup()
    expect(await s.take(img(1), [fill({ date: '2026-11-12' })])).toEqual({ waiting: 1, dropped: 0, possibleDuplicates: 0 })
    expect((await s.rows('pending'))[0]).toMatchObject({ filledOn: '2026-11-12', dateRead: true })
  })

  test('a fill of another ticker is ignored: no row, not counted', async () => {
    const s = await setup()
    expect(await s.take(img(1), [fill({ ticker: 'SOXL' }), fill({ price: '44.40' })])).toEqual({ waiting: 1, dropped: 0, possibleDuplicates: 0 })
    expect(await s.rows()).toHaveLength(1)
    expect(await s.take(img(2), [fill({ ticker: 'SOXL' })])).toEqual({ waiting: 0, dropped: 0, possibleDuplicates: 0 })
    expect(s.h.captureImages).toHaveLength(1)
  })
})

describe('ingestVrCapture: the same screenshot again', () => {
  test('while a row waits it is a duplicate: nothing added, still one image', async () => {
    const s = await setup()
    await s.take(img(1), [fill()])
    expect(await s.take(img(1), [fill()])).toBe('duplicate')
    expect(await s.rows()).toHaveLength(1)
    expect(s.h.captureImages).toHaveLength(1)
  })

  test('after two rows were confirmed and one rejected, every fill is dropped and nothing is stored', async () => {
    const s = await setup()
    await s.take(img(1), [fill({ price: '45.15' }), fill({ price: '44.39' }), fill({ side: 'sell', shares: 2, price: '61.10', date: undefined })])
    const [a, b, c] = await s.rows('pending')
    await confirmVrPending(s.run, a!.id, s.deps)
    await confirmVrPending(s.run, b!.id, s.deps)
    await rejectVrPending(s.run, c!.id, s.deps)
    expect(s.h.captureImages).toHaveLength(0)
    expect(await s.take(img(1), [fill({ price: '45.15' }), fill({ price: '44.39' }), fill({ side: 'sell', shares: 2, price: '61.10', date: undefined })]))
      .toEqual({ waiting: 0, dropped: 3, possibleDuplicates: 0 })
    expect(await s.rows()).toHaveLength(3)
    expect(await s.rows('pending')).toHaveLength(0)
    expect(s.h.captureImages).toHaveLength(0)
    expect(s.b._stores.captures).toHaveLength(1)
  })

  test('a fill equal to a rejected row from another screenshot is dropped', async () => {
    const s = await setup()
    await s.take(img(1), [fill()])
    await rejectVrPending(s.run, (await s.rows('pending'))[0]!.id, s.deps)
    expect(await s.take(img(2), [fill()])).toEqual({ waiting: 0, dropped: 1, possibleDuplicates: 0 })
    expect(await s.rows()).toHaveLength(1)
  })

  test('a rejected row with another price does not hide a fill: it is a plain waiting row', async () => {
    const s = await setup()
    await s.take(img(1), [fill({ price: '44.39' })])
    await rejectVrPending(s.run, (await s.rows('pending'))[0]!.id, s.deps)
    expect(await s.take(img(2), [fill({ price: '44.40' })])).toEqual({ waiting: 1, dropped: 0, possibleDuplicates: 0 })
    expect((await s.rows('pending'))[0]).toMatchObject({ price: 444_000n, dupPrice: null })
  })
})

describe('ingestVrCapture: duplicates against the books and waiting rows', () => {
  test('two identical fills with one already booked: one dropped, one waiting', async () => {
    const s = await setup()
    await s.book('buy', 3, 443_900n, '2026-11-09')
    expect(await s.take(img(1), [fill(), fill()])).toEqual({ waiting: 1, dropped: 1, possibleDuplicates: 0 })
    expect((await s.rows('pending'))[0]).toMatchObject({ dupPrice: null })
  })

  test('another price than a booked fill: a waiting row citing the booked price', async () => {
    const s = await setup()
    await s.book('buy', 3, 443_900n, '2026-11-09')
    expect(await s.take(img(1), [fill({ price: '44.40' })])).toEqual({ waiting: 1, dropped: 0, possibleDuplicates: 1 })
    expect((await s.rows('pending'))[0]).toMatchObject({ price: 444_000n, dupPrice: 443_900n, dateRead: true })
  })

  test('another price than a waiting row: a waiting row citing that row price', async () => {
    const s = await setup()
    await s.take(img(1), [fill({ price: '44.39' })])
    expect(await s.take(img(2), [fill({ price: '44.40' })])).toEqual({ waiting: 1, dropped: 0, possibleDuplicates: 1 })
    const rows = await s.rows('pending')
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.price === 444_000n)).toMatchObject({ dupPrice: 443_900n })
  })

  test('a possible duplicate whose fill had no date has dateRead false and today as its date', async () => {
    const s = await setup()
    await s.book('buy', 3, 443_900n, TODAY)
    expect(await s.take(img(1), [fill({ price: '44.40', date: undefined })])).toEqual({ waiting: 1, dropped: 0, possibleDuplicates: 1 })
    expect((await s.rows('pending'))[0]).toMatchObject({ filledOn: TODAY, dateRead: false, dupPrice: 443_900n, fee: null })
  })

  test('a possible duplicate carries the fee that was read, in cents', async () => {
    const s = await setup()
    await s.book('buy', 3, 443_900n, '2026-11-09')
    await s.take(img(1), [fill({ price: '44.40', fee: '0.07' })])
    expect((await s.rows('pending'))[0]).toMatchObject({ fee: 7, dupPrice: 443_900n })
  })

  test('a screenshot whose every fill is dropped stores no image but keeps a parsed capture', async () => {
    const s = await setup()
    await s.book('buy', 3, 443_900n, '2026-11-09')
    expect(await s.take(img(1), [fill()])).toEqual({ waiting: 0, dropped: 1, possibleDuplicates: 0 })
    expect(s.h.captureImages).toHaveLength(0)
    expect(s.b._stores.captures).toMatchObject([{ runId: s.runId, status: 'parsed' }])
    expect(await s.rows()).toHaveLength(0)
  })
})

describe('dropExactMatches', () => {
  const ex = (over: Record<string, unknown> = {}) => ({ side: 'buy' as const, ticker: 'TQQQ', shares: 3, price: 443_900n, filledOn: '2026-11-09', ...over })

  test('each existing entry cancels one fill: two entries against three equal fills drop two and keep one', () => {
    const fills = [fill(), fill(), fill()]
    const r = dropExactMatches([ex(), ex()], fills, TODAY)
    expect(r.dropped).toBe(2)
    expect(r.kept).toEqual([fills[2]!])
    expect(r.kept[0]).toBe(fills[2]!)
  })

  test('a missing date counts as today', () => {
    expect(dropExactMatches([ex({ filledOn: TODAY })], [fill({ date: undefined })], TODAY)).toEqual({ kept: [], dropped: 1 })
    expect(dropExactMatches([ex({ filledOn: '2026-11-09' })], [fill({ date: undefined })], TODAY).dropped).toBe(0)
  })

  test('a bigint price matches the extracted text in either spelling', () => {
    expect(dropExactMatches([ex()], [fill({ price: '44.39' })], TODAY).dropped).toBe(1)
    expect(dropExactMatches([ex()], [fill({ price: '44.3900' })], TODAY).dropped).toBe(1)
  })

  test('another ticker, side, shares, price or date is kept', () => {
    const fills = [fill({ ticker: 'SOXL' }), fill({ side: 'sell' }), fill({ shares: 4 }), fill({ price: '44.40' }), fill({ date: '2026-11-08' })]
    expect(dropExactMatches([ex()], fills, TODAY)).toEqual({ kept: fills, dropped: 0 })
  })

  test('nothing existing drops nothing', () => {
    const fills = [fill()]
    expect(dropExactMatches([], fills, TODAY)).toEqual({ kept: fills, dropped: 0 })
  })
})
