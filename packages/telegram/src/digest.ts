import { formatUsd } from '@st/core'
import type { Run, DayPlan, DayContext, PlannedOrder } from '@st/core'
import { dayInfo, type DayInfo } from '@st/calendar'
import type { Lang } from './i18n'
import { t } from './i18n'

export type { Lang }

export function renderDigest(run: Run, plan: DayPlan, ctx: DayContext, lang: Lang, ages?: Record<number, number>): string[] {
  const lines: string[] = []
  lines.push(t('header', lang, { name: run.name, ticker: run.ticker }))
  lines.push(t('trade-date', lang, { date: ctx.tradeDate, price: formatUsd(ctx.lastClose), lastDate: ctx.lastCloseDate }))
  for (const o of plan.orders.filter((x) => x.kind === 'buy_loc')) {
    lines.push(buyLine(o, lang))
  }
  const sellLocs = plan.orders.filter((x) => x.kind === 'sell_loc').sort((a, b) => a.bucketIndex - b.bucketIndex)
  for (const o of sellLocs) lines.push(sellLocLine(o, lang, ages))
  const marketSells = plan.orders.filter((x) => x.kind === 'market_sell').sort((a, b) => a.bucketIndex - b.bucketIndex)
  for (const o of marketSells) lines.push(marketSellLine(o, lang, ages))
  const consumedNotices = new Set<number>()
  for (const o of plan.skips) {
    const idx = plan.notices.findIndex((n, i) => !consumedNotices.has(i) && n.params?.bucket === o.bucketIndex)
    let reason = ''
    if (idx >= 0) {
      consumedNotices.add(idx)
      const n = plan.notices[idx]
      reason = t(n.code, lang, n.params)
    }
    lines.push(`${t('skip', lang)}  ${o.kind}  bucket ${o.bucketIndex}  ${reason}`.trim())
  }
  plan.notices.forEach((n, i) => {
    if (consumedNotices.has(i)) return
    lines.push(t(n.code, lang, n.params))
  })

  const chunks: string[] = []
  let cur = ''
  for (const l of lines) {
    const add = cur ? cur + '\n' + l : l
    if (add.length > 4000) {
      if (cur) chunks.push(cur)
      cur = l
    } else {
      cur = add
    }
  }
  if (cur) chunks.push(cur)
  return chunks.length ? chunks : ['']
}

function buyLine(o: PlannedOrder, lang: Lang): string {
  const verb = lang === 'ko' ? '매수' : 'Buy'
  return `${verb}  LOC  ${o.shares} sh  @ ${formatUsd(o.limitPrice)}  → bucket ${o.bucketIndex}`
}

function orderAge(o: PlannedOrder, ages?: Record<number, number>): number | undefined {
  return o.ageDays ?? ages?.[o.bucketIndex]
}

function sellLocLine(o: PlannedOrder, lang: Lang, ages?: Record<number, number>): string {
  const verb = lang === 'ko' ? '매도' : 'Sell'
  const age = orderAge(o, ages)
  const ageClause = age !== undefined ? `  (${t('age', lang, { n: age })})` : ''
  return `${verb}  LOC  ${o.shares} sh  @ ${formatUsd(o.limitPrice)}  → bucket ${o.bucketIndex}${ageClause}`
}

function marketSellLine(o: PlannedOrder, lang: Lang, ages?: Record<number, number>): string {
  const age = orderAge(o, ages)
  const ageClause = age !== undefined ? `  (${t('age-forced', lang, { n: age })})` : ''
  if (lang === 'ko') {
    return `매도  MARKET  ${o.shares} sh  bucket ${o.bucketIndex}${ageClause}`
  }
  return `Market  SELL  ${o.shares} sh  bucket ${o.bucketIndex}${ageClause}`
}

export function renderClosed(day: DayInfo, lang: Lang): string {
  const name = day.holidayName ? (lang === 'ko' ? day.holidayName.ko : day.holidayName.en) : null
  if (name) return t('closed-named', lang, { name })
  return t('closed', lang)
}

export function renderReminder(lang: Lang): string {
  return t('reminder', lang)
}
