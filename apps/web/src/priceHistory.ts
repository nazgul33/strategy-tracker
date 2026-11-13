// History-window math for the Run-detail price chart: the chart always starts
// one *trading* day before the first buy, so the dip the entry chased is
// visible. Pure date strings (ET dates); the server-side fetch anchors on it too.
import { prevTradingDay } from '@st/calendar';

export interface HistoryWindow {
  from: string;
  to: string;
  /** first day of the chart (first buy minus one trading day), null before any fills */
  start: string | null;
}

const FALLBACK_DAYS = 30;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * `today` is the ET trade date; the fetch ends at the previous trading day —
 * today's bar is not settled yet (the live quote is shown separately).
 */
export function computeHistoryWindow(buyDates: string[], today: string): HistoryWindow {
  const to = prevTradingDay(today);
  const buys = buyDates.filter((d) => d < to).sort();
  if (buys.length === 0) {
    const start = addDays(to, -FALLBACK_DAYS);
    return { from: start, to, start: null };
  }
  const start = prevTradingDay(buys[0]);
  return { from: start, to, start };
}
