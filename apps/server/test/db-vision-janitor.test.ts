import { describe, test, expect, beforeAll } from 'bun:test'
import { getDb, applyMigrations } from '../src/db/client'
import { getRepos } from '../src/db/repos'

const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip

// The database is shared with other suites: every case seeds its own captures and
// asserts by its own ids, never on the total swept.
describeIf('vision janitor (db)', () => {
  let repos: any
  beforeAll(async () => {
    const db = await getDb(process.env.TEST_DATABASE_URL!)
    await applyMigrations(db)
    repos = getRepos(db)
  })

  async function newCapture(): Promise<{ runId: number; captureId: number }> {
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2)
    const runId = await repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'J' + stamp.slice(-8), name: 'janitor-' + stamp, poolCents: 1000, costPpm: 10 })
    const ins = await repos.captureRepo.insert({ runId, chatId: 'c', imageHash: 'h' + stamp, status: 'parsed' })
    return { runId, captureId: ins.id! }
  }
  const review = (runId: number, captureId: number, pendingFillId: number, over: Record<string, unknown> = {}) => ({
    runId, captureId, pendingFillId, ticker: 'JJ', outcome: 'confirmed' as const,
    detectedSide: 'buy', detectedShares: 5, detectedPrice: 1234567n, detectedFilledOn: '2026-02-10', detectedFee: null,
    finalSide: 'buy', finalShares: 6, finalPrice: 1234567n, finalFilledOn: '2026-02-10', finalFee: 3,
    edited: true, feeOverridden: false, ...over,
  })
  const image = (captureId: number) => repos.captureImageRepo.insertIgnore({ captureId, mime: 'image/png', bytes: Buffer.from('png'), byteLen: 3 })
  const pending = (runId: number, captureId: number, status: 'pending' | 'confirmed' | 'rejected') =>
    repos.pendingRepo.insert({ runId, captureId, side: 'buy', ticker: 'JJ', shares: 1, price: 100n, fee: null, filledOn: '2026-02-10', status })

  test('sweepOrphans deletes an unkept image with no live pending row, and its frozen rows', async () => {
    const { runId, captureId } = await newCapture()
    await image(captureId)
    const pid = await pending(runId, captureId, 'confirmed')
    await repos.visionReviewRepo.insertIgnore(review(runId, captureId, pid))
    const swept: number[] = await repos.captureImageRepo.sweepOrphans()
    expect(swept).toContain(captureId)
    expect(await repos.captureImageRepo.getBytes(captureId)).toBeNull()
    expect(await repos.visionReviewRepo.listForCaptures([captureId])).toEqual([])
  })

  test('sweepOrphans keeps an unkept image while a pending row is live', async () => {
    const { runId, captureId } = await newCapture()
    await image(captureId)
    await pending(runId, captureId, 'pending')
    const swept: number[] = await repos.captureImageRepo.sweepOrphans()
    expect(swept).not.toContain(captureId)
    expect(await repos.captureImageRepo.getBytes(captureId)).not.toBeNull()
  })

  test('sweepOrphans keeps a kept image with no live pending row, and its frozen rows', async () => {
    const { runId, captureId } = await newCapture()
    await image(captureId)
    await repos.captureImageRepo.setKeep(captureId)
    const pid = await pending(runId, captureId, 'confirmed')
    await repos.visionReviewRepo.insertIgnore(review(runId, captureId, pid))
    const swept: number[] = await repos.captureImageRepo.sweepOrphans()
    expect(swept).not.toContain(captureId)
    expect(await repos.captureImageRepo.getBytes(captureId)).not.toBeNull()
    expect(await repos.visionReviewRepo.listForCaptures([captureId])).toHaveLength(1)
  })

  test('sweepOrphans deletes frozen rows left without an image and without a live pending row, but not those with a live sibling', async () => {
    const orphan = await newCapture()
    const sibling = await newCapture()
    const oPid = await pending(orphan.runId, orphan.captureId, 'confirmed')
    await repos.visionReviewRepo.insertIgnore(review(orphan.runId, orphan.captureId, oPid))
    const sPid = await pending(sibling.runId, sibling.captureId, 'confirmed')
    await repos.visionReviewRepo.insertIgnore(review(sibling.runId, sibling.captureId, sPid))
    await pending(sibling.runId, sibling.captureId, 'pending')

    const swept: number[] = await repos.captureImageRepo.sweepOrphans()
    expect(swept).toContain(orphan.captureId)
    expect(swept).not.toContain(sibling.captureId)
    expect(await repos.visionReviewRepo.listForCaptures([orphan.captureId])).toEqual([])
    expect(await repos.visionReviewRepo.listForCaptures([sibling.captureId])).toHaveLength(1)
    expect([...swept].sort((a, b) => a - b)).toEqual(swept)
    expect(new Set(swept).size).toBe(swept.length)
  })

  test('discard removes one capture\'s image and frozen rows and leaves another capture alone', async () => {
    const a = await newCapture()
    const b = await newCapture()
    for (const c of [a, b]) {
      await image(c.captureId)
      await repos.captureImageRepo.setKeep(c.captureId)
      const pid = await pending(c.runId, c.captureId, 'confirmed')
      await repos.visionReviewRepo.insertIgnore(review(c.runId, c.captureId, pid))
    }
    await repos.captureImageRepo.discard(a.captureId)
    expect(await repos.captureImageRepo.getBytes(a.captureId)).toBeNull()
    expect(await repos.visionReviewRepo.listForCaptures([a.captureId])).toEqual([])
    expect(await repos.captureImageRepo.getBytes(b.captureId)).not.toBeNull()
    expect(await repos.visionReviewRepo.listForCaptures([b.captureId])).toHaveLength(1)
  })
})
