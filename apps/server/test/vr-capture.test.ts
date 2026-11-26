import { describe, test, expect } from 'bun:test'
import { DEFAULT_VR_SETTINGS } from '@st/strategies/value-rebalancing'
import type { RawFill } from '@st/ingest'
import { ingestVrCapture } from '../src/domain/vr/capture'
import { confirmAllVrPending, confirmVrPending, editVrPending, rejectVrPending } from '../src/domain/vr/pending'
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
      fill({ price: '45.15', fee: '0.32', date: '2026-11-09', orderPrice: '45.15' }),
      fill({ price: '44.39', orderPrice: '0.0000' }),
      fill({ side: 'sell', shares: 2, price: '61.10', date: undefined }),
    ])
    expect(out).toEqual({ waiting: 3, dropped: 0, possibleDuplicates: 0 })
    const rows = await s.rows('pending')
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => ({ side: r.side, shares: r.shares, price: r.price, fee: r.fee, filledOn: r.filledOn, dateRead: r.dateRead, dupPrice: r.dupPrice, orderPrice: r.orderPrice, runId: r.runId }))).toEqual([
      { side: 'buy', shares: 3, price: 451_500n, fee: 32, filledOn: '2026-11-09', dateRead: true, dupPrice: null, orderPrice: 451_500n, runId: s.runId },
      { side: 'buy', shares: 3, price: 443_900n, fee: null, filledOn: '2026-11-09', dateRead: true, dupPrice: null, orderPrice: null, runId: s.runId },
      { side: 'sell', shares: 2, price: 611_000n, fee: null, filledOn: TODAY, dateRead: false, dupPrice: null, orderPrice: null, runId: s.runId },
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

  const THREE = () => [fill({ price: '45.15' }), fill({ price: '44.39' }), fill({ side: 'sell', shares: 2, price: '61.10', date: undefined })]
  async function decideThree(s: Awaited<ReturnType<typeof setup>>) {
    await s.take(img(1), THREE())
    const [a, b, c] = await s.rows('pending')
    await confirmVrPending(s.run, a!.id, s.deps)
    await confirmVrPending(s.run, b!.id, s.deps)
    await rejectVrPending(s.run, c!.id, s.deps)
    expect(s.h.captureImages).toHaveLength(0)
  }

  test('after two rows were confirmed and one rejected, the same screenshot is a duplicate: nothing new', async () => {
    const s = await setup()
    await decideThree(s)
    expect(await s.take(img(1), THREE())).toBe('duplicate')
    expect(await s.rows()).toHaveLength(3)
    expect(await s.rows('pending')).toHaveLength(0)
    expect(s.h.captureImages).toHaveLength(0)
    expect(s.b._stores.captures).toHaveLength(1)
  })

  test('a different screenshot of the same fills after those decisions drops all three and stores nothing', async () => {
    const s = await setup()
    await decideThree(s)
    expect(await s.take(img(2), THREE())).toEqual({ waiting: 0, dropped: 3, possibleDuplicates: 0 })
    expect(await s.rows()).toHaveLength(3)
    expect(s.h.captureImages).toHaveLength(0)
  })

  test('a screenshot that produced no row is read again and gives the same outcome', async () => {
    const s = await setup()
    await s.book('buy', 3, 443_900n, '2026-11-09')
    expect(await s.take(img(1), [fill()])).toEqual({ waiting: 0, dropped: 1, possibleDuplicates: 0 })
    expect(await s.take(img(1), [fill()])).toEqual({ waiting: 0, dropped: 1, possibleDuplicates: 0 })
    expect(s.b._stores.captures).toHaveLength(1)
  })

  test('a row edited before it was confirmed does not come back when the screenshot is sent again', async () => {
    const s = await setup()
    await s.take(img(1), [fill({ shares: 3 })])
    const [row] = await s.rows('pending')
    await editVrPending(s.run, row!.id, { side: 'buy', shares: 30, price: '44.39', filledOn: '2026-11-09' }, s.deps)
    await confirmVrPending(s.run, row!.id, s.deps)
    expect(await s.take(img(1), [fill({ shares: 3 })])).toBe('duplicate')
    expect(await s.rows()).toHaveLength(1)
    expect(s.h.vr.fills).toHaveLength(1)
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

describe('ingestVrCapture: the order price', () => {
  const rung = (p: string) => fill({ price: p, orderPrice: p })
  const plain = (p: string) => fill({ price: p })

  test('a second screenshot of the same ladder day: the new rung fills wait unmarked and Confirm all books them', async () => {
    const s = await setup()
    expect(await s.take(img(1), [rung('44.39'), rung('43.66'), rung('42.95')])).toEqual({ waiting: 3, dropped: 0, possibleDuplicates: 0 })
    expect(await s.take(img(2), [rung('42.95'), rung('42.26'), rung('41.59')])).toEqual({ waiting: 2, dropped: 1, possibleDuplicates: 0 })
    expect(await confirmAllVrPending(s.run, s.deps)).toEqual({ confirmed: 5, refused: [], skippedDuplicates: 0, skippedUndated: 0 })
    expect(s.h.vr.fills.map((f) => f.orderPrice)).toEqual([443_900n, 436_600n, 429_500n, 422_600n, 415_900n])
  })

  test('the same fills without order prices are marked, as before', async () => {
    const s = await setup()
    expect(await s.take(img(1), [plain('44.39'), plain('43.66'), plain('42.95')])).toEqual({ waiting: 3, dropped: 0, possibleDuplicates: 0 })
    expect(await s.take(img(2), [plain('42.95'), plain('42.26'), plain('41.59')])).toEqual({ waiting: 2, dropped: 1, possibleDuplicates: 2 })
  })

  test('a corrected row matches what is read later: the right read is dropped, a repeated misread is marked', async () => {
    const s = await setup()
    await s.take(img(1), [fill({ price: '44.30', orderPrice: '44.39' })])
    const [row] = await s.rows('pending')
    await editVrPending(s.run, row!.id, { side: 'buy', shares: 3, price: '44.39', filledOn: '2026-11-09' }, s.deps)
    await confirmVrPending(s.run, row!.id, s.deps)
    expect(await s.take(img(2), [fill({ price: '44.39', orderPrice: '44.39' })])).toEqual({ waiting: 0, dropped: 1, possibleDuplicates: 0 })
    expect(await s.take(img(3), [fill({ price: '44.30', orderPrice: '44.39' })])).toEqual({ waiting: 1, dropped: 0, possibleDuplicates: 1 })
  })

  test('a rejected fill read again with another order price is marked, not a plain row', async () => {
    const s = await setup()
    await s.take(img(1), [fill({ orderPrice: '44.39' })])
    await rejectVrPending(s.run, (await s.rows('pending'))[0]!.id, s.deps)
    expect(await s.take(img(2), [fill({ orderPrice: '44.30' })])).toEqual({ waiting: 1, dropped: 0, possibleDuplicates: 1 })
  })

  test('a typed fill has no order price: the same fill from a screenshot is dropped', async () => {
    const s = await setup()
    await s.book('buy', 3, 443_900n, '2026-11-09')
    expect(await s.take(img(1), [rung('44.39')])).toEqual({ waiting: 0, dropped: 1, possibleDuplicates: 0 })
  })
})
