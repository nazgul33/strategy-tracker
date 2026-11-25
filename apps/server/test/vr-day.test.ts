import { describe, test, expect, spyOn } from 'bun:test'
import { emptyState } from '@st/core'
import { DEFAULT_MR_PARAMS } from '@st/strategies'
import { DEFAULT_VR_SETTINGS, buyRungs } from '@st/strategies/value-rebalancing'
import { renderVrBuyInstruction } from '@st/telegram/vr'
import { runMorningPipeline, type DayDeps } from '../src/pipeline/day'
import type { NewVrCycle } from '../src/domain/vr/repo-types'
import { makeFakes } from './http-fakes'

type Fakes = ReturnType<typeof makeFakes>

async function mrRun(f: Fakes, ticker: string) {
  const st = emptyState(10)
  st.buckets[1] = { index: 1, state: 'held', shares: 10, buyPrice: 3402300n, buyFeeCents: 0, filledOn: '2026-11-03' }
  st.ages[1] = 3
  st.cashCents = 1000000
  await f.repos.runRepo.create({ strategyKey: 'mean-reversion', ticker, name: ticker[0]!, poolCents: 1000000, costPpm: 30, initialRunState: st })
}

async function setup(over: Partial<DayDeps> = {}, o: { mr?: string; vr?: string | null; deposit?: number; close?: { date: string; close: bigint } } = {}) {
  const f = makeFakes()
  if (o.mr) await mrRun(f, o.mr)
  const vrId = o.vr === null ? 0 : await f.repos.vrRunRepo.create({
    ...DEFAULT_VR_SETTINGS, cycleDepositCents: o.deposit ?? 0, ticker: o.vr ?? 'TQQQ', name: 'Q', costPpm: 0,
    initialVCents: 500_000, openingCashCents: 1_000_000, openedOn: '2026-11-20',
  })
  const sent: string[] = []
  const fetched: string[] = []
  const persisted: [string, string, bigint][] = []
  const deps: DayDeps = {
    today: () => '2026-12-07',
    fetchLastClose: async (tk) => { fetched.push(tk); return o.close ?? { date: '2026-12-04', close: 520_000n } },
    crossCheck: async () => ({ agree: true }),
    send: async (_c, text) => { sent.push(text) },
    allowedChatIds: ['c1'],
    repos: f.repos,
    params: () => DEFAULT_MR_PARAMS,
    digestLang: 'en',
    persistClose: async (tk, d, c) => { persisted.push([tk, d, c]) },
    ...over,
  }
  return { f, deps, sent, fetched, persisted, vrId }
}

const buy = (f: Fakes, runId: number, shares: number, price: bigint, on: string) =>
  f.repos.vrFillRepo.insert({ runId, side: 'buy', shares, price, fee: 0, filledOn: on, source: 'manual' })
const sell = (f: Fakes, runId: number, shares: number, price: bigint, on: string) =>
  f.repos.vrFillRepo.insert({ runId, side: 'sell', shares, price, fee: 0, filledOn: on, source: 'manual' })

function cycle1(runId: number, over: Partial<NewVrCycle> = {}): NewVrCycle {
  return {
    runId, seq: 1, scheduledStart: '2026-11-23', startDate: '2026-11-23', vCents: 500_000, bandMinCents: 425_000, bandMaxCents: 575_000,
    openShares: 100, openPoolCents: 500_000, buyBudgetCents: 250_000, buyLot: 2, sellLot: 1,
    prevClose: null, evalCents: null, poolBeforeCents: null, g: 10, formula: 'skill', depositCents: 0, vKept: false, openFillId: 0, ...over,
  }
}

const WARN_EN = (id: number, tk: string) => `Market data error — run #${id} ${tk}: last close unavailable or stale. Today's orders for this run could not be computed.`
const RUN_ERR = (id: number, tk: string) => `Morning pipeline error — run #${id} ${tk}: today's orders could not be planned. Check this run's Orders tab in the web app; if today's orders are missing, run the morning pipeline again.`
const BUY_HEAD = 'Q  TQQQ — VR buy instruction'

