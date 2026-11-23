import type { OrderRow, SellAttribution } from './sell-match'

export interface BookingNotifier {
  siblingCancelled(runId: number, order: OrderRow): Promise<void>
  sellAttributed(runId: number, attribution: SellAttribution): Promise<void>
  buyRemoved(runId: number, order: OrderRow): Promise<void>
}

export interface BookedOutcome { cancelledIds: number[]; attribution: SellAttribution | null; orphanedIds?: number[] }

// Tells the operator what a change to the fills needs from them, in this order:
// that a sell fill was attributed among several admissible orders, which cancelled
// orders still need pulling at the broker, and which orders lost their buy.
// Called after a booking, an edit, a correction or a delete committed and the run
// lock was released, so nothing here may fail or undo it: every error is logged
// and swallowed, per notification, so one bad notification does not hide the next.
export async function notifyBookingOutcome(
  runId: number,
  outcome: BookedOutcome,
  deps: { repos: { orderRepo: { get(id: number): Promise<OrderRow | null> } }; notify: BookingNotifier },
): Promise<void> {
  if (outcome.attribution) {
    try {
      await deps.notify.sellAttributed(runId, outcome.attribution)
    } catch (e) {
      console.error('booking notification failed:', runId, 'sell-attributed', String(e))
    }
  }
  for (const id of outcome.cancelledIds) {
    try {
      const order = await deps.repos.orderRepo.get(id)
      if (order) await deps.notify.siblingCancelled(runId, order)
    } catch (e) {
      console.error('booking notification failed:', runId, 'sibling-cancelled', id, String(e))
    }
  }
  for (const id of outcome.orphanedIds ?? []) {
    try {
      const order = await deps.repos.orderRepo.get(id)
      if (order) await deps.notify.buyRemoved(runId, order)
    } catch (e) {
      console.error('booking notification failed:', runId, 'buy-removed', id, String(e))
    }
  }
}
