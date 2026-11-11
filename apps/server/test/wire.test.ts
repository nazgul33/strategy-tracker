import { parseEnv, todayEt } from './deps'
import { buildCaptureHandler } from '../src/wire/capture'
import type { CaptureAction } from '../src/wire/capture'
import { applyMigrations } from '../src/db/migrate'
import type { PendingFillRow, RunRow, RunState } from '../src/domain/booking'
import { myrToUsd } from '@st/core/money'
import { describe, expect, test } from 'bun:test'

type FakeRow = Record<string, unknown>
interface FakeTables {
  runs: FakeRow[]
  run_states: FakeRow[]
  orders: FakeRow[]
  fills: FakeRow[]
  capture_hashes: FakeRow[]
  pending_fills: FakeRow[]
  ledger: FakeRow[]
  notifications: FakeRow[]
}

function emptyState() {
  return {
    seedCashUsdMm: 0n,
    cashUsdMm: 0n,
    bucketOpen: false,
    bucketCloseAt: null,
    bucketClosePlannedAt: null,
    lastAction: null,
    lastActionAt: null,
    nextCheckAt: null,
    nextPeekAt: null,
  }
}

function makeFakes() {
  const t: FakeTables = {
    runs: [], run_states: [], orders: [], fills: [], capture_hashes: [], pending_fills: [], ledger: [], notifications: [],
  }
  const states = new Map<number, RunState>()
  let seq = 0
  const repos = {
    runRepo: {
      list: async () => t.runs,
      get: async (id: number) => t.runs.find((r) => r.id === id) ?? null,
      create: async (row: FakeRow) => {
        const id = ++seq
        t.runs.push({ id, name: row.name, ticker: row.ticker, mode: row.mode, status: row.status, createdAt: row.createdAt })
        return id
      },
      updateStatus: async (id: number, status: string, at: string) => {
        const r = t.runs.find((x) => x.id === id)
        if (r) r.status = status
      },
    },
    bucketRepo: {
      loadState: async (runId: number) => states.get(runId) ?? null,
      saveState: async (runId: number, s: RunState, changedAt: string) => {
        states.set(runId, s)
        t.run_states.push({ run_id: runId, bucket_open: s.bucketOpen ? 1 : 0 })
      },
    },
    orderRepo: {
      insertMany: async (rows: FakeRow[]) => t.orders.push(...rows),
      listForDate: async (d: string) => t.orders.filter((o) => o.suggestedDate === d),
      markStale: async (d: string) => {
        for (const o of t.orders) if (o.suggestedDate < d) o.status = 'stale'
      },
      setStatus: async (ids: number[], status: string) => {
        for (const o of t.orders) if (ids.includes(o.id as number)) o.status = status
      },
      listOpenBefore: async (d: string) => t.orders.filter((o) => o.suggestedDate < d && o.status !== 'stale'),
    },
    fillRepo: { insert: async (row: FakeRow) => { t.fills.push(row); return row.id as number } },
    pendingRepo: {
      insert: async (row: FakeRow) => {
        const id = ++seq
        t.pending_fills.push({ ...row, id, status: 'pending' })
        return id
      },
      listPending: async () => t.pending_fills.filter((p) => p.status === 'pending'),
      decide: async (id: number, status: string, edited?: unknown) => {
        const p = t.pending_fills.find((x) => x.id === id)
        if (p) { p.status = status; if (edited) p.editedJson = edited }
      },
    },
    captureRepo: {
      hasHash: async (runId: number, h: string) => t.capture_hashes.some((c) => c.run_id === runId && c.imageHash === h),
      insert: async (runId: number, h: string) => {
        if (t.capture_hashes.some((c) => c.run_id === runId && c.imageHash === h)) return { inserted: false }
        const id = ++seq
        t.capture_hashes.push({ id, run_id: runId, imageHash: h })
        return { inserted: true, id }
      },
    },
    ledgerRepo: { insert: async (row: FakeRow) => t.ledger.push(row) },
    notificationRepo: { insert: async (row: FakeRow) => t.notifications.push(row) },
  }
  return { t, states, repos }
}

async function seedActiveRun(f: ReturnType<typeof makeFakes>, id: number, ticker: string) {
  const at = '2026-01-02T00:00:00.000Z'
  await f.repos.runRepo.create({ name: `run-${id}`, ticker, mode: 'live', status: 'active', createdAt: at })
  f.states.set(id, { ...emptyState(), seedCashUsdMm: 10_000_000n, cashUsdMm: 10_000_000n })
}

// Deterministic image bytes per name → distinct hashes per distinct name.
const img = (name: string) => new TextEncoder().encode(`png:${name}`)
const png = { name: 'shot.png', type: 'image/png', arrayBuffer: async () => img('shot').buffer }

