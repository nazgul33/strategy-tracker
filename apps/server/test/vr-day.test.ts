import { describe, test, expect, spyOn } from 'bun:test'
import { DEFAULT_VR_SETTINGS, buyRungs } from '@st/strategies/value-rebalancing'
import { t } from '@st/telegram/i18n'
import { renderVrBuyInstruction } from '@st/telegram/vr'
import { runMorningPipeline } from '../src/pipeline/day'
import { BUY_HEAD, LIST_ERR, RUN_ERR, WARN_EN, buy, cycle1, sell, setup } from './vr-day-fixture'

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

  test('a stale close in mid-cycle with shares: nothing is due, so no notice and the run completes', async () => {
    const { f, deps, sent, vrId } = await setup({ today: () => '2026-12-01', fetchLastClose: async () => ({ date: '2026-11-27', close: 520_000n }) })
    await f.repos.vrCycleRepo.open(cycle1(vrId), null)
    await buy(f, vrId, 100, 500_000n, '2026-11-20')
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(log).toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
    expect(sent).toEqual([])
    expect(f.notifications).toEqual([])
  })

  test('a failed close fetch in mid-cycle with shares is not reported either', async () => {
    const { f, deps, sent, vrId } = await setup({ today: () => '2026-12-01', fetchLastClose: async () => { throw new Error('yahoo down') } })
    await f.repos.vrCycleRepo.open(cycle1(vrId), null)
    await buy(f, vrId, 100, 500_000n, '2026-11-20')
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('sent')
    } finally {
      errors.mockRestore()
      log.mockRestore()
    }
    expect(sent).toEqual([])
  })

  test('a stale close on the due day: the VR data-error text, counted as failed', async () => {
    const { f, deps, sent, vrId } = await setup({ fetchLastClose: async () => ({ date: '2026-12-03', close: 520_000n }) })
    await f.repos.vrCycleRepo.open(cycle1(vrId), null)
    await buy(f, vrId, 100, 500_000n, '2026-11-20')
    expect(await runMorningPipeline(deps)).toBe('data-error')
    expect(sent).toEqual([WARN_EN(vrId, 'TQQQ')])
    expect(f.vr.cycles).toHaveLength(1)
  })

  test('a stale close when cycle 1 is due: the VR data-error text and no cycle', async () => {
    const { f, deps, sent, vrId } = await setup({ fetchLastClose: async () => ({ date: '2026-12-03', close: 520_000n }) })
    await buy(f, vrId, 100, 500_000n, '2026-12-04')
    expect(await runMorningPipeline(deps)).toBe('data-error')
    expect(sent).toEqual([WARN_EN(vrId, 'TQQQ')])
    expect(f.vr.cycles).toEqual([])
  })

  test('the VR data-error text in Korean', async () => {
    const { deps, sent } = await setup({ digestLang: 'ko', fetchLastClose: async () => ({ date: '2026-12-03', close: 520_000n }) })
    await runMorningPipeline(deps)
    expect(sent[0]).toBe(t('vr-warn-data-error', 'ko', { id: 100001, ticker: 'TQQQ' }))
    expect(sent[0]).toMatch(/TQQQ.*#100001|#100001.*TQQQ/)
    expect(sent[0]).not.toContain('{')
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
      expect(f.notifications[0]).toMatchObject({ runId: 100001, text: RUN_ERR(100001, 'TQQQ') })
      expect(sent[1]).toStartWith('R  SOXL — VR buy instruction')
      expect(sent).toHaveLength(2)
      expect(errors).toHaveBeenCalledWith('morning VR run failed:', { runId: 100001, ticker: 'TQQQ' }, 'Error: db-down')
    } finally {
      errors.mockRestore()
    }
  })

  test('the VR run list throwing after the MR runs went out: the MR digest, the list warning, and sent', async () => {
    const { f, deps, sent } = await setup({ fetchLastClose: async () => ({ date: '2026-12-04', close: 3402300n }) }, { mr: 'TSLA' })
    f.repos.vrRunRepo.list = async () => { throw new Error('vr-list-down') }
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(errors).toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
    expect(f.orders.length).toBeGreaterThan(0)
    expect(sent.length).toBeGreaterThan(1)
    expect(sent.at(-1)).toBe(LIST_ERR)
    expect(sent.some((x) => x.includes('stopped before any run was planned'))).toBe(false)
    expect(f.notifications.at(-1)).toMatchObject({ runId: null, text: LIST_ERR })
  })

  test('the VR run list throwing with no MR run: one failure, so the data-error result, not a throw', async () => {
    const { f, deps, sent } = await setup({}, { vr: null })
    f.repos.vrRunRepo.list = async () => { throw new Error('vr-list-down') }
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('data-error')
    } finally {
      errors.mockRestore()
    }
    expect(sent).toEqual([LIST_ERR])
  })

  test('a run paused between the list and the lock does nothing', async () => {
    const { f, deps, sent, vrId } = await setup()
    await buy(f, vrId, 100, 500_000n, '2026-12-04')
    const real = f.repos.vrRunRepo.list
    f.repos.vrRunRepo.list = async () => {
      const rows = await real()
      await f.repos.vrRunRepo.updateStatus(vrId, 'paused')
      return rows
    }
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(f.vr.cycles).toEqual([])
    expect(sent).toEqual([])
    expect(f.notifications).toEqual([])
  })

  test('settings changed between the list and the lock are the ones used', async () => {
    const { f, deps, vrId } = await setup()
    await f.repos.vrCycleRepo.open(cycle1(vrId), null)
    await buy(f, vrId, 100, 500_000n, '2026-11-20')
    const real = f.repos.vrRunRepo.list
    f.repos.vrRunRepo.list = async () => {
      const rows = await real()
      await f.repos.vrRunRepo.updateSettings(vrId, { ...DEFAULT_VR_SETTINGS, cycleDepositCents: 25_000 })
      return rows
    }
    await runMorningPipeline(deps)
    expect(f.vr.cycles[1]).toMatchObject({ seq: 2, depositCents: 25_000 })
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
