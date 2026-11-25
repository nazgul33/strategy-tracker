import { describe, test, expect } from 'bun:test'
import { createRun } from './http-fakes'
import { newVrRun, seedCycle, seedFill, vrSetup } from './vr-http-fixture'

const BASE = { name: 'vr', ticker: 'TQQQ', cashCents: 1_000_000 }

describe('GET /api/vr', () => {
  test('401 without a token', async () => {
    const { app } = await vrSetup()
    expect((await app.request('/api/vr/runs')).status).toBe(401)
  })
})

describe('POST /api/vr/runs', () => {
  test('applies the defaults and books the opening cash today', async () => {
    const s = await vrSetup()
    const res = await s.req('POST', '/api/vr/runs', BASE)
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ id: s.f.vr.runs[0]!.id })
    expect(s.f.vr.runs[0]).toMatchObject({ g: 10, formula: 'skill', bandPpm: 150_000, spendLimitPpm: 500_000, cycleDepositCents: 0, costPpm: 700, initialVCents: 500_000, ticker: 'TQQQ', name: 'vr' })
    expect(s.f.vr.cash).toHaveLength(1)
    expect(s.f.vr.cash[0]).toMatchObject({ kind: 'open', amountCents: 1_000_000, movedOn: '2026-11-10', cycleId: null })
  })

  test('honours every supplied field', async () => {
    const s = await vrSetup()
    await newVrRun(s, { initialStockCents: 300_000, g: 20, formula: 'basic', bandPpm: 100_000, spendLimitPpm: 0, cycleDepositCents: -5_000, costPpm: 0 })
    expect(s.f.vr.runs[0]).toMatchObject({ g: 20, formula: 'basic', bandPpm: 100_000, spendLimitPpm: 0, cycleDepositCents: -5_000, costPpm: 0, initialVCents: 300_000 })
  })

  test('the default stock share is checked after it is applied', async () => {
    const s = await vrSetup()
    expect(await s.req('POST', '/api/vr/runs', { ...BASE, cashCents: 1 })).toEqual({ status: 400, body: { error: 'invalid initialStockCents' } })
  })

  const bad: [string, Record<string, unknown>][] = [
    ['name', { name: ' ' }], ['name', { name: 5 }], ['ticker', { ticker: '' }], ['ticker', { ticker: undefined }],
    ['cashCents', { cashCents: 0 }], ['cashCents', { cashCents: 1.5 }], ['cashCents', { cashCents: '100' }],
    ['initialStockCents', { initialStockCents: 0 }], ['initialStockCents', { initialStockCents: 1_000_001 }], ['initialStockCents', { initialStockCents: 1.5 }],
    ['g', { g: 0 }], ['g', { g: 1001 }], ['g', { g: 1.5 }],
    ['formula', { formula: 'x' }], ['bandPpm', { bandPpm: 0 }], ['bandPpm', { bandPpm: 1_000_000 }],
    ['spendLimitPpm', { spendLimitPpm: -1 }], ['spendLimitPpm', { spendLimitPpm: 1_000_001 }],
    ['cycleDepositCents', { cycleDepositCents: 1.5 }], ['cycleDepositCents', { cycleDepositCents: 'a' }],
    ['costPpm', { costPpm: 5 }], ['costPpm', { costPpm: 1_000_010 }],
  ]
  for (const [field, patch] of bad) {
    test(`rejects a bad ${field}: ${JSON.stringify(patch)}`, async () => {
      const s = await vrSetup()
      expect(await s.req('POST', '/api/vr/runs', { ...BASE, ...patch })).toEqual({ status: 400, body: { error: `invalid ${field}` } })
      expect(s.f.vr.runs).toHaveLength(0)
    })
  }

  test('a name held by an MR run or another VR run is a 409', async () => {
    const s = await vrSetup()
    await createRun(s.app, s.auth, { name: 'mr', ticker: 'AAPL', costPpm: 0, poolCents: 100 })
    expect(await s.req('POST', '/api/vr/runs', { ...BASE, name: 'mr' })).toEqual({ status: 409, body: { error: 'vr-name-taken' } })
    await newVrRun(s)
    expect(await s.req('POST', '/api/vr/runs', BASE)).toEqual({ status: 409, body: { error: 'vr-name-taken' } })
    expect(s.f.vr.runs).toHaveLength(1)
  })
})

