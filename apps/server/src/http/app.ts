import { Hono } from 'hono'
import type { RepoSurface } from '../domain/booking'
import { authMiddleware, makeToken } from './auth'

export interface HttpRepoSurface extends RepoSurface {
  settingsRepo: { getAll(): Promise<Record<string, string>>; set(key: string, value: string): Promise<void> }
  poolEditRepo: { insert(input: { runId: number; poolCents: number }): Promise<void> }
  runRepo: RepoSurface['runRepo'] & { updatePool(id: number, poolCents: number): Promise<void> }
  orderRepo: RepoSurface['orderRepo'] & { listForRun(runId: number, date?: string): Promise<any[]> }
  fillRepo: RepoSurface['fillRepo'] & { listForRun(runId: number): Promise<any[]> }
  notificationRepo: RepoSurface['notificationRepo'] & { listForRun(runId: number): Promise<any[]> }
  pendingRepo: RepoSurface['pendingRepo'] & { get(id: number): Promise<any> }
}

export interface HttpDeps {
  repos: HttpRepoSurface
  password: string
  sessionSecret: string
  today: () => string
  defaultSettings: { visionBaseUrl: string; visionModel: string; digestLang: 'en' | 'ko' }
  triggerMorning: () => Promise<string>
}

import { runsRouter } from './routes/runs'
import { fillsRouter } from './routes/fills'
import { pendingRouter } from './routes/pending'
import { settingsRouter } from './routes/settings'
import { simStub } from './routes/sim-stub'

export function jsonBig(x: unknown): unknown {
  return JSON.parse(JSON.stringify(x, (_k, v) => typeof v === 'bigint' ? v.toString() : v))
}

export function createApp(deps: HttpDeps): Hono {
  const app = new Hono()
  app.use('*', authMiddleware(deps.sessionSecret))
  app.post('/api/login', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (!body || body.password !== deps.password) {
      return c.json({ error: 'invalid password' }, 401)
    }
    const expiry = Date.now() + 30 * 24 * 60 * 60 * 1000
    const token = makeToken(expiry, deps.sessionSecret)
    c.header('Set-Cookie', `st_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}; Path=/`)
    return c.json({ token })
  })
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.route('/api', runsRouter(deps))
  app.route('/api', fillsRouter(deps))
  app.route('/api', pendingRouter(deps))
  app.route('/api', settingsRouter(deps))
  app.route('/api/sim', simStub())
  app.post('/api/trigger/morning', async (c) => {
    const result = await deps.triggerMorning()
    return c.json({ result })
  })
  app.get('/', async (c) => {
    try {
      const file = Bun.file(new URL('../../web/dist/index.html', import.meta.url))
      if (!(await file.exists())) return c.text('not found', 404)
      return c.html(await file.text())
    } catch {
      return c.text('not found', 404)
    }
  })
  return app
}