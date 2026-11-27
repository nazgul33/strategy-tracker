import { dayInfo } from '@st/calendar'
import { etTime } from '../wire/deps'
import { fetchClose } from './close'
import { liveTickers } from './close-catchup'
import type { DayDeps } from './day'

export type EveningResult = { stored: number; behind: number } | 'closed' | 'too-early'

/** The earliest New York wall time the job stores anything: later than any close, half days included. */
export const EVENING_FROM = '16:30'

/**
 * Stores today's close for every ticker of an active or paused run of either strategy that has none for today yet.
 * Refuses to run on a day the market is closed and before 16:30 New York, so a bar of a session that is still open is
 * never stored; only a close dated today is stored. Silent: no message, no run lock, no change to any run or order.
 * Never throws; a ticker that could not be stored is logged and counted as behind. `stored` counts the tickers whose
 * close was fetched and handed to `persistClose`.
 */
export async function runEveningCloses(deps: DayDeps): Promise<EveningResult> {
  let stored = 0
  let behind = 0
  try {
    const today = deps.today()
    const time = etTime((deps.now ?? (() => new Date()))())
    if (!dayInfo(today).open) return 'closed'
    if (time < EVENING_FROM) return 'too-early'

    const latest = deps.latestStoredCloseDate
    if (!latest || !deps.persistClose) return { stored, behind }
    for (const ticker of await liveTickers(deps, 'evening closes')) {
      try {
        const have = await latest(ticker)
        if (have !== null && have >= today) continue
        if ((await fetchClose(deps, ticker, today, today)) === null) {
          behind++
          console.error('evening closes stored nothing:', ticker)
        } else {
          stored++
        }
      } catch (e) {
        behind++
        console.error('evening closes failed:', ticker, String(e))
      }
    }
  } catch (e) {
    console.error('evening closes failed:', String(e))
  }
  return { stored, behind }
}
