import { describe, expect, test } from 'bun:test'
import { parseUsd } from '@st/core'
import type { NewCorrection } from '../src/domain/correction-types'
import { fakeCorrectionRepo } from './fake-corrections'

// Mirrors the 'correction repo' scenario in db.test.ts so the fake and the real
// repo cannot drift apart silently.
const input: NewCorrection = {
  runId: 1, fillId: 1001, captureId: 2001, side: 'sell', ticker: 'CR',
  bookedShares: 270, bookedFilledOn: '2026-11-12', bookedPrice: parseUsd('64.70'), bookedFee: 345,
  proposedPrice: parseUsd('64.07'), proposedFee: 340,
}

describe('fakeCorrectionRepo parity with the real correctionRepo', () => {
  test('insert, get, listOpen, listBlocking, decide, hasOpenForCapture', async () => {
    const { repo } = fakeCorrectionRepo()
    const id = await repo.insert(input)
    expect(typeof id).toBe('number')

    const row = await repo.get(id)
    expect(row).toMatchObject({ id, ...input, status: 'open' })
    expect(typeof row!.createdAt).toBe('string')
    expect((await repo.listOpen()).some((c) => c.id === id)).toBe(true)

    expect((await repo.listBlocking(1001, parseUsd('64.07'))).map((c) => c.id)).toEqual([id])
    expect(await repo.listBlocking(1001, parseUsd('64.70'))).toEqual([])
    expect(await repo.hasOpenForCapture(2001)).toBe(true)

    expect(await repo.decide(id, 'dismissed')).toBe(true)
    expect((await repo.listBlocking(1001, parseUsd('64.07'))).map((c) => [c.id, c.status])).toEqual([[id, 'dismissed']])
    const id3 = await repo.insert(input)
    expect((await repo.listBlocking(1001, parseUsd('64.07'))).map((c) => [c.id, c.status])).toEqual([[id, 'dismissed'], [id3, 'open']])
    expect(await repo.decide(id3, 'applied')).toBe(true)
    expect(await repo.hasOpenForCapture(2001)).toBe(false)
    expect((await repo.listBlocking(1001, parseUsd('64.07'))).map((c) => c.id)).toEqual([id])
    expect((await repo.listOpen()).some((c) => c.id === id)).toBe(false)
    expect(await repo.decide(id, 'applied')).toBe(false)

    const id2 = await repo.insert({ ...input, captureId: null, proposedPrice: parseUsd('63.50'), proposedFee: null })
    expect((await repo.get(id2))?.proposedFee).toBeNull()
    expect((await repo.get(id2))?.captureId).toBeNull()
    expect(await repo.decide(id2, 'applied')).toBe(true)
    expect(await repo.listBlocking(1001, parseUsd('63.50'))).toEqual([])
  })

  test('a fetched row is not changed by a later decide', async () => {
    const { repo } = fakeCorrectionRepo()
    const id = await repo.insert(input)
    const before = await repo.get(id)
    const listed = await repo.listOpen()
    const blocking = await repo.listBlocking(1001, parseUsd('64.07'))
    expect(await repo.decide(id, 'applied')).toBe(true)
    expect(before!.status).toBe('open')
    expect(listed[0]!.status).toBe('open')
    expect(blocking[0]!.status).toBe('open')
    expect((await repo.get(id))!.status).toBe('applied')
  })

  test('omitted captureId/proposedFee read back as null', async () => {
    const { repo } = fakeCorrectionRepo()
    const { captureId: _c, proposedFee: _f, ...rest } = input
    const id = await repo.insert(rest as NewCorrection)
    const row = await repo.get(id)
    expect(row!.captureId).toBeNull()
    expect(row!.proposedFee).toBeNull()
  })
})
