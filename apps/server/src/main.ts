import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { calendarCrossCheck } from '@st/calendar'
import { createBot } from '@st/telegram'
import { DEFAULT_MR_PARAMS } from '@st/strategies'
import { fetchDailyBars, fetchLastClose } from '@st/market-data'
import { applyMigrations, getDb } from './db/client'
import { getRepos } from './db/repos'
import { createApp } from './http/app'
import { runMorningPipeline, type DayDeps } from './pipeline/day'
import { startJobs } from './pipeline/wire'
import { makeCaptureHandlers } from './wire/capture'
import { parseEnv, todayEt } from './wire/deps'

async function main(): Promise<void> {
  const env = parseEnv(process.env)
  const db = await getDb(env.databaseUrl)
  await applyMigrations(db)
  const repos = getRepos(db)

  // vision/digest config: DB settings override env (api key re-read on every capture)
  const settings = await repos.settingsRepo.getAll()
  const visionBaseUrl = settings.visionBaseUrl || (env.telegram?.visionBaseUrl ?? '')
  const visionModel = settings.visionModel || (env.telegram?.visionModel ?? '')
  const digestLang = settings.digestLang === 'en' || settings.digestLang === 'ko' ? settings.digestLang : env.digestLang

  // bot is optional: without a token every send just logs (dev + first boot before setup)
  let bot: ReturnType<typeof createBot> | null = null
  const send = async (chatId: string, text: string): Promise<void> => {
    if (!bot) {
      console.log(`[send:${chatId}] ${text.slice(0, 120)}`)
      return
    }
    await bot.api.sendMessage(chatId, text)
  }

  const handlers = makeCaptureHandlers({
    repos,
    vision: { baseUrl: visionBaseUrl, model: visionModel },
    getVisionApiKey: async () => (await repos.settingsRepo.getAll()).visionApiKey || env.visionApiKey,
    today: todayEt,
    lang: digestLang,
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
  }
  const jobs = startJobs(dayDeps, (m) => console.log(`[jobs] ${m}`))

  const app = createApp({
    repos,
    password: env.appPassword,
    sessionSecret: env.sessionSecret,
    today: todayEt,
    defaultSettings: { visionBaseUrl, visionModel, digestLang },
    triggerMorning: async () => JSON.stringify(await runMorningPipeline(dayDeps)),
    fetchDailyBars,
  })

  // web build if `bun run --cwd apps/web build` was run; SPA fallback for deep links
  const dist = resolve(import.meta.dir, '../../web/dist')
  const hasDist = existsSync(resolve(dist, 'index.html'))

  const server = Bun.serve({
    port: env.port,
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

  const shutdown = (): void => {
    for (const job of jobs) job.stop()
    void bot?.stop()
    server.stop()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((e) => {
  console.error('[main] fatal:', e)
  process.exit(1)
})
