import type { RunState } from '@st/core'
import { eq, and, sql, inArray } from 'drizzle-orm'
import * as s from './schema'
import type { Db, DbOrTx } from './db-type'
import { getSimRepo } from './repos-sim'
import { getBarRepos } from './repos-bars'
import { getVisionRepos } from './repos-vision'
import type { CorrectionRepo } from '../domain/correction-types'
import type { OrderRepo, PendingRepo } from '../domain/repo-types'

function serializeState(state: RunState): string {
  return JSON.stringify(state, (_, v) => typeof v === 'bigint' ? v.toString() : v)
}

export function getRepos(db: Db) {
  async function saveStateWith(q: DbOrTx, runId: number, state: RunState) {
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
    async create(input: { strategyKey: string; ticker: string; name: string; poolCents: number; costPpm: number; buyGapPpm?: number; sellGapPpm?: number; cutLossPpm?: number; initialRunState?: RunState }) {
      const state = input.initialRunState ?? { buckets: [], cashCents: input.poolCents, closed: [], ages: {} }
      return db.transaction(async (tx) => {
        const [res] = await tx.insert(s.strategyRuns).values({
          strategyKey: input.strategyKey, ticker: input.ticker, name: input.name,
          poolCents: input.poolCents, costPpm: input.costPpm, stateJson: serializeState(state),
          buyGapPpm: input.buyGapPpm ?? 0, sellGapPpm: input.sellGapPpm ?? 0,
          cutLossPpm: input.cutLossPpm ?? 0,
        })
        const runId = res.insertId
        if (input.initialRunState) {
          await saveStateWith(tx, runId, input.initialRunState)
        }
        return runId
      })
    },
    async updateStatus(id: number, status: string) {
      await db.update(s.strategyRuns).set({ status: status as any }).where(eq(s.strategyRuns.id, id))
    },
    async updateStatusMany(ids: number[], from: string[], to: string): Promise<number> {
      if (ids.length === 0 || from.length === 0) return 0
      const [res] = await db.update(s.strategyRuns).set({ status: to as any })
        .where(and(inArray(s.strategyRuns.id, ids), inArray(s.strategyRuns.status, from as any)))
      return res.affectedRows
    },
    async updatePool(id: number, poolCents: number) {
      await db.update(s.strategyRuns).set({ poolCents }).where(eq(s.strategyRuns.id, id))
    },
    async updateOrderShaping(id: number, v: { buyGapPpm: number; sellGapPpm: number; cutLossPpm: number }): Promise<void> {
      await db.update(s.strategyRuns).set({ buyGapPpm: v.buyGapPpm, sellGapPpm: v.sellGapPpm, cutLossPpm: v.cutLossPpm }).where(eq(s.strategyRuns.id, id))
    },
  }

  const bucketRepo = {
    async saveState(runId: number, state: RunState) {
      await db.transaction(async (tx) => saveStateWith(tx, runId, state))
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
    async insertMany(orders) {
      if (!orders.length) return
      await db.insert(s.orders).values(orders)
    },
    async get(id) {
      const rows = await db.select().from(s.orders).where(eq(s.orders.id, id))
      return rows[0] ?? null
    },
    async listForDate(date) {
      return db.select().from(s.orders).where(sql`${s.orders.tradeDate} = ${date}`)
    },
    async markStale(date) {
      const [res] = await db.update(s.orders).set({ status: 'stale' }).where(and(eq(s.orders.status, 'open'), sql`${s.orders.tradeDate} < ${date}`))
      return res.affectedRows
    },
    async setStatus(id, status, cancelReason?) {
      await db.update(s.orders)
        .set({ status, ...(cancelReason !== undefined ? { cancelReason } : {}) })
        .where(eq(s.orders.id, id))
    },
    async listOpenBefore(date) {
      return db.select().from(s.orders).where(and(eq(s.orders.status, 'open'), sql`${s.orders.tradeDate} < ${date}`))
    },
    async listForRun(runId, date?) {
      if (date) return db.select().from(s.orders).where(and(eq(s.orders.runId, runId), sql`${s.orders.tradeDate} = ${date}`))
      return db.select().from(s.orders).where(eq(s.orders.runId, runId))
    },
    async listForRunFrom(runId, fromDate) {
      return db.select().from(s.orders).where(and(eq(s.orders.runId, runId), sql`${s.orders.tradeDate} >= ${fromDate}`)).orderBy(s.orders.id)
    },
  } satisfies OrderRepo

  const fillRepo = {
    async insert(fill: any) { await db.insert(s.fills).values(fill) },
    async listForRun(runId: number) { return db.select().from(s.fills).where(eq(s.fills.runId, runId)).orderBy(s.fills.id) },
    // Run-scoped guard: a foreign fillId can never be touched. Field names
    // match the fills schema; price is bigint myriadths.
    async update(runId: number, fillId: number, patch: { shares?: number; price?: bigint; fee?: number; filledOn?: string }): Promise<void> {
      await db.update(s.fills).set(patch).where(and(eq(s.fills.id, fillId), eq(s.fills.runId, runId)))
    },
    // Run-scoped guard: a foreign fillId can never be touched. No-op when absent.
    async deleteById(runId: number, fillId: number): Promise<void> {
      await db.delete(s.fills).where(and(eq(s.fills.id, fillId), eq(s.fills.runId, runId)))
    },
  }

  async function hasPendingWithStatus(captureId: number, status: 'pending' | 'confirmed'): Promise<boolean> {
    const rows = await db.select({ id: s.pendingFills.id }).from(s.pendingFills)
      .where(and(eq(s.pendingFills.captureId, captureId), eq(s.pendingFills.status, status))).limit(1)
    return rows.length > 0
  }

  const pendingRepo = {
    async insert(p) { const [r] = await db.insert(s.pendingFills).values(p); return r.insertId },
    async listPending() { return db.select().from(s.pendingFills).where(eq(s.pendingFills.status, 'pending')) },
    async hasLiveForCapture(captureId) { return hasPendingWithStatus(captureId, 'pending') },
    async hasConfirmedForCapture(captureId) { return hasPendingWithStatus(captureId, 'confirmed') },
    async get(id) { const rows = await db.select().from(s.pendingFills).where(eq(s.pendingFills.id, id)); return rows[0] ?? null },
    async decide(id, status, edited?) {
      const patch = { status, ...edited }
      const [res] = await db.update(s.pendingFills).set(patch).where(and(eq(s.pendingFills.id, id), eq(s.pendingFills.status, 'pending')))
      return res.affectedRows > 0
    },
  } satisfies PendingRepo

  const correctionRepo: CorrectionRepo = {
    async insert(c) { const [r] = await db.insert(s.fillCorrections).values(c); return r.insertId },
    async get(id) {
      const rows = await db.select().from(s.fillCorrections).where(eq(s.fillCorrections.id, id))
      return rows[0] ?? null
    },
    async listOpen() {
      return db.select().from(s.fillCorrections).where(eq(s.fillCorrections.status, 'open')).orderBy(s.fillCorrections.id)
    },
    // Same "only from open" guard as pendingRepo.decide.
    async decide(id, status) {
      const [res] = await db.update(s.fillCorrections).set({ status })
        .where(and(eq(s.fillCorrections.id, id), eq(s.fillCorrections.status, 'open')))
      return res.affectedRows > 0
    },
    // Applied corrections never block; dismissed ones stick ("I checked, the booked price is right").
    // The caller drops snapshot-stale rows.
    async listBlocking(fillId, proposedPrice) {
      return db.select().from(s.fillCorrections)
        .where(and(eq(s.fillCorrections.fillId, fillId), eq(s.fillCorrections.proposedPrice, proposedPrice), inArray(s.fillCorrections.status, ['open', 'dismissed'])))
        .orderBy(s.fillCorrections.id)
    },
    async hasOpenForCapture(captureId) {
      const rows = await db.select({ id: s.fillCorrections.id }).from(s.fillCorrections)
        .where(and(eq(s.fillCorrections.captureId, captureId), eq(s.fillCorrections.status, 'open'))).limit(1)
      return rows.length > 0
    },
  }

  const captureRepo = {
    async findByHash(runId: number, hash: string): Promise<{ id: number; status: string } | null> {
      const rows = await db.select({ id: s.captures.id, status: s.captures.status }).from(s.captures)
        .where(and(eq(s.captures.runId, runId), eq(s.captures.imageHash, hash))).limit(1)
      return rows[0] ?? null
    },
    async setStatus(id: number, status: 'parsed' | 'unparseable'): Promise<void> {
      await db.update(s.captures).set({ status }).where(eq(s.captures.id, id))
    },
    async insert(c: any): Promise<{ inserted: boolean; id?: number }> {
      try {
        const [res] = await db.insert(s.captures).values(c)
        return { inserted: true, id: res.insertId }
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
    async listForRun(runId: number) { return db.select().from(s.notifications).where(eq(s.notifications.runId, runId)) },
  }

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
      await db.insert(s.poolEdits).values({ runId: input.runId, poolCents: input.poolCents })
    },
  }
  const simRepo = getSimRepo(db)
  const { priceHistoryRepo, barCoverageRepo } = getBarRepos(db)
  return { runRepo, orderRepo, fillRepo, priceHistoryRepo, barCoverageRepo, pendingRepo, correctionRepo, captureRepo, ledgerRepo, notificationRepo, bucketRepo, settingsRepo, poolEditRepo, simRepo, ...getVisionRepos(db) }
}
