import { emptyState } from '@st/core'
import { DEFAULT_MR_PARAMS } from '@st/strategies'
import { DEFAULT_VR_SETTINGS } from '@st/strategies/value-rebalancing'
import type { DayDeps } from '../src/pipeline/day'
import type { NewVrCycle } from '../src/domain/vr/repo-types'
import { makeFakes } from './http-fakes'

export type Fakes = ReturnType<typeof makeFakes>

async function mrRun(f: Fakes, ticker: string) {
  const st = emptyState(10)
  st.buckets[1] = { index: 1, state: 'held', shares: 10, buyPrice: 3402300n, buyFeeCents: 0, filledOn: '2026-11-03' }
  st.ages[1] = 3
  st.cashCents = 1000000
  await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: ticker[0]!, poolCents: 1000000, costPpm: 30, initialRunState: st })
}

export async function setup(over: Partial<DayDeps> = {}, o: { mr?: string; vr?: string | null; deposit?: number; close?: { date: string; close: bigint } } = {}) {
  const f = makeFakes()
  if (o.mr) await mrRun(f, o.mr)
  const vrId = o.vr === null ? 0 : await f.repos.vrRunRepo.create({
    ...DEFAULT_VR_SETTINGS, cycleDepositCents: o.deposit ?? 0, ticker: o.vr ?? 'TQQQ', name: 'Q', costPpm: 0,
    initialVCents: 500_000, openingCashCents: 1_000_000, openedOn: '2026-11-20',
  })
  const sent: string[] = []
  const fetched: string[] = []
  const persisted: [string, string, bigint][] = []
  const deps: DayDeps = {
    today: () => '2026-12-07',
    fetchLastClose: async (tk) => { fetched.push(tk); return o.close ?? { date: '2026-12-04', close: 520_000n } },
    crossCheck: async () => ({ agree: true }),
    send: async (_c, text) => { sent.push(text) },
    allowedChatIds: ['c1'],
    repos: f.repos,
    params: () => DEFAULT_MR_PARAMS,
    digestLang: 'en',
    persistClose: async (tk, d, c) => { persisted.push([tk, d, c]) },
    ...over,
  }
  return { f, deps, sent, fetched, persisted, vrId }
}

export const buy = (f: Fakes, runId: number, shares: number, price: bigint, on: string) =>
  f.repos.vrFillRepo.insert({ runId, side: 'buy', shares, price, fee: 0, filledOn: on, source: 'manual' })
export const sell = (f: Fakes, runId: number, shares: number, price: bigint, on: string) =>
  f.repos.vrFillRepo.insert({ runId, side: 'sell', shares, price, fee: 0, filledOn: on, source: 'manual' })

/** Screenshot fills waiting for a decision; returns their ids. */
export const waitingFill = (f: Fakes, runId: number, n: number) =>
  f.repos.vrPendingRepo.insertMany(Array.from({ length: n }, () => ({
    runId, captureId: 1, side: 'buy' as const, shares: 1, price: 500_000n, fee: null, filledOn: '2026-12-04', dateRead: true, dupPrice: null,
  })))

export function cycle1(runId: number, over: Partial<NewVrCycle> = {}): NewVrCycle {
  return {
    runId, seq: 1, scheduledStart: '2026-11-23', startDate: '2026-11-23', vCents: 500_000, bandMinCents: 425_000, bandMaxCents: 575_000,
    openShares: 100, openPoolCents: 500_000, buyBudgetCents: 250_000, buyLot: 2, sellLot: 1,
    prevClose: null, evalCents: null, poolBeforeCents: null, g: 10, formula: 'skill', depositCents: 0, vKept: false, openFillId: 0, ...over,
  }
}

export const WARN_EN = (id: number, tk: string) => `VR market data error — the last close for ${tk} is missing or out of date, so run #${id} was skipped this morning. It will be retried on the next morning run; orders already placed are not affected.`
export const RUN_ERR = (id: number, tk: string) => `VR run error — run #${id} (${tk}) could not be processed this morning. Open the run's page in the web app to check it.`
export const LIST_ERR = 'VR run error — the Value Rebalancing runs could not be loaded this morning; mean-reversion runs were processed as usual.'
export const BUY_HEAD = 'Q  TQQQ — VR buy instruction'
