import { prevTradingDay, type ISODate } from '@st/calendar'
import { t } from '@st/telegram/i18n'
import type { DayDeps } from './day'
import { notifyDay } from './notify'

/** The last close of a run's ticker, or null after the data-error warning went out (the run counts as failed). */
export async function fetchCheckedClose(
  deps: DayDeps,
  run: { id: number; ticker: string },
  today: ISODate,
): Promise<{ close: bigint; closeDate: ISODate } | null> {
  const warnDataError = () => notifyDay(deps, run.id, t('warn-data-error', deps.digestLang, { id: run.id, ticker: run.ticker }), 'data-error')

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
    return null
  }
  if (closeDate !== prevTradingDay(today)) {
    await warnDataError()
    return null
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
  return { close, closeDate }
}
