import type { RunState } from '@st/core'
import type { DayRepoSurface, NewNotification, NewOrder, NewRun, NotificationRow, OrderRecord, OrderStatus, RunRow, RunStatus } from '../src/domain/repo-types'
import { fakeCorrectionRepo } from './fake-corrections'
import { fakeRunRow, rehydrate, serializeState, FAKE_CREATED_AT } from './booking-fakes'
import { makeChoiceFakes } from './capture-choice-fakes'
import { makeVrFakes } from './vr-fakes'
import type { Expect, IsNever, ArityMismatches } from './type-assert'

export function makeRepos() {
  const runs: RunRow[] = []
  const orders: OrderRecord[] = []
  const notifications: NotificationRow[] = []
  let orderSeq = 1
  const runRepo = {
    async list() { return runs },
    async get(id: number) { return runs.find((r) => r.id === id) ?? null },
    async create(input: NewRun) { const id = runs.length + 1; runs.push(fakeRunRow(id, input)); return id },
    async updateStatus(id: number, s: RunStatus) { const r = runs.find((x) => x.id === id); if (r) r.status = s },
  }
  const bucketRepo = {
    async loadState(runId: number) { return rehydrate(JSON.parse(runs.find((x) => x.id === runId)!.stateJson)) },
    async saveState(runId: number, state: RunState) { runs.find((x) => x.id === runId)!.stateJson = serializeState(state) },
    // calls through the repo objects: the run-lock tests patch their methods
    async saveStateWithOrders(runId: number, state: RunState, os: NewOrder[]) {
      await orderRepo.insertMany(os)
      await bucketRepo.saveState(runId, state)
    },
  }
  const orderRepo = {
    async insertMany(os: NewOrder[]) { for (const o of os) orders.push({ id: orderSeq++, ...o, skipReason: null, cancelReason: null, reportedAt: null }) },
    async listForDate(d: string) { return orders.filter((o) => o.tradeDate === d) },
    async listForRun(runId: number, d?: string) { return orders.filter((o) => o.runId === runId && (d === undefined || o.tradeDate === d)) },
    async listForRunFrom(runId: number, fromDate: string) { return orders.filter((o) => o.runId === runId && o.tradeDate >= fromDate).sort((a, b) => a.id - b.id) },
    async get(id: number) { return orders.find((x) => x.id === id) ?? null },
    async markStale(d: string) { let c = 0; for (const o of orders) if (o.status === 'open' && o.tradeDate < d) { o.status = 'stale'; c++ } return c },
    async setStatus(id: number, s: OrderStatus, _cancelReason?: string) { const o = orders.find((x) => x.id === id); if (o) o.status = s },
    async listUnreportedStale(runId: number) { return orders.filter((o) => o.runId === runId && o.status === 'stale' && o.reportedAt === null).sort((a, b) => a.id - b.id) },
    async markReported(ids: number[]) { for (const o of orders) if (ids.includes(o.id)) o.reportedAt = FAKE_CREATED_AT },
  }
  const notificationRepo = {
    async insert(n: NewNotification) { notifications.push({ id: notifications.length + 1, sentAt: FAKE_CREATED_AT, ...n }) },
  }
  const vrFakes = makeVrFakes({ otherRuns: () => runs })
  const choiceFakes = makeChoiceFakes()
  const repos = {
    ...vrFakes.repos, captureChoiceRepo: choiceFakes.captureChoiceRepo, runRepo, bucketRepo, orderRepo, notificationRepo, correctionRepo: fakeCorrectionRepo().repo,
    fillRepo: { insert: async (_fill) => {}, async listForRun(_runId) { return [] } },
    pendingRepo: { insert: async (_p) => 1, listPending: async () => [], hasLiveForCapture: async (_captureId) => false, hasConfirmedForCapture: async (_captureId) => false, decide: async (_id, _status, _edited) => false },
    captureRepo: { findByHash: async (_runId, _hash) => null, setStatus: async (_id, _status) => {}, insert: async (_c) => ({ inserted: true, id: 1 }) },
    captureImageRepo: { insertIgnore: async (_row) => true, getBytes: async (_captureId) => null, isKept: async (_captureId) => false, setKeep: async (_captureId) => {}, deleteFor: async (_captureId) => {}, discard: async (_captureId) => {}, listKept: async (_limit) => [] },
    visionReviewRepo: { insertIgnore: async (_row) => {}, listForCaptures: async (_captureIds) => [], deleteFor: async (_captureId) => {} },
    ledgerRepo: { insert: async (_l) => {}, listForRun: async (_runId) => [] },
  } satisfies DayRepoSurface
  const { runs: vrRuns, cycles: vrCycles, fills: vrFills, cash: vrCash, pending: vrPending } = vrFakes
  return { repos, runs, orders, notifications, vr: { runs: vrRuns, cycles: vrCycles, fills: vrFills, cash: vrCash, pending: vrPending } }
}

type _day = Expect<IsNever<ArityMismatches<ReturnType<typeof makeRepos>['repos'], DayRepoSurface>>>