describe('VR morning job: the first day', () => {
  test('no shares and no cycle: the buy instruction, nothing written', async () => {
    const { f, deps, sent } = await setup({ fetchLastClose: async () => ({ date: '2026-12-04', close: 500_000n }) })
    expect(await runMorningPipeline(deps)).toBe('sent')
    const expected = renderVrBuyInstruction({ runId: 100001, name: 'Q', ticker: 'TQQQ', shares: 100, targetCents: 500_000, lastClose: 500_000n, lastCloseDate: '2026-12-04' }, 'en')
    expect(expected).toBe(`${BUY_HEAD}\nLast close: $50.00 (2026-12-04)\nBuy 100 sh (target $5000.00 ÷ last close). Order type is your choice.`)
    expect(sent).toEqual([expected])
    expect(f.notifications).toHaveLength(1)
    expect(f.notifications[0]).toMatchObject({ runId: 100001, chatId: 'c1', text: expected })
    expect(f.vr.cycles).toEqual([])
  })

  test('shares and no cycle: cycle 1, no deposit even when one is configured', async () => {
    const { f, deps, sent, vrId } = await setup({}, { deposit: 25_000 })
    const fillId = await buy(f, vrId, 100, 500_000n, '2026-12-04')
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(f.vr.cycles).toHaveLength(1)
    expect(f.vr.cycles[0]).toMatchObject({
      runId: vrId, seq: 1, scheduledStart: '2026-12-07', startDate: '2026-12-07', vCents: 500_000, bandMinCents: 425_000, bandMaxCents: 575_000,
      openShares: 100, openPoolCents: 500_000, buyBudgetCents: 250_000, buyLot: 2, sellLot: 1,
      prevClose: null, evalCents: null, poolBeforeCents: null, g: 10, formula: 'skill', depositCents: 0, vKept: false, openFillId: fillId,
    })
    expect(f.vr.cash.map((m) => m.kind)).toEqual(['open'])
    expect(sent).toHaveLength(1)
    expect(sent[0]!.startsWith(
      'Q  TQQQ — VR cycle 1: 2026-12-07 to 2026-12-20\nLast close: $52.00 (2026-12-04)\nV: $5000.00  Band: $4250.00 – $5750.00\n'
      + 'Shares: 100  Pool: $5000.00  Buy budget: $2500.00\nBuy 23 rungs, 2 sh each:',
    )).toBe(true)
    expect(sent[0]).toContain('Sell 25 rungs, 1 sh each:')
    expect(f.notifications).toHaveLength(1)
    expect(f.notifications[0]!.text).toBe(sent[0]!)
  })
})

describe('VR morning job: fills already booked when a cycle opens', () => {
  test('cycle 1 on the day the opening buy is dated: its id is stored and the message lists every buy rung', async () => {
    const { f, deps, sent, vrId } = await setup()
    await buy(f, vrId, 40, 400_000n, '2026-12-03')
    const openingId = await buy(f, vrId, 60, 500_000n, '2026-12-07')
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(f.vr.cycles).toHaveLength(1)
    expect(f.vr.cycles[0]).toMatchObject({ seq: 1, startDate: '2026-12-07', openShares: 100, openFillId: openingId })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Buy 23 rungs, 2 sh each:')
    expect(sent[0]).not.toContain('no rungs')
    expect(sent[0]).toContain('Sell 25 rungs, 1 sh each:')
    const before = { cycles: f.vr.cycles.length, sent: sent.length, notes: f.notifications.length }
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect({ cycles: f.vr.cycles.length, sent: sent.length, notes: f.notifications.length }).toEqual(before)
  })

  test('the stored id is the highest fill id of the run, whatever the dates', async () => {
    const { f, deps, vrId } = await setup()
    await buy(f, vrId, 1, 500_000n, '2026-12-04')
    const last = await buy(f, vrId, 1, 500_000n, '2026-11-02')
    await runMorningPipeline(deps)
    expect(f.vr.cycles[0]!.openFillId).toBe(last)
  })

  test('a roll with no fill in the books stores 0', async () => {
    const { f, deps, vrId } = await setup()
    await f.repos.vrCycleRepo.open(cycle1(vrId), null)
    await runMorningPipeline(deps)
    expect(f.vr.cycles[1]).toMatchObject({ seq: 2, openShares: 0, openFillId: 0 })
  })

  test('a roll day with a fill dated that day already booked: the new cycle lists every rung', async () => {
    const { f, deps, sent, vrId } = await setup()
    await f.repos.vrCycleRepo.open(cycle1(vrId), null)
    await buy(f, vrId, 100, 500_000n, '2026-11-20')
    const todays = await buy(f, vrId, 2, 520_000n, '2026-12-07')
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(f.vr.cycles).toHaveLength(2)
    const c2 = f.vr.cycles[1]!
    expect(c2).toMatchObject({ seq: 2, startDate: '2026-12-07', openShares: 102, openFillId: todays })
    const all = buyRungs({ minCents: c2.bandMinCents, openShares: c2.openShares, lot: c2.buyLot, budgetCents: c2.buyBudgetCents, poolCents: c2.openPoolCents })
    expect(all.length).toBeGreaterThan(1)
    expect(sent[0]).toContain(`Buy ${all.length} rungs, ${c2.buyLot} sh each:`)
    expect(sent[0]).not.toContain('no rungs')
    sent.length = 0
    await runMorningPipeline(deps)
    expect(f.vr.cycles).toHaveLength(2)
    expect(sent).toEqual([])
  })
})

