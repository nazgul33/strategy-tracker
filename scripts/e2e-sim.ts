/** Deterministic-sim step of the operator e2e: fixture bars through the pure simulator and the persisted run. */
import { runSim, simulateDays } from '../apps/server/src/sim/sim'
import type { ISODate } from '../packages/calendar/src/index'
import { DEFAULT_MR_PARAMS } from '../packages/strategies/src/mean-reversion'
import type { OHLCBar } from '../packages/market-data/src/yahoo'
import { parseUsd } from '../packages/core/src/money'
import type { E2eCtx } from './e2e-ctx'

// deterministic sim bars (myriadths via parseUsd); 4 bars → 3 sim days
const BAR_FIXTURE: [ISODate, string, string, string, string][] = [
  ['2026-11-06', '340.22', '346.83', '339.23', '346.38'],
  ['2026-11-09', '342.00', '352.83', '337.08', '350.00'],
  ['2026-11-10', '348.00', '355.40', '345.10', '351.20'],
  ['2026-11-12', '349.00', '358.90', '348.50', '355.00'],
]
const BARS: OHLCBar[] = BAR_FIXTURE.map(([date, o, h, l, c]) => ({
  date, open: parseUsd(o), high: parseUsd(h), low: parseUsd(l), close: parseUsd(c),
}))

export async function checkDeterministicSim(c: Pick<E2eCtx, 'ok'>, simRepo: Parameters<typeof runSim>[1]['repos']): Promise<void> {
  const ok = c.ok
  const simRun = { id: 0, name: 'E2E Sim', ticker: 'NVDA', strategyKey: 'mean-reversion' as const, costPpm: 1_000, buyGapPpm: 0, sellGapPpm: 0, cutLossPpm: 0, poolCents: 1_000_000, status: 'active' as const }
  const days = simulateDays(simRun, DEFAULT_MR_PARAMS, BARS)
  ok(days.map((d) => d.date).join(',') === '2026-11-09,2026-11-10,2026-11-12', '3 sim days from 4 bars')
  ok(days[0]!.fills.length === 1 && days[0]!.fills[0]!.side === 'buy' && days[0]!.fills[0]!.bucketIndex === 0 &&
    days[0]!.fills[0]!.shares === 2 && days[0]!.fills[0]!.price === 3420000n && days[0]!.fills[0]!.feeCents === 68,
    'day1: buy 2 sh @ 342.00 fee 68c')
  ok(days[1]!.fills.length === 2 && days[1]!.cashCents === 931_392, 'day2: sell bucket 0 + buy bucket 1, cash 931392')
  const lastDay = days[2]!
  ok(lastDay.fills.length === 3 && lastDay.fills[2]!.side === 'sell' && lastDay.fills[2]!.price === 3490000n,
    'day3: forced exit liquidates held bucket at last open 349.00 (market sells fill LOO)')
  ok(lastDay.heldCount === 0 && lastDay.cashCents === 1_000_982, 'sim ends flat with cash 1000982')
  const simSaved = await runSim(
    { ticker: 'NVDA', from: '2026-11-06', to: '2026-11-12', poolCents: 1_000_000, costPpm: 1_000 },
    { fetchDailyBars: async () => BARS, repos: simRepo },
  )
  ok(simSaved.id >= 1 && simSaved.dayCount === 3, 'runSim persists sim run + 3 day rows')
}
