import { expect } from 'bun:test'
import type { RunState } from '@st/core'
import type { HttpDeps, HttpRepoSurface, createApp } from '../src/http/app'
import { fakeCorrectionRepo } from './fake-corrections'
import { normTicker } from '../src/db/repos-bars'

export function makeFakes() {
  let runIdSeq = 1
  const runs: any[] = []
  const poolEdits: any[] = []
  const fills: any[] = []
  const ledger: any[] = []
  const orders: any[] = []
  const pending: any[] = []
  const correctionFake = fakeCorrectionRepo()
  const notifications: any[] = []
  const settings: Record<string, string> = {}
  const states = new Map<number, RunState>()
  const bucketRepo = {
    async loadState(runId: number) { return states.get(runId)! },
    async saveState(runId: number, state: RunState) { states.set(runId, state) },
  }
  const runRepo = {
    async list() { return [...runs] },
    async get(id: number) { return runs.find((r) => r.id === id) ?? null },
    async create(input: any) {
      const id = runIdSeq++
      const state = input.initialRunState
      if (state) states.set(id, state)
      runs.push({ id, strategyKey: input.strategyKey, ticker: input.ticker, name: input.name, poolCents: input.poolCents, costPpm: input.costPpm, buyGapPpm: input.buyGapPpm ?? 0, sellGapPpm: input.sellGapPpm ?? 0, cutLossPpm: input.cutLossPpm ?? 0, status: 'active', stateJson: JSON.stringify(state, (_k, v) => typeof v === 'bigint' ? v.toString() : v), createdAt: new Date() })
      return id
    },
    async updateStatus(id: number, status: string) {
      const r = runs.find((x) => x.id === id); if (r) r.status = status
    },
    async updateStatusMany(ids: number[], from: string[], to: string) {
      let n = 0
      for (const r of runs) if (ids.includes(r.id) && from.includes(r.status)) { r.status = to; n += 1 }
      return n
    },
    async updatePool(id: number, poolCents: number) {
      const r = runs.find((x) => x.id === id); if (r) r.poolCents = poolCents
    },
    async updateOrderShaping(id: number, v: { buyGapPpm: number; sellGapPpm: number; cutLossPpm: number }) {
      const r = runs.find((x) => x.id === id); if (r) { r.buyGapPpm = v.buyGapPpm; r.sellGapPpm = v.sellGapPpm; r.cutLossPpm = v.cutLossPpm }
    },
  }
  const orderRepo = {
    async insertMany(os: any[]) { for (const o of os) orders.push({ id: orders.length + 1, ...o }) },
    async listForDate(date: string) { return orders.filter((o) => o.tradeDate === date) },
    async markStale() { return 0 },
    async get(id: number) { return orders.find((x) => x.id === id) ?? null },
    async setStatus(id: number, status: string, cancelReason?: string) {
      const o = orders.find((x) => x.id === id)
      if (o) { o.status = status; if (cancelReason !== undefined) o.cancelReason = cancelReason }
    },
    async listOpenBefore() { return [] },
    async listForRun(runId: number, date?: string) {
      let out = orders.filter((o) => o.runId === runId)
      if (date) out = out.filter((o) => o.tradeDate === date)
      return out
    },
    async listForRunFrom(runId: number, fromDate: string) {
      return orders.filter((o) => o.runId === runId && o.tradeDate >= fromDate).sort((a, b) => a.id - b.id)
    },
  }
  const fillRepo = {
    async insert(f: any) { fills.push({ id: fills.length + 1, ...f }) },
    async listForRun(runId: number) { return fills.filter((f) => f.runId === runId) },
    async update(runId: number, fillId: number, patch: any) {
      const gi = fills.findIndex((x) => x.runId === runId && x.id === fillId)
      if (gi < 0) throw new Error('no fill')
      fills[gi] = { ...fills[gi], ...patch }
    },
    async deleteById(runId: number, fillId: number) {
      const gi = fills.findIndex((x) => x.runId === runId && x.id === fillId)
      if (gi >= 0) fills.splice(gi, 1)
    },
  }
  const pendingRepo = {
    async insert(p: any) { const id = pending.length + 1; pending.push({ id, ...p }); return id },
    async listPending() { return pending.filter((p) => p.status === 'pending') },
    async hasLiveForCapture(captureId: number) { return pending.some((p) => p.captureId === captureId && p.status === 'pending') },
    async hasConfirmedForCapture(captureId: number) { return pending.some((p) => p.captureId === captureId && p.status === 'confirmed') },
    async decide(id: number, status: string, edited?: any): Promise<boolean> {
      const p = pending.find((x) => x.id === id); if (!p || p.status !== 'pending') return false
      p.status = status
      if (edited) Object.assign(p, edited)
      return true
    },
    async get(id: number) { return pending.find((x) => x.id === id) ?? null },
  }
  const captureRepo = { async findByHash() { return null }, async setStatus() {}, async insert(c: any) { return { inserted: true, id: 1 } } }
  const captureImages: any[] = []
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
    async discard(captureId: number) {
      const i = captureImages.findIndex((x) => x.captureId === captureId)
      if (i >= 0) captureImages.splice(i, 1)
      for (let j = visionReviews.length - 1; j >= 0; j--) if (visionReviews[j]!.captureId === captureId) visionReviews.splice(j, 1)
    },
    async listKept(limit: number) {
      // newest first, ties by capture id, like the real repo
      const newestFirst = (a: any, b: any) => ((b.createdAt ?? '') < (a.createdAt ?? '') ? -1 : (b.createdAt ?? '') > (a.createdAt ?? '') ? 1 : b.captureId - a.captureId)
      return captureImages.filter((x) => x.keep).sort(newestFirst).slice(0, limit).map((x) => ({ captureId: x.captureId, mime: x.mime, byteLen: x.byteLen, createdAt: x.createdAt ?? '' }))
    },
    async existingIds(captureIds: number[]) { return new Set<number>(captureImages.filter((x) => captureIds.includes(x.captureId)).map((x) => x.captureId)) },
  }
  const visionReviews: any[] = []
  const visionReviewRepo = {
    async insertIgnore(row: any): Promise<void> {
      if (visionReviews.some((x) => x.pendingFillId === row.pendingFillId)) return
      visionReviews.push({ id: visionReviews.length + 1, createdAt: '', ...row })
    },
    async listForCaptures(captureIds: number[]) { return visionReviews.filter((x) => captureIds.includes(x.captureId)) },
    async deleteFor(captureId: number) {
      for (let i = visionReviews.length - 1; i >= 0; i--) if (visionReviews[i]!.captureId === captureId) visionReviews.splice(i, 1)
    },
  }
  const ledgerRepo = {
    async insert(l: any) { ledger.push({ id: ledger.length + 1, ...l }) },
    async listForRun(runId: number) { return ledger.filter((l) => l.runId === runId) },
  }
  const notificationRepo = {
    async insert(n: any) { notifications.push({ id: notifications.length + 1, ...n }) },
    async listForRun(runId: number) { return notifications.filter((n) => n.runId === runId) },
  }
  const sent: { chatId: string; text: string }[] = []
  const settingsRepo = {
    async getAll() { return { ...settings } },
    async set(key: string, value: string) { settings[key] = value },
  }
  const poolEditRepo = {
    async insert(input: { runId: number; poolCents: number }) { poolEdits.push({ id: poolEdits.length + 1, ...input }) },
  }
  // monotonic like AUTO_INCREMENT: ids are never reused after a delete
  let simRunIdSeq = 1
  let simDayIdSeq = 1
  const simRuns: any[] = []
  const simDays: any[] = []
  const simRepo = {
    async insertRun(i: any) {
      const id = simRunIdSeq++
      simRuns.push({ id, createdAt: '2026-11-10T00:00:00Z', ...i, draft: true })
      return id
    },
    async insertDays(rows: any[]) { for (const r of rows) simDays.push({ id: simDayIdSeq++, ...r }) },
    // guarded like the real one: nothing is touched unless the run is still a draft
    async rewriteDraft(id: number, v: any, rows: any[]): Promise<boolean> {
      const r = simRuns.find((x) => x.id === id)
      if (!r || !r.draft) return false
      Object.assign(r, v)
      for (let i = simDays.length - 1; i >= 0; i--) if (simDays[i].simRunId === id) simDays.splice(i, 1)
      for (const d of rows) simDays.push({ id: simDayIdSeq++, ...d })
      return true
    },
    async finalize(id: number) {
      const r = simRuns.find((x) => x.id === id)
      if (!r || !r.draft) return false
      r.draft = false
      return true
    },
    async deleteRun(id: number) {
      const i = simRuns.findIndex((x) => x.id === id)
      if (i < 0 || !simRuns[i].draft) return false
      simRuns.splice(i, 1)
      for (let j = simDays.length - 1; j >= 0; j--) if (simDays[j].simRunId === id) simDays.splice(j, 1)
      return true
    },
    async sweepDrafts(createdBefore: Date) {
      let n = 0
      for (let i = simRuns.length - 1; i >= 0; i--) {
        const r = simRuns[i]
        if (!r.draft || new Date(r.createdAt).getTime() >= createdBefore.getTime()) continue
        simRuns.splice(i, 1)
        for (let j = simDays.length - 1; j >= 0; j--) if (simDays[j].simRunId === r.id) simDays.splice(j, 1)
        n += 1
      }
      return n
    },
    async listRuns() { return [...simRuns].sort((a, b) => b.id - a.id) },
    async getRun(id: number) { return simRuns.find((x) => x.id === id) ?? null },
    async listDays(id: number) { return simDays.filter((d) => d.simRunId === id).sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1)) },
  }
  type FakeBar = { ticker: string; tradeDate: string; open?: bigint; high?: bigint; low?: bigint; close: bigint }
  const priceHistory: FakeBar[] = []
  const priceHistoryRepo = {
    async upsertMany(rows: { ticker: string; tradeDate: string; close: bigint }[]) {
      for (const r of rows) {
        const ticker = normTicker(r.ticker)
        const hit = priceHistory.find((x) => x.ticker === ticker && x.tradeDate === r.tradeDate)
        if (hit) hit.close = r.close
        else priceHistory.push({ ...r, ticker })
      }
      return rows.length
    },
    async upsertBars(rows: Required<FakeBar>[]) {
      for (const r of rows) {
        const row = { ...r, ticker: normTicker(r.ticker) }
        const hit = priceHistory.find((x) => x.ticker === row.ticker && x.tradeDate === row.tradeDate)
        if (hit) Object.assign(hit, row)
        else priceHistory.push(row)
      }
      return rows.length
    },
    async listForTicker(ticker: string, from?: string) {
      const t = normTicker(ticker)
      return priceHistory
        .filter((r) => r.ticker === t && (!from || r.tradeDate >= from))
        .sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1))
    },
    async listBars(ticker: string, from: string, to: string) {
      const t = normTicker(ticker)
      return priceHistory
        .filter((r) => r.ticker === t && r.tradeDate >= from && r.tradeDate <= to && r.open !== undefined && r.high !== undefined && r.low !== undefined)
        .sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1))
        .map((r) => ({ tradeDate: r.tradeDate, open: r.open!, high: r.high!, low: r.low!, close: r.close }))
    },
  }
  const coverage: { ticker: string; fromDate: string; toDate: string }[] = []
  const dayNum = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000)
  const barCoverageRepo = {
    async list(ticker: string) {
      const t = normTicker(ticker)
      return coverage.filter((c) => c.ticker === t).sort((a, b) => (a.fromDate < b.fromDate ? -1 : 1)).map((c) => ({ fromDate: c.fromDate, toDate: c.toDate }))
    },
    async add(rawTicker: string, fromDate: string, toDate: string) {
      if (fromDate > toDate) throw new Error(`bar coverage: inverted range ${fromDate}..${toDate} (from is after to)`)
      const ticker = normTicker(rawTicker)
      let from = fromDate
      let to = toDate
      for (let i = coverage.length - 1; i >= 0; i--) {
        const c = coverage[i]
        if (c.ticker !== ticker || dayNum(c.fromDate) > dayNum(toDate) + 1 || dayNum(c.toDate) < dayNum(fromDate) - 1) continue
        if (c.fromDate < from) from = c.fromDate
        if (c.toDate > to) to = c.toDate
        coverage.splice(i, 1)
      }
      coverage.push({ ticker, fromDate: from, toDate: to })
    },
  }
  const repos: HttpRepoSurface = {
    runRepo, bucketRepo, orderRepo, fillRepo, pendingRepo, correctionRepo: correctionFake.repo, captureRepo, captureImageRepo, visionReviewRepo, ledgerRepo, notificationRepo,
    settingsRepo, poolEditRepo, simRepo, priceHistoryRepo, barCoverageRepo,
  } as any
  return { repos, corrections: correctionFake.store, runs, poolEdits, fills, ledger, orders, pending, captureImages, visionReviews, notifications, sent, settings, states, simRuns, simDays, priceHistory, coverage }
}

