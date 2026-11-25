import { roundDiv } from '@st/core/money'
import type { ISODate } from '@st/core'
import { addDays as calendarAddDays } from '@st/calendar'

export const VALUE_REBALANCING = 'value-rebalancing'
export const VR_CYCLE_DAYS = 14
export const VR_MAX_RUNGS = 30
export const VR_LADDER_COVER_PPM = 300_000

export type VrFormula = 'basic' | 'skill'
export interface VrSettings { g: number; formula: VrFormula; bandPpm: number; spendLimitPpm: number; cycleDepositCents: number }
export const DEFAULT_VR_SETTINGS: VrSettings = { g: 10, formula: 'skill', bandPpm: 150_000, spendLimitPpm: 500_000, cycleDepositCents: 0 }

export interface VrFill { side: 'buy' | 'sell'; shares: number; price: bigint; feeCents: number; filledOn: ISODate }
export type VrCashKind = 'open' | 'deposit' | 'withdraw' | 'adjust'
export interface VrCashMove { kind: VrCashKind; amountCents: number; movedOn: ISODate }
export interface VrBooks { shares: number; poolCents: number; buyCostCents: number; sellProceedsCents: number; feesCents: number; netInvestedCents: number }
export interface VrRung { shares: number; price: bigint }

const C = BigInt(VR_LADDER_COVER_PPM)
const M = 1_000_000n
const SCALE = 1_000_000_000n
const SPAN = BigInt(VR_MAX_RUNGS - 1)

function big(name: string, x: number): bigint {
  if (!Number.isSafeInteger(x)) throw new RangeError(`${name} must be a safe integer`)
  return BigInt(x)
}

function num(x: bigint): number {
  const lim = BigInt(Number.MAX_SAFE_INTEGER)
  if (x > lim || x < -lim) throw new RangeError('value is outside the safe integer range')
  return Number(x)
}

function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('isqrt of a negative number')
  if (n < 2n) return n
  let x = n
  let y = (x + 1n) / 2n
  while (y < x) {
    x = y
    y = (x + n / x) / 2n
  }
  return x
}

function ceilPos(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b
}

export function fillCostCents(f: Pick<VrFill, 'shares' | 'price'>): number {
  return num(roundDiv(f.price * big('shares', f.shares), 100n))
}

export function evalCents(shares: number, price: bigint): number {
  return fillCostCents({ shares, price })
}

export function vrBooks(fills: readonly VrFill[], moves: readonly VrCashMove[]): VrBooks {
  let shares = 0
  let buyCost = 0
  let sellProceeds = 0
  let fees = 0
  let sumMoves = 0
  let netInvested = 0
  for (const f of fills) {
    const cost = fillCostCents(f)
    if (f.side === 'buy') {
      shares += f.shares
      buyCost += cost
    } else {
      shares -= f.shares
      sellProceeds += cost
    }
    fees += f.feeCents
  }
  for (const m of moves) {
    sumMoves += m.amountCents
    if (m.kind !== 'adjust') netInvested += m.amountCents
  }
  const poolCents = sumMoves - buyCost - fees + sellProceeds
  for (const x of [shares, buyCost, sellProceeds, fees, poolCents, netInvested]) big('books', x)
  return { shares, poolCents, buyCostCents: buyCost, sellProceedsCents: sellProceeds, feesCents: fees, netInvestedCents: netInvested }
}

export function avgCost(books: VrBooks): bigint | null {
  if (books.shares <= 0) return null
  return roundDiv(big('net cost', books.buyCostCents - books.sellProceedsCents) * 100n, BigInt(books.shares))
}

export function nextV(i: { vCents: number; poolCents: number; evalCents: number; settings: VrSettings }): { vCents: number; kept: boolean } {
  const { g, formula, cycleDepositCents } = i.settings
  if (!Number.isSafeInteger(g) || g < 1) throw new RangeError('g must be a safe integer >= 1')
  const v = big('vCents', i.vCents)
  const gb = BigInt(g)
  let next = v + roundDiv(big('poolCents', i.poolCents), gb) + big('cycleDepositCents', cycleDepositCents)
  if (formula === 'skill') {
    next += roundDiv((big('evalCents', i.evalCents) - v) * SCALE, isqrt(4n * gb * SCALE * SCALE))
  }
  if (next <= 0n) return { vCents: i.vCents, kept: true }
  return { vCents: num(next), kept: false }
}

