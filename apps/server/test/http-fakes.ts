import { expect } from 'bun:test'
import type { RunState } from '@st/core'
import type { HttpDeps, HttpRepoSurface, createApp } from '../src/http/app'
import type { DayRepoSurface, FillRow, LedgerRow, NewOrder, NotificationRow, OrderRecord, OrderStatus, PendingRow, RunRow, RunStatus } from '../src/domain/repo-types'
import type { CaptureImageInsert } from '../src/db/repos-vision'
import type { VisionReviewRow } from '../src/domain/vision-review'
import { fakeCorrectionRepo } from './fake-corrections'
import { fakeSimRepo } from './fake-sim'
import { fakeRunRow, FAKE_CREATED_AT } from './booking-fakes'
import { normTicker } from '../src/db/repos-bars'

export function makeFakes() {
  let runIdSeq = 1
  const runs: RunRow[] = []
  const poolEdits: Array<{ id: number; runId: number; poolCents: number }> = []
  const fills: FillRow[] = []
  const ledger: LedgerRow[] = []
  const orders: OrderRecord[] = []
  const pending: PendingRow[] = []
  const correctionFake = fakeCorrectionRepo()
  const notifications: NotificationRow[] = []
  const settings: Record<string, string> = {}
  const states = new Map<number, RunState>()
  const bucketRepo = {
    async loadState(runId: number) { return states.get(runId)! },
    async saveState(runId: number, state: RunState) { states.set(runId, state) },
    // calls through the repo objects: tests replace their methods
    async saveStateWithOrders(runId: number, state: RunState, os: NewOrder[]) {
      await orderRepo.insertMany(os)
      await bucketRepo.saveState(runId, state)
    },
  } satisfies DayRepoSurface['bucketRepo']
  const runRepo = {
    async list() { return [...runs] },
    async get(id: number) { return runs.find((r) => r.id === id) ?? null },
    async getMany(ids: number[]) { return runs.filter((r) => ids.includes(r.id)) },
    async create(input) {
      const id = runIdSeq++
      if (input.initialRunState) states.set(id, input.initialRunState)
      runs.push(fakeRunRow(id, input))
      return id
    },
    async updateStatus(id, status) { const r = runs.find((x) => x.id === id); if (r) r.status = status },
    async updateStatusMany(ids: number[], from: RunStatus[], to: RunStatus) {
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
  } satisfies HttpRepoSurface['runRepo']
  const orderRepo = {
    async insertMany(os: NewOrder[]) { for (const o of os) orders.push({ id: orders.length + 1, ...o, skipReason: null, cancelReason: null, reportedAt: null }) },
    async listForDate(date: string) { return orders.filter((o) => o.tradeDate === date) },
    async markStale(date: string) { let c = 0; for (const o of orders) if (o.status === 'open' && o.tradeDate < date) { o.status = 'stale'; c++ } return c },
    async get(id: number) { return orders.find((x) => x.id === id) ?? null },
    async setStatus(id: number, status: OrderStatus, cancelReason?: string) {
      const o = orders.find((x) => x.id === id)
      if (o) { o.status = status; if (cancelReason !== undefined) o.cancelReason = cancelReason }
    },
    async listForRun(runId: number, date?: string) {
      let out = orders.filter((o) => o.runId === runId)
      if (date) out = out.filter((o) => o.tradeDate === date)
      return out
    },
    async listForRunFrom(runId: number, fromDate: string) {
      return orders.filter((o) => o.runId === runId && o.tradeDate >= fromDate).sort((a, b) => a.id - b.id)
    },
    async listUnreportedStale(runId: number) { return orders.filter((o) => o.runId === runId && o.status === 'stale' && o.reportedAt === null).sort((a, b) => a.id - b.id) },
    async markReported(ids: number[]) { for (const o of orders) if (ids.includes(o.id)) o.reportedAt = FAKE_CREATED_AT },
  } satisfies HttpRepoSurface['orderRepo']
  const fillRepo = {
    async insert(f) { fills.push({ id: fills.length + 1, ...f }) },
    async listForRun(runId: number) { return fills.filter((f) => f.runId === runId) },
    async update(runId, fillId, patch) {
      const gi = fills.findIndex((x) => x.runId === runId && x.id === fillId)
      if (gi < 0) throw new Error('no fill')
      fills[gi] = { ...fills[gi], ...patch }
    },
    async deleteById(runId: number, fillId: number) {
      const gi = fills.findIndex((x) => x.runId === runId && x.id === fillId)
      if (gi >= 0) fills.splice(gi, 1)
    },
  } satisfies HttpRepoSurface['fillRepo']
  const pendingRepo = {
    async insert(p) { const id = pending.length + 1; pending.push({ id, createdAt: FAKE_CREATED_AT, ...p }); return id },
    async listPending() { return pending.filter((p) => p.status === 'pending') },
    async hasLiveForCapture(captureId: number) { return pending.some((p) => p.captureId === captureId && p.status === 'pending') },
    async hasConfirmedForCapture(captureId: number) { return pending.some((p) => p.captureId === captureId && p.status === 'confirmed') },
    async decide(id, status, edited) {
      const p = pending.find((x) => x.id === id); if (!p || p.status !== 'pending') return false
      p.status = status
      if (edited) Object.assign(p, edited)
      return true
    },
    async get(id: number) { return pending.find((x) => x.id === id) ?? null },
  } satisfies HttpRepoSurface['pendingRepo']
  const captureRepo = { async findByHash(_runId: number, _hash: string) { return null }, async setStatus(_id, _status) {}, async insert(_c) { return { inserted: true, id: 1 } } } satisfies HttpRepoSurface['captureRepo']
  const captureImages: Array<CaptureImageInsert & { keep: boolean; createdAt?: string }> = []
  const captureImageRepo = {
    async insertIgnore(row) {
      if (captureImages.some((x) => x.captureId === row.captureId)) return false
      captureImages.push({ ...row, keep: false })
      return true
    },
    async getBytes(captureId: number) {
      const r = captureImages.find((x) => x.captureId === captureId)
      return r ? { mime: r.mime, bytes: r.bytes } : null
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
      const newestFirst = (a: (typeof captureImages)[number], b: (typeof captureImages)[number]) => ((b.createdAt ?? '') < (a.createdAt ?? '') ? -1 : (b.createdAt ?? '') > (a.createdAt ?? '') ? 1 : b.captureId - a.captureId)
      return captureImages.filter((x) => x.keep).sort(newestFirst).slice(0, limit).map((x) => ({ captureId: x.captureId, mime: x.mime, byteLen: x.byteLen, createdAt: x.createdAt ?? '' }))
    },
    async existingIds(captureIds: number[]) { return new Set<number>(captureImages.filter((x) => captureIds.includes(x.captureId)).map((x) => x.captureId)) },
  } satisfies HttpRepoSurface['captureImageRepo']
  const visionReviews: VisionReviewRow[] = []
  const visionReviewRepo = {
    async insertIgnore(row) {
      if (visionReviews.some((x) => x.pendingFillId === row.pendingFillId)) return
      visionReviews.push({ id: visionReviews.length + 1, createdAt: '', ...row })
    },
    async listForCaptures(captureIds: number[]) { return visionReviews.filter((x) => captureIds.includes(x.captureId)) },
    async deleteFor(captureId: number) {
      for (let i = visionReviews.length - 1; i >= 0; i--) if (visionReviews[i]!.captureId === captureId) visionReviews.splice(i, 1)
    },
  } satisfies HttpRepoSurface['visionReviewRepo']
  const ledgerRepo = {
    async insert(l) { ledger.push({ id: ledger.length + 1, ts: FAKE_CREATED_AT, ...l }) },
    async listForRun(runId: number) { return ledger.filter((l) => l.runId === runId) },
  } satisfies HttpRepoSurface['ledgerRepo']
  const notificationRepo = {
    async insert(n) { notifications.push({ id: notifications.length + 1, sentAt: FAKE_CREATED_AT, ...n }) },
    async listForRun(runId: number) { return notifications.filter((n) => n.runId === runId) },
    async listBefore(before: number | null, limit: number) { return notifications.filter((n) => before === null || n.id < before).sort((a, b) => b.id - a.id).slice(0, limit) },
  } satisfies HttpRepoSurface['notificationRepo']
  const sent: { chatId: string; text: string }[] = []
  const settingsRepo = {
    async getAll() { return { ...settings } },
    async set(key: string, value: string) { settings[key] = value },
  } satisfies HttpRepoSurface['settingsRepo']
  const poolEditRepo = {
    async insert(input: { runId: number; poolCents: number }) { poolEdits.push({ id: poolEdits.length + 1, ...input }) },
  } satisfies HttpRepoSurface['poolEditRepo']
  const { repo: simRepo, simRuns, simDays } = fakeSimRepo()
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
  } satisfies HttpRepoSurface['priceHistoryRepo']
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
  } satisfies HttpRepoSurface['barCoverageRepo']
  const repos = {
    runRepo, bucketRepo, orderRepo, fillRepo, pendingRepo, correctionRepo: correctionFake.repo, captureRepo, captureImageRepo, visionReviewRepo, ledgerRepo, notificationRepo,
    settingsRepo, poolEditRepo, simRepo, priceHistoryRepo, barCoverageRepo,
  } satisfies HttpRepoSurface
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
