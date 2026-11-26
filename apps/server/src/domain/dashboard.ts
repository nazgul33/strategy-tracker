import type { ISODate } from '@st/core'
import { evalCents, vrBooks } from '@st/strategies/value-rebalancing'
import type { PendingRepo, RepoSurface, RunRepo } from './repo-types'
import type { VrCashRepo, VrFillRepo, VrPendingRepo, VrRunRepo } from './vr/repo-types'
import { lastCloseOf, toEngineFill } from './vr/view'

export type DashboardStrategy = 'mean-reversion' | 'value-rebalancing'
export interface DashboardRunInput {
  id: number; name: string; ticker: string; status: 'active' | 'paused' | 'closed'
  shares: number; cashCents: number; waiting: number
  lastClose: { date: ISODate; close: bigint } | null   // newest stored close of the ticker
}
export interface DashboardRow {
  id: number; name: string; ticker: string; status: 'active' | 'paused'
  shares: number
  close: bigint | null; closeDate: ISODate | null      // both null when shares is 0 or no close is stored
  closeMark: 'missing' | 'older' | null
  stockCents: number | null                             // null only when closeMark is 'missing'
  cashCents: number; valueCents: number; waiting: number
}
export interface DashboardGroup { strategy: DashboardStrategy; totalCents: number; incomplete: boolean; olderClose: boolean; runs: DashboardRow[] }
export interface Dashboard { today: ISODate; closeDate: ISODate | null; groups: [DashboardGroup, DashboardGroup] }

export interface DashboardRepos {
  runRepo: Pick<RunRepo, 'list'>
  bucketRepo: Pick<RepoSurface['bucketRepo'], 'loadState'>
  pendingRepo: Pick<PendingRepo, 'listPending'>
  vrRunRepo: Pick<VrRunRepo, 'list'>
  vrFillRepo: Pick<VrFillRepo, 'listForRun'>
  vrCashRepo: Pick<VrCashRepo, 'listForRun'>
  vrPendingRepo: Pick<VrPendingRepo, 'countPending'>
  priceHistoryRepo: { listForTicker(ticker: string): Promise<{ tradeDate: string; close: bigint }[]> }
}

type Live = DashboardRunInput & { status: 'active' | 'paused' }

function firstPass(i: Live): DashboardRow {
  const { id, name, ticker, status, shares, cashCents, waiting, lastClose } = i
  const base = { id, name, ticker, status, shares, cashCents, waiting }
  if (shares === 0) return { ...base, close: null, closeDate: null, closeMark: null, stockCents: 0, valueCents: cashCents }
  if (lastClose === null) return { ...base, close: null, closeDate: null, closeMark: 'missing', stockCents: null, valueCents: cashCents }
  const stockCents = evalCents(shares, lastClose.close)
  return { ...base, close: lastClose.close, closeDate: lastClose.date, closeMark: null, stockCents, valueCents: stockCents + cashCents }
}

const rowsOf = (inputs: readonly DashboardRunInput[]): DashboardRow[] =>
  inputs.filter((r): r is Live => r.status !== 'closed').sort((a, b) => a.id - b.id).map(firstPass)

function groupOf(strategy: DashboardStrategy, rows: DashboardRow[], pageDate: ISODate | null): DashboardGroup {
  const runs = rows.map((r): DashboardRow => (r.closeDate !== null && pageDate !== null && r.closeDate < pageDate ? { ...r, closeMark: 'older' } : r))
  return {
    strategy,
    totalCents: runs.reduce((n, r) => n + r.valueCents, 0),
    incomplete: runs.some((r) => r.closeMark === 'missing'),
    olderClose: runs.some((r) => r.closeMark === 'older'),
    runs,
  }
}

export function buildDashboard(i: { today: ISODate; mr: readonly DashboardRunInput[]; vr: readonly DashboardRunInput[] }): Dashboard {
  const mr = rowsOf(i.mr)
  const vr = rowsOf(i.vr)
  let closeDate: ISODate | null = null
  for (const r of [...mr, ...vr]) if (r.closeDate !== null && (closeDate === null || r.closeDate > closeDate)) closeDate = r.closeDate
  return { today: i.today, closeDate, groups: [groupOf('mean-reversion', mr, closeDate), groupOf('value-rebalancing', vr, closeDate)] }
}

export async function loadDashboard(deps: { repos: DashboardRepos; today: ISODate }): Promise<Dashboard> {
  const r = deps.repos
  const [mrRuns, pending, vrRuns] = await Promise.all([r.runRepo.list(), r.pendingRepo.listPending(), r.vrRunRepo.list()])
  const mrLive = mrRuns.filter((x) => x.status !== 'closed')
  const vrLive = vrRuns.filter((x) => x.status !== 'closed')
  const waitingByRun = new Map<number, number>()
  for (const p of pending) waitingByRun.set(p.runId, (waitingByRun.get(p.runId) ?? 0) + 1)
  const tickers = [...new Set([...mrLive, ...vrLive].map((x) => x.ticker))]

  const [closeList, mrStates, vrParts] = await Promise.all([
    Promise.all(tickers.map(async (t) => [t, lastCloseOf(await r.priceHistoryRepo.listForTicker(t))] as const)),
    Promise.all(mrLive.map((x) => r.bucketRepo.loadState(x.id))),
    Promise.all(vrLive.map((x) => Promise.all([r.vrFillRepo.listForRun(x.id), r.vrCashRepo.listForRun(x.id), r.vrPendingRepo.countPending(x.id)]))),
  ])
  const closes = new Map(closeList)

  const mr = mrLive.map((x, n): DashboardRunInput => {
    const state = mrStates[n]!
    return {
      id: x.id, name: x.name, ticker: x.ticker, status: x.status,
      shares: state.buckets.filter((b) => b.state !== 'empty').reduce((sum, b) => sum + b.shares, 0),
      cashCents: state.cashCents, waiting: waitingByRun.get(x.id) ?? 0, lastClose: closes.get(x.ticker) ?? null,
    }
  })
  const vr = vrLive.map((x, n): DashboardRunInput => {
    const [fills, moves, waiting] = vrParts[n]!
    const books = vrBooks(fills.map(toEngineFill), moves)
    return { id: x.id, name: x.name, ticker: x.ticker, status: x.status, shares: books.shares, cashCents: books.poolCents, waiting, lastClose: closes.get(x.ticker) ?? null }
  })
  return buildDashboard({ today: deps.today, mr, vr })
}
