import { emptyState, applyBuyFill, type ISODate } from '@st/core'
import { parseUsd } from '@st/core/money'
import { manualFill, type FillBookingDeps } from '../src/domain/booking'
import type { OrderStatus } from '../src/domain/repo-types'
import { fakeRepos, silentNotifier } from './booking-fakes'

export const D: ISODate = '2026-11-12'
export type Held = { idx: number; shares: number; buy: string }
export type Ord = { idx: number; kind: 'sell_loc' | 'stop_sell' | 'market_sell'; price: string; status?: OrderStatus; shares?: number; runId?: number; tradeDate?: string }

export async function setup(held: Held[], ords: Ord[]) {
  const f = fakeRepos()
  const deps: FillBookingDeps = { repos: f.repos, today: D, notify: silentNotifier }
  let s = emptyState(10)
  for (const h of held) s = applyBuyFill(s, h.idx, h.shares, parseUsd(h.buy), 0, '2026-11-01')
  const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'stops', poolCents: 1000000, costPpm: 0, initialRunState: { buckets: s.buckets, cashCents: s.cashCents, closed: s.closed, ages: s.ages } })
  await f.repos.orderRepo.insertMany(ords.map((o) => ({
    runId: o.runId ?? runId, tradeDate: o.tradeDate ?? D, kind: o.kind, bucketIdx: o.idx,
    limitPrice: o.kind === 'market_sell' ? 0n : parseUsd(o.price), shares: o.shares ?? 10, status: o.status ?? 'open',
  })))
  return { f, deps, runId }
}
export const sell = (runId: number, shares: number, price: string, deps: FillBookingDeps) =>
  manualFill(runId, { side: 'sell', shares, price, filledOn: D }, deps)
export const order = (f: ReturnType<typeof fakeRepos>, idx: number, kind: string) =>
  f._stores.orders.find((o) => o.bucketIdx === idx && o.kind === kind)!
export const lastFill = (f: ReturnType<typeof fakeRepos>) => f._stores.fills[f._stores.fills.length - 1]
export const bookInput = (runId: number, shares: number, priceStr: string) =>
  ({ runId, side: 'sell' as const, shares, priceStr, feeCents: null, filledOn: D, pendingId: null, source: 'manual' as const })
export const pair: Ord[] = [{ idx: 1, kind: 'sell_loc', price: '103.00' }, { idx: 1, kind: 'stop_sell', price: '97.00' }]
export const held1: Held[] = [{ idx: 1, shares: 10, buy: '100.00' }]
