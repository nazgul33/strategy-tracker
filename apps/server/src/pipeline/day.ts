import { dayInfo, prevTradingDay, type ISODate } from '@st/calendar'
import { advanceDay, type RunState, type Run } from '@st/core'
import { computeOrders, type MrParams } from '@st/strategies'
import { rollStale, type BookingDeps } from '../domain/booking'
import type { DayRepoSurface, NewOrder, OrderRecord, RunRow } from '../domain/repo-types'
import { withRunLock } from '../domain/run-lock'
import { broadcastNotice, type NoticeText } from '../wire/broadcast'
import { renderDigest, renderClosed, renderReminder } from '@st/telegram/digest'
import { t } from '@st/telegram/i18n'
import type { DayPlan } from '@st/core'

export interface DayDeps {
  today: () => ISODate
  fetchLastClose: (ticker: string) => Promise<{ date: ISODate; close: bigint }>
  crossCheck: (date: ISODate) => Promise<{ agree: boolean; remoteOpen?: boolean; error?: string }>
  send: (chatId: string, text: string) => Promise<void>
  allowedChatIds: string[]
  repos: DayRepoSurface
  params: (run: RunRow) => MrParams
  digestLang: 'en' | 'ko'
  /** optional: store the sanity-checked close for the price history chart */
  persistClose?: (ticker: string, tradeDate: ISODate, close: bigint) => Promise<void>
}

export type MorningResult = 'weekend' | 'closed' | 'conflict' | 'data-error' | 'sent'

function weekday(t: ISODate): number {
  return new Date(t + 'T12:00:00Z').getUTCDay()
}

function notify(deps: DayDeps, runId: number | null, text: NoticeText, kind: string): Promise<{ failed: number }> {
  return broadcastNotice(
    { allowedChatIds: deps.allowedChatIds, send: deps.send, notificationRepo: deps.repos.notificationRepo },
    runId, text, { kind },
  )
}

type StaleRoll = Awaited<ReturnType<typeof rollStale>>
type RunOutcome = 'completed' | 'failed'

export async function runMorningPipeline(deps: DayDeps): Promise<MorningResult> {
  try {
    return await morningPipeline(deps)
  } catch (e) {
    console.error('morning pipeline failed:', String(e))
    await notify(deps, null, t('warn-pipeline-error', deps.digestLang), 'pipeline-error')
    throw e
  }
}

async function morningPipeline(deps: DayDeps): Promise<MorningResult> {
  const today = deps.today()
  const lang = deps.digestLang

  // weekend guard (today() injectable)
  if (weekday(today) === 0 || weekday(today) === 6) {
    return 'weekend'
  }

  const info = dayInfo(today)
  if (!info.open) {
    await notify(deps, null, renderClosed(info, lang), 'closed')
    return 'closed'
  }

  // crosscheck
  const cc = await deps.crossCheck(today)
  if (cc.agree === false) {
    await notify(deps, null, t('warn-conflict', lang), 'conflict')
    return 'conflict'
  }

  // stale roll from last trading day: orders dated before today roll up. A failure
  // is logged and the morning carries on without that part of each run's "unconfirmed"
  // line; the part read from stored orders at plan time does not depend on this roll.
  let stale: StaleRoll = {}
  try {
    stale = await rollStale(today, { repos: deps.repos, today } as BookingDeps)
  } catch (e) {
    console.error('stale roll failed:', String(e))
  }

  const runs = await deps.repos.runRepo.list()
  const active = runs.filter((r) => r.status === 'active')

  let numFailed = 0
  let numCompleted = 0
  for (const run of active) {
    if ((await processRun(deps, run, today, stale)) === 'completed') numCompleted++
    else numFailed++
  }

  return numFailed > 0 && numCompleted === 0 ? 'data-error' : 'sent'
}

// One run never takes the others down: any throw is logged and warned about here.
async function processRun(deps: DayDeps, run: RunRow, today: ISODate, stale: StaleRoll): Promise<RunOutcome> {
  try {
    return await planRun(deps, run, today, stale)
  } catch (e) {
    console.error('morning run failed:', { runId: run.id, ticker: run.ticker }, String(e))
    await notify(deps, run.id, t('warn-run-error', deps.digestLang, { id: run.id, ticker: run.ticker }), 'run-error')
    return 'failed'
  }
}

// A run with orders dated today is already planned: skip it and say so. It has its
// orders, so it counts as completed.
async function skipPlanned(deps: DayDeps, run: RunRow): Promise<RunOutcome> {
  console.log('morning run skipped, already planned today:', { runId: run.id, ticker: run.ticker })
  await notify(deps, run.id, t('run-already-planned', deps.digestLang, { id: run.id, ticker: run.ticker }), 'already-planned')
  return 'completed'
}

