import { prevTradingDay, type ISODate } from '@st/calendar'
import { fetchClose } from './close'
import type { DayDeps } from './day'

type Listed = { ticker: string; status: string }

async function counted(list: () => Promise<Listed[]>, kind: string): Promise<string[]> {
  try {
    return (await list()).filter((r) => r.status === 'active' || r.status === 'paused').map((r) => r.ticker)
  } catch (e) {
    console.error('close catch-up: run list failed:', kind, String(e))
    return []
  }
}

/**
 * Stores the last close of every ticker of an active or paused run whose newest stored close is older than
 * the previous trading day, so a paused run's value does not go stale. Silent: no message, no run lock, no
 * change to any run or order. Never throws; a failing ticker is logged and the next one is tried.
 */
export async function catchUpCloses(deps: DayDeps, today: ISODate): Promise<void> {
  const latest = deps.latestStoredCloseDate
  if (!latest || !deps.persistClose) return
  try {
    const prev = prevTradingDay(today)
    const mr = await counted(() => deps.repos.runRepo.list(), 'MR')
    const vr = await counted(() => deps.repos.vrRunRepo.list(), 'VR')
    for (const ticker of new Set([...mr, ...vr])) {
      try {
        const stored = await latest(ticker)
        if (stored !== null && stored >= prev) continue
        await fetchClose(deps, ticker, today)
      } catch (e) {
        console.error('close catch-up failed:', ticker, String(e))
      }
    }
  } catch (e) {
    console.error('close catch-up failed:', String(e))
  }
}
