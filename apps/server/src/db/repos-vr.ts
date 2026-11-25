import { eq, and, inArray, desc, exists } from 'drizzle-orm'
import { VALUE_REBALANCING } from '@st/strategies/value-rebalancing'
import * as s from './schema'
import type { Db } from './db-type'
import {
  VrNameTakenError,
  type SharedRunRepo, type VrCashRepo, type VrCycleRepo, type VrFillRepo, type VrRunRepo, type VrRunRow,
} from '../domain/vr/repo-types'

const sharedColumns = {
  id: s.strategyRuns.id, strategyKey: s.strategyRuns.strategyKey, ticker: s.strategyRuns.ticker, name: s.strategyRuns.name,
  costPpm: s.strategyRuns.costPpm, status: s.strategyRuns.status, createdAt: s.strategyRuns.createdAt,
}
// Key order is the VrRunRow key order.
const vrRunColumns = {
  ...sharedColumns, g: s.vrRuns.g, formula: s.vrRuns.formula, bandPpm: s.vrRuns.bandPpm,
  spendLimitPpm: s.vrRuns.spendLimitPpm, cycleDepositCents: s.vrRuns.cycleDepositCents, initialVCents: s.vrRuns.initialVCents,
}

// drizzle wraps the driver error: the code and key name are on `.cause`.
function isDuplicateKey(e: unknown, key: string): boolean {
  const c = ((e as { cause?: unknown } | null)?.cause ?? e) as { code?: string; errno?: number; sqlMessage?: string; message?: string } | null
  return (c?.code === 'ER_DUP_ENTRY' || c?.errno === 1062) && String(c?.sqlMessage ?? c?.message ?? '').includes(key)
}

export function getVrRepos(db: Db) {
  // A fresh builder per call; each chain calls .where/.orderBy at most once.
  const runs = () => db.select(vrRunColumns).from(s.strategyRuns).innerJoin(s.vrRuns, eq(s.vrRuns.runId, s.strategyRuns.id))

  const sharedRunRepo = {
    async getMany(ids: number[]) {
      if (ids.length === 0) return []
      return db.select(sharedColumns).from(s.strategyRuns).where(inArray(s.strategyRuns.id, ids)).orderBy(s.strategyRuns.id)
    },
  } satisfies SharedRunRepo

  const vrRunRepo = {
    async list(): Promise<VrRunRow[]> { return runs().orderBy(s.strategyRuns.id) },
    async get(id: number): Promise<VrRunRow | null> {
      const rows = await runs().where(eq(s.strategyRuns.id, id))
      return rows[0] ?? null
    },
    async create(input) {
      try {
        return await db.transaction(async (tx) => {
          const [res] = await tx.insert(s.strategyRuns).values({ strategyKey: VALUE_REBALANCING, ticker: input.ticker, name: input.name, costPpm: input.costPpm })
          const runId = res.insertId
          await tx.insert(s.vrRuns).values({
            runId, g: input.g, formula: input.formula, bandPpm: input.bandPpm, spendLimitPpm: input.spendLimitPpm,
            cycleDepositCents: input.cycleDepositCents, initialVCents: input.initialVCents,
          })
          await tx.insert(s.vrCashMoves).values({ runId, kind: 'open', amountCents: input.openingCashCents, movedOn: input.openedOn, note: null, cycleId: null })
          return runId
        })
      } catch (e) {
        if (isDuplicateKey(e, 'strategy_runs_name_unique')) throw new VrNameTakenError(input.name)
        throw e
      }
    },
    async updateStatus(id, status) {
      const hasVrRow = exists(db.select({ runId: s.vrRuns.runId }).from(s.vrRuns).where(eq(s.vrRuns.runId, s.strategyRuns.id)))
      await db.update(s.strategyRuns).set({ status }).where(and(eq(s.strategyRuns.id, id), hasVrRow))
    },
    async updateSettings(id, v) {
      await db.update(s.vrRuns)
        .set({ g: v.g, formula: v.formula, bandPpm: v.bandPpm, spendLimitPpm: v.spendLimitPpm, cycleDepositCents: v.cycleDepositCents })
        .where(eq(s.vrRuns.runId, id))
    },
  } satisfies VrRunRepo

  const vrCycleRepo = {
    async listForRun(runId) { return db.select().from(s.vrCycles).where(eq(s.vrCycles.runId, runId)).orderBy(s.vrCycles.seq) },
    async latest(runId) {
      const rows = await db.select().from(s.vrCycles).where(eq(s.vrCycles.runId, runId)).orderBy(desc(s.vrCycles.seq)).limit(1)
      return rows[0] ?? null
    },
    async open(cycle, deposit) {
      return db.transaction(async (tx) => {
        const [res] = await tx.insert(s.vrCycles).values(cycle)
        const cycleId = res.insertId
        if (deposit) await tx.insert(s.vrCashMoves).values({ ...deposit, cycleId })
        return cycleId
      })
    },
  } satisfies VrCycleRepo

  const vrFillRepo = {
    async listForRun(runId) { return db.select().from(s.vrFills).where(eq(s.vrFills.runId, runId)).orderBy(s.vrFills.filledOn, s.vrFills.id) },
    async get(runId, id) {
      const rows = await db.select().from(s.vrFills).where(and(eq(s.vrFills.id, id), eq(s.vrFills.runId, runId)))
      return rows[0] ?? null
    },
    async insert(f) {
      const [res] = await db.insert(s.vrFills).values(f)
      return res.insertId
    },
    async update(runId, id, p) {
      await db.update(s.vrFills)
        .set({ side: p.side, shares: p.shares, price: p.price, fee: p.fee, filledOn: p.filledOn })
        .where(and(eq(s.vrFills.id, id), eq(s.vrFills.runId, runId)))
    },
    async deleteById(runId, id) {
      await db.delete(s.vrFills).where(and(eq(s.vrFills.id, id), eq(s.vrFills.runId, runId)))
    },
  } satisfies VrFillRepo

  const vrCashRepo = {
    async listForRun(runId) { return db.select().from(s.vrCashMoves).where(eq(s.vrCashMoves.runId, runId)).orderBy(s.vrCashMoves.movedOn, s.vrCashMoves.id) },
    async get(runId, id) {
      const rows = await db.select().from(s.vrCashMoves).where(and(eq(s.vrCashMoves.id, id), eq(s.vrCashMoves.runId, runId)))
      return rows[0] ?? null
    },
    async insert(m) {
      const [res] = await db.insert(s.vrCashMoves).values(m)
      return res.insertId
    },
    async update(runId, id, p) {
      await db.update(s.vrCashMoves)
        .set({ amountCents: p.amountCents, movedOn: p.movedOn, note: p.note })
        .where(and(eq(s.vrCashMoves.id, id), eq(s.vrCashMoves.runId, runId)))
    },
    async deleteById(runId, id) {
      await db.delete(s.vrCashMoves).where(and(eq(s.vrCashMoves.id, id), eq(s.vrCashMoves.runId, runId)))
    },
  } satisfies VrCashRepo

  return { sharedRunRepo, vrRunRepo, vrCycleRepo, vrFillRepo, vrCashRepo }
}
