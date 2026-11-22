import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { getDb, applyMigrations } from '../src/db/client'
import { getRepos } from '../src/db/repos'

const describeIf = process.env.TEST_DATABASE_URL ? describe : describe.skip

// sweepOrphans deletes globally, so this suite runs on its own scratch database
// (like scripts/e2e.ts) and never touches the tables other suites share in st_test.
describeIf('vision janitor (db)', () => {
  const SCRATCH = `st_janitor_${Date.now().toString(36)}_${process.pid.toString(36)}`
  let repos: ReturnType<typeof getRepos>
  let parent: Awaited<ReturnType<typeof getDb>> | undefined
  let scratch: Awaited<ReturnType<typeof getDb>> | undefined
  let created = false

  beforeAll(async () => {
    if (!/^st_janitor_[a-z0-9]+_[a-z0-9]+$/.test(SCRATCH)) throw new Error(`unexpected scratch db name '${SCRATCH}'`)
    const url = new URL(process.env.TEST_DATABASE_URL!)
    parent = await getDb(url.toString())
    await parent.$client.query(`CREATE DATABASE \`${SCRATCH}\``)
    created = true
    url.pathname = `/${SCRATCH}`
    scratch = await getDb(url.toString())
    await applyMigrations(scratch)
    repos = getRepos(scratch)
  })

  afterAll(async () => {
    try {
      if (created) await parent!.$client.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``)
    } finally {
      await scratch?.$client.end()
      await parent?.$client.end()
    }
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

  test('sweepOrphans leaves a half-reviewed capture alone', async () => {
    const { runId, captureId } = await newCapture()
    await image(captureId)
    await pending(runId, captureId, 'pending')
    const resolved = await pending(runId, captureId, 'confirmed')
    await repos.visionReviewRepo.insertIgnore(review(runId, captureId, resolved))
    const swept: number[] = await repos.captureImageRepo.sweepOrphans()
    expect(swept).not.toContain(captureId)
    expect(await repos.captureImageRepo.getBytes(captureId)).not.toBeNull()
    expect(await repos.visionReviewRepo.listForCaptures([captureId])).toHaveLength(1)
  })

  test('listUnfrozenKept lists resolved rows of kept images that lack a frozen row, and nothing else', async () => {
    const a = await newCapture()
    await image(a.captureId); await repos.captureImageRepo.setKeep(a.captureId)
    const lost = await pending(a.runId, a.captureId, 'confirmed')
    await pending(a.runId, a.captureId, 'pending')
    const b = await newCapture()
    await image(b.captureId); await repos.captureImageRepo.setKeep(b.captureId)
    const ok = await pending(b.runId, b.captureId, 'confirmed')
    await repos.visionReviewRepo.insertIgnore(review(b.runId, b.captureId, ok))
    const c = await newCapture()
    await image(c.captureId)
    await pending(c.runId, c.captureId, 'confirmed')
    // a reject that crashed between the flip and the freeze is just as unfrozen as a lost confirm
    const d = await newCapture()
    await image(d.captureId); await repos.captureImageRepo.setKeep(d.captureId)
    const rejected = await pending(d.runId, d.captureId, 'rejected')
    const rows = await repos.visionReviewRepo.listUnfrozenKept()
    const mine = rows.filter((r) => [a.captureId, b.captureId, c.captureId, d.captureId].includes(r.captureId))
    expect(mine.map((r) => r.id)).toEqual([lost, rejected])
    expect(mine[0]).toMatchObject({ captureId: a.captureId, status: 'confirmed', shares: 1, price: 100n })
    expect(mine[1]).toMatchObject({ captureId: d.captureId, status: 'rejected' })
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