// Orders this run reports as unconfirmed: what this morning's roll just flipped for it
// (covers a missed roll on an earlier morning), plus its stale orders from its most
// recent order date before today (a retry, or a failed roll, flips nothing now but the
// orders are stored). De-duplicated by id. Older stale orders were normally reported on
// an earlier morning (a day whose digest was never sent is reported again the next morning).
async function unconfirmedOrders(deps: DayDeps, runId: number, today: ISODate, rolled: OrderRecord[]): Promise<OrderRecord[]> {
  const past = (await deps.repos.orderRepo.listForRun(runId)).filter((o) => o.tradeDate < today)
  const last = past.reduce((max, o) => (o.tradeDate > max ? o.tradeDate : max), '')
  const byId = new Map<number, OrderRecord>()
  for (const o of [...rolled, ...past.filter((o) => o.tradeDate === last && o.status === 'stale')]) byId.set(o.id, o)
  return [...byId.values()]
}

async function planRun(deps: DayDeps, run: RunRow, today: ISODate, stale: StaleRoll): Promise<RunOutcome> {
  const lang = deps.digestLang
  const hasOrdersToday = async () => (await deps.repos.orderRepo.listForRun(run.id, today)).length > 0
  const warnDataError = () => notify(deps, run.id, t('warn-data-error', lang, { id: run.id, ticker: run.ticker }), 'data-error')

  // A run with no order today has nothing to age: computeOrders emits an order for every
  // held / force_sell bucket and advanceDay ages only those, so re-planning cannot age twice.
  if (await hasOrdersToday()) return skipPlanned(deps, run)

  // fetch + sanity close
  let close: bigint
  let closeDate: ISODate
  try {
    const res = await deps.fetchLastClose(run.ticker)
    close = res.close
    closeDate = res.date
  } catch (e) {
    console.error('last close fetch failed:', run.ticker, String(e))
    await warnDataError()
    return 'failed'
  }
  if (closeDate !== prevTradingDay(today)) {
    await warnDataError()
    return 'failed'
  }

  // collect history once the close passed the sanity check above; a failed
  // backfill must not break the digest (fire-and-warn). Independent of run
  // state, so it stays outside the run lock.
  if (deps.persistClose) {
    try {
      await deps.persistClose(run.ticker, closeDate, close)
    } catch (e) {
      console.error('price history persist failed:', run.ticker, String(e))
    }
  }

  // The check → load → advance → write span must not interleave with a booking,
  // a recalc or a second pipeline on this run, or its write would be overwritten
  // by the stale aged state (or age the run twice). Nothing inside calls another
  // locked function (the lock is not reentrant).
  const planned = await withRunLock(run.id, async () => {
    if (await hasOrdersToday()) return null
    const state0 = await deps.repos.bucketRepo.loadState(run.id)
    const mrParams = deps.params(run)
    const state = advanceDay(state0, mrParams.maxAgeDays)
    const plan: DayPlan = computeOrders(run as Run, state, { lastClose: close }, mrParams)

    const unconfirmed = await unconfirmedOrders(deps, run.id, today, stale[run.id] ?? [])
    if (unconfirmed.length > 0) {
      const oldest = unconfirmed.reduce((min, o) => (o.tradeDate < min ? o.tradeDate : min), unconfirmed[0]!.tradeDate)
      plan.notices.push({ code: 'unconfirmed', params: { count: unconfirmed.length, date: oldest } })
    }

    const rows = plan.orders.map((o): NewOrder => ({
      runId: run.id,
      tradeDate: today,
      kind: o.kind,
      bucketIdx: o.bucketIndex,
      limitPrice: o.limitPrice,
      shares: o.shares,
      status: 'open',
    }))
    // orders and state in one transaction: both are written or neither is
    await deps.repos.bucketRepo.saveStateWithOrders(run.id, state, rows)
    return { state, plan }
  })
  if (!planned) return skipPlanned(deps, run)

  const ctx = { tradeDate: today, lastClose: close, lastCloseDate: closeDate }
  const chunks = renderDigest(run as Run, planned.plan, ctx, lang, planned.state.ages)
  await notify(deps, run.id, { record: chunks.join('\n\n'), send: chunks }, 'digest')
  return 'completed'
}

export async function runReminder(deps: DayDeps): Promise<{ failed: number }> {
  const today = deps.today()
  const info = dayInfo(today)
  if (!info.open) return { failed: 0 }
  return notify(deps, null, renderReminder(deps.digestLang), 'reminder')
}

export async function runDecemberNudge(deps: DayDeps): Promise<{ failed: number }> {
  return notify(deps, null, t('december-nudge', deps.digestLang), 'december-nudge')
}
