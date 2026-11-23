import type { OHLCBar } from '@st/market-data'
import { parseUsd } from '@st/core/money'

export const bars: OHLCBar[] = [
  { date: '2026-11-01', open: 3500000n, high: 3550000n, low: 3450000n, close: 3500000n },
  { date: '2026-11-02', open: 3400000n, high: 3450000n, low: 3350000n, close: 3400000n },
  { date: '2026-11-03', open: 3450000n, high: 3500000n, low: 3400000n, close: 3450000n },
]

// seed close 100.00 → buyGapPpm 10_000 buys at 99.00 (fills: day2 low 95 < 99);
// sellGapPpm 20_000 sells at floorCents(99.00 × 1.02) = 100.98 (fills: day3 high 101)
export const gapBars: OHLCBar[] = [
  { date: '2026-12-01', open: parseUsd('100'), high: parseUsd('100'), low: parseUsd('100'), close: parseUsd('100') },
  { date: '2026-12-02', open: parseUsd('99.5'), high: parseUsd('99.5'), low: parseUsd('95'), close: parseUsd('90') },
  { date: '2026-12-03', open: parseUsd('100'), high: parseUsd('101'), low: parseUsd('99'), close: parseUsd('100.5') },
]

export function makeRun(over?: Partial<{ poolCents: number; cutLossPpm: number }>): any {
  return { id: 0, name: 'sim', ticker: 'TSLA', strategyKey: 'mean-reversion', costPpm: 30, buyGapPpm: 0, sellGapPpm: 0, cutLossPpm: 0, poolCents: 1000000, status: 'active', ...over }
}