export function vrBand(vCents: number, bandPpm: number): { minCents: number; maxCents: number } {
  const v = big('vCents', vCents)
  const b = big('bandPpm', bandPpm)
  return { minCents: num(roundDiv(v * (M - b), M)), maxCents: num(roundDiv(v * (M + b), M)) }
}

export function buyBudgetCents(poolCents: number, spendLimitPpm: number): number {
  if (poolCents <= 0) return 0
  return num(roundDiv(big('poolCents', poolCents) * big('spendLimitPpm', spendLimitPpm), M))
}

export function spentInCycleCents(fills: readonly VrFill[], cycleStart: ISODate): number {
  let sum = 0
  for (const f of fills) if (f.side === 'buy' && f.filledOn >= cycleStart) sum += fillCostCents(f)
  return sum
}

export function sharesInCycle(fills: readonly VrFill[], cycleStart: ISODate, side: 'buy' | 'sell'): number {
  let sum = 0
  for (const f of fills) if (f.side === side && f.filledOn >= cycleStart) sum += f.shares
  return sum
}

export function buyLot(openShares: number): number {
  if (openShares <= 0) return 1
  return Math.max(1, num(ceilPos(big('openShares', openShares) * C, (M - C) * SPAN)))
}

export function sellLot(openShares: number): number {
  if (openShares <= 0) return 1
  return Math.max(1, num(ceilPos(big('openShares', openShares) * C, (M + C) * SPAN)))
}

export function buyRungs(i: { minCents: number; openShares: number; lot: number; budgetCents: number; poolCents: number }): VrRung[] {
  if (i.openShares < 1 || i.lot < 1) return []
  const n = big('openShares', i.openShares)
  const lot = big('lot', i.lot)
  const min = big('minCents', i.minCents)
  const cap = BigInt(Math.min(i.budgetCents, i.poolCents))
  const out: VrRung[] = []
  let total = 0n
  let first: bigint | null = null
  for (let k = 0; k < VR_MAX_RUNGS; k++) {
    const pc = min / (n + BigInt(k) * lot)
    if (pc <= 0n) break
    if (total + pc * lot > cap) break
    total += pc * lot
    first ??= pc
    out.push({ shares: i.lot, price: pc * 100n })
    if (pc * M <= first * (M - C)) break
  }
  return out
}

export function sellRungs(i: { maxCents: number; openShares: number; lot: number }): VrRung[] {
  if (i.openShares < 2 || i.lot < 1) return []
  const n = big('openShares', i.openShares)
  const lot = big('lot', i.lot)
  const max = big('maxCents', i.maxCents)
  if (max < 1n) return []
  const out: VrRung[] = []
  let first: bigint | null = null
  for (let k = 0; k < VR_MAX_RUNGS; k++) {
    const left = n - BigInt(k + 1) * lot
    if (left < 1n) break
    const pc = ceilPos(max, n - BigInt(k) * lot)
    first ??= pc
    out.push({ shares: i.lot, price: pc * 100n })
    if (pc * M >= first * (M + C)) break
  }
  return out
}

export function remainingRungs(rungs: readonly VrRung[], filledShares: number): VrRung[] {
  if (filledShares <= 0) return rungs.slice()
  let left = filledShares
  const out: VrRung[] = []
  for (const r of rungs) {
    if (left >= r.shares) left -= r.shares
    else if (left > 0) {
      out.push({ shares: r.shares - left, price: r.price })
      left = 0
    } else out.push(r)
  }
  return out
}

export function buyInstructionShares(targetCents: number, lastClose: bigint): number {
  if (lastClose <= 0n || targetCents <= 0) return 0
  return num((big('targetCents', targetCents) * 100n) / lastClose)
}

export function addDays(date: ISODate, days: number): ISODate {
  return calendarAddDays(date, days)
}

export function cycleDue(scheduledStart: ISODate, today: ISODate): boolean {
  return today >= addDays(scheduledStart, VR_CYCLE_DAYS)
}

export function nextScheduledStart(scheduledStart: ISODate, today: ISODate): ISODate {
  return today >= addDays(scheduledStart, 2 * VR_CYCLE_DAYS) ? today : addDays(scheduledStart, VR_CYCLE_DAYS)
}
