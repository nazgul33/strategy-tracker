import { eq, and, lt, sql } from 'drizzle-orm'
import * as s from './schema'

type DayRow = { simRunId: number; tradeDate: string; planJson: string; stateJson: string; eventsJson: string }

function dayValues(rows: DayRow[]) {
  return rows.map((r) => ({
    simRunId: r.simRunId, tradeDate: r.tradeDate, planJson: r.planJson, stateJson: r.stateJson, eventsJson: r.eventsJson,
  }))
}

function affected(res: any): number {
  const header = Array.isArray(res) ? res[0] : res
  return header?.affectedRows ?? 0
}

export function getSimRepo(db: any) {
  return {
    // New runs are drafts until finalize().
    async insertRun(input: { ticker: string; fromDate: string; toDate: string; poolCents: number; costPpm: number; buyGapPpm: number; sellGapPpm: number; cutLossPpm: number; paramsJson: string }): Promise<number> {
      const [res] = await db.insert(s.simRuns).values({
        ticker: input.ticker, fromDate: input.fromDate, toDate: input.toDate,
        poolCents: input.poolCents, costPpm: input.costPpm, buyGapPpm: input.buyGapPpm, sellGapPpm: input.sellGapPpm,
        cutLossPpm: input.cutLossPpm, paramsJson: input.paramsJson, draft: true,
      })
      return (res as any).insertId
    },
    async updateConfig(id: number, v: { fromDate: string; toDate: string; poolCents: number; costPpm: number; buyGapPpm: number; sellGapPpm: number; cutLossPpm: number; paramsJson: string }): Promise<void> {
      await db.update(s.simRuns).set({
        fromDate: v.fromDate, toDate: v.toDate, poolCents: v.poolCents, costPpm: v.costPpm,
        buyGapPpm: v.buyGapPpm, sellGapPpm: v.sellGapPpm, cutLossPpm: v.cutLossPpm, paramsJson: v.paramsJson,
      }).where(eq(s.simRuns.id, id))
    },
    async insertDays(rows: DayRow[]) {
      if (!rows.length) return
      await db.insert(s.simDays).values(dayValues(rows))
    },
    async replaceDays(simRunId: number, rows: DayRow[]): Promise<void> {
      await db.transaction(async (tx: any) => {
        await tx.delete(s.simDays).where(eq(s.simDays.simRunId, simRunId))
        if (rows.length) await tx.insert(s.simDays).values(dayValues(rows))
      })
    },
    // Draft -> saved, once: false when the run is missing or already saved.
    async finalize(id: number): Promise<boolean> {
      const res = await db.update(s.simRuns).set({ draft: false }).where(and(eq(s.simRuns.id, id), eq(s.simRuns.draft, true)))
      return affected(res) > 0
    },
    // Drafts only: a saved run is never deleted here.
    async deleteRun(id: number): Promise<boolean> {
      return db.transaction(async (tx: any) => {
        const res = await tx.delete(s.simRuns).where(and(eq(s.simRuns.id, id), eq(s.simRuns.draft, true)))
        if (affected(res) === 0) return false
        await tx.delete(s.simDays).where(eq(s.simDays.simRunId, id))
        return true
      })
    },
    async sweepDrafts(createdBefore: Date): Promise<number> {
      return db.transaction(async (tx: any) => {
        const stale = await tx.select({ id: s.simRuns.id }).from(s.simRuns)
          .where(and(eq(s.simRuns.draft, true), lt(s.simRuns.createdAt, sql`FROM_UNIXTIME(${Math.floor(createdBefore.getTime() / 1000)})`)))
        const ids: number[] = stale.map((r: any) => r.id)
        for (const id of ids) {
          await tx.delete(s.simDays).where(eq(s.simDays.simRunId, id))
          await tx.delete(s.simRuns).where(and(eq(s.simRuns.id, id), eq(s.simRuns.draft, true)))
        }
        return ids.length
      })
    },
    async listRuns() { return db.select().from(s.simRuns) },
    async getRun(id: number) {
      const rows = await db.select().from(s.simRuns).where(eq(s.simRuns.id, id))
      return rows[0] ?? null
    },
    async listDays(id: number) {
      return db.select().from(s.simDays).where(eq(s.simDays.simRunId, id)).orderBy(s.simDays.tradeDate)
    },
  }
}
