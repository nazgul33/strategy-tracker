import type { RunState } from '@st/core'
import type { BookingNotifier, OrderRow, SellAttribution } from '../src/domain/booking'
import { fakeCorrectionRepo } from './fake-corrections'

export const silentNotifier: BookingNotifier = { siblingCancelled: async () => {}, sellAttributed: async () => {} }

export function recordingNotifier() {
  const siblings: Array<{ runId: number; order: OrderRow }> = []
  const attributions: Array<{ runId: number; attribution: SellAttribution }> = []
  const notify: BookingNotifier = {
    siblingCancelled: async (runId, order) => { siblings.push({ runId, order: { ...order } }) },
    sellAttributed: async (runId, attribution) => { attributions.push({ runId, attribution }) },
  }
  return { notify, siblings, attributions }
}

export function serializeState(state: RunState): string {
  return JSON.stringify(state, (_, v) => typeof v === 'bigint' ? v.toString() : v)
}
export function rehydrate(raw: any): RunState {
  const ages: Record<number, number> = {}
  for (const k of Object.keys(raw.ages ?? {})) ages[Number(k)] = raw.ages[k]
  return {
    buckets: (raw.buckets ?? []).map((b: any) => ({ ...b, buyPrice: BigInt(b.buyPrice ?? 0) })),
    cashCents: raw.cashCents,
    closed: (raw.closed ?? []).map((c: any) => ({ ...c, buyPrice: BigInt(c.buyPrice), soldPrice: BigInt(c.soldPrice) })),
    ages,
  }
}

