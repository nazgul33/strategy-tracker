// The one place for sell-test setup: sellSetup seeds bucket state directly (booking and matching tests); heldRun seeds it through real buy fills (tests that edit or delete fills, so the history must rebuild).
import { emptyState, applyBuyFill, type ISODate } from '@st/core'
import { parseUsd } from '@st/core/money'
import { manualFill, runBooking, type FillBookingDeps } from '../src/domain/booking'
import type { OrderEvidence } from '../src/domain/order-type'
import type { OrderStatus } from '../src/domain/repo-types'
import { fakeRepos, recordingNotifier } from './booking-fakes'

export const D: ISODate = '2026-11-12'
export const Y: ISODate = '2026-11-11'
export type Held = { idx: number; shares: number; buy: string }
export type Ord = { idx: number; kind: 'sell_loc' | 'stop_sell' | 'market_sell'; price?: string; shares?: number; status?: OrderStatus; tradeDate?: ISODate; runId?: number }
export type Fakes = ReturnType<typeof fakeRepos>

// A 10-bucket run (costPpm 0) holding `held`, with `ords` inserted in the given order. An order's shares default to
// what its bucket holds (the strategy sizes legs that way), else 10; market_sell limitPrice is 0n; tradeDate defaults to D;
// runId defaults to the new run (pass another id to plant an order of a different run). notifyOverride wraps the recording notifier.
export async function sellSetup(held: Held[], ords: Ord[], notifyOverride?: (base: FillBookingDeps['notify']) => FillBookingDeps['notify']) {
  const f = fakeRepos()
  const rec = recordingNotifier()
  const deps: FillBookingDeps = { repos: f.repos, today: D, notify: notifyOverride ? notifyOverride(rec.notify) : rec.notify }
  let s = emptyState(10)
  for (const h of held) s = applyBuyFill(s, h.idx, h.shares, parseUsd(h.buy), 0, '2026-11-01')
  const runId = await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'sell', poolCents: 1000000, costPpm: 0, initialRunState: { buckets: s.buckets, cashCents: s.cashCents, closed: s.closed, ages: s.ages } })
  await f.repos.orderRepo.insertMany(ords.map((o) => ({
    runId: o.runId ?? runId, tradeDate: o.tradeDate ?? D, kind: o.kind, bucketIdx: o.idx,
    limitPrice: o.kind === 'market_sell' ? 0n : parseUsd(o.price!),
    shares: o.shares ?? held.find((h) => h.idx === o.idx)?.shares ?? 10, status: o.status ?? 'open',
  })))
  return { f, deps, rec, runId }
}

// A 10-bucket run (costPpm 0, pool 1_000_000 cents, today = D) whose buckets are held through real buy fills
// (manualFill, so the history rebuilds), buy i landing in bucket i. Orders are inserted after the buys; an order's
// shares default to what its bucket holds, else 10; market_sell limitPrice is 0n; tradeDate defaults to D.
export async function heldRun(buys: Array<{ shares: number; price: string; filledOn: ISODate }>, ords: Ord[]) {
  const f = fakeRepos()
  const rec = recordingNotifier()
  const deps: FillBookingDeps = { repos: f.repos, today: D, notify: rec.notify }
  const runId = await f.repos.runRepo.create({
    strategyKey: 'mean-reversion', ticker: 'AAPL', name: 'held', poolCents: 1_000_000, costPpm: 0,
    initialRunState: { buckets: emptyState(10).buckets, cashCents: 1_000_000, closed: [], ages: {} },
  })
  for (const b of buys) await manualFill(runId, { side: 'buy', shares: b.shares, price: b.price, filledOn: b.filledOn }, deps)
  await f.repos.orderRepo.insertMany(ords.map((o) => ({
    runId, tradeDate: o.tradeDate ?? D, kind: o.kind, bucketIdx: o.idx,
    limitPrice: o.kind === 'market_sell' ? 0n : parseUsd(o.price!),
    shares: o.shares ?? buys[o.idx]?.shares ?? 10, status: o.status ?? 'open',
  })))
  return { f, deps, rec, runId }
}

export const sellAt = (runId: number, shares: number, price: string, deps: FillBookingDeps, filledOn: ISODate = D) =>
  manualFill(runId, { side: 'sell', shares, price, filledOn }, deps)
// A sell booked with the order evidence a screenshot would have given it.
export const sellTyped = (runId: number, shares: number, price: string, deps: FillBookingDeps, order: OrderEvidence, filledOn: ISODate = D) =>
  runBooking({ ...bookInput(runId, shares, price), filledOn, order }, deps)
export const orderOf = (f: Fakes, idx: number, kind: string, tradeDate: ISODate = D) =>
  f._stores.orders.find((o) => o.bucketIdx === idx && o.kind === kind && o.tradeDate === tradeDate)!
export const fillsOf = (f: Fakes): Array<[shares: number, bucketIdx: number]> =>
  f._stores.fills.filter((x) => x.side === 'sell').map((x): [number, number] => [x.shares, x.bucketIdx])
export const heldShares = async (f: Fakes, runId: number) => (await f.repos.bucketRepo.loadState(runId)).buckets.map((b) => b.shares)
export const lastFill = (f: Fakes) => f._stores.fills[f._stores.fills.length - 1]
export const lastFillId = (f: Fakes): number => Math.max(...f._stores.fills.map((x) => x.id))
export const bookInput = (runId: number, shares: number, priceStr: string) =>
  ({ runId, side: 'sell' as const, shares, priceStr, feeCents: null, filledOn: D, pendingId: null, source: 'manual' as const })

export const held43: Held[] = [{ idx: 0, shares: 10, buy: '100.00' }, { idx: 9, shares: 10, buy: '88.00' }]
export const book43 = (tradeDate: ISODate = D, status: OrderStatus = 'open'): Ord[] => [
  { idx: 0, kind: 'sell_loc', price: '103.00', tradeDate, status }, { idx: 0, kind: 'stop_sell', price: '97.00', tradeDate, status },
  { idx: 9, kind: 'sell_loc', price: '91.00', tradeDate, status }, { idx: 9, kind: 'stop_sell', price: '85.40', tradeDate, status },
]
export const pair: Ord[] = [{ idx: 1, kind: 'sell_loc', price: '103.00' }, { idx: 1, kind: 'stop_sell', price: '97.00' }]
export const held1: Held[] = [{ idx: 1, shares: 10, buy: '100.00' }]