describe('GET /api/vr/runs', () => {
  test('summaries in ascending id order; V and value are null until they can be known', async () => {
    const s = await vrSetup()
    const a = await newVrRun(s, { name: 'a' })
    const b = await newVrRun(s, { name: 'b', ticker: 'SOXL' })
    const res = await s.req('GET', '/api/vr/runs')
    expect(res.body.map((r: { id: number }) => r.id)).toEqual([a, b])
    expect(res.body[0]).toMatchObject({ name: 'a', ticker: 'TQQQ', status: 'active', shares: 0, poolCents: 1_000_000, vCents: null, valueCents: null, initialVCents: 500_000 })
    expect(res.body[0].settings).toEqual({ g: 10, formula: 'skill', bandPpm: 150_000, spendLimitPpm: 500_000, cycleDepositCents: 0 })
  })

  test('with a cycle and a close the summary has V and a value', async () => {
    const s = await vrSetup()
    const id = await newVrRun(s)
    await seedCycle(s, id)
    await seedFill(s, id, 'buy', 100, 450_000n, 0, '2026-11-04')
    await s.f.repos.priceHistoryRepo.upsertMany([{ ticker: 'TQQQ', tradeDate: '2026-11-09', close: 460_000n }])
    const [row] = (await s.req('GET', '/api/vr/runs')).body
    expect(row).toMatchObject({ shares: 100, poolCents: 1_000_000 - 450_000, vCents: 935_000, valueCents: 460_000 + 550_000 })
  })
})

describe('GET /api/vr/runs/:id', () => {
  test('the detail puts prices on the wire as decimal strings', async () => {
    const s = await vrSetup()
    const id = await newVrRun(s)
    await seedFill(s, id, 'buy', 176, 511_300n, 112, '2026-10-30')
    await seedCycle(s, id, { openPoolCents: 100_000 })
    await seedFill(s, id, 'buy', 3, 451_500n, 9, '2026-11-04')
    await s.f.repos.priceHistoryRepo.upsertMany([{ ticker: 'TQQQ', tradeDate: '2026-11-06', close: 450_000n }, { ticker: 'TQQQ', tradeDate: '2026-11-09', close: 460_000n }])
    const { status, body } = await s.req('GET', `/api/vr/runs/${id}`)
    expect(status).toBe(200)
    expect(body.today).toBe('2026-11-10')
    expect(body.lastClose).toEqual({ date: '2026-11-09', close: '460000' })
    expect(body.ladder.buy[0]).toEqual({ shares: 3, price: '443900' })
    expect(body.ladder.buyTotal).toBe(3)
    expect(body.ladder.sell[0]).toEqual({ shares: 2, price: '611000' })
    expect(typeof body.books.avgCost).toBe('string')
    expect(body.books).toMatchObject({ shares: 179, evalCents: 823_400, valueCents: 909_846, profitCents: -90_154 })
    expect(body.budgetLeftCents).toBe(36_455)
    expect(body.buyInstruction).toBeNull()
    expect(body.cycle).toMatchObject({ seq: 1, endDate: '2026-11-16', nextStart: '2026-11-17', prevClose: null })
    expect(body.run).toMatchObject({ id, name: 'vr', settings: { g: 10 } })
  })

  test('a new run without a close has no value and no buy instruction', async () => {
    const s = await vrSetup()
    const id = await newVrRun(s)
    const { body } = await s.req('GET', `/api/vr/runs/${id}`)
    expect(body).toMatchObject({ lastClose: null, cycle: null, budgetLeftCents: null, buyInstruction: null })
    expect(body.books).toMatchObject({ shares: 0, poolCents: 1_000_000, avgCost: null, evalCents: null, valueCents: null, profitCents: null })
    expect(body.ladder).toEqual({ buy: [], sell: [], buyTotal: 0, sellTotal: 0 })
  })

  test('before cycle 1, with a close and no shares, the buy instruction targets the initial V', async () => {
    const s = await vrSetup()
    const id = await newVrRun(s)
    await s.f.repos.priceHistoryRepo.upsertMany([{ ticker: 'TQQQ', tradeDate: '2026-11-09', close: 460_000n }])
    expect((await s.req('GET', `/api/vr/runs/${id}`)).body.buyInstruction).toEqual({ shares: 108, targetCents: 500_000 })
  })
})

