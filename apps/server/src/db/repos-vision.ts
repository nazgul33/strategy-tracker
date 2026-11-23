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
        await tx.delete(s.visionReviews).where(eq(s.visionReviews.captureId, captureId))
        await tx.delete(s.captureImages).where(eq(s.captureImages.captureId, captureId))
      })
    },
    // Boot-time janitor for bytes and frozen rows stranded by a swallowed archive failure.
    // Run it only while nothing else is writing. A requested keep is written before the confirm
    // or reject flips its row, so that image is safe; but a pass between the flip and the freeze
    // of a resolution that asked for no keep would delete an image it is still about to freeze.
    async sweepOrphans(): Promise<number[]> {
      return db.transaction(async (tx) => {
        const liveFor = (captureId: AnyMySqlColumn) => tx.select({ one: sql`1` }).from(s.pendingFills)
          .where(and(eq(s.pendingFills.captureId, captureId), eq(s.pendingFills.status, 'pending')))
        const unkept = await tx.select({ captureId: s.captureImages.captureId }).from(s.captureImages)
          .where(and(eq(s.captureImages.keep, false), notExists(liveFor(s.captureImages.captureId))))
          .for('update')
        const imageIds: number[] = unkept.map((r) => r.captureId)
        if (imageIds.length) {
          await tx.delete(s.visionReviews).where(inArray(s.visionReviews.captureId, imageIds))
          await tx.delete(s.captureImages).where(inArray(s.captureImages.captureId, imageIds))
        }
        const imageFor = (captureId: AnyMySqlColumn) => tx.select({ one: sql`1` }).from(s.captureImages)
          .where(eq(s.captureImages.captureId, captureId))
        const frozen = await tx.selectDistinct({ captureId: s.visionReviews.captureId }).from(s.visionReviews)
          .where(and(notExists(imageFor(s.visionReviews.captureId)), notExists(liveFor(s.visionReviews.captureId))))
          .for('update')
        const frozenIds: number[] = frozen.map((r) => r.captureId)
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
    // Resolved rows of a kept image that have no frozen record: what a crash between a
    // confirm's flip and its freeze leaves behind. Siblings are not looked at.
    async listUnfrozenKept(): Promise<UnfrozenPendingRow[]> {
      const frozen = db.select({ one: sql`1` }).from(s.visionReviews).where(eq(s.visionReviews.pendingFillId, s.pendingFills.id))
      const rows = await db.select({
        id: s.pendingFills.id, runId: s.pendingFills.runId, ticker: s.pendingFills.ticker, captureId: s.pendingFills.captureId,
        status: s.pendingFills.status, side: s.pendingFills.side, shares: s.pendingFills.shares, price: s.pendingFills.price,
        fee: s.pendingFills.fee, filledOn: s.pendingFills.filledOn,
        detectedSide: s.pendingFills.detectedSide, detectedShares: s.pendingFills.detectedShares,
        detectedPrice: s.pendingFills.detectedPrice, detectedFilledOn: s.pendingFills.detectedFilledOn,
        detectedFee: s.pendingFills.detectedFee, detectedAt: s.pendingFills.detectedAt,
      }).from(s.pendingFills)
        .innerJoin(s.captureImages, and(eq(s.captureImages.captureId, s.pendingFills.captureId), eq(s.captureImages.keep, true)))
        .where(and(inArray(s.pendingFills.status, ['confirmed', 'rejected']), notExists(frozen)))
        .orderBy(s.pendingFills.id)
      // Redundant with the inner join and the status filter; narrows the column types.
      return rows.filter((r): r is typeof r & { captureId: number; status: 'confirmed' | 'rejected' } =>
        r.captureId !== null && (r.status === 'confirmed' || r.status === 'rejected'))
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
