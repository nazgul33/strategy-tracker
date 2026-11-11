import { Hono } from 'hono'
import { jsonBig, type HttpDeps } from '../app'
import { confirmPendingFill } from '../../domain/booking'
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
      await confirmPendingFill(id, overrides, { repos: deps.repos as any, today: deps.today() as any })
    } catch (e: any) {
      return c.json({ error: e?.message ?? 'error' }, 422)
    }
    return c.json({ ok: true })
  })
  r.post('/pending/:id/reject', async (c) => {
    const id = Number(c.req.param('id'))
    const row = await deps.repos.pendingRepo.get(id)
    if (!row || row.status !== 'pending') return c.json({ error: 'not-pending' }, 409)
    await deps.repos.pendingRepo.decide(id, 'rejected')
    return c.json({ ok: true })
  })
  return r
}