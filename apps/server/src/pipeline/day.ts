import { dayInfo, prevTradingDay, type ISODate } from '@st/calendar'
import { advanceDay, type RunState, type Run } from '@st/core'
import { computeOrders, type MrParams } from '@st/strategies'
import { rollStale, type RepoSurface, type BookingDeps } from '../domain/booking'
import { renderDigest, renderClosed, renderReminder } from '@st/telegram/digest'
import { t } from '@st/telegram/i18n'
import type { DayPlan } from '@st/core'

export interface DayDeps {
  today: () => ISODate
  fetchLastClose: (ticker: string) => Promise<{ date: ISODate; close: bigint }>
  crossCheck: (date: ISODate) => Promise<{ agree: boolean; remoteOpen?: boolean; error?: string }>
  send: (chatId: string, text: string) => Promise<void>
  allowedChatIds: string[]
  repos: RepoSurface
  params: (run: any) => MrParams
  digestLang: 'en' | 'ko'
}

export type MorningResult = 'weekend' | 'closed' | 'conflict' | 'data-error' | 'sent'

function weekday(t: ISODate): number {
  return new Date(t + 'T12:00:00Z').getUTCDay()
}

export async function runMorningPipeline(deps: DayDeps): Promise<MorningResult> {
  const today = deps.today()
  const lang = deps.digestLang

  // weekend guard (today() injectable)
  if (weekday(today) === 0 || weekday(today) === 6) {
    return 'weekend'
  }

  const info = dayInfo(today)
  if (!info.open) {
    const text = renderClosed(info, lang)
    for (const chatId of deps.allowedChatIds) {
      await deps.send(chatId, text)
      await deps.repos.notificationRepo.insert({ runId: null, chatId, text })
    }
    return 'closed'
  }

  // crosscheck
  const cc = await deps.crossCheck(today)
  if (cc.agree === false) {
    const text = t('warn-conflict', lang)
    for (const chatId of deps.allowedChatIds) {
      await deps.send(chatId, text)
      await deps.repos.notificationRepo.insert({ runId: null, chatId, text })
    }
    return 'conflict'
  }

  // stale roll from last trading day: orders dated before today roll up
  const stale = await rollStale(today, { repos: deps.repos, today } as BookingDeps)

  const runs = (await deps.repos.runRepo.list()) as any[]
  const active = runs.filter((r) => r.status === 'active')

  for (const run of active) {
    // fetch + sanity close
    let close: bigint
    let closeDate: ISODate
    try {
      const res = await deps.fetchLastClose(run.ticker)
      close = res.close
      closeDate = res.date
    } catch (e) {
      const text = t('warn-data-error', lang)
      for (const chatId of deps.allowedChatIds) {
        await deps.send(chatId, text)
        await deps.repos.notificationRepo.insert({ runId: null, chatId, text })
      }
      return 'data-error'
    }
    const prevTd = prevTradingDay(today)
    if (closeDate !== prevTd) {
      const text = t('warn-data-error', lang)
      for (const chatId of deps.allowedChatIds) {
        await deps.send(chatId, text)
        await deps.repos.notificationRepo.insert({ runId: null, chatId, text })
      }
      return 'data-error'
    }

    const state0 = await deps.repos.bucketRepo.loadState(run.id)
    const state = advanceDay(state0)
    const plan: DayPlan = computeOrders(run as Run, state, { lastClose: close }, deps.params(run))

    // unconfirmed stale linkage: date = oldest stale entry's tradeDate
    const staleEntries = stale[run.id]
    if (staleEntries && staleEntries.length > 0) {
      const oldest = staleEntries.reduce((min: string, e: any) => (e.tradeDate < min ? e.tradeDate : min), staleEntries[0].tradeDate)
      plan.notices.push({ code: 'unconfirmed', params: { count: staleEntries.length, date: oldest } })
    }

    // persist orders
    const rows = plan.orders.map((o) => ({
      runId: run.id,
      tradeDate: today,
      kind: o.kind,
      bucketIdx: o.bucketIndex,
      limitPrice: o.limitPrice,
      shares: o.shares,
      status: 'open',
    }))
    await deps.repos.orderRepo.insertMany(rows)

    await deps.repos.bucketRepo.saveState(run.id, state)

    const ctx = { tradeDate: today, lastClose: close, lastCloseDate: closeDate }
    const chunks = renderDigest(run as Run, plan, ctx, lang, state.ages)
    for (const chunk of chunks) {
      for (const chatId of deps.allowedChatIds) {
        await deps.send(chatId, chunk)
        await deps.repos.notificationRepo.insert({ runId: run.id, chatId, text: chunk })
      }
    }
  }

  return 'sent'
}

export async function runReminder(deps: DayDeps): Promise<void> {
  const today = deps.today()
  const info = dayInfo(today)
  if (!info.open) return
  const lang = deps.digestLang
  const text = renderReminder(lang)
  for (const chatId of deps.allowedChatIds) {
    await deps.send(chatId, text)
    await deps.repos.notificationRepo.insert({ runId: null, chatId, text })
  }
}