describe('VR morning job: an existing cycle', () => {
  test('mid-cycle with shares: no notice, no new cycle, the close is still fetched', async () => {
    const { f, deps, sent, fetched, vrId } = await setup({ today: () => '2026-12-01' }, { close: { date: '2026-11-30', close: 520_000n } })
    await f.repos.vrCycleRepo.open(cycle1(vrId), null)
    await buy(f, vrId, 100, 500_000n, '2026-11-20')
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(sent).toEqual([])
    expect(f.notifications).toEqual([])
    expect(f.vr.cycles).toHaveLength(1)
    expect(fetched).toEqual(['TQQQ'])
  })

  async function dueDay(deposit: number) {
    const s = await setup({}, { deposit })
    await s.f.repos.vrCycleRepo.open(cycle1(s.vrId), null)
    await buy(s.f, s.vrId, 100, 500_000n, '2026-11-20')
    return s
  }

  test('due day: cycle 2 with the new V, the inputs recorded and one deposit', async () => {
    const { f, deps, sent, vrId } = await dueDay(25_000)
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(f.vr.cycles).toHaveLength(2)
    const c2 = f.vr.cycles[1]!
    expect(c2).toMatchObject({
      runId: vrId, seq: 2, scheduledStart: '2026-12-07', startDate: '2026-12-07', vCents: 578_162, bandMinCents: 491_438, bandMaxCents: 664_886,
      openShares: 100, openPoolCents: 525_000, buyBudgetCents: 262_500, buyLot: 2, sellLot: 1,
      prevClose: 520_000n, evalCents: 520_000, poolBeforeCents: 500_000, g: 10, formula: 'skill', depositCents: 25_000, vKept: false, openFillId: 1,
    })
    expect(f.vr.cash.filter((m) => m.kind === 'deposit')).toEqual([
      expect.objectContaining({ kind: 'deposit', amountCents: 25_000, movedOn: '2026-12-07', cycleId: c2.id, note: null, runId: vrId }),
    ])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('VR cycle 2: 2026-12-07 to 2026-12-20')
    expect(sent[0]).toContain('Deposit booked for this cycle: $250.00')
  })

  test('a negative deposit books a withdrawal', async () => {
    const { f, deps, sent, vrId } = await dueDay(-25_000)
    await runMorningPipeline(deps)
    expect(f.vr.cycles[1]).toMatchObject({ vCents: 528_162, bandMinCents: 448_938, bandMaxCents: 607_386, openPoolCents: 475_000, buyBudgetCents: 237_500, depositCents: -25_000 })
    expect(f.vr.cash.filter((m) => m.kind === 'withdraw')).toEqual([
      expect.objectContaining({ kind: 'withdraw', amountCents: -25_000, movedOn: '2026-12-07', cycleId: f.vr.cycles[1]!.id, runId: vrId }),
    ])
    expect(sent[0]).toContain('Withdrawal booked for this cycle: $250.00')
  })

  test('no deposit: V rolls and no cash move is booked', async () => {
    const { f, deps } = await dueDay(0)
    await runMorningPipeline(deps)
    expect(f.vr.cycles[1]).toMatchObject({ vCents: 553_162, depositCents: 0, openPoolCents: 500_000 })
    expect(f.vr.cash.map((m) => m.kind)).toEqual(['open'])
  })

  test('Review Focus 1: running the pipeline again on the due day adds no cycle and no deposit', async () => {
    const { f, deps, sent } = await dueDay(25_000)
    await runMorningPipeline(deps)
    sent.length = 0
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(f.vr.cycles).toHaveLength(2)
    expect(f.vr.cash.filter((m) => m.kind === 'deposit')).toHaveLength(1)
    expect(sent).toEqual([])
  })

  test('Review Focus 1: two pipelines at once open one cycle', async () => {
    const { f, deps } = await dueDay(25_000)
    expect(await Promise.all([runMorningPipeline(deps), runMorningPipeline(deps)])).toEqual(['sent', 'sent'])
    expect(f.vr.cycles).toHaveLength(2)
    expect(f.vr.cash.filter((m) => m.kind === 'deposit')).toHaveLength(1)
  })

  async function flat() {
    const s = await setup()
    await s.f.repos.vrCycleRepo.open(cycle1(s.vrId), null)
    await buy(s.f, s.vrId, 100, 500_000n, '2026-11-20')
    await sell(s.f, s.vrId, 100, 500_000n, '2026-11-25')
    return s
  }

  test('Review Focus 3: a cycle and no shares: mid-cycle the buy instruction targets the cycle V', async () => {
    const { f, deps, sent } = await flat()
    await runMorningPipeline({ ...deps, today: () => '2026-12-01', fetchLastClose: async () => ({ date: '2026-11-30', close: 520_000n }) })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain(BUY_HEAD)
    expect(sent[0]).toContain('Buy 96 sh (target $5000.00 ÷ last close)')
    expect(f.vr.cycles).toHaveLength(1)
  })

  test('Review Focus 3: on the due day the cycle message carries the instruction and no ladder', async () => {
    const { f, deps, sent } = await flat()
    await runMorningPipeline(deps)
    expect(f.vr.cycles[1]).toMatchObject({ seq: 2, vCents: 520_943, openShares: 0, buyBudgetCents: 500_000, buyLot: 1, sellLot: 1 })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('VR cycle 2')
    expect(sent[0]).toContain('No shares held, so this cycle has no ladder.')
    expect(sent[0]).toContain('Buy 100 sh (target $5209.43 ÷ last close)')
    expect(sent[0]).not.toContain('rungs')
  })
})

