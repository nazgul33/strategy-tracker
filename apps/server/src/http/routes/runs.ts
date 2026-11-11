import { Hono } from 'hono'
import { emptyState } from '@st/core'
import { parseUsd } from '@st/core/money'
import { progressView } from '@st/strategies'
import { seedRun, manualFill } from '../../domain/booking'
import type { RawFill } from '@st/ingest'
import { jsonBig, type HttpDeps } from '../app'

const SEED_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const MAX_PPM = 1_000_000
function isValidPpm(x: unknown): x is number {
  return Number.isInteger(x) && (x as number) >= 0 && (x as number) <= MAX_PPM
}

export const RUN_STATUSES_SERVER = ['active', 'paused', 'closed'] as const
export const RUN_TRANSITIONS: Record<string, string[]> = {
  active: ['paused', 'closed'],
  paused: ['active', 'closed'],
  closed: [],
}

// booking.seedRun overwrites state.cashCents unconditionally, so a seed
// missing (or with a fractional/negative) cashCents bricks the run server-side.
function validSeed(seed: any, bucketCount: number): boolean {
  if (typeof seed !== 'object' || seed === null || Array.isArray(seed)) return false
  if (!Number.isInteger(seed.cashCents) || seed.cashCents < 0) return false
  if (!Array.isArray(seed.buckets) || seed.buckets.length > bucketCount) return false
  for (const b of seed.buckets) {
    if (typeof b !== 'object' || b === null) return false
    if (!Number.isInteger(b.shares) || b.shares <= 0) return false
    if (typeof b.buyPrice !== 'string') return false
    let price: bigint
    try {
      price = parseUsd(b.buyPrice)
    } catch {
      return false
    }
    if (price < 0n) return false
    if (typeof b.filledOn !== 'string' || !SEED_DATE_RE.test(b.filledOn)) return false
  }
  return true
}

