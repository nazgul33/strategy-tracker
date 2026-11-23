import { Hono } from 'hono'
import type { HttpDeps } from '../app'
import { loadNoticePage, NOTICE_PAGE_DEFAULT, NOTICE_PAGE_MAX } from '../../domain/notice-feed'
import { parseId } from '../params'

export function notificationsRouter(deps: HttpDeps): Hono {
  const r = new Hono()
  r.get('/notifications', async (c) => {
    const rawBefore = c.req.query('before')
    const rawLimit = c.req.query('limit')
    const before = rawBefore === undefined ? null : parseId(rawBefore)
    if (rawBefore !== undefined && before === null) return c.json({ error: 'invalid before' }, 400)
    const parsedLimit = rawLimit === undefined ? NOTICE_PAGE_DEFAULT : parseId(rawLimit)
    if (parsedLimit === null) return c.json({ error: 'invalid limit' }, 400)
    const page = await loadNoticePage(deps.repos.notificationRepo, before, Math.min(parsedLimit, NOTICE_PAGE_MAX))
    const tickers = new Map<number, string>()
    if (page.entries.some((e) => e.runId !== null)) {
      for (const run of await deps.repos.runRepo.list()) tickers.set(run.id, run.ticker)
    }
    return c.json({
      entries: page.entries.map((e) => ({ ...e, ticker: e.runId === null ? null : (tickers.get(e.runId) ?? null) })),
      nextBefore: page.nextBefore,
    })
  })
  return r
}
