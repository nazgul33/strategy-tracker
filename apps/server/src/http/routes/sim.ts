import { Hono } from 'hono'
import { DomainError } from '@st/core'
import { MarketDataError } from '@st/market-data'
import { runSim } from '../../sim/sim'
import { jsonBig, type HttpDeps } from '../app'

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/

function validateBody(body: any): { ok: true; input: any } | { ok: false; error: string } {
  const name = body?.name
  const ticker = body?.ticker
  const from = body?.from
  const to = body?.to
  const poolCents = body?.poolCents
  const costPpm = body?.costPpm
  if (typeof name !== 'string' || name.trim() === '') return { ok: false, error: 'invalid name' }
  if (typeof ticker !== 'string' || ticker.trim() === '') return { ok: false, error: 'invalid ticker' }
  if (typeof from !== 'string' || !ISO_RE.test(from)) return { ok: false, error: 'invalid from' }
  if (typeof to !== 'string' || !ISO_RE.test(to)) return { ok: false, error: 'invalid to' }
  if (from > to) return { ok: false, error: 'invalid range' }
  if (!Number.isInteger(poolCents) || poolCents <= 0) return { ok: false, error: 'invalid poolCents' }
  if (!Number.isInteger(costPpm) || costPpm < 0) return { ok: false, error: 'invalid costPpm' }
  const params = body?.params
  if (params != null) {
    if (typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid params' }
    if (params.bucketCount != null) {
      if (!Number.isInteger(params.bucketCount) || params.bucketCount < 1 || params.bucketCount > 50) return { ok: false, error: 'invalid bucketCount' }
    }
  }
  return { ok: true, input: { name, ticker, from, to, poolCents, costPpm, params } }
}

export function simRouter(deps: HttpDeps): Hono {
  const r = new Hono()
  r.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const v = validateBody(body)
    if (!v.ok) return c.json({ error: v.error }, 400)
    try {
      const res = await runSim(v.input, { fetchDailyBars: deps.fetchDailyBars, repos: deps.repos.simRepo as any })
      return c.json(res, 200)
    } catch (e: any) {
      if (e instanceof DomainError) return c.json({ error: e.kind }, 422)
      if (e instanceof MarketDataError) return c.json({ error: 'market-data:' + e.kind }, 502)
      return c.json({ error: e?.message ?? 'error' }, 500)
    }
  })
  r.get('/', async (c) => {
    const rows = await deps.repos.simRepo.listRuns()
    return c.json(jsonBig(rows))
  })
  r.get('/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const run = await deps.repos.simRepo.getRun(id)
    if (!run) return c.json({ error: 'not-found' }, 404)
    const days = await deps.repos.simRepo.listDays(id)
    const parsedDays = days.map((d: any) => ({
      ...d,
      planJson: JSON.parse(d.planJson),
      stateJson: JSON.parse(d.stateJson),
      eventsJson: JSON.parse(d.eventsJson),
    }))
    return c.json(jsonBig({ run, days: parsedDays }))
  })
  return r
}