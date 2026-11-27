import { Hono } from 'hono'
import { jsonBig, type HttpDeps } from '../app'
import { expectedCloseDate, loadDashboard } from '../../domain/dashboard'
import { etTime, todayEt } from '../../wire/deps'

// One instant when a clock is injected; otherwise today first, so a skew across midnight can only make the expected close older.
function nyNow(deps: HttpDeps): { today: string; time: string } {
  if (deps.now) {
    const at = deps.now()
    return { today: todayEt(at), time: etTime(at) }
  }
  const today = deps.today()
  return { today, time: etTime(new Date()) }
}

export function dashboardRouter(deps: HttpDeps): Hono {
  const r = new Hono()
  r.get('/dashboard', async (c) => {
    const { today, time } = nyNow(deps)
    return c.json(jsonBig(await loadDashboard({ repos: deps.repos, today, expectedClose: expectedCloseDate(today, time) })))
  })
  return r
}