function fakeExtract(
  fills: { side: 'buy' | 'sell'; ticker: string; shares: number; price: string }[],
  note: string | null = 'looks fine',
) {
  return async () => ({
    raw: { fills, note, bucket_open: null, close_date: null, sell_tickers: null, reason: null },
    confidence: 'high',
    warnings: [],
  })
}

async function login(app: { request: (path: string, init?: RequestInit) => Promise<Response> }) {
  const res = await app.request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'hunter2' }),
  })
  expect(res.status).toBe(200)
  const token = (await res.json()).token as string
  return { headers: { authorization: `Bearer ${token}` } }
}

function makeHttpDeps(repos: ReturnType<typeof makeFakes>['repos']) {
  return {
    repos: {
      ...repos,
      settingsRepo: { get: async () => null, upsert: async () => {} },
      poolEditRepo: {
        get: async () => null,
        apply: async () => ({ ok: true }),
        add: async () => ({ ok: true }),
        delete: async () => ({ ok: true }),
      },
      simRepo: {
        listRuns: async () => [],
        listFillEvents: async () => [],
        listLedger: async () => [],
        listNotifications: async () => [],
        insertRun: async () => {},
        insertEvents: async () => {},
        insertLedger: async () => {},
        insertNotifications: async () => {},
      },
    },
    password: 'hunter2',
    sessionSecret: 's'.repeat(32),
    today: () => '2026-01-05',
    defaultSettings: { visionBaseUrl: 'http://llm.test/v1', visionModel: 'm1' },
    triggerMorning: async () => ({ orders: 0, notifications: 0, status: 'ok' as const }),
    fetchDailyBars: async () => {
      throw new Error('unused in wire tests')
    },
  }
}

function makeCaptureEnv(f: ReturnType<typeof makeFakes>) {
  const sent: { chatId: string; text: string; keyboard?: unknown }[] = []
  const handlers: Record<string, (u: unknown) => Promise<void>> = {}
  let captureHandler: ((photo: { file_id: string }, text?: string) => Promise<void>) | null = null
  const env = {
    sent,
    get handlers() { return handlers },
    get capture() { return captureHandler },
  }
  const make = (extract: (image: unknown) => Promise<unknown>) => ({
    repos: f.repos as never,
    visionBaseUrl: 'https://llm.test/v1',
    visionApiKey: 'k',
    visionModel: 'vision-test',
    allowedChatIds: ['111'],
    today: () => '2026-01-05',
    extract,
    fetchImpl: (async () => {
      throw new Error('no direct fetch in capture path')
    }) as unknown as typeof fetch,
    api: {
      sendMessage: async (chatId: string, text: string, keyboard?: unknown) => {
        sent.push({ chatId, text, keyboard })
        return { message_id: 9 }
      },
      sendPhoto: async () => ({ message_id: 10 }),
      onText: (cmd: string, h: (u: unknown) => Promise<void>) => { handlers[cmd] = h },
      onPhoto: (h: (photo: { file_id: string }, text?: string) => Promise<void>) => { captureHandler = h },
      onCallback: async (_p: string, h: (u: unknown) => Promise<void>) => { handlers[_p] = h },
      getFileUrl: async () => 'https://tg.test/photo.png',
      runPolling: async () => {},
      setCommands: async () => {},
    },
  })
  return { env, make }
}

const okFills = fakeExtract([{ side: 'buy', ticker: 'NVDA', shares: 10, price: '180.50' }]) as unknown as (
  image: unknown,
) => Promise<import('../src/wire/capture').ExtractResult>

const badExtract = (async () => {
  throw new Error('vision model offline')
}) as unknown as (image: unknown) => Promise<import('../src/wire/capture').ExtractResult>

describe('parseEnv', () => {
  test('missing required vars produce ONE error naming them all', () => {
    let err = ''
    try {
      parseEnv({})
    } catch (e) {
      err = e instanceof Error ? e.message : String(e)
    }
    expect(err).not.toBe('')
    expect(err).toContain('DATABASE_URL')
    expect(err).toContain('APP_PASSWORD')
    expect(err).toContain('SESSION_SECRET')
    expect((err.match(/required/i) ?? []).length).toBe(1)
  })

  test('defaults: port 8080, digest lang en, no telegram', () => {
    const cfg = parseEnv({ DATABASE_URL: 'x', APP_PASSWORD: 'p', SESSION_SECRET: 's' })
    expect(cfg.port).toBe(8080)
    expect(cfg.digestLang).toBe('en')
    expect(cfg.telegram).toBeNull()
  })

  test('telegram requires all four companions', () => {
    expect(() => parseEnv({ DATABASE_URL: 'x', APP_PASSWORD: 'p', SESSION_SECRET: 's', TELEGRAM_BOT_TOKEN: 't' })).toThrow()
    const cfg = parseEnv({
      DATABASE_URL: 'x',
      APP_PASSWORD: 'p',
      SESSION_SECRET: 's',
      TELEGRAM_BOT_TOKEN: 't',
      TELEGRAM_ALLOWED_CHAT_IDS: '1,2',
      VISION_BASE_URL: 'https://llm/v1',
      VISION_API_KEY: 'k',
      VISION_MODEL: 'm',
    })
    expect(cfg.telegram).not.toBeNull()
    expect(cfg.telegram?.allowedChatIds).toEqual(['1', '2'])
    expect(cfg.telegram?.visionModel).toBe('m')
  })
})

