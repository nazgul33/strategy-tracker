import { describe, test, expect, spyOn } from 'bun:test'
import { parseUsd } from '@st/core/money'
import { confirmPendingFill, rejectPendingFill } from '../src/domain/booking'
import type { NewPending } from '../src/domain/repo-types'
import { createApp } from '../src/http/app'
import { makeCaptureHandlers } from '../src/wire/capture'
import { t } from '@st/telegram/i18n'
import { makeFakes, makeDeps, loginAs, createRun } from './http-fakes'
import { TODAY, setup } from './vision-review-fixture'

describe('rejectPendingFill', () => {
  test('resolves null for a missing or already handled row and writes nothing', async () => {
    const { f, deps, ids } = await setup(2)
    expect(await rejectPendingFill(999, deps)).toBeNull()
    expect(await rejectPendingFill(ids[0]!, deps)).toEqual({ archived: true })
    expect(await rejectPendingFill(ids[0]!, deps)).toBeNull()
    expect(f._stores.visionReviews).toHaveLength(1)
  })

  test('an archive failure after the reject took effect is logged, not thrown', async () => {
    const { f, deps, ids } = await setup(1)
    f.repos.visionReviewRepo.insertIgnore = async () => { throw new Error('archive-down') }
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await rejectPendingFill(ids[0]!, deps)).toEqual({ archived: false })
      expect(String(err.mock.calls[0]!.join(' '))).toContain('archive-down')
    } finally {
      err.mockRestore()
    }
    expect(f._stores.pending.find((p: any) => p.id === ids[0])!.status).toBe('rejected')
  })
})

describe('confirmPendingFill validation order', () => {
  test('a malformed override on an already handled row answers not-pending first', async () => {
    const { deps, ids } = await setup(1)
    await rejectPendingFill(ids[0]!, deps)
    await expect(confirmPendingFill(ids[0]!, { side: 'hold' as any }, deps)).rejects.toThrow('pending-not-found-or-not-pending')
    await expect(confirmPendingFill(ids[0]!, { feeCents: -1 }, deps)).rejects.toThrow('pending-not-found-or-not-pending')
  })
})

describe('Telegram reject', () => {
  async function telegram() {
    const s = await setup(2)
    const sent: string[] = []
    const repos = { ...s.f.repos, pendingRepo: { ...s.f.repos.pendingRepo, get: async (id: number) => s.f._stores.pending.find((p: any) => p.id === id) ?? null } }
    const handlers = makeCaptureHandlers({
      repos, vision: { baseUrl: 'http://x', model: 'm' }, getVisionApiKey: async () => 'k',
      today: () => TODAY, allowedChatIds: [], send: async (_chat, text) => { sent.push(text) },
    })
    return { ...s, sent, handlers }
  }

  test('rejecting the last pending fill of a capture freezes its row and sweeps the bytes', async () => {
    const { f, ids, sent, handlers } = await telegram()
    await handlers.onConfirm('777', `no:${ids[0]}`, false)
    expect(f._stores.captureImages).toHaveLength(1)
    expect(f._stores.visionReviews).toHaveLength(1)
    expect(f._stores.visionReviews[0]).toMatchObject({ pendingFillId: ids[0], outcome: 'rejected', finalShares: null, edited: false })

    await handlers.onConfirm('777', `no:${ids[1]}`, false)
    expect(f._stores.captureImages).toHaveLength(0)
    expect(f._stores.visionReviews).toHaveLength(0)
    expect(sent).toEqual([t('rejected-line', 'en'), t('rejected-line', 'en')])
  })

  test('a repeat reject says already handled and archives nothing more', async () => {
    const { f, ids, sent, handlers } = await telegram()
    await handlers.onConfirm('777', `no:${ids[0]}`, false)
    await handlers.onConfirm('777', `no:${ids[0]}`, false)
    expect(sent).toEqual([t('rejected-line', 'en'), t('confirm-err-already-handled', 'en')])
    expect(f._stores.visionReviews).toHaveLength(1)
  })
})

describe('reject route', () => {
  test('rejecting the last unkept fill sweeps the bytes; a rejected fill with a pending sibling keeps them', async () => {
    const fakes = makeFakes()
    const app = createApp(makeDeps(fakes))
    const auth = await loginAs(app)
    const runId = await createRun(app, auth, { strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'rj', poolCents: 1_000_000, costPpm: 100 })
    const base: NewPending = { runId, captureId: 5, bucketIdx: null, side: 'buy', ticker: 'AAPL', shares: 1, price: parseUsd('10.00'), fee: null, filledOn: '2026-11-10', status: 'pending', detectedSide: 'buy', detectedShares: 1, detectedPrice: parseUsd('10.00'), detectedFilledOn: null, detectedFee: null, detectedAt: '2026-11-10 09:00:00' }
    const a = await fakes.repos.pendingRepo.insert({ ...base })
    const b = await fakes.repos.pendingRepo.insert({ ...base })
    await fakes.repos.captureImageRepo.insertIgnore({ captureId: 5, mime: 'image/png', bytes: Buffer.from('x'), byteLen: 1 })

    expect((await app.request(`/api/pending/${a}/reject`, { method: 'POST', headers: auth })).status).toBe(200)
    expect(fakes.captureImages).toHaveLength(1)
    expect(fakes.visionReviews).toHaveLength(1)
    expect(fakes.visionReviews[0]).toMatchObject({ pendingFillId: a, outcome: 'rejected', finalShares: null })

    expect((await app.request(`/api/pending/${b}/reject`, { method: 'POST', headers: auth })).status).toBe(200)
    expect(fakes.captureImages).toHaveLength(0)
    expect(fakes.visionReviews).toHaveLength(0)
  })
})
