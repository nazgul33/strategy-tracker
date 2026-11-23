import { emptyState, parseUsd, type ISODate } from '@st/core'
import { manualFill, type FillBookingDeps } from '../src/domain/booking'
import { fakeRepos, recordingNotifier } from './booking-fakes'
import { D, type Ord } from './sell-fixture'

type Fakes = ReturnType<typeof fakeRepos>

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

export const lastFillId = (f: Fakes): number => Math.max(...f._stores.fills.map((x) => x.id))
