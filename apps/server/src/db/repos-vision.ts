import { and, desc, eq, inArray, notExists, sql } from 'drizzle-orm'
import * as s from './schema'
import type { VisionReviewInsert, VisionReviewRow } from '../domain/vision-review'

export type CaptureImageInsert = { captureId: number; mime: string; bytes: Buffer; byteLen: number }
export type CaptureImageListing = { captureId: number; mime: string; byteLen: number; createdAt: string }

export function getVisionRepos(db: any) {
  const captureImageRepo = {
    // INSERT IGNORE rather than a no-op ON DUPLICATE KEY UPDATE: mysql2 connects
    // with CLIENT_FOUND_ROWS, so a no-op update still reports affectedRows = 1
    // and could not be told apart from a real insert. First bytes win.
    async insertIgnore(row: CaptureImageInsert): Promise<boolean> {
      const [res] = await db.insert(s.captureImages).ignore().values(row)
      return (res as any)?.affectedRows === 1
    },
    // The only method that reads the blob.
    async getBytes(captureId: number): Promise<{ mime: string; bytes: Buffer } | null> {
      const rows = await db.select({ mime: s.captureImages.mime, bytes: s.captureImages.bytes }).from(s.captureImages)
        .where(eq(s.captureImages.captureId, captureId)).limit(1)
      return rows[0] ?? null
    },
    // Presence check for listings: selects the key only, never the blob.
    async existingIds(captureIds: number[]): Promise<Set<number>> {
      if (!captureIds.length) return new Set()
      const rows = await db.select({ captureId: s.captureImages.captureId }).from(s.captureImages)
        .where(inArray(s.captureImages.captureId, captureIds))
      return new Set<number>(rows.map((r: { captureId: number }) => r.captureId))
    },
    async isKept(captureId: number): Promise<boolean> {
      const rows = await db.select({ keep: s.captureImages.keep }).from(s.captureImages)
        .where(eq(s.captureImages.captureId, captureId)).limit(1)
      return rows[0]?.keep === true
    },
    async setKeep(captureId: number): Promise<void> {
      await db.update(s.captureImages).set({ keep: true }).where(eq(s.captureImages.captureId, captureId))
    },
    async deleteFor(captureId: number): Promise<void> {
      await db.delete(s.captureImages).where(eq(s.captureImages.captureId, captureId))
    },
    // The image and its frozen rows go together or not at all.
    async discard(captureId: number): Promise<void> {
      await db.transaction(async (tx: any) => {
        await tx.delete(s.visionReviews).where(eq(s.visionReviews.captureId, captureId))
        await tx.delete(s.captureImages).where(eq(s.captureImages.captureId, captureId))
      })
    },
    // Boot-time janitor for bytes and frozen rows stranded by a swallowed archive failure.
    // Run it only while nothing else is writing: a pass between a confirm's decide and its
    // setKeep would delete the image that confirm is about to keep.
    async sweepOrphans(): Promise<number[]> {
      return db.transaction(async (tx: any) => {
        const liveFor = (captureId: any) => tx.select({ one: sql`1` }).from(s.pendingFills)
          .where(and(eq(s.pendingFills.captureId, captureId), eq(s.pendingFills.status, 'pending')))
        const unkept = await tx.select({ captureId: s.captureImages.captureId }).from(s.captureImages)
          .where(and(eq(s.captureImages.keep, false), notExists(liveFor(s.captureImages.captureId))))
          .for('update')
        const imageIds: number[] = unkept.map((r: { captureId: number }) => r.captureId)
        if (imageIds.length) {
          await tx.delete(s.visionReviews).where(inArray(s.visionReviews.captureId, imageIds))
          await tx.delete(s.captureImages).where(inArray(s.captureImages.captureId, imageIds))
        }
        const imageFor = (captureId: any) => tx.select({ one: sql`1` }).from(s.captureImages)
          .where(eq(s.captureImages.captureId, captureId))
        const frozen = await tx.selectDistinct({ captureId: s.visionReviews.captureId }).from(s.visionReviews)
          .where(and(notExists(imageFor(s.visionReviews.captureId)), notExists(liveFor(s.visionReviews.captureId))))
          .for('update')
        const frozenIds: number[] = frozen.map((r: { captureId: number }) => r.captureId)
        if (frozenIds.length) await tx.delete(s.visionReviews).where(inArray(s.visionReviews.captureId, frozenIds))
        return [...new Set([...imageIds, ...frozenIds])].sort((a, b) => a - b)
      })
    },
    async listKept(limit: number): Promise<CaptureImageListing[]> {
      return db.select({
        captureId: s.captureImages.captureId, mime: s.captureImages.mime,
        byteLen: s.captureImages.byteLen, createdAt: s.captureImages.createdAt,
      }).from(s.captureImages).where(eq(s.captureImages.keep, true))
        .orderBy(desc(s.captureImages.createdAt), desc(s.captureImages.captureId)).limit(limit)
    },
  }

  const visionReviewRepo = {
    async insertIgnore(row: VisionReviewInsert): Promise<void> {
      await db.insert(s.visionReviews).values(row)
        .onDuplicateKeyUpdate({ set: { pendingFillId: row.pendingFillId } })
    },
    async listForCaptures(captureIds: number[]): Promise<VisionReviewRow[]> {
      if (!captureIds.length) return []
      return db.select({
        id: s.visionReviews.id, runId: s.visionReviews.runId, captureId: s.visionReviews.captureId,
        pendingFillId: s.visionReviews.pendingFillId, ticker: s.visionReviews.ticker, outcome: s.visionReviews.outcome,
        detectedSide: s.visionReviews.detectedSide, detectedShares: s.visionReviews.detectedShares,
        detectedPrice: s.visionReviews.detectedPrice, detectedFilledOn: s.visionReviews.detectedFilledOn,
        detectedFee: s.visionReviews.detectedFee,
        finalSide: s.visionReviews.finalSide, finalShares: s.visionReviews.finalShares,
        finalPrice: s.visionReviews.finalPrice, finalFilledOn: s.visionReviews.finalFilledOn,
        finalFee: s.visionReviews.finalFee,
        edited: s.visionReviews.edited, feeOverridden: s.visionReviews.feeOverridden, createdAt: s.visionReviews.createdAt,
      }).from(s.visionReviews).where(inArray(s.visionReviews.captureId, captureIds)).orderBy(s.visionReviews.id)
    },
    async deleteFor(captureId: number): Promise<void> {
      await db.delete(s.visionReviews).where(eq(s.visionReviews.captureId, captureId))
    },
  }

  return { captureImageRepo, visionReviewRepo }
}
