import { Hono } from 'hono'
import { jsonBig, type HttpDeps } from '../app'
import { confirmAllVrPending, confirmVrPending, editVrPending, listVrPending, rejectVrPending, type VrPendingDeps } from '../../domain/vr/pending'
import { vrRouteHelpers } from './vr-entries'

export function vrPendingRouter(deps: HttpDeps): Hono {
  const r = new Hono()
  const pendingDeps = (): VrPendingDeps => ({ repos: deps.repos, today: deps.today() })
  const { readBody, runRoute, entryRoute } = vrRouteHelpers(deps)

  r.get('/runs/:id/pending', runRoute(async (c, run) => c.json(jsonBig(await listVrPending(run, pendingDeps())))))
  r.post('/runs/:id/pending/confirm-all', runRoute(async (c, run) => c.json(jsonBig(await confirmAllVrPending(run, pendingDeps())))))
  r.put('/runs/:id/pending/:pid', entryRoute(async (c, run, pid) => {
    await editVrPending(run, pid, await readBody(c), pendingDeps())
    return c.body(null, 204)
  }, 'pid'))
  r.post('/runs/:id/pending/:pid/confirm', entryRoute(async (c, run, pid) => c.json({ fillId: await confirmVrPending(run, pid, pendingDeps()) }, 201), 'pid'))
  r.post('/runs/:id/pending/:pid/reject', entryRoute(async (c, run, pid) => {
    await rejectVrPending(run, pid, pendingDeps())
    return c.body(null, 204)
  }, 'pid'))
  return r
}
