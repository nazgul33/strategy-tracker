import { Hono, type Context } from 'hono'
import { DomainError } from '@st/core'
import { MarketDataError } from '@st/market-data'
import { runSim, updateSimRun } from '../../sim/sim'
import { isValidPpm, isValidCostPpm, isValidCutLossPpm } from '../../domain/ppm'
import { jsonBig, type HttpDeps } from '../app'

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/

type Validated = { ok: true; input: any } | { ok: false; error: string }

// Everything a simulation takes except the ticker: POST adds it from the body, PUT from the stored draft.
function validateConfig(body: any, defaultCostPpm: number): Validated {
  const name = body?.name
  const from = body?.from
  const to = body?.to
  const poolCents = body?.poolCents
  const costPpm = body?.costPpm === undefined ? defaultCostPpm : body.costPpm
  if (typeof name !== 'string' || name.trim() === '') return { ok: false, error: 'invalid name' }
  if (typeof from !== 'string' || !ISO_RE.test(from)) return { ok: false, error: 'invalid from' }
  if (typeof to !== 'string' || !ISO_RE.test(to)) return { ok: false, error: 'invalid to' }
  if (from > to) return { ok: false, error: 'invalid range' }
  if (!Number.isInteger(poolCents) || poolCents <= 0) return { ok: false, error: 'invalid poolCents' }
  if (!isValidCostPpm(costPpm)) return { ok: false, error: 'invalid costPpm' }
  const buyGapPpm = body?.buyGapPpm ?? 0
  const sellGapPpm = body?.sellGapPpm ?? 0
  if (!isValidPpm(buyGapPpm)) return { ok: false, error: 'invalid buyGapPpm' }
  if (!isValidPpm(sellGapPpm)) return { ok: false, error: 'invalid sellGapPpm' }
  const cutLossPpm = body?.cutLossPpm ?? 0
  if (!isValidCutLossPpm(cutLossPpm)) return { ok: false, error: 'invalid cutLossPpm' }
  const params = body?.params
  if (params != null) {
    if (typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid params' }
    if (params.bucketCount != null) {
      if (!Number.isInteger(params.bucketCount) || params.bucketCount < 1 || params.bucketCount > 50) return { ok: false, error: 'invalid bucketCount' }
    }
  }
  return { ok: true, input: { name, from, to, poolCents, costPpm, buyGapPpm, sellGapPpm, cutLossPpm, params } }
}

function validateCreate(body: any, defaultCostPpm: number): Validated {
  const ticker = body?.ticker
  if (typeof ticker !== 'string' || ticker.trim() === '') return { ok: false, error: 'invalid ticker' }
  const v = validateConfig(body, defaultCostPpm)
  return v.ok ? { ok: true, input: { ...v.input, ticker } } : v
}

function parseId(raw: string): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

export function simRouter(deps: HttpDeps): Hono {
  const r = new Hono()
  const sim = () => deps.repos.simRepo
  const fail = (c: Context, e: any) => {
    if (e instanceof DomainError) {
      if (e.kind === 'sim-not-found') return c.json({ error: 'not-found' }, 404)
      if (e.kind === 'sim-finalized') return c.json({ error: 'sim-finalized' }, 409)
      return c.json({ error: e.kind }, 422)
    }
    if (e instanceof MarketDataError) return c.json({ error: 'market-data:' + e.kind }, 502)
    return c.json({ error: e?.message ?? 'error' }, 500)
  }
  r.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const v = validateCreate(body, deps.defaultSettings.defaultCostPpm)
    if (!v.ok) return c.json({ error: v.error }, 400)
    try {
      const res = await runSim(v.input, { fetchDailyBars: deps.fetchDailyBars, repos: sim() })
      return c.json(res, 200)
    } catch (e: any) {
      return fail(c, e)
    }
  })
  r.get('/', async (c) => {
    const rows = await sim().listRuns()
    return c.json(jsonBig([...rows].sort((a, b) => b.id - a.id)))
  })
  r.get('/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    const run = id === null ? null : await sim().getRun(id)
    if (!run) return c.json({ error: 'not-found' }, 404)
    const days = await sim().listDays(run.id)
    const parsedDays = days.map((d: any) => ({
      ...d,
      planJson: JSON.parse(d.planJson),
      stateJson: JSON.parse(d.stateJson),
      eventsJson: JSON.parse(d.eventsJson),
    }))
    return c.json(jsonBig({ run, days: parsedDays }))
  })
  r.put('/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'not-found' }, 404)
    const body = await c.req.json().catch(() => ({}))
    const v = validateConfig(body, deps.defaultSettings.defaultCostPpm)
    if (!v.ok) return c.json({ error: v.error }, 400)
    try {
      return c.json(await updateSimRun(id, v.input, { fetchDailyBars: deps.fetchDailyBars, repos: sim() }), 200)
    } catch (e: any) {
      return fail(c, e)
    }
  })
  r.post('/:id/save', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null || !(await sim().getRun(id))) return c.json({ error: 'not-found' }, 404)
    if (!(await sim().finalize(id))) return c.json({ error: 'sim-finalized' }, 409)
    return c.body(null, 204)
  })
  r.delete('/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null || !(await sim().getRun(id))) return c.json({ error: 'not-found' }, 404)
    if (!(await sim().deleteRun(id))) return c.json({ error: 'sim-finalized' }, 409)
    return c.body(null, 204)
  })
  return r
}
