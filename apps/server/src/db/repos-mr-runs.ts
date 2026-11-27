import type { Bucket, ClosedBucket, RunState } from '@st/core'
import { eq, and, inArray, exists } from 'drizzle-orm'
import * as s from './schema'
import type { Db, DbOrTx } from './db-type'
import type { NewOrder, NewRun, RunRepo, RunRow, RunStatus } from '../domain/repo-types'

// bigints are stored as strings in mr_runs.state_json
type StoredBucket = Omit<Bucket, 'buyPrice'> & { buyPrice?: string | null }
type StoredClosed = Omit<ClosedBucket, 'buyPrice' | 'soldPrice'> & { buyPrice: string; soldPrice: string }

function serializeState(state: RunState): string {
  return JSON.stringify(state, (_, v) => typeof v === 'bigint' ? v.toString() : v)
}

// Key order is the RunRow key order.
const runColumns = {
  id: s.strategyRuns.id, strategyKey: s.strategyRuns.strategyKey, ticker: s.strategyRuns.ticker, name: s.strategyRuns.name,
  poolCents: s.mrRuns.poolCents, costPpm: s.strategyRuns.costPpm,
  buyGapPpm: s.mrRuns.buyGapPpm, sellGapPpm: s.mrRuns.sellGapPpm, cutLossPpm: s.mrRuns.cutLossPpm,
  status: s.strategyRuns.status, stateJson: s.mrRuns.stateJson, createdAt: s.strategyRuns.createdAt,
}

export function getMrRunRepos(db: Db) {
  // A fresh builder per call; each chain calls .where/.orderBy at most once.
  const runs = () => db.select(runColumns).from(s.strategyRuns).innerJoin(s.mrRuns, eq(s.mrRuns.runId, s.strategyRuns.id))

  const hasMrRow = () => exists(db.select({ runId: s.mrRuns.runId }).from(s.mrRuns).where(eq(s.mrRuns.runId, s.strategyRuns.id)))

  async function saveStateWith(q: DbOrTx, runId: number, state: RunState) {
    await q.update(s.mrRuns).set({ stateJson: serializeState(state) }).where(eq(s.mrRuns.runId, runId))
    await q.delete(s.mrBuckets).where(eq(s.mrBuckets.runId, runId))
    if (state.buckets.length) {
      await q.insert(s.mrBuckets).values(state.buckets.map((b) => ({
        runId, idx: b.index, state: b.state, shares: b.shares,
        buyPriceMyriadths: b.state === 'empty' ? null : b.buyPrice,
        buyFeeCents: b.buyFeeCents, filledOn: b.state === 'empty' ? null : b.filledOn,
      })))
    }
  }

  const runRepo = {
    async list(): Promise<RunRow[]> { return runs().orderBy(s.strategyRuns.id) },
    async get(id: number): Promise<RunRow | null> {
      const rows = await runs().where(eq(s.strategyRuns.id, id))
      return rows[0] ?? null
    },
    async getMany(ids: number[]): Promise<RunRow[]> {
      if (ids.length === 0) return []
      return runs().where(inArray(s.strategyRuns.id, ids))
    },
    async create(input: NewRun): Promise<number> {
      const state = input.initialRunState ?? { buckets: [], cashCents: input.poolCents, closed: [], ages: {} }
      return db.transaction(async (tx) => {
        const [res] = await tx.insert(s.strategyRuns).values({
          strategyKey: input.strategyKey, ticker: input.ticker, name: input.name, costPpm: input.costPpm,
        })
        const runId = res.insertId
        await tx.insert(s.mrRuns).values({
          runId, poolCents: input.poolCents,
          buyGapPpm: input.buyGapPpm ?? 0, sellGapPpm: input.sellGapPpm ?? 0,
          cutLossPpm: input.cutLossPpm ?? 0, stateJson: serializeState(state),
        })
        if (input.initialRunState) {
          await saveStateWith(tx, runId, input.initialRunState)
        }
        return runId
      })
    },
    async updateStatus(id: number, status: RunStatus): Promise<void> {
      await db.update(s.strategyRuns).set({ status }).where(and(eq(s.strategyRuns.id, id), hasMrRow()))
    },
    async updateStatusMany(ids: number[], from: RunStatus[], to: RunStatus): Promise<number> {
      if (ids.length === 0 || from.length === 0) return 0
      const [res] = await db.update(s.strategyRuns).set({ status: to })
        .where(and(inArray(s.strategyRuns.id, ids), inArray(s.strategyRuns.status, from), hasMrRow()))
      return res.affectedRows
    },
    async updatePool(id: number, poolCents: number): Promise<void> {
      await db.update(s.mrRuns).set({ poolCents }).where(eq(s.mrRuns.runId, id))
    },
    async updateOrderShaping(id: number, v: { buyGapPpm: number; sellGapPpm: number; cutLossPpm: number }): Promise<void> {
      await db.update(s.mrRuns).set({ buyGapPpm: v.buyGapPpm, sellGapPpm: v.sellGapPpm, cutLossPpm: v.cutLossPpm }).where(eq(s.mrRuns.runId, id))
    },
  } satisfies RunRepo

  const bucketRepo = {
    async saveState(runId: number, state: RunState) {
      await db.transaction(async (tx) => saveStateWith(tx, runId, state))
    },
    async saveStateWithOrders(runId: number, state: RunState, orders: NewOrder[]) {
      await db.transaction(async (tx) => {
        if (orders.length) await tx.insert(s.mrOrders).values(orders)
        await saveStateWith(tx, runId, state)
      })
    },
    async saveStateWithPool(runId: number, state: RunState, poolCents: number) {
      await db.transaction(async (tx) => {
        await tx.update(s.mrRuns).set({ poolCents }).where(eq(s.mrRuns.runId, runId))
        await saveStateWith(tx, runId, state)
      })
    },
    async loadState(runId: number): Promise<RunState> {
      const rows = await db.select({ stateJson: s.mrRuns.stateJson }).from(s.mrRuns).where(eq(s.mrRuns.runId, runId))
      const raw: { buckets?: StoredBucket[]; cashCents: number; closed?: StoredClosed[]; ages?: Record<string, number> } = JSON.parse(rows[0].stateJson)
      // rehydrate bigints and age keys
      const rehydrateBucket = (b: StoredBucket) => ({ ...b, buyPrice: BigInt(b.buyPrice ?? 0) })
      const ages: Record<number, number> = {}
      for (const k of Object.keys(raw.ages ?? {})) ages[Number(k)] = raw.ages![k]
      return {
        buckets: (raw.buckets ?? []).map(rehydrateBucket),
        cashCents: raw.cashCents,
        closed: (raw.closed ?? []).map((c) => ({ ...c, buyPrice: BigInt(c.buyPrice), soldPrice: BigInt(c.soldPrice) })),
        ages,
      }
    },
  }

  return { runRepo, bucketRepo }
}
