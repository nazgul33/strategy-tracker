import { describe, test, expect } from 'bun:test'
import type { NewVrFill, NewVrPending } from '../src/domain/vr/repo-types'
import { makeChoiceFakes } from './capture-choice-fakes'
import { makeVrFakes } from './vr-fakes'

const pendingRow = (runId: number, over: Partial<NewVrPending> = {}): NewVrPending =>
  ({ runId, captureId: 1, side: 'buy', shares: 3, price: 451_500n, fee: null, filledOn: '2026-11-03', dateRead: true, dupPrice: null, ...over })
const fillFor = (runId: number, over: Partial<NewVrFill> = {}): NewVrFill =>
  ({ runId, side: 'buy', shares: 3, price: 451_500n, fee: 3, filledOn: '2026-11-03', source: 'capture', ...over })

describe('fake vrPendingRepo.confirm behaves like the real one', () => {
  test('two confirms started together on one pending row give one fill id and one null', async () => {
    const f = makeVrFakes()
    const [id] = await f.repos.vrPendingRepo.insertMany([pendingRow(7)])
    const results = await Promise.all([
      f.repos.vrPendingRepo.confirm(7, id!, fillFor(7)),
      f.repos.vrPendingRepo.confirm(7, id!, fillFor(7)),
    ])
    expect(results.filter((r) => r === null)).toHaveLength(1)
    expect(results.filter((r) => typeof r === 'number')).toHaveLength(1)
    expect(f.fills).toHaveLength(1)
    expect((await f.repos.vrPendingRepo.get(7, id!))!.status).toBe('confirmed')
  })

  test('a confirm whose fill insert throws leaves the row pending and adds no fill', async () => {
    const f = makeVrFakes()
    const [id] = await f.repos.vrPendingRepo.insertMany([pendingRow(7)])
    f.repos.vrFillRepo.insert = async () => { throw new Error('insert failed') }
    await expect(f.repos.vrPendingRepo.confirm(7, id!, fillFor(7))).rejects.toThrow('insert failed')
    expect((await f.repos.vrPendingRepo.get(7, id!))!.status).toBe('pending')
    expect(f.fills).toHaveLength(0)
  })

  test('a fill for another run throws before anything is written', async () => {
    const f = makeVrFakes()
    const [id] = await f.repos.vrPendingRepo.insertMany([pendingRow(7)])
    await expect(f.repos.vrPendingRepo.confirm(7, id!, fillFor(8))).rejects.toThrow('fill.runId')
    expect((await f.repos.vrPendingRepo.get(7, id!))!.status).toBe('pending')
    expect(f.fills).toHaveLength(0)
  })
})

describe('fake hasAnyForCapture', () => {
  test('true for a row in any status, false for a capture without one', async () => {
    const f = makeVrFakes()
    const [, b, c] = await f.repos.vrPendingRepo.insertMany([pendingRow(7, { captureId: 1 }), pendingRow(7, { captureId: 2 }), pendingRow(7, { captureId: 3 })])
    await f.repos.vrPendingRepo.reject(7, b!)
    await f.repos.vrPendingRepo.confirm(7, c!, fillFor(7))
    expect(await Promise.all([1, 2, 3, 4].map((id) => f.repos.vrPendingRepo.hasAnyForCapture(id)))).toEqual([true, true, true, false])
  })
})

describe('fake captureChoiceRepo ids', () => {
  test('a deleted question\'s id is not handed out again', async () => {
    const t = { now: new Date('2026-11-01T00:00:00Z') }
    const c = makeChoiceFakes(() => t.now)
    const q = { chatId: 'c', ticker: 'TQQQ', mrRunId: 1, vrRunId: 2, fills: [], image: { base64: 'QUJD', mime: 'image/png' }, readOn: '2026-11-01' }
    const first = await c.captureChoiceRepo.park(q)
    t.now = new Date('2026-11-05T00:00:00Z')
    expect(await c.captureChoiceRepo.deleteOlderThan(new Date('2026-11-03T00:00:00Z'))).toBe(1)
    const second = await c.captureChoiceRepo.park(q)
    expect(second).not.toBe(first)
    expect(await c.captureChoiceRepo.get(first)).toBeNull()
  })
})
