import { eq, inArray } from 'drizzle-orm'
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
    async listKept(limit: number): Promise<CaptureImageListing[]> {
      return db.select({
        captureId: s.captureImages.captureId, mime: s.captureImages.mime,
        byteLen: s.captureImages.byteLen, createdAt: s.captureImages.createdAt,
      }).from(s.captureImages).where(eq(s.captureImages.keep, true))
        .orderBy(s.captureImages.createdAt, s.captureImages.captureId).limit(limit)
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
        edited: s.visionReviews.edited, createdAt: s.visionReviews.createdAt,
      }).from(s.visionReviews).where(inArray(s.visionReviews.captureId, captureIds)).orderBy(s.visionReviews.id)
    },
    async deleteFor(captureId: number): Promise<void> {
      await db.delete(s.visionReviews).where(eq(s.visionReviews.captureId, captureId))
    },
  }

  return { captureImageRepo, visionReviewRepo }
}