describe('VR morning job: failures and isolation', () => {
  test('a stale close: the data-error notice, counted as failed', async () => {
    const { f, deps, sent } = await setup({ fetchLastClose: async () => ({ date: '2026-12-03', close: 520_000n }) })
    expect(await runMorningPipeline(deps)).toBe('data-error')
    expect(sent).toEqual([WARN_EN(100001, 'TQQQ')])
    expect(f.notifications[0]).toMatchObject({ runId: 100001, chatId: 'c1', text: WARN_EN(100001, 'TQQQ') })
  })

  test('a stale VR close next to an MR run that completes still reports sent', async () => {
    const { f, deps, sent } = await setup({
      fetchLastClose: async (tk) => ({ date: tk === 'TQQQ' ? '2026-12-03' : '2026-12-04', close: 3402300n }),
    }, { mr: 'TSLA' })
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(sent).toContain(WARN_EN(100001, 'TQQQ'))
    expect(f.orders.length).toBeGreaterThan(0)
  })

  test('one VR run throwing does not stop the next', async () => {
    const { f, deps, sent } = await setup()
    await f.repos.vrRunRepo.create({ ...DEFAULT_VR_SETTINGS, ticker: 'SOXL', name: 'R', costPpm: 0, initialVCents: 500_000, openingCashCents: 1_000_000, openedOn: '2026-11-20' })
    const real = f.repos.vrCycleRepo.latest
    f.repos.vrCycleRepo.latest = async (id) => {
      if (id === 100001) throw new Error('db-down')
      return real(id)
    }
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(sent[0]).toBe(RUN_ERR(100001, 'TQQQ'))
      expect(sent[1]).toStartWith('R  SOXL — VR buy instruction')
      expect(sent).toHaveLength(2)
      expect(errors).toHaveBeenCalledWith('morning VR run failed:', { runId: 100001, ticker: 'TQQQ' }, 'Error: db-down')
    } finally {
      errors.mockRestore()
    }
  })

  test('an MR run and a VR run on one ticker: the MR output is what it is without the VR run', async () => {
    const over = { fetchLastClose: async () => ({ date: '2026-12-04', close: 3402300n }) }
    const A = await setup(over, { mr: 'TSLA', vr: null })
    const B = await setup(over, { mr: 'TSLA', vr: 'TSLA' })
    expect(await runMorningPipeline(A.deps)).toBe('sent')
    expect(await runMorningPipeline(B.deps)).toBe('sent')
    expect(A.sent.length).toBeGreaterThan(0)
    expect(B.sent.slice(0, A.sent.length)).toEqual(A.sent)
    expect(B.sent.length).toBe(A.sent.length + 1)
    expect(B.f.notifications.filter((n) => n.runId === 1)).toEqual(A.f.notifications.filter((n) => n.runId === 1))
    expect(B.f.orders).toEqual(A.f.orders)
  })

  test('the checked close of a VR-only ticker is persisted', async () => {
    const { deps, persisted } = await setup()
    await runMorningPipeline(deps)
    expect(persisted).toEqual([['TQQQ', '2026-12-04', 520_000n]])
  })

  test('with no VR run nothing is sent and the result is unchanged', async () => {
    const { deps, sent } = await setup({}, { vr: null })
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(sent).toEqual([])
  })
})
