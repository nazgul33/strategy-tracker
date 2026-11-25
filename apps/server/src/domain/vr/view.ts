import type { ISODate } from '@st/core'
import {
  VR_CYCLE_DAYS, addDays, avgCost, buyInstructionShares, buyRungs, evalCents, remainingRungs, sellRungs, sharesInCycle, spentInCycleCents, vrBooks,
  type VrFill, type VrFormula, type VrRung,
} from '@st/strategies/value-rebalancing'
import type { RunStatus } from '../repo-types'
import type { VrCashMoveRow, VrCycleRow, VrFillRow, VrRunRow } from './repo-types'

export interface VrSettingsDto { g: number; formula: VrFormula; bandPpm: number; spendLimitPpm: number; cycleDepositCents: number }
export interface VrRunView { id: number; name: string; ticker: string; status: RunStatus; costPpm: number; createdAt: string; initialVCents: number; settings: VrSettingsDto }
export interface VrRunSummary extends VrRunView { shares: number; poolCents: number; vCents: number | null; valueCents: number | null }
export interface VrCycleView {
  id: number; seq: number; scheduledStart: ISODate; startDate: ISODate; endDate: ISODate; nextStart: ISODate
  vCents: number; bandMinCents: number; bandMaxCents: number; openShares: number; openPoolCents: number; buyBudgetCents: number; buyLot: number; sellLot: number
  prevClose: bigint | null; evalCents: number | null; poolBeforeCents: number | null; g: number; formula: VrFormula; depositCents: number; vKept: boolean
}
export interface VrLastClose { date: ISODate; close: bigint }
export interface VrBooksView {
  shares: number; poolCents: number; netInvestedCents: number; avgCost: bigint | null
  evalCents: number | null; valueCents: number | null; profitCents: number | null
}
export interface VrLadder { buy: VrRung[]; sell: VrRung[]; buyTotal: number; sellTotal: number }
export interface VrRunDetail {
  run: VrRunView; today: ISODate; lastClose: VrLastClose | null; books: VrBooksView
  cycle: VrCycleView | null; budgetLeftCents: number | null
  buyInstruction: { shares: number; targetCents: number } | null
  ladder: VrLadder
}
export interface VrFillView { id: number; side: 'buy' | 'sell'; shares: number; price: bigint; fee: number; filledOn: ISODate; source: 'manual' | 'capture'; createdAt: string; beforeCycle: boolean }
export interface VrCashView { id: number; kind: VrCashMoveRow['kind']; amountCents: number; movedOn: ISODate; note: string | null; cycleId: number | null; createdAt: string; beforeCycle: boolean }

export interface VrViewInput { run: VrRunRow; fills: VrFillRow[]; moves: VrCashMoveRow[]; cycle: VrCycleRow | null; lastClose: VrLastClose | null }

export function toEngineFill(f: VrFillRow): VrFill {
  return { side: f.side, shares: f.shares, price: f.price, feeCents: f.fee, filledOn: f.filledOn }
}

/** Rows come in ascending trade date; the newest is last. */
export function lastCloseOf(rows: { tradeDate: string; close: bigint }[]): VrLastClose | null {
  const last = rows[rows.length - 1]
  return last ? { date: last.tradeDate, close: last.close } : null
}

export function runView(r: VrRunRow): VrRunView {
  return {
    id: r.id, name: r.name, ticker: r.ticker, status: r.status, costPpm: r.costPpm, createdAt: r.createdAt, initialVCents: r.initialVCents,
    settings: { g: r.g, formula: r.formula, bandPpm: r.bandPpm, spendLimitPpm: r.spendLimitPpm, cycleDepositCents: r.cycleDepositCents },
  }
}

