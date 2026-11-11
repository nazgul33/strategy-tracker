/**
 * Operator end-to-end smoke test against a throwaway scratch database.
 *
 * Prereq (see AGENTS.md "Test matrix"): the MariaDB test container is up.
 * Run from the repo ROOT (applyMigrations resolves apps/server/db/migrations from cwd):
 *
 *   TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/st_test bun scripts/e2e.ts
 *
 * One process, real wiring, loopback-only network (MariaDB + our own fake vision
 * endpoint on 127.0.0.1). Bars, closes and the calendar cross-check are injected —
 * nothing here touches Yahoo or howmanytradingdays.com.
 *
 * Flow: scratch DB st_e2e_<ts> (created + always dropped) → migrations → login
 * through the real Hono app → seeded run create → photo capture through
 * wire/capture against a fake vision model → duplicate guard → HTTP pending
 * confirm → state asserts → morning digest → web viewmodels → deterministic sim.
 * Exit 0 = every pinned assertion below held.
 */
import { getDb, closeDb, applyMigrations } from '../apps/server/src/db/client'
import { getRepos } from '../apps/server/src/db/repos'
import { createApp, type HttpDeps } from '../apps/server/src/http/app'
import { makeCaptureHandlers } from '../apps/server/src/wire/capture'
import { runMorningPipeline, type DayDeps } from '../apps/server/src/pipeline/day'
import { runSim, simulateDays } from '../apps/server/src/sim/sim'
import { bucketCells } from '../apps/web/src/viewmodels'
import { prevTradingDay, type ISODate } from '../packages/calendar/src/index'
import { DEFAULT_MR_PARAMS } from '../packages/strategies/src/mean-reversion'
import type { OHLCBar } from '../packages/market-data/src/yahoo'
import { parseUsd } from '../packages/core/src/money'

let checks = 0
function ok(cond: unknown, label: string): void {
  if (!cond) throw new Error(`E2E FAILED: ${label}`)
  checks++
  console.log(`  ok  ${label}`)
}
const jsonOf = async (r: Response): Promise<any> => r.json()

// ---- fixtures ------------------------------------------------------------
const PASSWORD = 'e2e-password'
const SECRET = 'e2e-session-secret'
const TODAY: ISODate = '2026-11-09' // Monday
const PREV: ISODate = prevTradingDay(TODAY) // previous open = Friday 2026-11-06
const IMG = { base64: 'ZTJlLWZhZ2UtcG5n', mime: 'image/png' } // 'e2e-fake-png'
const VISION_FILLS = [{ side: 'buy', ticker: 'NVDA', shares: 30, price: '179.50', fee: '0.50' }]

// deterministic sim bars (myriadths via parseUsd); 4 bars → 3 sim days
const BAR_FIXTURE: [ISODate, string, string, string, string][] = [
  ['2026-11-06', '340.22', '346.83', '339.23', '346.38'],
  ['2026-11-09', '342.00', '352.83', '337.08', '350.00'],
  ['2026-11-10', '348.00', '355.40', '345.10', '351.20'],
  ['2026-11-12', '349.00', '358.90', '348.50', '355.00'],
]
const BARS: OHLCBar[] = BAR_FIXTURE.map(([date, o, h, l, c]) => ({
  date, open: parseUsd(o), high: parseUsd(h), low: parseUsd(l), close: parseUsd(c),
}))