export const PASSWORD = 'secret'
export const SECRET = 'session-secret'

export function makeDeps(fakes: ReturnType<typeof makeFakes>): HttpDeps {
  return {
    repos: fakes.repos,
    password: PASSWORD,
    sessionSecret: SECRET,
    today: () => '2026-11-10',
    defaultSettings: { visionBaseUrl: 'http://x', visionModel: 'm', digestLang: 'en', defaultCostPpm: 700 },
    triggerMorning: async () => 'morning-ok',
    fetchDailyBars: async () => [],
    allowedChatIds: ['42'],
    send: async (chatId: string, text: string) => { fakes.sent.push({ chatId, text }) },
  }
}

type App = ReturnType<typeof createApp>

export const json = { 'content-type': 'application/json' }

export async function loginAs(app: App) {
  const res = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: json })
  return { Authorization: `Bearer ${(await res.json()).token}` }
}

export async function createRun(app: App, auth: Record<string, string>, body: Record<string, unknown>) {
  const res = await app.request('/api/runs', { method: 'POST', body: JSON.stringify(body), headers: { ...json, ...auth } })
  expect(res.status).toBe(201)
  return (await res.json()).id as number
}

export async function postFill(app: App, auth: Record<string, string>, id: number, body: Record<string, unknown>) {
  const res = await app.request(`/api/runs/${id}/fills`, { method: 'POST', body: JSON.stringify(body), headers: { ...json, ...auth } })
  expect(res.status).toBe(200)
}