export function cycleView(c: VrCycleRow): VrCycleView {
  return {
    id: c.id, seq: c.seq, scheduledStart: c.scheduledStart, startDate: c.startDate,
    endDate: addDays(c.scheduledStart, VR_CYCLE_DAYS - 1), nextStart: addDays(c.scheduledStart, VR_CYCLE_DAYS),
    vCents: c.vCents, bandMinCents: c.bandMinCents, bandMaxCents: c.bandMaxCents, openShares: c.openShares, openPoolCents: c.openPoolCents,
    buyBudgetCents: c.buyBudgetCents, buyLot: c.buyLot, sellLot: c.sellLot,
    prevClose: c.prevClose, evalCents: c.evalCents, poolBeforeCents: c.poolBeforeCents, g: c.g, formula: c.formula, depositCents: c.depositCents, vKept: c.vKept,
  }
}

const beforeStart = (date: ISODate, cycle: VrCycleRow | null) => cycle !== null && date < cycle.startDate

export function fillView(f: VrFillRow, cycle: VrCycleRow | null): VrFillView {
  return { id: f.id, side: f.side, shares: f.shares, price: f.price, fee: f.fee, filledOn: f.filledOn, source: f.source, createdAt: f.createdAt, beforeCycle: beforeStart(f.filledOn, cycle) }
}

export function cashView(m: VrCashMoveRow, cycle: VrCycleRow | null): VrCashView {
  return { id: m.id, kind: m.kind, amountCents: m.amountCents, movedOn: m.movedOn, note: m.note, cycleId: m.cycleId, createdAt: m.createdAt, beforeCycle: beforeStart(m.movedOn, cycle) }
}

function booksOf(i: VrViewInput, fills: VrFill[]): VrBooksView {
  const b = vrBooks(fills, i.moves)
  const evalC = i.lastClose === null ? null : evalCents(b.shares, i.lastClose.close)
  const valueC = evalC === null ? null : evalC + b.poolCents
  return {
    shares: b.shares, poolCents: b.poolCents, netInvestedCents: b.netInvestedCents, avgCost: avgCost(b),
    evalCents: evalC, valueCents: valueC, profitCents: valueC === null ? null : valueC - b.netInvestedCents,
  }
}

export function ladderOf(cycle: VrCycleRow | null, shares: number, fills: VrFill[]): VrLadder {
  if (cycle === null || cycle.openShares === 0 || shares === 0) return { buy: [], sell: [], buyTotal: 0, sellTotal: 0 }
  const buyAll = buyRungs({ minCents: cycle.bandMinCents, openShares: cycle.openShares, lot: cycle.buyLot, budgetCents: cycle.buyBudgetCents, poolCents: cycle.openPoolCents })
  const sellAll = sellRungs({ maxCents: cycle.bandMaxCents, openShares: cycle.openShares, lot: cycle.sellLot })
  return {
    buy: remainingRungs(buyAll, sharesInCycle(fills, cycle.startDate, 'buy')),
    sell: remainingRungs(sellAll, sharesInCycle(fills, cycle.startDate, 'sell')),
    buyTotal: buyAll.length,
    sellTotal: sellAll.length,
  }
}

export function buildVrDetail(i: VrViewInput & { today: ISODate }): VrRunDetail {
  const fills = i.fills.map(toEngineFill)
  const books = booksOf(i, fills)
  const target = i.cycle?.vCents ?? i.run.initialVCents
  return {
    run: runView(i.run),
    today: i.today,
    lastClose: i.lastClose,
    books,
    cycle: i.cycle === null ? null : cycleView(i.cycle),
    budgetLeftCents: i.cycle === null ? null : Math.max(0, i.cycle.buyBudgetCents - spentInCycleCents(fills, i.cycle.startDate)),
    buyInstruction: books.shares === 0 && i.lastClose !== null ? { shares: buyInstructionShares(target, i.lastClose.close), targetCents: target } : null,
    ladder: ladderOf(i.cycle, books.shares, fills),
  }
}

export function buildVrSummary(i: VrViewInput): VrRunSummary {
  const books = booksOf(i, i.fills.map(toEngineFill))
  return { ...runView(i.run), shares: books.shares, poolCents: books.poolCents, vCents: i.cycle?.vCents ?? null, valueCents: books.valueCents }
}
