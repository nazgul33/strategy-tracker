import { describe, test, expect, beforeAll } from 'bun:test'
import { sql, type SQL } from 'drizzle-orm'
import { getDb, applyMigrations } from '../src/db/client'
import type { Db } from '../src/db/db-type'
import { getRepos } from '../src/db/repos'
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

  describe('vision review storage', () => {
    async function newCapture(): Promise<{ runId: number; captureId: number }> {
      const stamp = Date.now() + '-' + Math.random().toString(36).slice(2)
      const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'V' + stamp.slice(-8), name: 'vision-' + stamp, poolCents: 1000, costPpm: 10 })
      const ins = await repos.captureRepo.insert({ runId, chatId: 'c', imageHash: 'h' + stamp, status: 'pending' })
      return { runId, captureId: ins.id! }
    }
    const review = (runId: number, captureId: number, pendingFillId: number, over: Record<string, unknown> = {}) => ({
      runId, captureId, pendingFillId, ticker: 'VV', outcome: 'confirmed' as const,
      detectedSide: 'buy', detectedShares: 5, detectedPrice: 1234567n, detectedFilledOn: '2026-02-10', detectedFee: null,
      finalSide: 'buy', finalShares: 6, finalPrice: 1234567n, finalFilledOn: '2026-02-10', finalFee: 3,
      edited: true, feeOverridden: false, ...over,
    })

    test('captureImageRepo: insertIgnore stores once, second call reports false and keeps the original bytes', async () => {
      const { captureId } = await newCapture()
      expect(await repos.captureImageRepo.insertIgnore({ captureId, mime: 'image/png', bytes: Buffer.from('one'), byteLen: 3 })).toBe(true)
      expect(await repos.captureImageRepo.insertIgnore({ captureId, mime: 'image/jpeg', bytes: Buffer.from('two'), byteLen: 3 })).toBe(false)
      const got = (await repos.captureImageRepo.getBytes(captureId))!
      expect(got.mime).toBe('image/png')
      expect(Buffer.isBuffer(got.bytes)).toBe(true)
      expect(got.bytes.equals(Buffer.from('one'))).toBe(true)
    })

    test('captureImageRepo: bytes round trip binary content intact', async () => {
      const { captureId } = await newCapture()
      const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
      await repos.captureImageRepo.insertIgnore({ captureId, mime: 'image/jpeg', bytes, byteLen: bytes.length })
      expect((await repos.captureImageRepo.getBytes(captureId))!.bytes.equals(bytes)).toBe(true)
      expect(await repos.captureImageRepo.getBytes(2_000_000_000)).toBeNull()
    })

    test('captureImageRepo: setKeep then deleteFor', async () => {
      const { captureId } = await newCapture()
      await repos.captureImageRepo.insertIgnore({ captureId, mime: 'image/png', bytes: Buffer.from('abcd'), byteLen: 4 })
      expect((await repos.captureImageRepo.listKept(1000)).some((r) => r.captureId === captureId)).toBe(false)
      expect(await repos.captureImageRepo.isKept(captureId)).toBe(false)
      await repos.captureImageRepo.setKeep(captureId)
      expect(await repos.captureImageRepo.isKept(captureId)).toBe(true)
      const kept = (await repos.captureImageRepo.listKept(1000)).find((r) => r.captureId === captureId)
      expect(kept).toEqual({ captureId, mime: 'image/png', byteLen: 4, createdAt: expect.any(String) })
      expect(kept).not.toHaveProperty('bytes')
      await repos.captureImageRepo.deleteFor(captureId)
      expect((await repos.captureImageRepo.listKept(1000)).some((r) => r.captureId === captureId)).toBe(false)
      expect(await repos.captureImageRepo.getBytes(captureId)).toBeNull()
    })

    test('captureImageRepo: listKept is newest first, ties broken by capture id, and the limit drops the oldest', async () => {
      const [a, b, c] = [await newCapture(), await newCapture(), await newCapture()]
      const stamps = [[a, '2098-01-01 00:00:00'], [b, '2099-01-01 00:00:00'], [c, '2099-01-01 00:00:00']] as const
      for (const [cap] of stamps) await repos.captureImageRepo.insertIgnore({ captureId: cap.captureId, mime: 'image/png', bytes: Buffer.from('x'), byteLen: 1 })
      try {
        for (const [cap, at] of stamps) {
          await repos.captureImageRepo.setKeep(cap.captureId)
          await db.execute(sql`UPDATE capture_images SET created_at = ${at} WHERE capture_id = ${cap.captureId}`)
        }
        const expected = [Math.max(b.captureId, c.captureId), Math.min(b.captureId, c.captureId), a.captureId]
        expect((await repos.captureImageRepo.listKept(1000)).map((r) => r.captureId).filter((id: number) => expected.includes(id))).toEqual(expected)
        // 2099 rows outrank anything a sibling test left behind, so the top two are exactly ours.
        expect((await repos.captureImageRepo.listKept(2)).map((r) => r.captureId)).toEqual(expected.slice(0, 2))
      } finally {
        for (const cap of [a, b, c]) await repos.captureImageRepo.deleteFor(cap.captureId)
      }
    })

    test('captureImageRepo: existingIds reports only captures that have bytes', async () => {
      const a = await newCapture()
      const b = await newCapture()
      await repos.captureImageRepo.insertIgnore({ captureId: a.captureId, mime: 'image/png', bytes: Buffer.from('abcd'), byteLen: 4 })
      expect([...(await repos.captureImageRepo.existingIds([a.captureId, b.captureId, 2_000_000_000]))]).toEqual([a.captureId])
      expect((await repos.captureImageRepo.existingIds([])).size).toBe(0)
    })

    test('visionReviewRepo: insertIgnore is idempotent per pendingFillId and listForCaptures groups by capture', async () => {
      const a = await newCapture()
      const b = await newCapture()
      const base = Date.now() % 1_000_000_000
      await repos.visionReviewRepo.insertIgnore(review(a.runId, a.captureId, base))
      await repos.visionReviewRepo.insertIgnore(review(a.runId, a.captureId, base, { finalShares: 99 }))
      await repos.visionReviewRepo.insertIgnore(review(a.runId, a.captureId, base + 1, { outcome: 'rejected', finalSide: null, finalShares: null, finalPrice: null, finalFilledOn: null, finalFee: null, edited: false }))
      await repos.visionReviewRepo.insertIgnore(review(b.runId, b.captureId, base + 2, { feeOverridden: true }))
      const rows = await repos.visionReviewRepo.listForCaptures([a.captureId, b.captureId])
      expect(rows.map((r) => r.pendingFillId)).toEqual([base, base + 1, base + 2])
      expect(rows.map((r) => r.captureId)).toEqual([a.captureId, a.captureId, b.captureId])
      expect(rows[0]).toMatchObject({ detectedPrice: 1234567n, detectedFee: null, finalShares: 6, finalFee: 3, edited: true, outcome: 'confirmed', feeOverridden: false })
      expect(rows[1]).toMatchObject({ outcome: 'rejected', finalShares: null, edited: false, feeOverridden: false })
      expect(rows[2]).toMatchObject({ feeOverridden: true })
      expect(await repos.visionReviewRepo.listForCaptures([])).toEqual([])
      expect(await repos.visionReviewRepo.listForCaptures([a.captureId])).toHaveLength(2)
    })

    test('visionReviewRepo: deleteFor removes only that capture', async () => {
      const a = await newCapture()
      const b = await newCapture()
      const base = (Date.now() % 1_000_000_000) + 10
      await repos.visionReviewRepo.insertIgnore(review(a.runId, a.captureId, base))
      await repos.visionReviewRepo.insertIgnore(review(b.runId, b.captureId, base + 1))
      await repos.visionReviewRepo.deleteFor(a.captureId)
      expect(await repos.visionReviewRepo.listForCaptures([a.captureId])).toEqual([])
      expect(await repos.visionReviewRepo.listForCaptures([b.captureId])).toHaveLength(1)
    })

    test('pending_fills snapshot columns round trip, detectedAt null on rows without a snapshot', async () => {
      const { runId, captureId } = await newCapture()
      const legacy = await repos.pendingRepo.insert({ runId, captureId, bucketIdx: null, side: 'buy', ticker: 'V', shares: 1, price: 100n, fee: null, filledOn: '2026-02-10', status: 'pending', ...NO_SNAPSHOT })
      const snap = await repos.pendingRepo.insert({
        runId, captureId, bucketIdx: null, side: 'buy', ticker: 'V', shares: 1, price: 100n, fee: null, filledOn: '2026-02-10', status: 'pending',
        detectedSide: 'buy', detectedShares: 1, detectedPrice: 100n, detectedFilledOn: null, detectedFee: null, detectedAt: '2026-02-10 12:00:00',
      })
      const l = (await repos.pendingRepo.get(legacy))!
      const s = (await repos.pendingRepo.get(snap))!
      expect(l.detectedAt).toBeNull()
      expect(l.detectedSide).toBeNull()
      expect(s).toMatchObject({ detectedSide: 'buy', detectedShares: 1, detectedPrice: 100n, detectedFilledOn: null, detectedFee: null })
      expect(s.detectedAt).not.toBeNull()
    })

    test('decide stores the fee override and listUnfrozenKept returns it', async () => {
      const { runId, captureId } = await newCapture()
      await repos.captureImageRepo.insertIgnore({ captureId, mime: 'image/png', bytes: Buffer.from('abcd'), byteLen: 4 })
      await repos.captureImageRepo.setKeep(captureId)
      const id = await repos.pendingRepo.insert({ runId, captureId, bucketIdx: null, side: 'buy', ticker: 'V', shares: 1, price: 100n, fee: 5, filledOn: '2026-02-10', status: 'pending', ...NO_SNAPSHOT })
      expect(await repos.pendingRepo.decide(id, 'confirmed', { side: 'buy', shares: 1, price: 100n, fee: 0, filledOn: '2026-02-10', bucketIdx: 0, feeOverride: 'cleared' })).toBe(true)
      expect(await selectRows(sql`select fee_override from pending_fills where id = ${id}`)).toEqual([{ fee_override: 'cleared' }])
      expect(await repos.visionReviewRepo.listUnfrozenKept()).toContainEqual(expect.objectContaining({ id, feeOverride: 'cleared' }))
    })
  })
})
