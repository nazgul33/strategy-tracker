import type { ISODate } from '@st/core'
import type { BookingDeps } from './booking'
import type { OrderRecord } from './repo-types'

export function rollStale(tradeDate: ISODate, deps: BookingDeps): Promise<number> {
  return deps.repos.orderRepo.markStale(tradeDate)
}

export const CANCEL_REASONS = ['broker-filled', 'strategy-change', 'stale-price', 'other'] as const

export async function cancelOrder(runId: number, orderId: number, reason: string, deps: BookingDeps): Promise<OrderRecord & { cancelReason: string }> {
  if (!(CANCEL_REASONS as readonly string[]).includes(reason)) throw new Error('invalid-reason')
  const repos = deps.repos
  const order = await repos.orderRepo.get(orderId)
  if (!order || order.runId !== runId) throw new Error('order-not-found')
  if (order.status !== 'open') throw new Error('order-not-open')
  await repos.orderRepo.setStatus(orderId, 'cancelled', reason)
  return { ...order, status: 'cancelled', cancelReason: reason }
}