describe('todayEt', () => {
  const at = (ms: number) => () => new Date(ms)
  test('2025-12-31T04:30:00Z -> 2025-12-31', () => expect(todayEt(at(1767155400000))).toBe('2025-12-31'))
  test('2026-01-01T05:30:00Z -> 2026-01-01', () => expect(todayEt(at(1767274200000))).toBe('2026-01-01'))
})

describe('capture handler (telegram photo -> pending fill)', () => {
  test('photo with run id books a pending fill and replies with the confirm card', async () => {
    const f = makeFakes()
    await seedActiveRun(f, 1, 'NVDA')
    const { env, make } = makeCaptureEnv(f)
    buildCaptureHandler(make(okFills))
    await env.capture!(png, '1')
    expect(f.t.pending_fills).toHaveLength(1)
    const p = f.t.pending_fills[0] as unknown as PendingFillRow
    expect(p.runId).toBe(1)
    expect(p.shares).toBe(10)
    expect(p.priceUsdMm).toBe(180_500_000n)
    expect(env.sent).toHaveLength(1)
    expect(env.sent[0].chatId).toBe('111')
    expect(env.sent[0].text).toContain('NVDA')
    expect(env.sent[0].text).toContain('10')
    expect(env.sent[0].text).toContain('180.50')
    expect(env.sent[0].keyboard).toEqual({
      inline_keyboard: [[{ text: '✅ Book it', callback_data: 'capture:yes:2' }, { text: '❌ Reject', callback_data: 'capture:no:2' }]],
    })
  })

  test('same photo twice for one run: second reply is the duplicate line, row stored once', async () => {
    const f = makeFakes()
    await seedActiveRun(f, 1, 'NVDA')
    const { env, make } = makeCaptureEnv(f)
    buildCaptureHandler(make(okFills))
    await env.capture!(png, '1')
    await env.capture!(png, '1')
    expect(f.t.pending_fills).toHaveLength(1)
    expect(env.sent.map((s) => s.text)).toEqual([
      'Booked: buy NVDA 10 @ $180.50',
      'Duplicate — this screenshot is already booked for this run.',
    ])
  })

  test('photo without an id: single matching run books it; zero and two runs get their own lines', async () => {
    const f = makeFakes()
    await seedActiveRun(f, 1, 'NVDA')
    const { env, make } = makeCaptureEnv(f)
    buildCaptureHandler(make(okFills))
    await env.capture!(png) // no runId in caption, NVDA matches run 1
    expect(env.sent[0].text).toContain('NVDA')
    expect(f.t.pending_fills[0].runId).toBe(1)

    const g = makeFakes()
    const env2 = makeCaptureEnv(g)
    buildCaptureHandler(env2.make(okFills))
    await env2.capture!(png) // no runs at all
    expect(env2.sent[0].text).toBe('No active run matches — send "/capture <runId> <photo>".')
    expect(g.t.pending_fills).toHaveLength(0)

    const h = makeFakes()
    await seedActiveRun(h, 1, 'NVDA')
    await seedActiveRun(h, 2, 'NVDA')
    const env3 = makeCaptureEnv(h)
    buildCaptureHandler(env3.make(okFills))
    await env3.capture!(png)
    expect(env3.sent[0].text).toBe('Two active runs match — reply "/capture <runId> <photo>" with the run id.')
    expect(h.t.pending_fills).toHaveLength(0)
  })

  test('extract failure: error line, nothing stored, notification recorded', async () => {
    const f = makeFakes()
    await seedActiveRun(f, 1, 'NVDA')
    const { env, make } = makeCaptureEnv(f)
    buildCaptureHandler(make(badExtract))
    await env.capture!(png, '1')
    expect(env.sent[0].text).toBe('Could not parse this screenshot — check the vision model settings.')
    expect(f.t.pending_fills).toHaveLength(0)
    expect(f.t.capture_hashes).toHaveLength(0)
    expect(f.t.notifications).toHaveLength(1)
    expect(f.t.notifications[0].type).toBe('capture-bad-extract')
  })

  test('capture callback: yes books the fill + ledger and flips the suggested order; no rejects it', async () => {
    const f = makeFakes()
    await seedActiveRun(f, 1, 'NVDA')
    f.states.set(1, { ...f.states.get(1)!, bucketOpen: true, cashUsdMm: 10_000_000n - 1_805_000_000n })
    const { env, make } = makeCaptureEnv(f)
    buildCaptureHandler(make(okFills))
    await env.capture!(png, '1')
    const pid = f.t.pending_fills[0].id as number

    const handlers = env.handlers
    await handlers['capture:yes:1']({ id: `u${pid}`, message: { chat: { id: 111 } }, data: `capture:yes:1` })
    expect(f.t.pending_fills[0].status).toBe('confirmed')
    expect(f.t.fills).toHaveLength(1)
    expect(f.t.fills[0].side).toBe('buy')
    expect(f.t.fills[0].ticker).toBe('NVDA')
    expect(f.t.fills[0].priceUsdMm).toBe(180_500_000n)
    expect(f.t.ledger).toHaveLength(1)
    expect(f.t.ledger[0].amountCents).toBe(-18050)
    expect(f.t.orders[0].status).toBe('booked')
    const last = env.sent[env.sent.length - 1].text
    expect(last).toContain('NVDA')
    expect(last).toContain('10')
    expect(last).toContain('180.50')

    // second yes: pending row is no longer pending → error line only
    const before = env.sent.length
    await handlers['capture:yes:1']({ id: `u${pid}`, message: { chat: { id: 111 } }, data: `capture:yes:1` })
    expect(env.sent.length).toBe(before + 1)
    expect(env.sent[env.sent.length - 1].text).toBe('Could not parse this screenshot — check the vision model settings.')

    // reject path mirrors POST /api/pending/:id/reject
    const g = makeFakes()
    await seedActiveRun(g, 1, 'NVDA')
    const env2 = makeCaptureEnv(g)
    buildCaptureHandler(env2.make(okFills))
    await env2.capture!(png, '1')
    const pid2 = g.t.pending_fills[0].id as number
    await env2.handlers[`capture:no:${pid2}`]({ id: `u${pid2}`, message: { chat: { id: 111 } }, data: `capture:no:${pid2}` })
    expect(g.t.pending_fills[0].status).toBe('rejected')
    expect(g.t.fills).toHaveLength(0)
  })

  test('the /capture text command explains the usage', async () => {
    const f = makeFakes()
    const { env, make } = makeCaptureEnv(f)
    buildCaptureHandler(make(okFills))
    await env.handlers['capture']({ message: { chat: { id: 111 }, text: '/capture' } })
    expect(env.sent[0].text).toContain('photo')
  })
})

