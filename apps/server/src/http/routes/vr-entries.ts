import { Hono, type Context } from 'hono'
import { DomainError } from '@st/core'
import { jsonBig, type HttpDeps } from '../app'
import { parseId } from '../params'
import { addVrCash, addVrFill, deleteVrCash, deleteVrFill, editVrCash, editVrFill, VrNotFoundError, type VrBookingDeps } from '../../domain/vr/booking'
import type { VrRunRow } from '../../domain/vr/repo-types'
import { cashView, fillView } from '../../domain/vr/view'

const NOT_FOUND = { error: 'not found' }

export async function vrRunParam(deps: HttpDeps, raw: string): Promise<VrRunRow | null> {
  const id = parseId(raw)
  return id === null ? null : deps.repos.vrRunRepo.get(id)
}

export function vrFail(c: Context, e: unknown) {
  if (e instanceof VrNotFoundError) return c.json(NOT_FOUND, 404)
  if (e instanceof DomainError) return c.json({ error: e.kind }, e.kind === 'vr-not-pending' ? 409 : 422)
  throw e
}

export function vrRouteHelpers(deps: HttpDeps) {
  const readBody = (c: Context) => c.req.json().catch(() => ({}))

  // Runs `fn` for a VR run and an entry id; 404 for an MR run, a malformed id or a missing entry.
  const entryRoute = (fn: (c: Context, run: VrRunRow, entryId: number) => Promise<Response>, param: string) => async (c: Context) => {
    const run = await vrRunParam(deps, c.req.param('id') ?? '')
    const entryId = parseId(c.req.param(param) ?? '')
    if (!run || entryId === null) return c.json(NOT_FOUND, 404)
    try {
      return await fn(c, run, entryId)
    } catch (e) {
      return vrFail(c, e)
    }
  }
  const runRoute = (fn: (c: Context, run: VrRunRow) => Promise<Response>) => async (c: Context) => {
    const run = await vrRunParam(deps, c.req.param('id') ?? '')
    if (!run) return c.json(NOT_FOUND, 404)
    try {
      return await fn(c, run)
    } catch (e) {
      return vrFail(c, e)
    }
  }
  return { readBody, runRoute, entryRoute }
}

export function vrEntriesRouter(deps: HttpDeps): Hono {
  const r = new Hono()
  const bookingDeps = (): VrBookingDeps => ({ repos: deps.repos, today: deps.today() })
  const { readBody, runRoute, entryRoute } = vrRouteHelpers(deps)

  r.get('/runs/:id/fills', runRoute(async (c, run) => {
    const [rows, cycle] = await Promise.all([deps.repos.vrFillRepo.listForRun(run.id), deps.repos.vrCycleRepo.latest(run.id)])
    return c.json(jsonBig(rows.reverse().map((f) => fillView(f, cycle))))
  }))
  r.post('/runs/:id/fills', runRoute(async (c, run) => c.json({ id: await addVrFill(run, await readBody(c), bookingDeps()) }, 201)))
  r.put('/runs/:id/fills/:fillId', entryRoute(async (c, run, fillId) => {
    await editVrFill(run, fillId, await readBody(c), bookingDeps())
    return c.body(null, 204)
  }, 'fillId'))
  r.delete('/runs/:id/fills/:fillId', entryRoute(async (c, run, fillId) => {
    await deleteVrFill(run, fillId, bookingDeps())
    return c.body(null, 204)
  }, 'fillId'))

  r.get('/runs/:id/cash', runRoute(async (c, run) => {
    const [rows, cycle] = await Promise.all([deps.repos.vrCashRepo.listForRun(run.id), deps.repos.vrCycleRepo.latest(run.id)])
    return c.json(jsonBig(rows.reverse().map((m) => cashView(m, cycle))))
  }))
  r.post('/runs/:id/cash', runRoute(async (c, run) => c.json({ id: await addVrCash(run, await readBody(c), bookingDeps()) }, 201)))
  r.put('/runs/:id/cash/:cashId', entryRoute(async (c, run, cashId) => {
    await editVrCash(run, cashId, await readBody(c), bookingDeps())
    return c.body(null, 204)
  }, 'cashId'))
  r.delete('/runs/:id/cash/:cashId', entryRoute(async (c, run, cashId) => {
    await deleteVrCash(run, cashId, bookingDeps())
    return c.body(null, 204)
  }, 'cashId'))
  return r
}
