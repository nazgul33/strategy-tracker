import { test, expect } from 'bun:test'
import type { getRepos } from '../src/db/repos'
import type { RepoSurface } from '../src/domain/booking'
import type { DayRepoSurface } from '../src/domain/repo-types'
import type { HttpDeps, HttpRepoSurface } from '../src/http/app'
import type { CaptureRepos } from '../src/wire/capture'
import type { Expect, IsNever, ArityMismatches } from './type-assert'
import type { fakeRepos } from './booking-fakes'
import type { makeFakes } from './http-fakes'
import type { getVrRepos } from '../src/db/repos-vr'
import type { NewVrCycle, SharedRunRepo, VrRepos } from '../src/domain/vr/repo-types'
import type { makeVrFakes } from './vr-fakes'

export function _dbPins(g: typeof getRepos) {
  // @ts-expect-error the real repositories need a Drizzle database
  g({})
}

export async function _orderPendingPins(r: RepoSurface) {
  // @ts-expect-error an order needs every column
  await r.orderRepo.insertMany([{ runId: 1 }])
  // @ts-expect-error 'closed' is a run status, not an order status
  await r.orderRepo.setStatus(1, 'closed')
  // @ts-expect-error limitPrice is bigint myriadths
  const _lp: string = (await r.orderRepo.get(1))!.limitPrice
  // @ts-expect-error markReported takes a list of order ids
  await r.orderRepo.markReported(1)
  // @ts-expect-error reportedAt is a timestamp string or null
  const _ra: number = (await r.orderRepo.get(1))!.reportedAt
  // @ts-expect-error a pending row carries its vision snapshot
  await r.pendingRepo.insert({ runId: 1 })
  // @ts-expect-error a pending row carries every detected* column, not only the fields the operator sees
  await r.pendingRepo.insert({ runId: 1, captureId: null, bucketIdx: null, side: 'buy', ticker: 'X', shares: 1, price: 1n, fee: null, filledOn: '2026-01-01', status: 'pending' })
  // @ts-expect-error price is bigint myriadths
  const _pp: string = (await r.pendingRepo.listPending())[0]!.price
}

export async function _runPins(r: HttpRepoSurface) {
  // @ts-expect-error 'done' is not a run status
  await r.runRepo.updateStatus(1, 'done')
  // @ts-expect-error a run needs its name, pool and cost
  await r.runRepo.create({ ticker: 'X' })
  // @ts-expect-error get may return null
  const _t: string = (await r.runRepo.get(1)).ticker
  // @ts-expect-error getMany takes a list of run ids
  await r.runRepo.getMany(1)
}

export async function _restPins(r: HttpRepoSurface, d: HttpDeps) {
  // @ts-expect-error a fill needs every column
  await r.fillRepo.insert({ runId: 1 })
  // @ts-expect-error a capture needs its hash and status
  await r.captureRepo.insert({ runId: 1 })
  // @ts-expect-error a ledger entry needs kind and amount
  await r.ledgerRepo.insert({ runId: 1 })
  // @ts-expect-error a notification needs its chat
  await r.notificationRepo.insert({ text: 'x' })
  // @ts-expect-error text is a string
  const _n: number = (await r.notificationRepo.listForRun(1))[0]!.text
  // @ts-expect-error the page cursor is a row id or null
  await r.notificationRepo.listBefore('5', 20)
  // @ts-expect-error bars carry a bigint close
  const _c: string = (await d.fetchDailyBars('X', '2026-01-01', '2026-01-02'))[0]!.close
}

export async function _vrPins(r: HttpRepoSurface) {
  // @ts-expect-error getMany takes a list of run ids
  await r.sharedRunRepo.getMany(1)
  // @ts-expect-error 'done' is not a run status
  await r.vrRunRepo.updateStatus(1, 'done')
  // @ts-expect-error 'turbo' is not a VR formula
  await r.vrRunRepo.updateSettings(1, { g: 10, formula: 'turbo', bandPpm: 1, spendLimitPpm: 1, cycleDepositCents: 0 })
  // @ts-expect-error a cycle's previous close is bigint myriadths
  await r.vrCycleRepo.open({ ...({} as NewVrCycle), prevClose: '1' }, null)
  // @ts-expect-error a fill price is bigint myriadths
  await r.vrFillRepo.update(1, 2, { side: 'buy', shares: 1, price: 1, fee: 0, filledOn: '2026-01-01' })
  // @ts-expect-error cash amounts are integer cents
  await r.vrCashRepo.update(1, 2, { amountCents: '5', movedOn: '2026-01-01', note: null })
}

export type _real = Expect<IsNever<ArityMismatches<ReturnType<typeof getRepos>, HttpRepoSurface>>>
export type _realCapture = Expect<IsNever<ArityMismatches<ReturnType<typeof getRepos>, CaptureRepos>>>
export type _realDay = Expect<IsNever<ArityMismatches<ReturnType<typeof getRepos>, DayRepoSurface>>>
export type _booking = Expect<IsNever<ArityMismatches<ReturnType<typeof fakeRepos>['repos'], RepoSurface>>>
export type _http = Expect<IsNever<ArityMismatches<ReturnType<typeof makeFakes>['repos'], HttpRepoSurface>>>
export type _realVr = Expect<IsNever<ArityMismatches<ReturnType<typeof getVrRepos>, VrRepos & { sharedRunRepo: SharedRunRepo }>>>
export type _vrFake = Expect<IsNever<ArityMismatches<ReturnType<typeof makeVrFakes>['repos'], VrRepos & { sharedRunRepo: SharedRunRepo }>>>
// @ts-expect-error a fake that drops listForRun's date is caught
export type _neg = Expect<IsNever<ArityMismatches<{ orderRepo: { listForRun(runId: number): Promise<[]> } }, Pick<RepoSurface, 'orderRepo'>>>>

test('repository surface type pins compile', () => { expect(true).toBe(true) })
