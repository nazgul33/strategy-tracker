import type { OrderRow } from './sell-match'

export interface SiblingNotifyDeps {
  repos: { orderRepo: { get(id: number): Promise<OrderRow | null> } }
  notifySiblingCancelled?: (runId: number, order: OrderRow) => Promise<void>
}

// Tells the operator which cancelled orders still need pulling at the broker.
// Called after the booking committed and the run lock was released, so nothing
// here may fail or undo it: every error is logged and swallowed, per order, so
// one bad notification does not hide the next. No ids, nothing sent.
export async function notifySiblingsCancelled(runId: number, cancelledIds: number[], deps: SiblingNotifyDeps): Promise<void> {
  const notify = deps.notifySiblingCancelled
  if (!notify) return
  for (const id of cancelledIds) {
    try {
      const order = await deps.repos.orderRepo.get(id)
      if (order) await notify(runId, order)
    } catch (e) {
      console.error('sibling-cancel notification failed:', runId, id, String(e))
    }
  }
}
