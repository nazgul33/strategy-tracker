import { VALUE_REBALANCING } from '@st/strategies/value-rebalancing'
import type { RunStatus } from '../src/domain/repo-types'
import {
  VrNameTakenError,
  type NewVrCashMove, type NewVrCycle, type NewVrFill, type NewVrRun, type SharedRunRepo, type SharedRunRow, type VrCashMoveRow, type VrCashPatch,
  type VrCashRepo, type VrCycleRepo, type VrCycleRow, type VrFillPatch, type VrFillRepo, type VrFillRow, type VrPendingPatch, type VrPendingRepo, type VrPendingRow, type VrPendingStatus, type NewVrPending,
  type VrRepos, type VrRunRepo, type VrRunRow,
} from '../src/domain/vr/repo-types'
import type { VrSettings } from '@st/strategies/value-rebalancing'
import { FAKE_CREATED_AT } from './booking-fakes'
import type { Expect, IsNever, ArityMismatches } from './type-assert'

// VR run ids start above every run id the host fakes hand out or tests pick by hand.
export const VR_FAKE_RUN_ID_BASE = 100_000

const nextId = (rows: { id: number }[]) => Math.max(0, ...rows.map((r) => r.id)) + 1
const byDateThenId = <T extends { id: number }>(date: (r: T) => string) => (a: T, b: T) => (date(a) < date(b) ? -1 : date(a) > date(b) ? 1 : a.id - b.id)

