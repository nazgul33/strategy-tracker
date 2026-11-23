import { Hono } from 'hono'
import { DomainError, type ISODate } from '@st/core'
import type { BookingDeps } from '../../domain/booking'
import { rebookFill, deleteFill, recalcRunState } from '../../domain/recompute'
import type { HttpDeps } from '../app'
import { fillBookingDeps } from '../booking-deps'
import { parseId } from '../params'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Editing captured fills and recalculating state. Auth is already handled by the
// app-level middleware. All routes only call domain functions; the domain persists state itself.
export function fillsRouter(deps: HttpDeps): Hono {
  const r = new Hono()
  const bookingDeps = (): BookingDeps => ({ repos: deps.repos, today: deps.today() })
  // cents -> parseUsd string: 5 -> '0.05', 1005 -> '10.05'
  const centsToStr = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`

  r.put('/runs/:id/fills/:fillId', async (c) => {
    const runId = parseId(c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    const { qty, priceCents, feeCents, filledOn } = body ?? {}
    // feeCents must be sent: integer >= 0, or null = recompute the fee from run costPpm
    // filledOn is optional; when present it must be an ISO YYYY-MM-DD string
    if (!Number.isInteger(qty) || qty <= 0 || !Number.isInteger(priceCents) || priceCents <= 0
      || (feeCents !== null && (!Number.isInteger(feeCents) || feeCents < 0))
      || (filledOn !== undefined && (typeof filledOn !== 'string' || !ISO_DATE_RE.test(filledOn)))) return c.json({ error: 'invalid-body' }, 400)
    const run = runId === null ? null : await deps.repos.runRepo.get(runId)
    if (runId === null || !run) return c.json({ error: 'no-run' }, 404)
    const fillId = parseId(c.req.param('fillId'))
    if (fillId === null) return c.json({ error: 'no-fill' }, 422)
    let edited: { deltaCents: number }
    try {
      // no cash guard: an oversized qty is the operator's call, books go negative
      edited = await rebookFill(runId, {
        fillId, shares: qty, priceStr: centsToStr(priceCents), feeCents: feeCents as number | null,
        filledOn: filledOn as ISODate | undefined,
      }, fillBookingDeps(deps))
    } catch (e) {
      if (e instanceof DomainError) return c.json({ error: e.kind }, 422)
      throw e
    }
    return c.json({ ok: true, deltaCents: edited.deltaCents })
  })

  r.delete('/runs/:id/fills/:fillId', async (c) => {
    const runId = parseId(c.req.param('id'))
    const fillId = parseId(c.req.param('fillId'))
    if (fillId === null) return c.json({ error: 'no-fill' }, 422)
    const run = runId === null ? null : await deps.repos.runRepo.get(runId)
    if (runId === null || !run) return c.json({ error: 'no-run' }, 404)
    let deleted: { fill: { id: number }; deltaCents: number }
    try {
      // the domain guards per-bucket newness and books the compensating adjust
      deleted = await deleteFill(runId, fillId, fillBookingDeps(deps))
    } catch (e) {
      if (e instanceof DomainError) return c.json({ error: e.kind }, 422)
      throw e
    }
    return c.json({ ok: true, deletedFillId: deleted.fill.id, deltaCents: deleted.deltaCents })
  })

  // Re-derive the run state from the fill history without touching any row.
  r.post('/runs/:id/recalc', async (c) => {
    const runId = parseId(c.req.param('id'))
    const run = runId === null ? null : await deps.repos.runRepo.get(runId)
    if (runId === null || !run) return c.json({ error: 'no-run' }, 404)
    let recalc: { deltaCents: number; fillCount: number }
    try {
      recalc = await recalcRunState(runId, bookingDeps())
    } catch (e) {
      if (e instanceof DomainError) return c.json({ error: e.kind }, 422)
      throw e
    }
    return c.json({ ok: true, deltaCents: recalc.deltaCents, fillCount: recalc.fillCount })
  })
  return r
}
