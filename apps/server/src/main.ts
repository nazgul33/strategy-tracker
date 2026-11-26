import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { calendarCrossCheck } from '@st/calendar'
import { createBot } from '@st/telegram'
import { DEFAULT_MR_PARAMS } from '@st/strategies'
import { fetchDailyBars, fetchLastClose } from '@st/market-data'
import { applyMigrations, closeDb, getDb } from './db/client'
import { getRepos } from './db/repos'
import { createApp } from './http/app'
import { makeCachedBarReader } from './market/bars'
import { runMorningPipeline, type DayDeps } from './pipeline/day'
import { startJobs } from './pipeline/wire'
import { runBootSweeps } from './wire/boot-sweeps'
import { makeCaptureHandlers, type CaptureDeps } from './wire/capture'
import { makeCaptureRouting } from './wire/capture-route'
import { parseEnv, resolveVisionApiKey, todayEt, visionSource } from './wire/deps'
import { makeSend } from './wire/send'

async function main(): Promise<void> {
  const env = parseEnv(process.env)
  const db = await getDb(env.databaseUrl)
  await applyMigrations(db)
  const repos = getRepos(db)

  // Must stay ahead of the bot, the cron jobs and the HTTP server: the screenshot sweep is only safe while no confirm can be in flight.
  await runBootSweeps(repos, new Date())

  // vision/digest config: DB settings override env (api key re-read on every capture)
  const settings = await repos.settingsRepo.getAll()
  const visionBaseUrl = settings.visionBaseUrl || env.visionBaseUrl
  const visionModel = settings.visionModel || env.visionModel
  const digestLang = settings.digestLang === 'en' || settings.digestLang === 'ko' ? settings.digestLang : env.digestLang

  // bot is optional: without a token every send just logs (dev + first boot before setup)
  let bot: ReturnType<typeof createBot> | null = null
  const send: CaptureDeps['send'] = makeSend(() => bot?.api ?? null)

  // one routing core for the Telegram handlers and the web upload route
  const captureRouteDeps = {
    repos,
    vision: { baseUrl: visionBaseUrl, baseUrlSource: visionSource(settings.visionBaseUrl), model: visionModel, modelSource: visionSource(settings.visionModel) },
    getVisionApiKey: async () => resolveVisionApiKey((await repos.settingsRepo.getAll()).visionApiKey, env.visionApiKey),
    today: todayEt,
  }
  const handlers = makeCaptureHandlers({
    ...captureRouteDeps,
    lang: digestLang,
    allowedChatIds: env.telegram?.allowedChatIds ?? [],
    send,
  })

  const tg = env.telegram
  if (tg) {
    bot = createBot({
      token: tg.token,
      allowedChatIds: tg.allowedChatIds,
      lang: digestLang,
      onPhoto: handlers.onPhoto,
      onConfirm: handlers.onConfirm,
      onChoice: handlers.onChoice,
      onStatus: handlers.onStatus,
      onOrders: handlers.onOrders,
    })
    // resolves once polling stops (bot.stop() / shutdown)
    void bot.start().catch((e) => console.error('[bot] polling ended:', e))
    console.log('[main] Telegram bot polling started')
  } else {
    console.log('[main] TELEGRAM_BOT_TOKEN not set — Telegram bot disabled')
  }

  const dayDeps: DayDeps = {
    today: todayEt,
    fetchLastClose,
    crossCheck: calendarCrossCheck,
    send,
    allowedChatIds: tg?.allowedChatIds ?? [],
    repos,
    params: () => DEFAULT_MR_PARAMS,
    digestLang,
    persistClose: async (ticker, tradeDate, close) => {
      await repos.priceHistoryRepo.upsertMany([{ ticker, tradeDate, close }])
    },
  }
  const jobs = startJobs(dayDeps, (m) => console.log(`[jobs] ${m}`))

  const app = createApp({
    repos,
    password: env.appPassword,
    sessionSecret: env.sessionSecret,
    today: todayEt,
    defaultSettings: { visionBaseUrl, visionModel, digestLang, defaultCostPpm: env.defaultCostPpm },
    triggerMorning: async () => JSON.stringify(await runMorningPipeline(dayDeps)),
    // one cache for the simulator and the price chart
    fetchDailyBars: makeCachedBarReader({ upstream: fetchDailyBars, repos, today: todayEt }),
    allowedChatIds: tg?.allowedChatIds ?? [],
    send,
    routeCapture: makeCaptureRouting(captureRouteDeps),
  })

  // web build if `bun run --cwd apps/web build` was run; SPA fallback for deep links
  const dist = resolve(import.meta.dir, '../../web/dist')
  const hasDist = existsSync(resolve(dist, 'index.html'))

  const server = Bun.serve({
    port: env.port,
    idleTimeout: 60, // seconds; Bun's default is 10, and a web upload waits up to 50 s for vision
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (!path.startsWith('/api') && hasDist) {
        let abs: string
        try {
          const rel = path === '/' ? 'index.html' : decodeURIComponent(path).slice(1)
          abs = resolve(dist, rel)
        } catch {
          return new Response('not found', { status: 404 })
        }
        if (abs.startsWith(`${dist}/`)) {
          const file = Bun.file(abs)
          if (await file.exists()) return new Response(file)
          return new Response(Bun.file(resolve(dist, 'index.html')))
        }
        return new Response('not found', { status: 404 })
      }
      return app.fetch(req)
    },
  })
  console.log(`[main] listening on :${env.port} (static: ${hasDist ? 'apps/web/dist' : 'none'})`)

  const shutdown = async (): Promise<void> => {
    for (const job of jobs) job.stop()
    try {
      await bot?.stop()
    } catch (e) {
      console.error('[main] bot stop failed:', e)
    }
    server.stop()
    try {
      await closeDb()
    } catch (e) {
      console.error('[main] db close failed:', e)
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

main().catch((e) => {
  console.error('[main] fatal:', e)
  process.exit(1)
})