export function runsRouter(deps: HttpDeps): Hono {
  const r = new Hono()
  r.get('/runs', async (c) => {
    const rows = await deps.repos.runRepo.list()
    return c.json(rows)
  })
  r.post('/runs', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const name = body?.name
    const ticker = body?.ticker
    const costPpm = body?.costPpm
    const poolCents = body?.poolCents
    if (typeof name !== 'string' || name.trim() === '') return c.json({ error: 'invalid name' }, 400)
    if (typeof ticker !== 'string' || ticker.trim() === '') return c.json({ error: 'invalid ticker' }, 400)
    if (!Number.isInteger(costPpm) || costPpm < 0) return c.json({ error: 'invalid costPpm' }, 400)
    if (!Number.isInteger(poolCents) || poolCents <= 0) return c.json({ error: 'invalid poolCents' }, 400)
    const buyGapPpm = body?.buyGapPpm ?? 0
    const sellGapPpm = body?.sellGapPpm ?? 0
    if (!isValidPpm(buyGapPpm)) return c.json({ error: 'invalid buyGapPpm' }, 400)
    if (!isValidPpm(sellGapPpm)) return c.json({ error: 'invalid sellGapPpm' }, 400)
    const params = body?.params
    let bucketCount = 10
    if (params != null) {
      if (typeof params !== 'object' || Array.isArray(params)) return c.json({ error: 'invalid params' }, 400)
      const keys = Object.keys(params)
      for (const k of keys) {
        if (k !== 'bucketCount') return c.json({ error: 'unsupported param' }, 400)
      }
      if (params.bucketCount != null) {
        if (!Number.isInteger(params.bucketCount) || params.bucketCount <= 0) return c.json({ error: 'invalid bucketCount' }, 400)
        bucketCount = params.bucketCount
      }
    }
    const seed = body?.seed
    if (seed && !validSeed(seed, bucketCount)) return c.json({ error: 'invalid seed' }, 400)
    const state = emptyState(bucketCount)
    state.cashCents = poolCents
    const id = await deps.repos.runRepo.create({
      strategyKey: 'mean-reversion', ticker, name, poolCents, costPpm, buyGapPpm, sellGapPpm, initialRunState: state,
    })
    if (seed) {
      await seedRun(id, seed, { repos: deps.repos as any, today: deps.today() as any })
    }
    return c.json({ id }, 201)
  })
  r.post('/runs/bulk-status', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const ids = body?.ids
    const status = body?.status
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500
      || !ids.every((x: unknown) => Number.isInteger(x) && (x as number) > 0)) {
      return c.json({ error: 'invalid ids' }, 400)
    }
    if (!(RUN_STATUSES_SERVER as readonly string[]).includes(status)) return c.json({ error: 'invalid status' }, 400)
    // eligible sources = every status whose transition table allows -> status;
    // one batched UPDATE applies the same guard in SQL (see runRepo.updateStatusMany)
    const from = Object.keys(RUN_TRANSITIONS).filter((f) => RUN_TRANSITIONS[f]!.includes(status))
    return c.json({ updated: await deps.repos.runRepo.updateStatusMany(ids, from, status) })
  })
  r.get('/runs/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const run = await deps.repos.runRepo.get(id)
    if (!run) return c.json({ error: 'not found' }, 404)
    const state = await deps.repos.bucketRepo.loadState(id)
    const pv = progressView(state)
    return c.json(jsonBig({ ...run, progressView: pv, state }))
  })
  r.patch('/runs/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    const status = body?.status
    if (!(RUN_STATUSES_SERVER as readonly string[]).includes(status)) return c.json({ error: 'invalid status' }, 400)
    const run = await deps.repos.runRepo.get(id)
    if (!run) return c.json({ error: 'not found' }, 404)
    // `?? []` guards legacy `done` rows until the enum migration lands
    if (!(RUN_TRANSITIONS[run.status] ?? []).includes(status)) return c.json({ error: 'invalid transition' }, 409)
    await deps.repos.runRepo.updateStatus(id, status)
    return c.json({ ok: true })
  })
  r.post('/runs/:id/pool', async (c) => {
    const id = Number(c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    const amountCents = body?.amountCents
    if (!Number.isInteger(amountCents) || amountCents <= 0) return c.json({ error: 'invalid amountCents' }, 400)
    await deps.repos.runRepo.updatePool(id, amountCents)
    await deps.repos.poolEditRepo.insert({ runId: id, poolCents: amountCents })
    return c.json({ ok: true })
  })
  // gaps are editable in any run status (operator ruling): pure price-config edit
  r.post('/runs/:id/gaps', async (c) => {
    const id = Number(c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    if (!isValidPpm(body?.buyGapPpm) || !isValidPpm(body?.sellGapPpm)) return c.json({ error: 'invalid gaps' }, 400)
    const run = await deps.repos.runRepo.get(id)
    if (!run) return c.json({ error: 'not found' }, 404)
    await deps.repos.runRepo.updateGaps(id, body.buyGapPpm, body.sellGapPpm)
    return c.body(null, 204)
  })
  r.get('/runs/:id/orders', async (c) => {
    const id = Number(c.req.param('id'))
    const date = c.req.query('date')
    const rows = await deps.repos.orderRepo.listForRun(id, date)
    return c.json(jsonBig(rows))
  })
  r.get('/runs/:id/fills', async (c) => {
    const id = Number(c.req.param('id'))
    const rows = await deps.repos.fillRepo.listForRun(id)
    return c.json(jsonBig(rows))
  })
  r.get('/runs/:id/notifications', async (c) => {
    const id = Number(c.req.param('id'))
    const rows = await deps.repos.notificationRepo.listForRun(id)
    return c.json(rows)
  })
  r.post('/runs/:id/fills', async (c) => {
    const id = Number(c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    const fill = body as RawFill & { filledOn: string }
    try {
      await manualFill(id, fill, { repos: deps.repos as any, today: deps.today() as any })
    } catch (e: any) {
      return c.json({ error: e?.message ?? 'error' }, 422)
    }
    return c.json({ ok: true })
  })
  return r
}