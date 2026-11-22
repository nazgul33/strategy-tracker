import { Hono } from 'hono'
import { jsonBig, type HttpDeps } from '../app'
import { DomainError, type RunState } from '@st/core'
import { confirmPendingFill, rejectPendingFill } from '../../domain/booking'
import { fillBookingDeps } from '../booking-deps'
import { parseId } from '../params'

// null for a row captured before the snapshot existed ("predates it"), as opposed
// to an object with null fields ("vision missed that field").
function detectedDto(row: any) {
  if (row.detectedAt == null) return null
  return { side: row.detectedSide ?? null, shares: row.detectedShares ?? null, price: row.detectedPrice ?? null, filledOn: row.detectedFilledOn ?? null, fee: row.detectedFee ?? null }
}

function heldBucketsOf(state: RunState): Array<{ index: number; shares: number }> {
  return state.buckets.filter((b) => b.state !== 'empty').map((b) => ({ index: b.index, shares: b.shares })).sort((a, b) => a.index - b.index)
}

export function pendingRouter(deps: HttpDeps): Hono {
  const r = new Hono()
  r.get('/pending', async (c) => {
    const rows = await deps.repos.pendingRepo.listPending()
    const withImage = await deps.repos.captureImageRepo.existingIds(rows.map((p: any) => p.captureId).filter((id: number | null) => id != null) as number[])
    const perRun = new Map(await Promise.all(
      [...new Set<number>(rows.map((p: any) => p.runId))].map(async (runId) => {
        const run = await deps.repos.runRepo.get(runId)
        const heldBuckets = run ? heldBucketsOf(await deps.repos.bucketRepo.loadState(runId)) : []
        return [runId, { costPpm: run?.costPpm ?? deps.defaultSettings.defaultCostPpm, heldBuckets }] as const
      }),
    ))
    return c.json(jsonBig(rows.map((p: any) => {
      const { detectedSide, detectedShares, detectedPrice, detectedFilledOn, detectedFee, detectedAt, ...row } = p
      const { costPpm, heldBuckets } = perRun.get(p.runId)!
      return {
        ...row,
        hasImage: p.captureId != null && withImage.has(p.captureId),
        detected: detectedDto(p),
        costPpm,
        heldBuckets,
      }
    })))
  })
  r.post('/pending/:id/confirm', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'not-pending' }, 409)
    const body = await c.req.json().catch(() => ({}))
    const overrides = body?.overrides ?? null
    let archived: boolean
    try {
      ({ archived } = await confirmPendingFill(id, overrides, fillBookingDeps(deps), { keepImage: body?.keepImage === true }))
    } catch (e: any) {
      if (e?.message === 'ticker-mismatch') return c.json({ error: 'ticker-mismatch' }, 409)
      if (e?.message === 'pending-not-pending' || e?.message === 'pending-not-found-or-not-pending') return c.json({ error: 'not-pending' }, 409)
      if (e instanceof DomainError) return c.json({ error: e.kind }, 422)
      return c.json({ error: e?.message ?? 'error' }, 422)
    }
    return c.json({ ok: true, archived })
  })
  r.post('/pending/:id/reject', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'not-pending' }, 409)
    const body = await c.req.json().catch(() => ({}))
    const rejected = await rejectPendingFill(id, fillBookingDeps(deps), { keepImage: body?.keepImage === true })
    if (!rejected) return c.json({ error: 'not-pending' }, 409)
    return c.json({ ok: true, archived: rejected.archived })
  })
  return r
}
