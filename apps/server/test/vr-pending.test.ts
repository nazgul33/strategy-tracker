import { describe, test, expect } from 'bun:test'
import { DomainError } from '@st/core'
import { feeCents } from '@st/core/money'
import { VrNotFoundError } from '../src/domain/vr/booking'
import { confirmAllVrPending, confirmVrPending, editVrPending, listVrPending, rejectVrPending } from '../src/domain/vr/pending'
import type { NewVrPending } from '../src/domain/vr/repo-types'
import { newVrRun, seedFill, vrSetup } from './vr-http-fixture'

const TODAY = '2026-11-10'
const IMAGE = { mime: 'image/png', bytes: Buffer.from('x'), byteLen: 1 }

async function setup() {
  const s = await vrSetup()
  const id = await newVrRun(s)
  const run = (await s.f.repos.vrRunRepo.get(id))!
  const deps = { repos: s.f.repos, today: TODAY }
  const seed = async (over: Partial<NewVrPending> = {}, withImage = true) => {
    const row: NewVrPending = { runId: id, captureId: 7, side: 'buy', shares: 10, price: 451_500n, fee: null, filledOn: '2026-11-09', dateRead: true, dupPrice: null, ...over }
    const [pid] = await s.f.repos.vrPendingRepo.insertMany([row])
    if (withImage) await s.f.repos.captureImageRepo.insertIgnore({ captureId: row.captureId, ...IMAGE })
    return pid!
  }
  const status = async (pid: number) => (await s.f.repos.vrPendingRepo.get(id, pid))!.status
  return { s, id, run, deps, seed, status }
}

const code = async (p: Promise<unknown>) => {
  try { await p } catch (e) { return e instanceof DomainError ? e.kind : e }
  return 'resolved'
}

describe('confirmVrPending', () => {
  test('books a capture fill with the computed fee, confirms the row and returns the fill id', async () => {
    const t = await setup()
    const pid = await t.seed()
    const fillId = await confirmVrPending(t.run, pid, t.deps)
    expect(t.s.f.vr.fills).toHaveLength(1)
    expect(t.s.f.vr.fills[0]).toMatchObject({ id: fillId, runId: t.id, side: 'buy', shares: 10, price: 451_500n, filledOn: '2026-11-09', source: 'capture', fee: feeCents(451_500n, 10, 700) })
    expect(await t.status(pid)).toBe('confirmed')
  })

  test('a fee that was read is used as it is', async () => {
    const t = await setup()
    await confirmVrPending(t.run, await t.seed({ fee: 32 }), t.deps)
    expect(t.s.f.vr.fills[0]!.fee).toBe(32)
    await confirmVrPending(t.run, await t.seed({ fee: 0, captureId: 8 }), t.deps)
    expect(t.s.f.vr.fills[1]!.fee).toBe(0)
  })

  test('the image goes only when the last waiting row of the capture is decided', async () => {
    const t = await setup()
    const a = await t.seed()
    const b = await t.seed({ price: 443_900n }, false)
    await confirmVrPending(t.run, a, t.deps)
    expect(t.s.f.captureImages).toHaveLength(1)
    await confirmVrPending(t.run, b, t.deps)
    expect(t.s.f.captureImages).toHaveLength(0)
  })

  test('an unknown id, another run id and a decided row are refused', async () => {
    const t = await setup()
    expect(await code(confirmVrPending(t.run, 999, t.deps))).toBeInstanceOf(VrNotFoundError)
    const other = await newVrRun(t.s, { name: 'other' })
    const foreign = (await t.s.f.repos.vrPendingRepo.insertMany([{ runId: other, captureId: 9, side: 'buy', shares: 1, price: 1n, fee: 0, filledOn: TODAY, dateRead: true, dupPrice: null }]))[0]!
    expect(await code(confirmVrPending(t.run, foreign, t.deps))).toBeInstanceOf(VrNotFoundError)
    const pid = await t.seed()
    await confirmVrPending(t.run, pid, t.deps)
    expect(await code(confirmVrPending(t.run, pid, t.deps))).toBe('vr-not-pending')
    expect(t.s.f.vr.fills).toHaveLength(1)
  })

  test('a row dated after today is refused and stays waiting with its image; editing the date lets it confirm', async () => {
    const t = await setup()
    const pid = await t.seed({ filledOn: '2026-11-11' })
    expect(await code(confirmVrPending(t.run, pid, t.deps))).toBe('fill-date-in-future')
    expect(await t.status(pid)).toBe('pending')
    expect(t.s.f.captureImages).toHaveLength(1)
    expect(t.s.f.vr.fills).toHaveLength(0)
    await editVrPending(t.run, pid, { side: 'buy', shares: 10, price: '45.15', filledOn: TODAY }, t.deps)
    const fillId = await confirmVrPending(t.run, pid, t.deps)
    expect(t.s.f.vr.fills).toMatchObject([{ id: fillId, filledOn: TODAY }])
  })

  test('a sell beyond the holding is refused with vr-negative-shares', async () => {
    const t = await setup()
    await seedFill(t.s, t.id, 'buy', 10, 451_500n, 0, '2026-11-01')
    const pid = await t.seed({ side: 'sell', shares: 11 })
    expect(await code(confirmVrPending(t.run, pid, t.deps))).toBe('vr-negative-shares')
    expect(await t.status(pid)).toBe('pending')
    expect(t.s.f.vr.fills).toHaveLength(1)
  })

  test('an entry that would overflow the books is refused with vr-too-large', async () => {
    const t = await setup()
    const pid = await t.seed({ shares: 2_000_000_000, price: 500_000_000n, fee: 0 })
    expect(await code(confirmVrPending(t.run, pid, t.deps))).toBe('vr-too-large')
    expect(await t.status(pid)).toBe('pending')
  })

  test('a computed fee beyond the INT range is refused with invalid-fee', async () => {
    const t = await setup()
    const pid = await t.seed({ shares: 2_000_000_000, price: 500_000_000n, fee: null })
    expect(await code(confirmVrPending(t.run, pid, t.deps))).toBe('invalid-fee')
    expect(await t.status(pid)).toBe('pending')
    expect(t.s.f.vr.fills).toHaveLength(0)
  })
})