describe('http surface (wired deps shape)', () => {
  test('health is public; every other api route is 401 without a token', async () => {
    const f = makeFakes()
    const { createApp } = await import('../src/http/app')
    const app = createApp(makeHttpDeps(f.repos))
    const health = await app.request('/api/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })
    for (const p of ['/api/runs', '/api/runs/1/ledger', '/api/pending', '/api/settings', '/api/sim/runs']) {
      expect((await app.request(p)).status).toBe(401)
    }
    const auth = await login(app)
    expect((await app.request('/api/runs', auth)).status).toBe(200)
  })

  test('PUT /api/settings persists the telegram chat id and vision settings', async () => {
    const f = makeFakes()
    let saved: Record<string, unknown> | null = null
    const deps = {
      ...makeHttpDeps(f.repos),
      repos: {
        ...makeHttpDeps(f.repos).repos,
        settingsRepo: {
          get: async () => null,
          upsert: async (row: Record<string, unknown>) => { saved = row },
        },
      },
    }
    const { createApp } = await import('../src/http/app')
    const app = createApp(deps)
    const auth = await login(app)
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth.headers },
      body: JSON.stringify({
        visionBaseUrl: 'https://llm.example/v1',
        visionApiKey: 'sk-abc123456789',
        visionModel: 'gpt-4o',
        digestLang: 'ko',
        telegramChatId: '987654',
      }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(saved).not.toBeNull()
    expect(saved!.telegramChatId).toBe('987654')
    expect(saved!.visionApiKey).toBe('sk-abc123456789')
    expect(saved!.digestLang).toBe('ko')
    const masked = await app.request('/api/settings', auth)
    expect(await masked.json()).toEqual({
      visionBaseUrl: 'https://llm.example/v1',
      visionApiKeyMasked: '…456789',
      visionModel: 'gpt-4o',
      digestLang: 'ko',
      telegramChatId: '987654',
    })
  })
})
