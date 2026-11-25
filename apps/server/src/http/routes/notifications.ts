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
    const runIds = [...new Set(page.entries.flatMap((e) => (e.runId === null ? [] : [e.runId])))]
    const runs = new Map<number, { ticker: string; strategyKey: string }>()
    for (const run of await deps.repos.sharedRunRepo.getMany(runIds)) runs.set(run.id, { ticker: run.ticker, strategyKey: run.strategyKey })
    return c.json({
      entries: page.entries.map((e) => {
        const run = e.runId === null ? undefined : runs.get(e.runId)
        return { ...e, ticker: run?.ticker ?? null, strategyKey: run?.strategyKey ?? null }
      }),
      nextBefore: page.nextBefore,
    })
  })
  return r
}
