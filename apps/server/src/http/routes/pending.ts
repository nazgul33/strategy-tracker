import { Hono } from 'hono'
import { jsonBig, type HttpDeps } from '../app'
import { DomainError } from '@st/core'
import { confirmPendingFill, rejectPendingFill } from '../../domain/booking'
import { fillBookingDeps } from '../booking-deps'

// null for a row captured before the snapshot existed ("predates it"), as opposed
// to an object with null fields ("vision missed that field").
function detectedDto(row: any) {
  if (row.detectedAt == null) return null
  return { side: row.detectedSide ?? null, shares: row.detectedShares ?? null, price: row.detectedPrice ?? null, filledOn: row.detectedFilledOn ?? null, fee: row.detectedFee ?? null }
}

export function pendingRouter(deps: HttpDeps): Hono {
  const r = new Hono()
  r.get('/pending', async (c) => {
    const rows = await deps.repos.pendingRepo.listPending()
    const withImage = await deps.repos.captureImageRepo.existingIds(rows.map((p: any) => p.captureId).filter((id: number | null) => id != null) as number[])
    const costPpm = new Map<number, number>()
    for (const runId of new Set<number>(rows.map((p: any) => p.runId))) {
      costPpm.set(runId, (await deps.repos.runRepo.get(runId))?.costPpm ?? deps.defaultSettings.defaultCostPpm)
    }
    return c.json(jsonBig(rows.map((p: any) => {
      const { detectedSide, detectedShares, detectedPrice, detectedFilledOn, detectedFee, detectedAt, ...row } = p
      return {
        ...row,
        hasImage: p.captureId != null && withImage.has(p.captureId),
        detected: detectedDto(p),
        costPpm: costPpm.get(p.runId)!,
      }
    })))
  })
  r.post('/pending/:id/confirm', async (c) => {
    const id = Number(c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    const overrides = body?.overrides ?? null
    try {
      await confirmPendingFill(id, overrides, fillBookingDeps(deps), { keepImage: body?.keepImage === true })
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
    const body = await c.req.json().catch(() => ({}))
    if (!(await rejectPendingFill(id, fillBookingDeps(deps), { keepImage: body?.keepImage === true }))) return c.json({ error: 'not-pending' }, 409)
    return c.json({ ok: true })
  })
  return r
}
