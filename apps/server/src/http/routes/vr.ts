import { Hono } from 'hono'
import { jsonBig, type HttpDeps } from '../app'
import { RUN_STATUSES_SERVER, RUN_TRANSITIONS } from './runs'
import { vrEntriesRouter, vrRunParam } from './vr-entries'
import { VrNameTakenError } from '../../domain/vr/repo-types'
import { createVrRun, loadVrDetail, loadVrSummaries, parseVrCreate, parseVrSettings, setVrStatus, updateVrSettings, VrBadInput } from '../../domain/vr/runs'
import { cycleView } from '../../domain/vr/view'

export function vrRouter(deps: HttpDeps): Hono {
  const r = new Hono()
  const readDeps = () => ({ repos: deps.repos, today: deps.today() })
  const notFound = { error: 'not found' }

  r.get('/runs', async (c) => c.json(jsonBig(await loadVrSummaries(readDeps()))))
  r.post('/runs', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    try {
      const input = parseVrCreate(body, deps.defaultSettings.defaultCostPpm, deps.today())
      return c.json({ id: await createVrRun(deps.repos.vrRunRepo, input) }, 201)
    } catch (e) {
      if (e instanceof VrBadInput) return c.json({ error: e.message }, 400)
      if (e instanceof VrNameTakenError) return c.json({ error: 'vr-name-taken' }, 409)
      throw e
    }
  })
  r.get('/runs/:id', async (c) => {
    const run = await vrRunParam(deps, c.req.param('id'))
    if (!run) return c.json(notFound, 404)
    return c.json(jsonBig(await loadVrDetail(run, readDeps())))
  })
  r.patch('/runs/:id', async (c) => {
    const run = await vrRunParam(deps, c.req.param('id'))
    if (!run) return c.json(notFound, 404)
    const body = await c.req.json().catch(() => ({}))
    const status = body?.status
    if (!(RUN_STATUSES_SERVER as readonly unknown[]).includes(status)) return c.json({ error: 'invalid status' }, 400)
    const result = await setVrStatus(deps.repos.vrRunRepo, run.id, status, RUN_TRANSITIONS)
    if (result === 'not-found') return c.json(notFound, 404)
    if (result === 'invalid-transition') return c.json({ error: 'invalid transition' }, 409)
    return c.json({ ok: true })
  })
  r.post('/runs/:id/settings', async (c) => {
    const run = await vrRunParam(deps, c.req.param('id'))
    if (!run) return c.json(notFound, 404)
    const body = await c.req.json().catch(() => ({}))
    try {
      if (!(await updateVrSettings(deps.repos.vrRunRepo, run.id, parseVrSettings(body, false)))) return c.json(notFound, 404)
    } catch (e) {
      if (e instanceof VrBadInput) return c.json({ error: e.message }, 400)
      throw e
    }
    return c.body(null, 204)
  })
  r.get('/runs/:id/cycles', async (c) => {
    const run = await vrRunParam(deps, c.req.param('id'))
    if (!run) return c.json(notFound, 404)
    return c.json(jsonBig((await deps.repos.vrCycleRepo.listForRun(run.id)).reverse().map(cycleView)))
  })
  r.route('/', vrEntriesRouter(deps))
  return r
}