describe('PATCH /api/vr/runs/:id', () => {
  test('follows the transition table', async () => {
    const s = await vrSetup()
    const id = await newVrRun(s)
    expect(await s.req('PATCH', `/api/vr/runs/${id}`, { status: 'paused' })).toEqual({ status: 200, body: { ok: true } })
    expect(s.f.vr.runs[0]!.status).toBe('paused')
    expect(await s.req('PATCH', `/api/vr/runs/${id}`, { status: 'closed' })).toEqual({ status: 200, body: { ok: true } })
    expect(await s.req('PATCH', `/api/vr/runs/${id}`, { status: 'active' })).toEqual({ status: 409, body: { error: 'invalid transition' } })
    expect(s.f.vr.runs[0]!.status).toBe('closed')
  })

  test('the same status is a 409 and an unknown status a 400', async () => {
    const s = await vrSetup()
    const id = await newVrRun(s)
    expect((await s.req('PATCH', `/api/vr/runs/${id}`, { status: 'active' })).status).toBe(409)
    expect(await s.req('PATCH', `/api/vr/runs/${id}`, { status: 'done' })).toEqual({ status: 400, body: { error: 'invalid status' } })
    expect((await s.req('PATCH', `/api/vr/runs/${id}`, {})).status).toBe(400)
  })
})

describe('POST /api/vr/runs/:id/settings', () => {
  const full = { g: 20, formula: 'basic', bandPpm: 100_000, spendLimitPpm: 250_000, cycleDepositCents: 1_000 }

  test('stores the full settings in any status', async () => {
    const s = await vrSetup()
    const id = await newVrRun(s)
    await s.req('PATCH', `/api/vr/runs/${id}`, { status: 'closed' })
    expect(await s.req('POST', `/api/vr/runs/${id}/settings`, full)).toEqual({ status: 204, body: null })
    expect(s.f.vr.runs[0]).toMatchObject(full)
  })

  for (const [field, patch] of [['g', { g: 0 }], ['formula', { formula: 'x' }], ['bandPpm', { bandPpm: 0 }], ['spendLimitPpm', { spendLimitPpm: -1 }], ['cycleDepositCents', { cycleDepositCents: 0.5 }]] as const) {
    test(`a bad ${field} is a 400 and changes nothing`, async () => {
      const s = await vrSetup()
      const id = await newVrRun(s)
      expect(await s.req('POST', `/api/vr/runs/${id}/settings`, { ...full, ...patch })).toEqual({ status: 400, body: { error: `invalid ${field}` } })
      expect(s.f.vr.runs[0]).toMatchObject({ g: 10, formula: 'skill' })
    })
  }

  test('an absent field is a 400', async () => {
    const s = await vrSetup()
    const id = await newVrRun(s)
    const { g: _g, ...rest } = full
    expect(await s.req('POST', `/api/vr/runs/${id}/settings`, rest)).toEqual({ status: 400, body: { error: 'invalid g' } })
  })
})

describe('GET /api/vr/runs/:id/cycles', () => {
  test('newest first, with the window dates', async () => {
    const s = await vrSetup()
    const id = await newVrRun(s)
    await seedCycle(s, id)
    await seedCycle(s, id, { seq: 2, scheduledStart: '2026-11-17', startDate: '2026-11-17', prevClose: 460_000n })
    const { status, body } = await s.req('GET', `/api/vr/runs/${id}/cycles`)
    expect(status).toBe(200)
    expect(body.map((c: { seq: number }) => c.seq)).toEqual([2, 1])
    expect(body[0]).toMatchObject({ endDate: '2026-11-30', nextStart: '2026-12-01', prevClose: '460000' })
    expect(body[1]).toMatchObject({ endDate: '2026-11-16', nextStart: '2026-11-17', prevClose: null })
  })
})

describe('an MR run or a malformed id', () => {
  test('answers 404 on every VR run route', async () => {
    const s = await vrSetup()
    const mr = await createRun(s.app, s.auth, { name: 'mr', ticker: 'AAPL', costPpm: 0, poolCents: 100 })
    const fill = { side: 'buy', shares: 1, price: '1.00', filledOn: '2026-11-01' }
    const move = { kind: 'deposit', amountCents: 100, movedOn: '2026-11-01', amount: 1 }
    for (const id of [String(mr), 'abc', '0', '999999']) {
      const p = `/api/vr/runs/${id}`
      const calls: [string, string, unknown?][] = [
        ['GET', p], ['PATCH', p, { status: 'paused' }], ['POST', `${p}/settings`, { g: 10, formula: 'skill', bandPpm: 150_000, spendLimitPpm: 500_000, cycleDepositCents: 0 }],
        ['GET', `${p}/cycles`], ['GET', `${p}/fills`], ['POST', `${p}/fills`, fill], ['PUT', `${p}/fills/1`, fill], ['DELETE', `${p}/fills/1`],
        ['GET', `${p}/cash`], ['POST', `${p}/cash`, move], ['PUT', `${p}/cash/1`, { amountCents: 1, movedOn: '2026-11-01' }], ['DELETE', `${p}/cash/1`],
      ]
      for (const [method, path, body] of calls) {
        expect(await s.req(method, path, body)).toEqual({ status: 404, body: { error: 'not found' } })
      }
    }
  })
})
