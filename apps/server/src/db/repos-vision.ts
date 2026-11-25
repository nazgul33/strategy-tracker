import { and, desc, eq, inArray, notExists, sql } from 'drizzle-orm'
import type { AnyMySqlColumn } from 'drizzle-orm/mysql-core'
import * as s from './schema'
import type { Db } from './db-type'
import type { UnfrozenPendingRow, VisionReviewInsert, VisionReviewRow } from '../domain/vision-review'

export type CaptureImageInsert = { captureId: number; mime: string; bytes: Buffer; byteLen: number }
export type CaptureImageListing = { captureId: number; mime: string; byteLen: number; createdAt: string }

export function getVisionRepos(db: Db) {
  const captureImageRepo = {
    // INSERT IGNORE rather than a no-op ON DUPLICATE KEY UPDATE: mysql2 connects
    // with CLIENT_FOUND_ROWS, so a no-op update still reports affectedRows = 1
    // and could not be told apart from a real insert. First bytes win.
    async insertIgnore(row: CaptureImageInsert): Promise<boolean> {
      const [res] = await db.insert(s.captureImages).ignore().values(row)
      return res.affectedRows === 1
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
      return new Set<number>(rows.map((r) => r.captureId))
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
      await db.transaction(async (tx) => {
        await tx.delete(s.mrVisionReviews).where(eq(s.mrVisionReviews.captureId, captureId))
        await tx.delete(s.captureImages).where(eq(s.captureImages.captureId, captureId))
      })
    },
    // Boot-time janitor for bytes and frozen rows stranded by a swallowed archive failure.
    // Run it only while nothing else is writing. A requested keep is written before the confirm
    // or reject flips its row, so that image is safe; but a pass between the flip and the freeze
    // of a resolution that asked for no keep would delete an image it is still about to freeze.
    async sweepOrphans(): Promise<number[]> {
      return db.transaction(async (tx) => {
        const liveFor = (captureId: AnyMySqlColumn) => tx.select({ one: sql`1` }).from(s.mrPendingFills)
          .where(and(eq(s.mrPendingFills.captureId, captureId), eq(s.mrPendingFills.status, 'pending')))
        const unkept = await tx.select({ captureId: s.captureImages.captureId }).from(s.captureImages)
          .where(and(eq(s.captureImages.keep, false), notExists(liveFor(s.captureImages.captureId))))
          .for('update')
        const imageIds: number[] = unkept.map((r) => r.captureId)
        if (imageIds.length) {
          await tx.delete(s.mrVisionReviews).where(inArray(s.mrVisionReviews.captureId, imageIds))
          await tx.delete(s.captureImages).where(inArray(s.captureImages.captureId, imageIds))
        }
        const imageFor = (captureId: AnyMySqlColumn) => tx.select({ one: sql`1` }).from(s.captureImages)
          .where(eq(s.captureImages.captureId, captureId))
        const frozen = await tx.selectDistinct({ captureId: s.mrVisionReviews.captureId }).from(s.mrVisionReviews)
          .where(and(notExists(imageFor(s.mrVisionReviews.captureId)), notExists(liveFor(s.mrVisionReviews.captureId))))
          .for('update')
        const frozenIds: number[] = frozen.map((r) => r.captureId)
        if (frozenIds.length) await tx.delete(s.mrVisionReviews).where(inArray(s.mrVisionReviews.captureId, frozenIds))
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
      await db.insert(s.mrVisionReviews).values(row)
        .onDuplicateKeyUpdate({ set: { pendingFillId: row.pendingFillId } })
    },
    // Resolved rows of a kept image that have no frozen record: what a crash between a
    // confirm's flip and its freeze leaves behind. Siblings are not looked at.
    async listUnfrozenKept(): Promise<UnfrozenPendingRow[]> {
      const frozen = db.select({ one: sql`1` }).from(s.mrVisionReviews).where(eq(s.mrVisionReviews.pendingFillId, s.mrPendingFills.id))
      const rows = await db.select({
        id: s.mrPendingFills.id, runId: s.mrPendingFills.runId, ticker: s.mrPendingFills.ticker, captureId: s.mrPendingFills.captureId,
        status: s.mrPendingFills.status, side: s.mrPendingFills.side, shares: s.mrPendingFills.shares, price: s.mrPendingFills.price,
        fee: s.mrPendingFills.fee, filledOn: s.mrPendingFills.filledOn, feeOverride: s.mrPendingFills.feeOverride,
        detectedSide: s.mrPendingFills.detectedSide, detectedShares: s.mrPendingFills.detectedShares,
        detectedPrice: s.mrPendingFills.detectedPrice, detectedFilledOn: s.mrPendingFills.detectedFilledOn,
        detectedFee: s.mrPendingFills.detectedFee, detectedAt: s.mrPendingFills.detectedAt,
      }).from(s.mrPendingFills)
        .innerJoin(s.captureImages, and(eq(s.captureImages.captureId, s.mrPendingFills.captureId), eq(s.captureImages.keep, true)))
        .where(and(inArray(s.mrPendingFills.status, ['confirmed', 'rejected']), notExists(frozen)))
        .orderBy(s.mrPendingFills.id)
      // Redundant with the inner join and the status filter; narrows the column types.
      return rows.filter((r): r is typeof r & { captureId: number; status: 'confirmed' | 'rejected' } =>
        r.captureId !== null && (r.status === 'confirmed' || r.status === 'rejected'))
    },
    async listForCaptures(captureIds: number[]): Promise<VisionReviewRow[]> {
      if (!captureIds.length) return []
      return db.select({
        id: s.mrVisionReviews.id, runId: s.mrVisionReviews.runId, captureId: s.mrVisionReviews.captureId,
        pendingFillId: s.mrVisionReviews.pendingFillId, ticker: s.mrVisionReviews.ticker, outcome: s.mrVisionReviews.outcome,
        detectedSide: s.mrVisionReviews.detectedSide, detectedShares: s.mrVisionReviews.detectedShares,
        detectedPrice: s.mrVisionReviews.detectedPrice, detectedFilledOn: s.mrVisionReviews.detectedFilledOn,
        detectedFee: s.mrVisionReviews.detectedFee,
        finalSide: s.mrVisionReviews.finalSide, finalShares: s.mrVisionReviews.finalShares,
        finalPrice: s.mrVisionReviews.finalPrice, finalFilledOn: s.mrVisionReviews.finalFilledOn,
        finalFee: s.mrVisionReviews.finalFee,
        edited: s.mrVisionReviews.edited, feeOverridden: s.mrVisionReviews.feeOverridden, createdAt: s.mrVisionReviews.createdAt,
      }).from(s.mrVisionReviews).where(inArray(s.mrVisionReviews.captureId, captureIds)).orderBy(s.mrVisionReviews.id)
    },
    async deleteFor(captureId: number): Promise<void> {
      await db.delete(s.mrVisionReviews).where(eq(s.mrVisionReviews.captureId, captureId))
    },
  }

  return { captureImageRepo, visionReviewRepo }
}
