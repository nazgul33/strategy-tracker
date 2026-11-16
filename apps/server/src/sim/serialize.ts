import type { RunState } from '@st/core'
import type { SimDay } from './sim'

export interface SimDayBody {
  tradeDate: string
  planJson: string
  stateJson: string
  eventsJson: string
}

export function bigintReplacer(_k: string, v: any): any {
  return typeof v === 'bigint' ? v.toString() : v
}

export function serializeDays(days: SimDay[], states: RunState[]): SimDayBody[] {
  return days.map((d, idx) => ({
    tradeDate: d.date,
    planJson: JSON.stringify({ ...d.plan, orders: d.plan.orders.map((o) => ({ ...o, limitPrice: o.limitPrice.toString() })), skips: d.plan.skips.map((o) => ({ ...o, limitPrice: o.limitPrice.toString() })) }, bigintReplacer),
    stateJson: JSON.stringify(states[idx], bigintReplacer),
    eventsJson: JSON.stringify(d.events, bigintReplacer),
  }))
}
