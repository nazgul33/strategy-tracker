import { Hono } from 'hono'
import { DomainError, type ISODate } from '@st/core'
import type { BookingDeps } from '../../domain/booking'
import { applyCorrection, dismissCorrection, listOpenCorrections } from '../../domain/corrections'
import { jsonBig, type HttpDeps } from '../app'
import { fillBookingDeps } from '../booking-deps'
import { parseId } from '../params'

// Review of capture-proposed fill corrections. Auth is handled by the app-level middleware.
export function correctionsRouter(deps: HttpDeps): Hono {
  const r = new Hono()
  const bookingDeps = (): BookingDeps => ({ repos: deps.repos, today: deps.today() as ISODate })
  const failure = (c: any, e: unknown) => {
    if (!(e instanceof DomainError)) throw e
    if (e.kind === 'correction-not-found') return c.json({ error: e.kind }, 404)
    if (e.kind === 'correction-not-open' || e.kind === 'correction-stale') return c.json({ error: e.kind }, 409)
    return c.json({ error: e.kind }, 422)
  }

  r.get('/corrections', async (c) => c.json(jsonBig(await listOpenCorrections(bookingDeps()))))

  r.post('/corrections/:id/apply', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'correction-not-found' }, 404)
    try {
      const { deltaCents } = await applyCorrection(id, fillBookingDeps(deps))
      return c.json({ ok: true, deltaCents })
    } catch (e) {
      return failure(c, e)
    }
  })

  r.post('/corrections/:id/dismiss', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'correction-not-found' }, 404)
    try {
      await dismissCorrection(id, bookingDeps())
      return c.json({ ok: true })
    } catch (e) {
      return failure(c, e)
    }
  })
  return r
}
