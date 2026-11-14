import { Hono } from 'hono'
import { DomainError } from '@st/core'
import { rebookFill, deleteFill, recalcRunState } from '../../domain/recompute'
import type { HttpDeps } from '../app'

// Editing captured fills and recalculating state. Auth is already handled by the
// app-level middleware. All routes only call domain functions; the domain persists state itself.
export function fillsRouter(deps: HttpDeps): Hono {
  const r = new Hono()
  const bookingDeps = () => ({ repos: deps.repos as any, today: deps.today() as any })
  // cents -> parseUsd string: 5 -> '0.05', 1005 -> '10.05'
  const centsToStr = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`

  r.put('/runs/:id/fills/:fillId', async (c) => {
    const runId = Number(c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    const { qty, priceCents, feeCents } = body ?? {}
    // feeCents must be sent: integer >= 0, or null = recompute the fee from run costPpm
    if (!Number.isInteger(qty) || qty <= 0 || !Number.isInteger(priceCents) || priceCents <= 0
      || (feeCents !== null && (!Number.isInteger(feeCents) || feeCents < 0))) return c.json({ error: 'invalid-body' }, 400)
    const run = await deps.repos.runRepo.get(runId)
    if (!run) return c.json({ error: 'no-run' }, 404)
    let edited: { deltaCents: number }
    try {
      // no cash guard: an oversized qty is the operator's call, books go negative
      edited = await rebookFill(runId, {
        fillId: Number(c.req.param('fillId')), shares: qty, priceStr: centsToStr(priceCents), feeCents: feeCents as number | null,
      }, bookingDeps())
    } catch (e) {
      if (e instanceof DomainError) return c.json({ error: e.kind }, 422)
      throw e
    }
    return c.json({ ok: true, deltaCents: edited.deltaCents })
  })

  r.delete('/runs/:id/fills/:fillId', async (c) => {
    const runId = Number(c.req.param('id'))
    // a non-numeric id can never name the newest fill of a bucket
    const raw = c.req.param('fillId')
    if (!/^\d+$/.test(raw)) return c.json({ error: 'not-last' }, 422)
    const run = await deps.repos.runRepo.get(runId)
    if (!run) return c.json({ error: 'no-run' }, 404)
    let deleted: { fill: { id: number }; deltaCents: number }
    try {
      // the domain guards per-bucket newness and books the compensating adjust
      deleted = await deleteFill(runId, Number(raw), bookingDeps())
    } catch (e) {
      if (e instanceof DomainError) return c.json({ error: e.kind }, 422)
      throw e
    }
    return c.json({ ok: true, deletedFillId: deleted.fill.id, deltaCents: deleted.deltaCents })
  })

  // Re-derive the run state from the fill history without touching any row.
  r.post('/runs/:id/recalc', async (c) => {
    const runId = Number(c.req.param('id'))
    const run = await deps.repos.runRepo.get(runId)
    if (!run) return c.json({ error: 'no-run' }, 404)
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
