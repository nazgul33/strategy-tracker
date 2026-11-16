import type { RunState } from '@st/core'
import type { HttpDeps, HttpRepoSurface } from '../src/http/app'
import { fakeCorrectionRepo } from './fake-corrections'

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
      runs.push({ id, strategyKey: input.strategyKey, ticker: input.ticker, name: input.name, poolCents: input.poolCents, costPpm: input.costPpm, buyGapPpm: input.buyGapPpm ?? 0, sellGapPpm: input.sellGapPpm ?? 0, status: 'active', stateJson: JSON.stringify(state, (_k, v) => typeof v === 'bigint' ? v.toString() : v), createdAt: new Date() })
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
    async updateGaps(id: number, buyGapPpm: number, sellGapPpm: number) {
      const r = runs.find((x) => x.id === id); if (r) { r.buyGapPpm = buyGapPpm; r.sellGapPpm = sellGapPpm }
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
  const simRuns: any[] = []
  const simRepo = {
    async insertRun(i: any) { simRuns.push({ id: simRuns.length + 1, createdAt: '2026-11-10T00:00:00Z', ...i }); return simRuns.length },
    async insertDays() {},
    async listRuns() { return simRuns },
    async getRun() { return null },
    async listDays() { return [] },
  }
  const priceHistory: { ticker: string; tradeDate: string; close: bigint }[] = []
  const priceHistoryRepo = {
    async upsertMany(rows: { ticker: string; tradeDate: string; close: bigint }[]) {
      for (const r of rows) {
        const hit = priceHistory.find((x) => x.ticker === r.ticker && x.tradeDate === r.tradeDate)
        if (hit) hit.close = r.close
        else priceHistory.push({ ...r })
      }
      return rows.length
    },
    async listForTicker(ticker: string, from?: string) {
      return priceHistory
        .filter((r) => r.ticker === ticker && (!from || r.tradeDate >= from))
        .sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1))
    },
  }
  const repos: HttpRepoSurface = {
    runRepo, bucketRepo, orderRepo, fillRepo, pendingRepo, correctionRepo: correctionFake.repo, captureRepo, ledgerRepo, notificationRepo,
    settingsRepo, poolEditRepo, simRepo, priceHistoryRepo,
  } as any
  return { repos, corrections: correctionFake.store, runs, poolEdits, fills, ledger, orders, pending, notifications, sent, settings, states, simRuns, priceHistory }
}

export const PASSWORD = 'secret'
export const SECRET = 'session-secret'

export function makeDeps(fakes: ReturnType<typeof makeFakes>): HttpDeps {
  return {
    repos: fakes.repos,
    password: PASSWORD,
    sessionSecret: SECRET,
    today: () => '2026-11-10',
    defaultSettings: { visionBaseUrl: 'http://x', visionModel: 'm', digestLang: 'en' },
    triggerMorning: async () => 'morning-ok',
    fetchDailyBars: async () => [],
    allowedChatIds: ['42'],
    send: async (chatId: string, text: string) => { fakes.sent.push({ chatId, text }) },
  }
}
