import type { RunState } from '@st/core'
import { eq, and, lt, sql } from 'drizzle-orm'
import * as s from './schema'

function serializeState(state: RunState): string {
  return JSON.stringify(state, (_, v) => typeof v === 'bigint' ? v.toString() : v)
}

export function getRepos(db: any) {
  async function saveStateWith(q: any, runId: number, state: RunState) {
    await q.update(s.strategyRuns).set({ stateJson: serializeState(state) }).where(eq(s.strategyRuns.id, runId))
    await q.delete(s.buckets).where(eq(s.buckets.runId, runId))
    if (state.buckets.length) {
      await q.insert(s.buckets).values(state.buckets.map((b) => ({
        runId, idx: b.index, state: b.state, shares: b.shares,
        buyPriceMyriadths: b.state === 'empty' ? null : b.buyPrice,
        buyFeeCents: b.buyFeeCents, filledOn: b.state === 'empty' ? null : b.filledOn,
      })))
    }
  }

  const runRepo = {
    async list() { return db.select().from(s.strategyRuns) },
    async get(id: number) {
      const rows = await db.select().from(s.strategyRuns).where(eq(s.strategyRuns.id, id))
      return rows[0] ?? null
    },
    async create(input: { strategyKey: string; ticker: string; name: string; poolCents: number; costPpm: number; initialRunState?: RunState }) {
      const state = input.initialRunState ?? { buckets: [], cashCents: input.poolCents, closed: [], ages: {} }
      return db.transaction(async (tx: any) => {
        const [res] = await tx.insert(s.strategyRuns).values({
          strategyKey: input.strategyKey, ticker: input.ticker, name: input.name,
          poolCents: input.poolCents, costPpm: input.costPpm, stateJson: serializeState(state),
        })
        const runId = (res as any).insertId
        if (input.initialRunState) {
          await saveStateWith(tx, runId, input.initialRunState)
        }
        return runId
      })
    },
    async updateStatus(id: number, status: string) {
      await db.update(s.strategyRuns).set({ status: status as any }).where(eq(s.strategyRuns.id, id))
    },
  }

  const bucketRepo = {
    async saveState(runId: number, state: RunState) {
      await db.transaction(async (tx: any) => saveStateWith(tx, runId, state))
    },
    async loadState(runId: number): Promise<RunState> {
      const rows = await db.select().from(s.strategyRuns).where(eq(s.strategyRuns.id, runId))
      const raw = JSON.parse(rows[0].stateJson)
      // rehydrate bigints and age keys
      const rehydrateBucket = (b: any) => ({ ...b, buyPrice: BigInt(b.buyPrice ?? 0) })
      const ages: Record<number, number> = {}
      for (const k of Object.keys(raw.ages ?? {})) ages[Number(k)] = raw.ages[k]
      return {
        buckets: (raw.buckets ?? []).map(rehydrateBucket),
        cashCents: raw.cashCents,
        closed: (raw.closed ?? []).map((c: any) => ({ ...c, buyPrice: BigInt(c.buyPrice), soldPrice: BigInt(c.soldPrice) })),
        ages,
      }
    },
  }

  const orderRepo = {
    async insertMany(orders: any[]) {
      if (!orders.length) return
      await db.insert(s.orders).values(orders)
    },
    async listForDate(date: string) {
      return db.select().from(s.orders).where(sql`${s.orders.tradeDate} = ${date}`)
    },
    async markStale(date: string) {
      const res: any = await db.update(s.orders).set({ status: 'stale' }).where(and(eq(s.orders.status, 'open'), sql`${s.orders.tradeDate} < ${date}`))
      const header = Array.isArray(res) ? res[0] : res
      return header?.affectedRows ?? 0
    },
    async setStatus(id: number, status: string) {
      await db.update(s.orders).set({ status: status as any }).where(eq(s.orders.id, id))
    },
    async listOpenBefore(date: string) {
      return db.select().from(s.orders).where(and(eq(s.orders.status, 'open'), sql`${s.orders.tradeDate} < ${date}`))
    },
  }

  const fillRepo = {
    async insert(fill: any) { await db.insert(s.fills).values(fill) },
  }

  const pendingRepo = {
    async insert(p: any) { const [r] = await db.insert(s.pendingFills).values(p); return (r as any).insertId },
    async listPending() { return db.select().from(s.pendingFills).where(eq(s.pendingFills.status, 'pending')) },
    async decide(id: number, status: string, edited?: any) {
      const patch: any = { status }
      if (edited) Object.assign(patch, edited)
      await db.update(s.pendingFills).set(patch).where(eq(s.pendingFills.id, id))
    },
  }

  const captureRepo = {
    async hasHash(runId: number, hash: string): Promise<boolean> {
      const rows = await db.select().from(s.captures).where(and(eq(s.captures.runId, runId), eq(s.captures.imageHash, hash)))
      return rows.length > 0
    },
    async insert(c: any): Promise<{ inserted: boolean; id?: number }> {
      try {
        const [res] = await db.insert(s.captures).values(c)
        return { inserted: true, id: (res as any).insertId }
      } catch (e: any) {
        const msg = String(e) + ' ' + (e?.message ?? '') + ' ' + (e?.cause?.message ?? '')
        if (msg.includes('ER_DUP_ENTRY') || msg.toLowerCase().includes('duplicate')) return { inserted: false }
        throw e
      }
    },
  }

  const ledgerRepo = {
    async insert(l: any) { await db.insert(s.ledger).values(l) },
    async listForRun(runId: number) { return db.select().from(s.ledger).where(eq(s.ledger.runId, runId)) },
  }

  const notificationRepo = {
    async insert(n: any) { await db.insert(s.notifications).values(n) },
  }

  return { runRepo, orderRepo, fillRepo, pendingRepo, captureRepo, ledgerRepo, notificationRepo, bucketRepo }
}
