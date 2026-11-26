import { describe, test, expect, spyOn } from 'bun:test'
import { DEFAULT_VR_SETTINGS } from '@st/strategies/value-rebalancing'
import { t } from '@st/telegram/i18n'
import { runMorningPipeline } from '../src/pipeline/day'
import { BUY_HEAD, WARN_EN, buy, cycle1, sell, setup, waitingFill } from './vr-day-fixture'

const HELD = (n: number) =>
  `Q  TQQQ — VR: ${n} screenshot fill(s) are waiting to be confirmed, so this morning's cycle step is held. `
  + 'Confirm or reject them on the run\'s Pending tab; the next morning run continues once none are waiting.'

async function dueWithWaiting(n: number, over: Parameters<typeof setup>[0] = {}) {
  const s = await setup(over, { deposit: 25_000 })
  await s.f.repos.vrCycleRepo.open(cycle1(s.vrId), null)
  await buy(s.f, s.vrId, 100, 500_000n, '2026-11-20')
  const ids = await waitingFill(s.f, s.vrId, n)
  return { ...s, ids }
}

describe('VR morning job: waiting fills hold the cycle', () => {
  test('a due cycle with two waiting fills is held: no cycle, no deposit, one message', async () => {
    const { f, deps, sent, vrId } = await dueWithWaiting(2)
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(f.vr.cycles).toHaveLength(1)
    expect(f.vr.cash.map((m) => m.kind)).toEqual(['open'])
    expect(sent).toEqual([HELD(2)])
    expect(f.notifications).toEqual([expect.objectContaining({ runId: vrId, chatId: 'c1', text: HELD(2) })])
  })

  test('cleared the next day, the cycle opens on the original anchor', async () => {
    const { f, deps, sent, vrId, ids } = await dueWithWaiting(2)
    await runMorningPipeline(deps)
    for (const id of ids) await f.repos.vrPendingRepo.reject(vrId, id)
    sent.length = 0
    const next = { ...deps, today: () => '2026-12-08', fetchLastClose: async () => ({ date: '2026-12-07', close: 520_000n }) }
    expect(await runMorningPipeline(next)).toBe('sent')
    expect(f.vr.cycles).toHaveLength(2)
    expect(f.vr.cycles[1]).toMatchObject({ seq: 2, scheduledStart: '2026-12-07', startDate: '2026-12-08' })
    expect(f.vr.cash.filter((m) => m.kind === 'deposit')).toEqual([expect.objectContaining({ amountCents: 25_000, movedOn: '2026-12-08' })])
    expect(sent.at(-1)).toContain('VR cycle 2: 2026-12-08 to 2026-12-20')
  })

  test('held on every run while the list is not clear', async () => {
    const { f, deps, sent } = await dueWithWaiting(2)
    await runMorningPipeline(deps)
    await runMorningPipeline(deps)
    expect(sent).toEqual([HELD(2), HELD(2)])
    expect(f.vr.cycles).toHaveLength(1)
  })

  test('shares and no cycle, one waiting fill: cycle 1 is not opened until the list is clear', async () => {
    const { f, deps, sent, vrId } = await setup()
    await buy(f, vrId, 100, 500_000n, '2026-12-04')
    const [id] = await waitingFill(f, vrId, 1)
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(sent).toEqual([HELD(1)])
    expect(f.vr.cycles).toEqual([])
    await f.repos.vrPendingRepo.reject(vrId, id!)
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(f.vr.cycles).toHaveLength(1)
    expect(f.vr.cycles[0]).toMatchObject({ seq: 1, scheduledStart: '2026-12-07', startDate: '2026-12-07', openShares: 100 })
  })

  test('no shares and no cycle, the opening buy awaits confirmation: held, not the buy instruction', async () => {
    const { f, deps, sent, vrId } = await setup({ fetchLastClose: async () => ({ date: '2026-12-04', close: 500_000n }) })
    const [id] = await waitingFill(f, vrId, 1)
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(sent).toEqual([HELD(1)])
    expect(sent[0]).not.toContain(BUY_HEAD)
    expect(f.vr.cycles).toEqual([])
    const fill = { runId: vrId, side: 'buy' as const, shares: 1, price: 500_000n, fee: 0, filledOn: '2026-12-04', source: 'capture' as const }
    await f.repos.vrPendingRepo.confirm(vrId, id!, fill)
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(f.vr.cycles[0]).toMatchObject({ seq: 1, openShares: 1 })
  })

  test('mid-cycle with shares and waiting fills: nothing is sent or changed', async () => {
    const { f, deps, sent, vrId } = await setup({ today: () => '2026-12-01' }, { close: { date: '2026-11-30', close: 520_000n } })
    await f.repos.vrCycleRepo.open(cycle1(vrId), null)
    await buy(f, vrId, 100, 500_000n, '2026-11-20')
    await waitingFill(f, vrId, 2)
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(sent).toEqual([])
    expect(f.notifications).toEqual([])
    expect(f.vr.cycles).toHaveLength(1)
  })

  test('mid-cycle with no shares and waiting fills: the buy instruction is held', async () => {
    const { f, deps, sent, vrId } = await setup()
    await f.repos.vrCycleRepo.open(cycle1(vrId), null)
    await buy(f, vrId, 100, 500_000n, '2026-11-20')
    await sell(f, vrId, 100, 500_000n, '2026-11-25')
    await waitingFill(f, vrId, 1)
    await runMorningPipeline({ ...deps, today: () => '2026-12-01', fetchLastClose: async () => ({ date: '2026-11-30', close: 520_000n }) })
    expect(sent).toEqual([HELD(1)])
    expect(sent[0]).not.toContain(BUY_HEAD)
    expect(f.vr.cycles).toHaveLength(1)
  })

  test('a due cycle, waiting fills and a stale close: the held message only, the run completes', async () => {
    const { f, deps, sent } = await dueWithWaiting(2, { fetchLastClose: async () => ({ date: '2026-12-03', close: 520_000n }) })
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(sent).toEqual([HELD(2)])
    expect(sent.join('\n')).not.toContain(WARN_EN(100001, 'TQQQ'))
    expect(f.vr.cycles).toHaveLength(1)
  })

  test('a failed close fetch with waiting fills on a due cycle is not reported as a data error either', async () => {
    const { deps, sent } = await dueWithWaiting(1, { fetchLastClose: async () => { throw new Error('yahoo down') } })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('sent')
    } finally {
      errors.mockRestore()
    }
    expect(sent).toEqual([HELD(1)])
  })

  test('the hold is per run: a second run without waiting fills still gets its buy instruction', async () => {
    const { f, deps, sent, vrId } = await setup()
    await f.repos.vrRunRepo.create({ ...DEFAULT_VR_SETTINGS, ticker: 'SOXL', name: 'R', costPpm: 0, initialVCents: 500_000, openingCashCents: 1_000_000, openedOn: '2026-11-20' })
    await waitingFill(f, vrId, 1)
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(sent).toHaveLength(2)
    expect(sent[0]).toBe(HELD(1))
    expect(sent[1]).toStartWith('R  SOXL — VR buy instruction')
  })

  test('the held message in Korean', async () => {
    const { deps, sent } = await dueWithWaiting(2, { digestLang: 'ko' })
    await runMorningPipeline(deps)
    expect(sent[0]).toBe(t('vr-cycle-held', 'ko', { name: 'Q', ticker: 'TQQQ', n: 2 }))
    expect(sent[0]).toContain('TQQQ')
    expect(sent[0]).toContain('2')
    expect(sent[0]).not.toContain('{')
  })

  test('the notice is logged under the vr-held kind when sending fails, and the run still completes', async () => {
    const { f, deps, vrId } = await dueWithWaiting(1, { send: async () => { throw new Error('telegram down') } })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runMorningPipeline(deps)).toBe('sent')
      expect(errors).toHaveBeenCalledWith('notice failed:', 'vr-held', expect.objectContaining({ runId: vrId, chatId: 'c1' }), 'Error: telegram down')
    } finally {
      errors.mockRestore()
    }
    expect(f.vr.cycles).toHaveLength(1)
  })
})
