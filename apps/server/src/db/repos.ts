import { eq, and, sql, inArray, isNull, lt, desc } from 'drizzle-orm'
import * as s from './schema'
import type { Db } from './db-type'
import { getMrRunRepos } from './repos-mr-runs'
import { getSimRepo } from './repos-sim'
import { getBarRepos } from './repos-bars'
import { getVisionRepos } from './repos-vision'
import { getVrRepos } from './repos-vr'
import { getCaptureChoiceRepos } from './repos-capture-choice'
import type { CorrectionRepo, CorrectionRow } from '../domain/correction-types'
import type {
  CaptureRepo, CaptureStatus, FillPatch, FillRepo, LedgerRepo, NewCapture, NewFill, NewLedgerEntry, NewNotification,
  NotificationRepo, OrderRepo, OrderRecord, PendingRepo, PendingRow,
} from '../domain/repo-types'

export function getRepos(db: Db) {
  const { runRepo, bucketRepo } = getMrRunRepos(db)

  const orderRepo = {
    async insertMany(orders) {
      if (!orders.length) return
      await db.insert(s.mrOrders).values(orders)
    },
    async get(id): Promise<OrderRecord | null> {
      const rows = await db.select().from(s.mrOrders).where(eq(s.mrOrders.id, id))
      return rows[0] ?? null
    },
    async listForDate(date) {
      return db.select().from(s.mrOrders).where(sql`${s.mrOrders.tradeDate} = ${date}`)
    },
    async markStale(date) {
      const [res] = await db.update(s.mrOrders).set({ status: 'stale' }).where(and(eq(s.mrOrders.status, 'open'), sql`${s.mrOrders.tradeDate} < ${date}`))
      return res.affectedRows
    },
    async setStatus(id, status, cancelReason?) {
      await db.update(s.mrOrders)
        .set({ status, ...(cancelReason !== undefined ? { cancelReason } : {}) })
        .where(eq(s.mrOrders.id, id))
    },
    async listForRun(runId, date?) {
      if (date) return db.select().from(s.mrOrders).where(and(eq(s.mrOrders.runId, runId), sql`${s.mrOrders.tradeDate} = ${date}`))
      return db.select().from(s.mrOrders).where(eq(s.mrOrders.runId, runId))
    },
    async listForRunFrom(runId, fromDate) {
      return db.select().from(s.mrOrders).where(and(eq(s.mrOrders.runId, runId), sql`${s.mrOrders.tradeDate} >= ${fromDate}`)).orderBy(s.mrOrders.id)
    },
    async listUnreportedStale(runId) {
      return db.select().from(s.mrOrders)
        .where(and(eq(s.mrOrders.runId, runId), eq(s.mrOrders.status, 'stale'), isNull(s.mrOrders.reportedAt)))
        .orderBy(s.mrOrders.id)
    },
    async markReported(ids) {
      if (!ids.length) return
      await db.update(s.mrOrders).set({ reportedAt: sql`now()` }).where(inArray(s.mrOrders.id, ids))
    },
  } satisfies OrderRepo

  const fillRepo = {
    async insert(fill: NewFill): Promise<void> { await db.insert(s.mrFills).values(fill) },
    async listForRun(runId: number) { return db.select().from(s.mrFills).where(eq(s.mrFills.runId, runId)).orderBy(s.mrFills.id) },
    // Run-scoped guard: a foreign fillId can never be touched. Field names
    // match the mr_fills schema; price is bigint myriadths.
    async update(runId: number, fillId: number, patch: FillPatch): Promise<void> {
      await db.update(s.mrFills).set(patch).where(and(eq(s.mrFills.id, fillId), eq(s.mrFills.runId, runId)))
    },
    // Run-scoped guard: a foreign fillId can never be touched. No-op when absent.
    async deleteById(runId: number, fillId: number): Promise<void> {
      await db.delete(s.mrFills).where(and(eq(s.mrFills.id, fillId), eq(s.mrFills.runId, runId)))
    },
  } satisfies FillRepo

  async function hasPendingWithStatus(captureId: number, status: 'pending' | 'confirmed'): Promise<boolean> {
    const rows = await db.select({ id: s.mrPendingFills.id }).from(s.mrPendingFills)
      .where(and(eq(s.mrPendingFills.captureId, captureId), eq(s.mrPendingFills.status, status))).limit(1)
    return rows.length > 0
  }

  const pendingRepo = {
    async insert(p) { const [r] = await db.insert(s.mrPendingFills).values(p); return r.insertId },
    async listPending() { return db.select().from(s.mrPendingFills).where(eq(s.mrPendingFills.status, 'pending')) },
    async hasLiveForCapture(captureId) { return hasPendingWithStatus(captureId, 'pending') },
    async hasConfirmedForCapture(captureId) { return hasPendingWithStatus(captureId, 'confirmed') },
    async get(id): Promise<PendingRow | null> { const rows = await db.select().from(s.mrPendingFills).where(eq(s.mrPendingFills.id, id)); return rows[0] ?? null },
    async decide(id, status, edited?) {
      const patch = { status, ...edited }
      const [res] = await db.update(s.mrPendingFills).set(patch).where(and(eq(s.mrPendingFills.id, id), eq(s.mrPendingFills.status, 'pending')))
      return res.affectedRows > 0
    },
  } satisfies PendingRepo

  const correctionRepo = {
    async insert(c) { const [r] = await db.insert(s.mrFillCorrections).values(c); return r.insertId },
    async get(id): Promise<CorrectionRow | null> {
      const rows = await db.select().from(s.mrFillCorrections).where(eq(s.mrFillCorrections.id, id))
      return rows[0] ?? null
    },
    async listOpen() {
      return db.select().from(s.mrFillCorrections).where(eq(s.mrFillCorrections.status, 'open')).orderBy(s.mrFillCorrections.id)
    },
    // Same "only from open" guard as pendingRepo.decide.
    async decide(id, status) {
      const [res] = await db.update(s.mrFillCorrections).set({ status })
        .where(and(eq(s.mrFillCorrections.id, id), eq(s.mrFillCorrections.status, 'open')))
      return res.affectedRows > 0
    },
    // Applied corrections never block; dismissed ones stick ("I checked, the booked price is right").
    // The caller drops snapshot-stale rows.
    async listBlocking(fillId, proposedPrice) {
      return db.select().from(s.mrFillCorrections)
        .where(and(eq(s.mrFillCorrections.fillId, fillId), eq(s.mrFillCorrections.proposedPrice, proposedPrice), inArray(s.mrFillCorrections.status, ['open', 'dismissed'])))
        .orderBy(s.mrFillCorrections.id)
    },
    async hasOpenForCapture(captureId) {
      const rows = await db.select({ id: s.mrFillCorrections.id }).from(s.mrFillCorrections)
        .where(and(eq(s.mrFillCorrections.captureId, captureId), eq(s.mrFillCorrections.status, 'open'))).limit(1)
      return rows.length > 0
    },
  } satisfies CorrectionRepo

  const captureRepo = {
    async findByHash(runId: number, hash: string): Promise<{ id: number; status: CaptureStatus } | null> {
      const rows = await db.select({ id: s.captures.id, status: s.captures.status }).from(s.captures)
        .where(and(eq(s.captures.runId, runId), eq(s.captures.imageHash, hash))).limit(1)
      return rows[0] ?? null
    },
    async setStatus(id: number, status: 'parsed' | 'unparseable'): Promise<void> {
      await db.update(s.captures).set({ status }).where(eq(s.captures.id, id))
    },
    async insert(c: NewCapture): Promise<{ inserted: boolean; id?: number }> {
      try {
        const [res] = await db.insert(s.captures).values(c)
        return { inserted: true, id: res.insertId }
      } catch (e) {
        const err = e as { message?: string; cause?: { message?: string } } | null | undefined
        const msg = String(e) + ' ' + (err?.message ?? '') + ' ' + (err?.cause?.message ?? '')
        if (msg.includes('ER_DUP_ENTRY') || msg.toLowerCase().includes('duplicate')) return { inserted: false }
        throw e
      }
    },
  } satisfies CaptureRepo

  const ledgerRepo = {
    async insert(l: NewLedgerEntry): Promise<void> { await db.insert(s.mrLedger).values(l) },
    async listForRun(runId: number) { return db.select().from(s.mrLedger).where(eq(s.mrLedger.runId, runId)) },
  } satisfies LedgerRepo

  const notificationRepo = {
    async insert(n: NewNotification): Promise<void> { await db.insert(s.notifications).values(n) },
    async listForRun(runId: number) { return db.select().from(s.notifications).where(eq(s.notifications.runId, runId)) },
    async listBefore(before: number | null, limit: number) {
      return db.select().from(s.notifications).where(before === null ? undefined : lt(s.notifications.id, before)).orderBy(desc(s.notifications.id)).limit(limit)
    },
  } satisfies NotificationRepo

  const settingsRepo = {
    async getAll(): Promise<Record<string, string>> {
      const rows = await db.select().from(s.settings)
      const out: Record<string, string> = {}
      for (const r of rows) out[r.key] = r.value
      return out
    },
    async set(key: string, value: string) {
      await db.insert(s.settings).values({ key, value }).onDuplicateKeyUpdate({ set: { value } })
    },
  }
  const poolEditRepo = {
    async insert(input: { runId: number; poolCents: number }) {
      await db.insert(s.mrPoolEdits).values({ runId: input.runId, poolCents: input.poolCents })
    },
  }
  const simRepo = getSimRepo(db)
  const { priceHistoryRepo, barCoverageRepo } = getBarRepos(db)
  return { runRepo, orderRepo, fillRepo, priceHistoryRepo, barCoverageRepo, pendingRepo, correctionRepo, captureRepo, ledgerRepo, notificationRepo, bucketRepo, settingsRepo, poolEditRepo, simRepo, ...getVisionRepos(db), ...getVrRepos(db), ...getCaptureChoiceRepos(db) }
}
