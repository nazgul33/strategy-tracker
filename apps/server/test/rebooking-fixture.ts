import { DomainError, applyBuyFill, emptyState, parseUsd, roundDiv, type ISODate, type RunState } from '@st/core'
import { ageBuckets } from '@st/strategies'
import type { FillBookingDeps } from '../src/domain/booking'
import { fakeRepos, silentNotifier } from './booking-fakes'

export const TODAY: ISODate = '2026-01-15'
type F = ReturnType<typeof fakeRepos>

export const deps = (f: F): FillBookingDeps => ({ repos: f.repos, today: TODAY, notify: silentNotifier })
export const getState = (f: F, runId: number): Promise<RunState> => f.repos.bucketRepo.loadState(runId)
export const adjustRows = (f: F) => f._stores.ledger.filter((l: any) => l.kind === 'adjust')
export const asJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))

// Mimics the real SQL listing, which has no ORDER BY: the fake returns the run's
// fills rotated (neither id-ascending nor id-descending).
export function scrambleListForRun(f: F) {
  const real = f.repos.fillRepo.listForRun
  f.repos.fillRepo.listForRun = async (runId: number) => {
    const rows = await real(runId)
    return rows.length > 1 ? [...rows.slice(1), rows[0]] : rows
  }
}

export function createRun(f: F, poolCents = 100_000, bucketCount = 10): Promise<number> {
  return f.repos.runRepo.create({
    strategyKey: 'mean-reversion', ticker: 'SPY', name: 'r', poolCents, costPpm: 0,
    initialRunState: { buckets: emptyState(bucketCount).buckets, cashCents: poolCents, closed: [], ages: {} },
  })
}

// Seed a held bucket directly through the core applier (no ledger row), so tests
// can assert the adjust rows that rebook/delete add.
export async function bookBuy(f: F, runId: number, o: { idx: number; shares: number; price: string; feeCents?: number; filledOn: ISODate }) {
  const st = await getState(f, runId)
  const price = parseUsd(o.price)
  const fee = o.feeCents ?? 0
  const next = applyBuyFill(st, o.idx, o.shares, price, fee, o.filledOn)
  next.ages[o.idx] = ageBuckets(next.ages, TODAY, { [o.idx]: o.filledOn })[o.idx]!
  await f.repos.bucketRepo.saveState(runId, next)
  await f.repos.fillRepo.insert({ runId, bucketIdx: o.idx, side: 'buy', ticker: 'SPY', shares: o.shares, price, fee, filledOn: o.filledOn, source: 'seed' })
}

const gross = (price: string, shares: number) => Number(roundDiv(parseUsd(price) * BigInt(shares), 100n))
export const buyEffect = (price: string, shares: number, fee = 0) => -(gross(price, shares) + fee)
export const sellEffect = (price: string, shares: number, fee = 0) => gross(price, shares) - fee
export const ageOf = (filledOn: ISODate) => ageBuckets({}, TODAY, { 0: filledOn })[0]!

export async function expectKind(fn: () => Promise<unknown>): Promise<DomainError> {
  try {
    await fn()
  } catch (e) {
    return e as DomainError
  }
  throw new Error('expected a DomainError, but the call resolved')
}
