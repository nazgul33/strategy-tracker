import { formatUsd } from '@st/core'
import { t, type Lang } from './i18n'

export interface VrRungView { shares: number; price: bigint }
export interface VrCycleView {
  runId: number; name: string; ticker: string; seq: number; startDate: string; endDate: string
  lastClose: bigint; lastCloseDate: string
  vCents: number; bandMinCents: number; bandMaxCents: number; shares: number; poolCents: number; budgetCents: number
  depositCents: number; vKept: boolean
  buy: VrRungView[]; sell: VrRungView[]
  /** Set instead of a ladder when the run holds no shares. */
  instruction: { shares: number; targetCents: number } | null
}
export interface VrBuyView { runId: number; name: string; ticker: string; shares: number; targetCents: number; lastClose: bigint; lastCloseDate: string }
export interface VrStatusView { runId: number; ticker: string; shares: number; poolCents: number; vCents: number | null; bandMinCents: number | null; bandMaxCents: number | null }
export interface VrOrdersView { runId: number; ticker: string; buy: VrRungView[]; sell: VrRungView[] }

const MAX_CHUNK = 4000
const PRICES_PER_ROW = 5

// Amounts reach the catalog already formatted, so a negative Pool reads -$12.34.
const usd = (cents: number): string => (cents < 0 ? '-$' : '$') + formatUsd(BigInt(Math.abs(cents)) * 100n)
const px = (price: bigint): string => '$' + formatUsd(price)

function side(rungs: VrRungView[], which: 'buy' | 'sell', lang: Lang, whenEmpty: boolean): string[] {
  if (rungs.length === 0) return whenEmpty ? [t(`vr-side-${which}-none`, lang)] : []
  const count = rungs.length
  if (rungs.every((r) => r.shares === rungs[0]!.shares)) {
    const lines = [t(`vr-side-${which}`, lang, { count, shares: rungs[0]!.shares })]
    for (let i = 0; i < count; i += PRICES_PER_ROW) lines.push(rungs.slice(i, i + PRICES_PER_ROW).map((r) => px(r.price)).join('  '))
    return lines
  }
  return [t(`vr-side-${which}-mixed`, lang, { count }), ...rungs.map((r) => t('vr-rung', lang, { shares: r.shares, price: px(r.price) }))]
}

function chunk(lines: string[]): string[] {
  const chunks: string[] = []
  let cur = ''
  for (const l of lines) {
    const add = cur ? cur + '\n' + l : l
    if (add.length > MAX_CHUNK) {
      if (cur) chunks.push(cur)
      cur = l
    } else {
      cur = add
    }
  }
  if (cur) chunks.push(cur)
  return chunks.length ? chunks : ['']
}

const buyLine = (shares: number, targetCents: number, lastClose: bigint, lang: Lang) =>
  shares > 0 ? t('vr-buy-line', lang, { shares, target: usd(targetCents) }) : t('vr-buy-small', lang, { target: usd(targetCents), price: px(lastClose) })
const lastCloseLine = (price: bigint, date: string, lang: Lang) => t('vr-last-close', lang, { price: px(price), date })
const targetLine = (v: number, min: number, max: number, lang: Lang) => t('vr-target', lang, { v: usd(v), min: usd(min), max: usd(max) })

export function renderVrCycle(v: VrCycleView, lang: Lang): string[] {
  const lines = [
    t('vr-cycle-head', lang, { name: v.name, ticker: v.ticker, seq: v.seq, start: v.startDate, end: v.endDate }),
    lastCloseLine(v.lastClose, v.lastCloseDate, lang),
    targetLine(v.vCents, v.bandMinCents, v.bandMaxCents, lang),
    t('vr-books', lang, { shares: v.shares, pool: usd(v.poolCents), budget: usd(v.budgetCents) }),
  ]
  if (v.depositCents !== 0) lines.push(t(v.depositCents > 0 ? 'vr-deposit' : 'vr-withdraw', lang, { amount: usd(Math.abs(v.depositCents)) }))
  if (v.vKept) lines.push(t('vr-v-kept', lang))
  if (v.instruction) lines.push(t('vr-no-ladder', lang), buyLine(v.instruction.shares, v.instruction.targetCents, v.lastClose, lang))
  else lines.push(...side(v.buy, 'buy', lang, true), ...side(v.sell, 'sell', lang, true))
  return chunk(lines)
}

export function renderVrBuyInstruction(v: VrBuyView, lang: Lang): string {
  return [
    t('vr-buy-head', lang, { name: v.name, ticker: v.ticker }),
    lastCloseLine(v.lastClose, v.lastCloseDate, lang),
    buyLine(v.shares, v.targetCents, v.lastClose, lang),
  ].join('\n')
}

export function renderVrStatus(v: VrStatusView, lang: Lang): string {
  const hasCycle = v.vCents !== null && v.bandMinCents !== null && v.bandMaxCents !== null
  return [
    t('vr-run-line', lang, { id: v.runId, ticker: v.ticker }),
    t('vr-holdings', lang, { shares: v.shares, pool: usd(v.poolCents) }),
    hasCycle ? targetLine(v.vCents!, v.bandMinCents!, v.bandMaxCents!, lang) : t('vr-no-cycle', lang),
  ].join('\n')
}

export function renderVrOrders(v: VrOrdersView, lang: Lang): string {
  return [t('vr-run-line', lang, { id: v.runId, ticker: v.ticker }), ...side(v.buy, 'buy', lang, false), ...side(v.sell, 'sell', lang, false)].join('\n')
}