describe('confirmVrPending: the format checks of a typed fill', () => {
  test('a row with price 0 is refused with invalid-price and stays waiting with its image', async () => {
    const t = await setup()
    const pid = await t.seed({ price: 0n })
    expect(await code(confirmVrPending(t.run, pid, t.deps))).toBe('invalid-price')
    expect(await t.status(pid)).toBe('pending')
    expect(t.s.f.captureImages).toHaveLength(1)
    expect(t.s.f.vr.fills).toHaveLength(0)
  })

  test('a row with 0 shares is refused with invalid-shares', async () => {
    const t = await setup()
    const pid = await t.seed({ shares: 0 })
    expect(await code(confirmVrPending(t.run, pid, t.deps))).toBe('invalid-shares')
    expect(await t.status(pid)).toBe('pending')
  })

  test('the format codes come before the date and books codes', async () => {
    const t = await setup()
    const pid = await t.seed({ price: 0n, filledOn: '2026-11-11' })
    expect(await code(confirmVrPending(t.run, pid, t.deps))).toBe('invalid-price')
  })
})

describe('confirmVrPending: a failure after the commit', () => {
  test('a failing image step still answers with the fill id and leaves the row confirmed', async () => {
    const t = await setup()
    const pid = await t.seed()
    t.s.f.repos.vrPendingRepo.hasPendingForCapture = async () => { throw new Error('db down') }
    const log = console.error
    console.error = () => {}
    try {
      const fillId = await confirmVrPending(t.run, pid, t.deps)
      expect(t.s.f.vr.fills).toMatchObject([{ id: fillId }])
      expect(await t.status(pid)).toBe('confirmed')
    } finally { console.error = log }
  })

  test('the same for reject', async () => {
    const t = await setup()
    const pid = await t.seed()
    t.s.f.repos.vrPendingRepo.hasPendingForCapture = async () => { throw new Error('db down') }
    const log = console.error
    console.error = () => {}
    try {
      await rejectVrPending(t.run, pid, t.deps)
      expect(await t.status(pid)).toBe('rejected')
    } finally { console.error = log }
  })
})