async function main(): Promise<void> {
  const parentUrl = process.env.TEST_DATABASE_URL ?? ''
  if (!/^mysql(2)?:\/\//.test(parentUrl)) {
    console.error('TEST_DATABASE_URL is required, e.g. mysql://root:test@127.0.0.1:3307/st_test')
    process.exit(1)
  }
  const u = new URL(parentUrl)
  const SCRATCH = `st_e2e_${Date.now().toString(36)}`
  const scratchUrl = `${u.protocol}//${u.username}:${u.password}@${u.host}/${SCRATCH}`

  const visionHits: any[] = []
  const vision = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      visionHits.push(await req.json().catch(() => null))
      return Response.json({ choices: [{ message: { content: JSON.stringify({ fills: VISION_FILLS }) } }] })
    },
  })
  console.log(`fake vision on http://127.0.0.1:${vision.port}/v1`)

  try {
    // ---- scratch database + migrations -------------------------------------
    ok(/^st_e2e_[a-z0-9]+$/.test(SCRATCH), `scratch db name '${SCRATCH}' matches st_e2e_*`)
    let db: Awaited<ReturnType<typeof getDb>> = await getDb(parentUrl)
    await db.$client.query(`CREATE DATABASE \`${SCRATCH}\``)
    await closeDb()
    db = await getDb(scratchUrl)
    await applyMigrations(db)
    const repos = getRepos(db)
    console.log(`  ok  migrations applied on fresh scratch db '${SCRATCH}'`)

    // ---- HTTP app (real Hono wiring, injected fakes) -------------------------
    const httpDeps: HttpDeps = {
      repos,
      password: PASSWORD,
      sessionSecret: SECRET,
      today: () => TODAY,
      defaultSettings: { visionBaseUrl: `http://127.0.0.1:${vision.port}/v1`, visionModel: 'e2e-vision', digestLang: 'en' },
      triggerMorning: async () => 'sent',
      fetchDailyBars: async () => [],
    }
    const app = createApp(httpDeps)
    const req = (method: string, path: string, body?: unknown, token?: string) =>
      app.request(`/api${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })

    const badLogin = await req('POST', '/login', { password: 'wrong' })
    ok(badLogin.status === 401 && (await jsonOf(badLogin)).error === 'invalid password', 'wrong password -> 401 invalid password')
    const gated = await req('GET', '/runs/1')
    ok(gated.status === 401 && (await jsonOf(gated)).error === 'unauthorized', 'no token -> 401 unauthorized')
    const login = await req('POST', '/login', { password: PASSWORD })
    ok(login.status === 200, 'login -> 200')
    const { token } = (await jsonOf(login)) as { token: string }
    ok((login.headers.get('set-cookie') ?? '').includes('st_session='), 'login also sets st_session cookie')

    // ---- run create via HTTP (seeded first bucket) ----------------------------
    const badSeed = await req('POST', '/runs', { name: 'X', ticker: 'NVDA', poolCents: 100, costPpm: 1000, seed: { cashCents: -5, buckets: [] } }, token)
    ok(badSeed.status === 400 && (await jsonOf(badSeed)).error === 'invalid seed', 'seed with negative cash -> 400 invalid seed')
    const created = await req('POST', '/runs', {
      name: 'E2E NVDA',
      ticker: 'NVDA',
      poolCents: 1_000_000,
      costPpm: 1_000,
      seed: { cashCents: 700_000, buckets: [{ shares: 32, buyPrice: '178.50', filledOn: PREV }] },
    }, token)
    ok(created.status === 201, 'POST /api/runs (seeded) -> 201')
    const { id: runId } = (await jsonOf(created)) as { id: number }

    const detail = await jsonOf(await req('GET', `/runs/${runId}`, undefined, token))
    ok(detail.state.buckets.length === 10, 'default bucketCount is 10')
    const sb = detail.state.buckets[0]
    ok(sb.shares === 32 && sb.buyPrice === '1785000' && sb.filledOn === PREV,
      `seed bucket 0: 32 sh, buyPrice '1785000' myriadths-string, filledOn ${PREV}`)
    ok(detail.state.cashCents === 700_000 && detail.progressView.heldCount === 1, 'seeded cash 700000, heldCount 1')

    // ---- photo capture through wire/capture → fake vision → pending row ------
    const captureMsgs: string[] = []
    const capture = makeCaptureHandlers({
      repos,
      vision: { baseUrl: `http://127.0.0.1:${vision.port}/v1`, model: 'e2e-vision' },
      getVisionApiKey: async () => 'e2e-key',
      today: () => TODAY,
      send: async (_chatId: string, text: string) => { captureMsgs.push(text) },
    })
    await capture.onPhoto('chat-1', IMG, 'NVDA 11/9 broker fill') // no run id in caption -> ticker auto-route
    ok(captureMsgs.some((m) => m === 'Booked NVDA buy 30 sh @ $179.50 — confirm?'), 'capture-booked message verbatim')
    const pend = await repos.pendingRepo.listPending()
    ok(pend.length === 1 && pend[0]!.side === 'buy' && pend[0]!.shares === 30 &&
      pend[0]!.price === 1795000n && pend[0]!.fee === 50, 'pending row: buy 30 sh, price 1795000n (bigint), fee 50c')
    await capture.onPhoto('chat-1', IMG, 'NVDA 11/9 broker fill')
    ok(captureMsgs.some((m) => m === 'Duplicate capture — already booked.'), 'same photo again -> duplicate-capture message')
    ok((await repos.pendingRepo.listPending()).length === 1, 'duplicate created no second pending row')
    ok(visionHits.length === 2 && visionHits[0]!.model === 'e2e-vision',
      'both photos hit fake vision (hash guard runs after extraction), model echoed')

    // ---- confirm through HTTP, assert booked state ---------------------------
    const pendingWire = await jsonOf(await req('GET', '/pending', undefined, token))
    ok(pendingWire.length === 1 && pendingWire[0].price === '1795000', 'GET /api/pending serialises bigint price as string')
    const confirm = await req('POST', `/pending/${pendingWire[0].id}/confirm`, {}, token)
    ok(confirm.status === 200, 'POST /api/pending/:id/confirm -> 200')
    const reConfirm = await req('POST', `/pending/${pendingWire[0].id}/confirm`, {}, token)
    ok(reConfirm.status === 422 && (await jsonOf(reConfirm)).error === 'pending-not-found-or-not-pending', 'second confirm -> 422')
    const cookieResp = await app.request(`/api/runs/${runId}`, { headers: { cookie: `st_session=${encodeURIComponent(token)}` } })
    ok(cookieResp.status === 200, 'st_session cookie also authenticates')
    const after = await jsonOf(await req('GET', `/runs/${runId}`, undefined, token))
    const cb = after.state.buckets[1]
    ok(cb.shares === 30 && cb.buyPrice === '1795000' && cb.filledOn === TODAY, 'confirmed fill booked into bucket 1')
    ok(after.state.cashCents === 161_450, 'cash = 700000 - cost 538500 - fee 50 (extracted pending fee kept on confirm)')
    ok(after.progressView.heldCount === 2, 'heldCount 2 after confirm')

    // ---- morning pipeline (injected closes + crossCheck) ----------------------
    const sent: { chat: string; text: string }[] = []
    const dayDeps: DayDeps = {
      today: () => TODAY,
      fetchLastClose: async () => ({ date: PREV, close: parseUsd('180.00') }),
      crossCheck: async () => ({ agree: true }),
      send: async (chatId: string, text: string) => { sent.push({ chat: chatId, text }) },
      allowedChatIds: ['chat-1'],
      repos,
      params: () => DEFAULT_MR_PARAMS,
      digestLang: 'en',
    }
    const morning = await runMorningPipeline(dayDeps)
    ok(morning === 'sent', 'runMorningPipeline -> sent')
    ok(sent.length > 0 && sent.every((s) => s.chat === 'chat-1'), 'digest delivered to allowed chat only')
    const digest = sent.map((s) => s.text).join('\n')
    console.log('--- digest as sent ---\n' + digest + '\n--------------------')
    ok(digest.includes('E2E NVDA  NVDA'), 'digest header verbatim')
    ok(digest.includes(`Trade date: ${TODAY}  Last close: 180.00 (${PREV})`), 'digest trade-date line verbatim')
    ok(digest.includes('Buy  LOC  5 sh  @ 179.99  → bucket 2'), 'digest buy_loc line: 5 sh @ 179.99 (close−tick) into lowest empty bucket 2')
    ok(digest.includes('Sell  LOC  32 sh  @ 178.867  → bucket 0'), 'digest sell_loc line for seeded bucket 0')
    ok(digest.includes('Sell  LOC  30 sh  @ 179.869  → bucket 1'), 'digest sell_loc line for captured bucket 1')
    const aged = await jsonOf(await req('GET', `/runs/${runId}`, undefined, token))
    ok(aged.state.buckets[0].state === 'held' && aged.state.ages['0'] === 2, 'morning advanceDay aged seeded bucket 0 to 2')

    // ---- web viewmodels on the live wire payload -----------------------------
    const cells = bucketCells(aged.state.buckets, aged.state.ages, 10, DEFAULT_MR_PARAMS.maxAgeDays)
    ok(cells.length === 10, 'bucketCells renders all 10 buckets')
    const heldCells = cells.filter((c) => c.filled)
    ok(heldCells.length === 2 && heldCells[0]!.index === 0 && heldCells[0]!.state === 'held' &&
      heldCells[0]!.shares === 32 && heldCells[0]!.buyPrice === '1785000' &&
      heldCells[0]!.notionalCents === 571_200 && heldCells[0]!.ageDays === 2 && !heldCells[0]!.forceSell,
      'cell 0: 32 sh, buyPrice 1785000, notional 571200c, age 2, no forceSell')
    ok(heldCells[1]!.index === 1 && heldCells[1]!.shares === 30 && heldCells[1]!.buyPrice === '1795000' &&
      heldCells[1]!.ageDays === 1, 'cell 1: captured fill 30 sh, age 1 (booked today, aged once by morning run)')

    // ---- deterministic sim (fixture bars, pure + persisted) ------------------
    const simRun = { id: 0, name: 'E2E Sim', ticker: 'NVDA', strategyKey: 'mean-reversion' as const, costPpm: 1_000, poolCents: 1_000_000, status: 'active' as const }
    const days = simulateDays(simRun, DEFAULT_MR_PARAMS, BARS)
    ok(days.map((d) => d.date).join(',') === '2026-11-09,2026-11-10,2026-11-12', '3 sim days from 4 bars')
    ok(days[0]!.fills.length === 1 && days[0]!.fills[0]!.side === 'buy' && days[0]!.fills[0]!.bucketIndex === 0 &&
      days[0]!.fills[0]!.shares === 2 && days[0]!.fills[0]!.price === 3420000n && days[0]!.fills[0]!.feeCents === 68,
      'day1: buy 2 sh @ 342.00 fee 68c')
    ok(days[1]!.fills.length === 2 && days[1]!.cashCents === 931_392, 'day2: sell bucket 0 + buy bucket 1, cash 931392')
    const lastDay = days[2]!
    ok(lastDay.fills.length === 3 && lastDay.fills[2]!.side === 'sell' && lastDay.fills[2]!.price === 3550000n,
      'day3: forced exit liquidates held bucket at last close 355.00')
    ok(lastDay.heldCount === 0 && lastDay.cashCents === 1_002_181, 'sim ends flat with cash 1002181')
    const simSaved = await runSim(
      { name: 'E2E Sim', ticker: 'NVDA', from: '2026-11-06', to: '2026-11-12', poolCents: 1_000_000, costPpm: 1_000 },
      { fetchDailyBars: async () => BARS, repos: repos.simRepo },
    )
    ok(simSaved.id >= 1 && simSaved.dayCount === 3, 'runSim persists sim run + 3 day rows')

    // ---- teardown + idempotency proof -----------------------------------------
    await closeDb()
    const parent = await getDb(parentUrl)
    await parent.$client.query(`DROP DATABASE \`${SCRATCH}\``)
    const [left] = (await parent.$client.query(`SHOW DATABASES LIKE 'st\\_e2e\\_%'`)) as [any[], unknown]
    await closeDb()
    ok(left.length === 0, 'no st_e2e_* databases left on the server after the run')
    console.log(`e2e OK — ${checks} assertions passed`)
  } finally {
    vision.stop(true)
    try { await closeDb() } catch { /* already closed */ }
    try {
      const p = await getDb(parentUrl)
      await p.$client.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``)
      await closeDb()
    } catch { /* scratch drop is best-effort on failure paths */ }
  }
}

try {
  await main()
} catch (err) {
  console.error(err)
  process.exitCode = 1
}
