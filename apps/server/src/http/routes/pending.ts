import { Hono } from 'hono'
import { jsonBig, type HttpDeps } from '../app'
import { DomainError } from '@st/core'
import { confirmPendingFill, rejectPendingFill } from '../../domain/booking'
import { fillBookingDeps } from '../booking-deps'
export function pendingRouter(deps: HttpDeps): Hono {
  const r = new Hono()
  r.get('/pending', async (c) => {
    const rows = await deps.repos.pendingRepo.listPending()
    return c.json(jsonBig(rows))
  })
  r.post('/pending/:id/confirm', async (c) => {
    const id = Number(c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    const overrides = body?.overrides ?? null
    try {
      await confirmPendingFill(id, overrides, fillBookingDeps(deps))
    } catch (e: any) {
      if (e?.message === 'ticker-mismatch') return c.json({ error: 'ticker-mismatch' }, 409)
      if (e?.message === 'pending-not-pending' || e?.message === 'pending-not-found-or-not-pending') return c.json({ error: 'not-pending' }, 409)
      if (e instanceof DomainError) return c.json({ error: e.kind }, 422)
      return c.json({ error: e?.message ?? 'error' }, 422)
    }
    return c.json({ ok: true })
  })
  r.post('/pending/:id/reject', async (c) => {
    const id = Number(c.req.param('id'))
    // keepImage stays false until the request body carries it.
    if (!(await rejectPendingFill(id, fillBookingDeps(deps), { keepImage: false }))) return c.json({ error: 'not-pending' }, 409)
    return c.json({ ok: true })
  })
  return r
}