describe('editVrPending', () => {
  const GOOD = { side: 'sell', shares: 4, price: '61.10', fee: '0.50', filledOn: '2026-11-08' }

  test('stores the typed values (USD strings), keeps dupPrice and dateRead', async () => {
    const t = await setup()
    const pid = await t.seed({ dupPrice: 443_900n, dateRead: false })
    await editVrPending(t.run, pid, GOOD, t.deps)
    expect(await t.s.f.repos.vrPendingRepo.get(t.id, pid)).toMatchObject({ side: 'sell', shares: 4, price: 611_000n, fee: 50, filledOn: '2026-11-08', dupPrice: 443_900n, dateRead: false, status: 'pending' })
  })

  test('an empty, null or absent fee is stored as null', async () => {
    const t = await setup()
    const pid = await t.seed({ fee: 32 })
    for (const fee of ['', null, undefined]) {
      await editVrPending(t.run, pid, { ...GOOD, fee: '1.00' }, t.deps)
      expect((await t.s.f.repos.vrPendingRepo.get(t.id, pid))!.fee).toBe(100)
      await editVrPending(t.run, pid, { ...GOOD, fee }, t.deps)
      expect((await t.s.f.repos.vrPendingRepo.get(t.id, pid))!.fee).toBeNull()
    }
  })

  test('a date after today is accepted', async () => {
    const t = await setup()
    const pid = await t.seed()
    await editVrPending(t.run, pid, { ...GOOD, filledOn: '2026-11-20' }, t.deps)
    expect((await t.s.f.repos.vrPendingRepo.get(t.id, pid))!.filledOn).toBe('2026-11-20')
  })

  const bad: [string, Record<string, unknown>][] = [
    ['invalid-side', { side: 'hold' }], ['invalid-side', { side: undefined }],
    ['invalid-shares', { shares: 0 }], ['invalid-shares', { shares: 1.5 }], ['invalid-shares', { shares: '3' }], ['invalid-shares', { shares: 2_147_483_648 }],
    ['invalid-price', { price: '0' }], ['invalid-price', { price: 'abc' }], ['invalid-price', { price: '1.23456' }], ['invalid-price', { price: 45.15 }],
    ['invalid-fee', { fee: '-1' }], ['invalid-fee', { fee: 'x' }], ['invalid-fee', { fee: 1 }], ['invalid-fee', { fee: '21474836.48' }],
    ['invalid-date', { filledOn: '2026/11/01' }], ['invalid-date', { filledOn: '2026-13-45' }], ['invalid-date', { filledOn: undefined }],
  ]
  for (const [c, patch] of bad) {
    test(`${c} for ${JSON.stringify(patch)}`, async () => {
      const t = await setup()
      const pid = await t.seed()
      expect(await code(editVrPending(t.run, pid, { ...GOOD, ...patch }, t.deps))).toBe(c)
      expect(await t.s.f.repos.vrPendingRepo.get(t.id, pid)).toMatchObject({ side: 'buy', shares: 10, price: 451_500n })
    })
  }

  test('a decided row is vr-not-pending; an unknown id is not found even for a bad body', async () => {
    const t = await setup()
    const pid = await t.seed()
    await rejectVrPending(t.run, pid, t.deps)
    expect(await code(editVrPending(t.run, pid, GOOD, t.deps))).toBe('vr-not-pending')
    expect(await code(editVrPending(t.run, 999, { side: 'x' }, t.deps))).toBeInstanceOf(VrNotFoundError)
  })
})

describe('rejectVrPending', () => {
  test('marks the row rejected and drops the image with the last waiting row', async () => {
    const t = await setup()
    const a = await t.seed()
    const b = await t.seed({ price: 443_900n }, false)
    await rejectVrPending(t.run, a, t.deps)
    expect(await t.status(a)).toBe('rejected')
    expect(t.s.f.captureImages).toHaveLength(1)
    await rejectVrPending(t.run, b, t.deps)
    expect(t.s.f.captureImages).toHaveLength(0)
    expect(t.s.f.vr.fills).toHaveLength(0)
  })

  test('a decided row is vr-not-pending, an unknown id is not found', async () => {
    const t = await setup()
    const pid = await t.seed()
    await rejectVrPending(t.run, pid, t.deps)
    expect(await code(rejectVrPending(t.run, pid, t.deps))).toBe('vr-not-pending')
    expect(await code(rejectVrPending(t.run, 999, t.deps))).toBeInstanceOf(VrNotFoundError)
  })
})

