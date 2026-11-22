import { Hono } from 'hono'
import type { RepoSurface } from '../domain/booking'
import type { OrderRepo, PendingRepo, RunRepo } from '../domain/repo-types'
import type { SimRepoSurface } from '../sim/sim'
import { authMiddleware, makeToken } from './auth'
import type { BarCacheRepos } from '../market/bars'

export interface HttpRepoSurface extends RepoSurface {
  priceHistoryRepo: BarCacheRepos['priceHistoryRepo'] & {
    upsertMany(rows: { ticker: string; tradeDate: string; close: bigint }[]): Promise<number>
    listForTicker(ticker: string, from?: string): Promise<{ tradeDate: string; close: bigint }[]>
  }
  barCoverageRepo: BarCacheRepos['barCoverageRepo']
  settingsRepo: { getAll(): Promise<Record<string, string>>; set(key: string, value: string): Promise<void> }
  poolEditRepo: { insert(input: { runId: number; poolCents: number }): Promise<void> }
  runRepo: RunRepo
  orderRepo: OrderRepo
  fillRepo: RepoSurface['fillRepo']
  notificationRepo: RepoSurface['notificationRepo'] & { listForRun(runId: number): Promise<any[]> }
  pendingRepo: PendingRepo
  captureImageRepo: RepoSurface['captureImageRepo'] & { existingIds(captureIds: number[]): Promise<Set<number>> }
  simRepo: SimRepoSurface
}

export interface HttpDeps {
  repos: HttpRepoSurface
  password: string
  sessionSecret: string
  today: () => string
  defaultSettings: { visionBaseUrl: string; visionModel: string; digestLang: 'en' | 'ko'; defaultCostPpm: number }
  triggerMorning: () => Promise<string>
  // The price-history route relies on this reader persisting the bars it returns (production wires the cached reader); each bar carries `date`.
  fetchDailyBars: (ticker: string, from: string, to: string) => Promise<any[]>
  allowedChatIds: string[]
  send: (chatId: string, text: string) => Promise<void>
}

import { runsRouter } from './routes/runs'
import { fillsRouter } from './routes/fills'
import { pendingRouter } from './routes/pending'
import { correctionsRouter } from './routes/corrections'
import { settingsRouter } from './routes/settings'
import { simRouter } from './routes/sim'
import { visionReviewRouter } from './routes/vision-review'

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
  app.route('/api', visionReviewRouter(deps))
  app.route('/api', correctionsRouter(deps))
  app.route('/api', settingsRouter(deps))
  app.route('/api/sim', simRouter(deps))
  app.post('/api/trigger/morning', async (c) => {
    const result = await deps.triggerMorning()
    return c.json({ result })
  })
  // NOTE: the static SPA (apps/web/dist) is served by main.ts, not here —
  // createApp stays pure so http tests can run without the web build.
  return app
}
