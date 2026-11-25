import { expect } from 'bun:test'
import { DEFAULT_VR_SETTINGS } from '@st/strategies/value-rebalancing'
import { createApp } from '../src/http/app'
import type { NewVrCycle } from '../src/domain/vr/repo-types'
import { makeFakes, makeDeps, loginAs, json } from './http-fakes'

export async function vrSetup() {
  const f = makeFakes()
  const app = createApp(makeDeps(f))
  const auth = await loginAs(app)
  const req = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { ...json, ...auth }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: res.status === 204 ? null : await res.json() }
  }
  return { f, app, auth, req }
}
export type VrSetup = Awaited<ReturnType<typeof vrSetup>>

export async function newVrRun(s: VrSetup, body: Record<string, unknown> = {}): Promise<number> {
  const res = await s.req('POST', '/api/vr/runs', { name: 'vr', ticker: 'TQQQ', cashCents: 1_000_000, ...body })
  expect(res.status).toBe(201)
  return res.body.id as number
}

export async function seedCycle(s: VrSetup, runId: number, over: Partial<NewVrCycle> = {}): Promise<number> {
  return s.f.repos.vrCycleRepo.open({
    runId, seq: 1, scheduledStart: '2026-11-03', startDate: '2026-11-03', vCents: 935_000, bandMinCents: 794_750, bandMaxCents: 1_075_250,
    openShares: 176, openPoolCents: 100_000, buyBudgetCents: 50_000, buyLot: 3, sellLot: 2,
    prevClose: null, evalCents: null, poolBeforeCents: null, ...DEFAULT_VR_SETTINGS, depositCents: 0, vKept: false, ...over,
  }, null)
}

export const seedFill = (s: VrSetup, runId: number, side: 'buy' | 'sell', shares: number, price: bigint, fee: number, filledOn: string) =>
  s.f.repos.vrFillRepo.insert({ runId, side, shares, price, fee, filledOn, source: 'manual' })