describe('listVrPending', () => {
  test('waiting rows only, in date then id order, with the flags', async () => {
    const t = await setup()
    const late = await t.seed({ filledOn: '2026-11-11' })
    const early = await t.seed({ filledOn: '2026-11-02', captureId: 8 }, false)
    const done = await t.seed({ filledOn: '2026-11-01', captureId: 8 }, false)
    await rejectVrPending(t.run, done, t.deps)
    const rows = await listVrPending(t.run, t.deps)
    expect(rows.map((r) => r.id)).toEqual([early, late])
    expect(rows.map((r) => [r.dateAfterToday, r.hasImage])).toEqual([[false, false], [true, true]])
    expect(rows[0]).toEqual({ id: early, captureId: 8, side: 'buy', shares: 10, price: 451_500n, fee: null, filledOn: '2026-11-02', dateRead: true, dupPrice: null, dateAfterToday: false, hasImage: false, createdAt: expect.any(String) })
  })
})

describe('confirmAllVrPending', () => {
  test('buys are confirmed before sells, so a same-day buy and sell both book even when the sell is listed first', async () => {
    const t = await setup()
    const sell = await t.seed({ side: 'sell', shares: 5, filledOn: '2026-11-09' })
    const buy = await t.seed({ side: 'buy', shares: 5, filledOn: '2026-11-09' }, false)
    expect(await confirmAllVrPending(t.run, t.deps)).toEqual({ confirmed: 2, refused: [], skippedDuplicates: 0, skippedUndated: 0 })
    const fills = t.s.f.vr.fills
    expect(fills).toHaveLength(2)
    expect(fills.find((f) => f.side === 'buy')!.id).toBeLessThan(fills.find((f) => f.side === 'sell')!.id)
    expect([await t.status(sell), await t.status(buy)]).toEqual(['confirmed', 'confirmed'])
  })

  test('within a side the earlier date goes first', async () => {
    const t = await setup()
    await t.seed({ filledOn: '2026-11-09' })
    await t.seed({ filledOn: '2026-11-03' }, false)
    await confirmAllVrPending(t.run, t.deps)
    const idOn = (d: string) => t.s.f.vr.fills.find((f) => f.filledOn === d)!.id
    expect(idOn('2026-11-03')).toBeLessThan(idOn('2026-11-09'))
  })

  test('a refused row is reported and the others continue', async () => {
    const t = await setup()
    const future = await t.seed({ filledOn: '2026-11-11' })
    const ok = await t.seed({ price: 443_900n }, false)
    expect(await confirmAllVrPending(t.run, t.deps)).toEqual({ confirmed: 1, refused: [{ id: future, error: 'fill-date-in-future' }], skippedDuplicates: 0, skippedUndated: 0 })
    expect(await t.status(future)).toBe('pending')
    expect(await t.status(ok)).toBe('confirmed')
  })

  test('rows with a dupPrice are skipped, counted and stay waiting', async () => {
    const t = await setup()
    const dup = await t.seed({ dupPrice: 443_900n })
    await t.seed({ price: 443_900n, shares: 3 }, false)
    expect(await confirmAllVrPending(t.run, t.deps)).toEqual({ confirmed: 1, refused: [], skippedDuplicates: 1, skippedUndated: 0 })
    expect(await t.status(dup)).toBe('pending')
  })

  test('a row with a guessed date stays waiting and is counted as undated; it confirms by itself', async () => {
    const t = await setup()
    const undated = await t.seed({ dateRead: false })
    await t.seed({ price: 443_900n }, false)
    expect(await confirmAllVrPending(t.run, t.deps)).toEqual({ confirmed: 1, refused: [], skippedDuplicates: 0, skippedUndated: 1 })
    expect(await t.status(undated)).toBe('pending')
    await confirmVrPending(t.run, undated, t.deps)
    expect(await t.status(undated)).toBe('confirmed')
  })

  test('a row that is both a possible duplicate and undated is counted once, as a duplicate', async () => {
    const t = await setup()
    await t.seed({ dateRead: false, dupPrice: 443_900n })
    expect(await confirmAllVrPending(t.run, t.deps)).toEqual({ confirmed: 0, refused: [], skippedDuplicates: 1, skippedUndated: 0 })
  })

  test('nothing waiting gives zeros', async () => {
    const t = await setup()
    expect(await confirmAllVrPending(t.run, t.deps)).toEqual({ confirmed: 0, refused: [], skippedDuplicates: 0, skippedUndated: 0 })
  })
})