export function fakeRepos() {
  const runs = new Map<number, any>()
  const buckets: any[] = []
  const orders: any[] = []
  const fills: any[] = []
  const pending: any[] = []
  const captures: any[] = []
  const ledger: any[] = []
  const captureImages: any[] = []
  const visionReviews: any[] = []
  const corrections = fakeCorrectionRepo()
  let runSeq = 1, orderSeq = 1, fillSeq = 1, pendingSeq = 1, captureSeq = 1, ledgerSeq = 1, visionSeq = 1

  const runRepo = {
    async list() { return [...runs.values()] },
    async get(id: number) { return runs.get(id) ?? null },
    async create(input: any) {
      const id = runSeq++
      const state = input.initialRunState ?? { buckets: [], cashCents: input.poolCents, closed: [], ages: {} }
      const run = { id, strategyKey: input.strategyKey, ticker: input.ticker, name: input.name, poolCents: input.poolCents, costPpm: input.costPpm, status: 'active', stateJson: serializeState(state) }
      runs.set(id, run)
      if (input.initialRunState) await bucketRepo.saveState(id, input.initialRunState)
      return id
    },
    async updateStatus(id: number, status: string) { const r = runs.get(id); if (r) r.status = status },
  }
  const bucketRepo = {
    async saveState(runId: number, state: RunState) {
      const run = runs.get(runId); if (run) run.stateJson = serializeState(state)
    },
    async loadState(runId: number): Promise<RunState> {
      const run = runs.get(runId)
      return rehydrate(JSON.parse(run.stateJson))
    },
  }
  const orderRepo = {
    async insertMany(os: any[]) { for (const o of os) { orders.push({ id: orderSeq++, ...o }) } },
    async listForDate(date: string) { return orders.filter((o) => o.tradeDate === date) },
    async listForRun(runId: number, date?: string) {
      return orders.filter((o) => o.runId === runId && (date === undefined || o.tradeDate === date))
    },
    async listForRunFrom(runId: number, fromDate: string) {
      return orders.filter((o) => o.runId === runId && o.tradeDate >= fromDate).sort((a, b) => a.id - b.id)
    },
    async get(id: number) { return orders.find((x) => x.id === id) ?? null },
    async markStale(date: string) {
      let cnt = 0
      for (const o of orders) { if (o.status === 'open' && o.tradeDate < date) { o.status = 'stale'; cnt++ } }
      return cnt
    },
    async setStatus(id: number, status: string, cancelReason?: string) {
      const o = orders.find((x) => x.id === id)
      if (o) { o.status = status; if (cancelReason !== undefined) o.cancelReason = cancelReason }
    },
    async listOpenBefore(date: string) { return orders.filter((o) => o.status === 'open' && o.tradeDate < date) },
  }
  const fillRepo = {
    async insert(fill: any) { fills.push({ id: fillSeq++, ...fill }) },
    async listForRun(runId: number) {
      return fills.filter((f) => f.runId === runId).map((f) => ({ ...f })).sort((a, b) => a.id - b.id)
    },
    async update(runId: number, fillId: number, patch: any) {
      const f = fills.find((x) => x.runId === runId && x.id === fillId)
      if (f) Object.assign(f, patch)
    },
    async deleteById(runId: number, fillId: number) {
      const gi = fills.findIndex((f) => f.runId === runId && f.id === fillId)
      if (gi >= 0) fills.splice(gi, 1)
    },
  }
  const pendingRepo = {
    async insert(p: any) { const id = pendingSeq++; pending.push({ id, ...p }); return id },
    async listPending() { return pending.filter((p) => p.status === 'pending') },
    async hasLiveForCapture(captureId: number) { return pending.some((p) => p.captureId === captureId && p.status === 'pending') },
    async hasConfirmedForCapture(captureId: number) { return pending.some((p) => p.captureId === captureId && p.status === 'confirmed') },
    async decide(id: number, status: string, edited?: any): Promise<boolean> {
      const p = pending.find((x) => x.id === id)
      if (!p) throw new Error('not found')
      if (p.status !== 'pending') throw new Error('not pending')
      p.status = status
      if (edited) Object.assign(p, edited)
      return true
    },
  }
  const captureRepo = {
    async findByHash(runId: number, hash: string) {
      const c = captures.find((x) => x.runId === runId && x.imageHash === hash)
      return c ? { id: c.id as number, status: c.status as string } : null
    },
    async setStatus(id: number, status: string) { const c = captures.find((x) => x.id === id); if (c) c.status = status },
    async insert(c: any) {
      const dup = captures.some((x) => x.runId === c.runId && x.imageHash === c.imageHash)
      if (dup) return { inserted: false }
      const id = captureSeq++
      captures.push({ id, ...c })
      return { inserted: true, id }
    },
  }
  const ledgerRepo = {
    async insert(l: any) { ledger.push({ id: ledgerSeq++, ...l }) },
    async listForRun(runId: number) { return ledger.filter((l) => l.runId === runId) },
  }
  const captureImageRepo = {
    async insertIgnore(row: any): Promise<boolean> {
      if (captureImages.some((x) => x.captureId === row.captureId)) return false
      captureImages.push({ ...row, keep: false })
      return true
    },
    async getBytes(captureId: number) {
      const r = captureImages.find((x) => x.captureId === captureId)
      return r ? { mime: r.mime as string, bytes: r.bytes as Buffer } : null
    },
    async isKept(captureId: number) { return captureImages.some((x) => x.captureId === captureId && x.keep) },
    async setKeep(captureId: number) { const r = captureImages.find((x) => x.captureId === captureId); if (r) r.keep = true },
    async deleteFor(captureId: number) {
      const i = captureImages.findIndex((x) => x.captureId === captureId)
      if (i >= 0) captureImages.splice(i, 1)
    },
    async listKept(limit: number) {
      return captureImages.filter((x) => x.keep).slice(0, limit).map((x) => ({ captureId: x.captureId, mime: x.mime, byteLen: x.byteLen, createdAt: '' }))
    },
  }
  const visionReviewRepo = {
    async insertIgnore(row: any): Promise<void> {
      if (visionReviews.some((x) => x.pendingFillId === row.pendingFillId)) return
      visionReviews.push({ id: visionSeq++, createdAt: '', ...row })
    },
    async listForCaptures(captureIds: number[]) { return visionReviews.filter((x) => captureIds.includes(x.captureId)) },
    async deleteFor(captureId: number) {
      for (let i = visionReviews.length - 1; i >= 0; i--) if (visionReviews[i]!.captureId === captureId) visionReviews.splice(i, 1)
    },
  }
  return {
    repos: { runRepo, bucketRepo, orderRepo, fillRepo, pendingRepo, correctionRepo: corrections.repo, captureRepo, ledgerRepo, captureImageRepo, visionReviewRepo },
    _stores: { runs, orders, fills, pending, captures, ledger, corrections: corrections.store, captureImages, visionReviews },
  }
}
