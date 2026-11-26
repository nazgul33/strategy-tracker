import { Hono } from 'hono'
import { jsonBig, type HttpDeps } from '../app'
import { loadDashboard } from '../../domain/dashboard'

export function dashboardRouter(deps: HttpDeps): Hono {
  const r = new Hono()
  r.get('/dashboard', async (c) => c.json(jsonBig(await loadDashboard({ repos: deps.repos, today: deps.today() }))))
  return r
}
