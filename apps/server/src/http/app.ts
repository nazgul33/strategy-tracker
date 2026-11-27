import { Hono } from 'hono'
import type { RepoSurface } from '../domain/booking'
import type { CaptureChoiceRepo } from '../domain/capture-choice'
import type { PoolBucketRepo } from '../domain/pool-edit'
import type { OHLCBar } from '@st/market-data'
import type { FillRepo, NotificationRepo, OrderRepo, PendingRepo, RunRepo } from '../domain/repo-types'
import type { SharedRunRepo, VrRepos } from '../domain/vr/repo-types'
import type { SimRepoSurface } from '../sim/sim'
import { authMiddleware, makeToken } from './auth'
import type { BarCacheRepos } from '../market/bars'
import type { RouteCapture } from '../wire/capture-route'

export interface HttpRepoSurface extends RepoSurface, VrRepos {
  sharedRunRepo: SharedRunRepo
  priceHistoryRepo: BarCacheRepos['priceHistoryRepo'] & {
    upsertMany(rows: { ticker: string; tradeDate: string; close: bigint }[]): Promise<number>
    listForTicker(ticker: string, from?: string): Promise<{ tradeDate: string; close: bigint }[]>
  }
  barCoverageRepo: BarCacheRepos['barCoverageRepo']
  settingsRepo: { getAll(): Promise<Record<string, string>>; set(key: string, value: string): Promise<void> }
  poolEditRepo: { insert(input: { runId: number; poolCents: number }): Promise<void> }
  runRepo: RunRepo
  bucketRepo: PoolBucketRepo
  orderRepo: OrderRepo
  fillRepo: FillRepo
  notificationRepo: NotificationRepo
  pendingRepo: PendingRepo
  captureImageRepo: RepoSurface['captureImageRepo'] & { existingIds(captureIds: number[]): Promise<Set<number>> }
  simRepo: SimRepoSurface
  captureChoiceRepo: CaptureChoiceRepo
}

export interface HttpDeps {
  repos: HttpRepoSurface
  password: string
  sessionSecret: string
  today: () => string
  defaultSettings: { visionBaseUrl: string; visionModel: string; digestLang: 'en' | 'ko'; defaultCostPpm: number }
  triggerMorning: () => Promise<string>
  // The price-history route relies on this reader persisting the bars it returns (production wires the cached reader); each bar carries `date`.
  fetchDailyBars: (ticker: string, from: string, to: string) => Promise<OHLCBar[]>
  allowedChatIds: string[]
  send: (chatId: string, text: string) => Promise<void>
  routeCapture: RouteCapture
  /** optional: the clock the dashboard reads the New York date and time from; the real time by default */
  now?: () => Date
}

import { runsRouter } from './routes/runs'
import { fillsRouter } from './routes/fills'
import { pendingRouter } from './routes/pending'
import { correctionsRouter } from './routes/corrections'
import { settingsRouter } from './routes/settings'
import { notificationsRouter } from './routes/notifications'
import { simRouter } from './routes/sim'
import { visionReviewRouter } from './routes/vision-review'
import { capturesRouter } from './routes/captures'
import { vrRouter } from './routes/vr'
import { dashboardRouter } from './routes/dashboard'

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
  app.route('/api', notificationsRouter(deps))
  app.route('/api', capturesRouter(deps))
  app.route('/api', dashboardRouter(deps))
  app.route('/api/sim', simRouter(deps))
  app.route('/api/vr', vrRouter(deps))
  app.post('/api/trigger/morning', async (c) => {
    try {
      const result = await deps.triggerMorning()
      return c.json({ result })
    } catch (e) {
      console.error('morning trigger failed:', String(e))
      return c.json({ error: 'pipeline-error' }, 500)
    }
  })
  // NOTE: the static SPA (apps/web/dist) is served by main.ts, not here —
  // createApp stays pure so http tests can run without the web build.
  return app
}
