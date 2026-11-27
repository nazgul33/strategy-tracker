import { prevTradingDay, type ISODate } from '@st/calendar'
import { t } from '@st/telegram/i18n'
import type { DayDeps } from './day'
import { notifyDay } from './notify'

export interface CheckedClose { close: bigint; closeDate: ISODate }

/**
 * The last close of a ticker once it passed the freshness check and was stored, or null when it is missing or dated other
 * than `expected` (the previous trading day by default).
 * Says nothing to the owner: the caller decides what a missing close means for its strategy.
 */
export async function fetchClose(
  deps: DayDeps,
  ticker: string,
  today: ISODate,
  expected: ISODate = prevTradingDay(today),
): Promise<CheckedClose | null> {
  // fetch + sanity close
  let close: bigint
  let closeDate: ISODate
  try {
    const res = await deps.fetchLastClose(ticker)
    close = res.close
    closeDate = res.date
  } catch (e) {
    console.error('last close fetch failed:', ticker, String(e))
    return null
  }
  if (closeDate !== expected) return null

  // collect history once the close passed the sanity check above; a failed
  // backfill must not break the digest (fire-and-warn). Independent of run
  // state, so it stays outside the run lock.
  if (deps.persistClose) {
    try {
      await deps.persistClose(ticker, closeDate, close)
    } catch (e) {
      console.error('price history persist failed:', ticker, String(e))
    }
  }
  return { close, closeDate }
}

/** The last close of a mean-reversion run's ticker, or null after the data-error warning went out (the run counts as failed). */
export async function fetchCheckedClose(
  deps: DayDeps,
  run: { id: number; ticker: string },
  today: ISODate,
): Promise<CheckedClose | null> {
  const checked = await fetchClose(deps, run.ticker, today)
  if (!checked) await notifyDay(deps, run.id, t('warn-data-error', deps.digestLang, { id: run.id, ticker: run.ticker }), 'data-error')
  return checked
}