/** In-memory VR repositories. `otherRuns` is read on every call, so rows a test pushes later are found. */
export function makeVrFakes(opts: { otherRuns?: () => SharedRunRow[] } = {}) {
  const other = opts.otherRuns ?? (() => [])
  const runs: VrRunRow[] = []
  const cycles: VrCycleRow[] = []
  const fills: VrFillRow[] = []
  const cash: VrCashMoveRow[] = []
  const pending: VrPendingRow[] = []

  const sharedRunRepo = {
    async getMany(ids: number[]) {
      if (ids.length === 0) return []
      return [...other(), ...runs].filter((r) => ids.includes(r.id)).sort((a, b) => a.id - b.id)
        .map((r): SharedRunRow => ({ id: r.id, strategyKey: r.strategyKey, ticker: r.ticker, name: r.name, costPpm: r.costPpm, status: r.status, createdAt: r.createdAt }))
    },
  } satisfies SharedRunRepo

  const vrRunRepo = {
    async list() { return runs.map((r) => ({ ...r })).sort((a, b) => a.id - b.id) },
    async get(id: number) { const r = runs.find((x) => x.id === id); return r ? { ...r } : null },
    async create(input: NewVrRun) {
      if (other().some((r) => r.name === input.name) || runs.some((r) => r.name === input.name)) throw new VrNameTakenError(input.name)
      const id = Math.max(VR_FAKE_RUN_ID_BASE, ...runs.map((r) => r.id), ...other().map((r) => r.id)) + 1
      runs.push({
        id, strategyKey: VALUE_REBALANCING, ticker: input.ticker, name: input.name, costPpm: input.costPpm, status: 'active', createdAt: FAKE_CREATED_AT,
        g: input.g, formula: input.formula, bandPpm: input.bandPpm, spendLimitPpm: input.spendLimitPpm, cycleDepositCents: input.cycleDepositCents,
        initialVCents: input.initialVCents,
      })
      cash.push({ id: nextId(cash), runId: id, kind: 'open', amountCents: input.openingCashCents, movedOn: input.openedOn, note: null, cycleId: null, createdAt: FAKE_CREATED_AT })
      return id
    },
    async updateStatus(id: number, status: RunStatus) { const r = runs.find((x) => x.id === id); if (r) r.status = status },
    async updateSettings(id: number, v: VrSettings) {
      const r = runs.find((x) => x.id === id)
      if (r) Object.assign(r, { g: v.g, formula: v.formula, bandPpm: v.bandPpm, spendLimitPpm: v.spendLimitPpm, cycleDepositCents: v.cycleDepositCents })
    },
  } satisfies VrRunRepo

  const vrCycleRepo = {
    async listForRun(runId: number) { return cycles.filter((c) => c.runId === runId).sort((a, b) => a.seq - b.seq).map((c) => ({ ...c })) },
    async latest(runId: number) {
      const rows = cycles.filter((c) => c.runId === runId).sort((a, b) => b.seq - a.seq)
      return rows[0] ? { ...rows[0] } : null
    },
    async open(cycle: NewVrCycle, deposit: Omit<NewVrCashMove, 'cycleId'> | null) {
      if (cycles.some((c) => c.runId === cycle.runId && c.seq === cycle.seq)) throw new Error('duplicate (runId, seq)')
      const id = nextId(cycles)
      cycles.push({ ...cycle, id, createdAt: FAKE_CREATED_AT })
      if (deposit) cash.push({ ...deposit, cycleId: id, id: nextId(cash), createdAt: FAKE_CREATED_AT })
      return id
    },
  } satisfies VrCycleRepo

  const vrFillRepo = {
    async listForRun(runId: number) { return fills.filter((f) => f.runId === runId).sort(byDateThenId((f) => f.filledOn)).map((f) => ({ ...f })) },
    async get(runId: number, id: number) { const f = fills.find((x) => x.id === id && x.runId === runId); return f ? { ...f } : null },
    async insert(f: NewVrFill) { const id = nextId(fills); fills.push({ ...f, id, createdAt: FAKE_CREATED_AT }); return id },
    async update(runId: number, id: number, p: VrFillPatch) {
      const f = fills.find((x) => x.id === id && x.runId === runId)
      if (f) Object.assign(f, { side: p.side, shares: p.shares, price: p.price, fee: p.fee, filledOn: p.filledOn })
    },
    async deleteById(runId: number, id: number) {
      const i = fills.findIndex((x) => x.id === id && x.runId === runId)
      if (i >= 0) fills.splice(i, 1)
    },
  } satisfies VrFillRepo

  const vrCashRepo = {
    async listForRun(runId: number) { return cash.filter((m) => m.runId === runId).sort(byDateThenId((m) => m.movedOn)).map((m) => ({ ...m })) },
    async get(runId: number, id: number) { const m = cash.find((x) => x.id === id && x.runId === runId); return m ? { ...m } : null },
    async insert(m: NewVrCashMove) { const id = nextId(cash); cash.push({ ...m, id, createdAt: FAKE_CREATED_AT }); return id },
    async update(runId: number, id: number, p: VrCashPatch) {
      const m = cash.find((x) => x.id === id && x.runId === runId)
      if (m) Object.assign(m, { amountCents: p.amountCents, movedOn: p.movedOn, note: p.note })
    },
    async deleteById(runId: number, id: number) {
      const i = cash.findIndex((x) => x.id === id && x.runId === runId)
      if (i >= 0) cash.splice(i, 1)
    },
  } satisfies VrCashRepo

  const findPending = (runId: number, id: number) => pending.find((p) => p.id === id && p.runId === runId && p.status === 'pending')
  const vrPendingRepo = {
    async listForRun(runId: number, status?: VrPendingStatus) {
      return pending.filter((p) => p.runId === runId && (status === undefined || p.status === status)).sort(byDateThenId((p) => p.filledOn)).map((p) => ({ ...p }))
    },
    async get(runId: number, id: number) { const p = pending.find((x) => x.id === id && x.runId === runId); return p ? { ...p } : null },
    async insertMany(rows: NewVrPending[]) {
      return rows.map((r) => { const id = nextId(pending); pending.push({ ...r, id, status: 'pending', createdAt: FAKE_CREATED_AT }); return id })
    },
    async update(runId: number, id: number, p: VrPendingPatch) {
      const r = findPending(runId, id)
      if (!r) return false
      Object.assign(r, { side: p.side, shares: p.shares, price: p.price, fee: p.fee, filledOn: p.filledOn })
      return true
    },
    async confirm(runId: number, id: number, fill: NewVrFill) {
      if (fill.runId !== runId) throw new Error(`confirm: fill.runId ${fill.runId} differs from runId ${runId}`)
      const r = findPending(runId, id)
      if (!r) return null
      r.status = 'confirmed' // before the first await, so a second confirm started now finds the row decided
      try {
        return await vrFillRepo.insert(fill) // through the object: a test that makes insert throw leaves the row pending
      } catch (e) {
        r.status = 'pending'
        throw e
      }
    },
    async reject(runId: number, id: number) { const r = findPending(runId, id); if (!r) return false; r.status = 'rejected'; return true },
    async countPending(runId: number) { return pending.filter((p) => p.runId === runId && p.status === 'pending').length },
    async hasPendingForCapture(captureId: number) { return pending.some((p) => p.captureId === captureId && p.status === 'pending') },
    async hasConfirmedForCapture(captureId: number) { return pending.some((p) => p.captureId === captureId && p.status === 'confirmed') },
    async hasAnyForCapture(captureId: number) { return pending.some((p) => p.captureId === captureId) },
  } satisfies VrPendingRepo

  return { repos: { sharedRunRepo, vrRunRepo, vrCycleRepo, vrFillRepo, vrCashRepo, vrPendingRepo }, runs, cycles, fills, cash, pending }
}

type _vr = Expect<IsNever<ArityMismatches<ReturnType<typeof makeVrFakes>['repos'], VrRepos & { sharedRunRepo: SharedRunRepo }>>>
