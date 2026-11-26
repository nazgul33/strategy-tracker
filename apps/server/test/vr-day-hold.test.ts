import { describe, test, expect, spyOn } from 'bun:test'
import { DEFAULT_VR_SETTINGS } from '@st/strategies/value-rebalancing'
import { t } from '@st/telegram/i18n'
import { runMorningPipeline } from '../src/pipeline/day'
import { BUY_HEAD, WARN_EN, buy, cycle1, sell, setup, waitingFill } from './vr-day-fixture'

const HELD = (n: number) =>
  `Q  TQQQ — VR: screenshot fills waiting to be confirmed: ${n}. This morning's cycle step is held; orders already placed still stand. `
  + 'Confirm or reject the waiting fills on the run\'s Pending tab; a later morning run continues once none are waiting.'
const HELD_QUESTION =
  'Q  TQQQ — VR: a screenshot question for this ticker is still unanswered on Telegram, so this morning\'s cycle step is held; '
  + 'orders already placed still stand. Answer the question there (it expires 24 hours after it was asked); '
  + 'a later morning run continues once it is answered or has expired.'

const NOW = new Date('2026-12-07T13:00:00Z')
const AT = { now: () => NOW }
const HOUR = 3_600_000
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

// A parked Telegram question naming a VR run, created `hoursAgo` before NOW.
async function question(f: Awaited<ReturnType<typeof setup>>['f'], vrRunId: number, hoursAgo = 10) {
  const id = await f.repos.captureChoiceRepo.park({
    chatId: 'c1', ticker: 'TQQQ', mrRunId: 1, vrRunId, fills: [], image: { base64: 'QUJD', mime: 'image/png' }, readOn: '2026-12-04',
  })
  f.choices.find((c) => c.id === id)!.createdAt = stamp(NOW.getTime() - hoursAgo * HOUR)
  return id
}

async function dueWithWaiting(n: number, over: Parameters<typeof setup>[0] = {}) {
  const s = await setup(over, { deposit: 25_000 })
  await s.f.repos.vrCycleRepo.open(cycle1(s.vrId), null)
  await buy(s.f, s.vrId, 100, 500_000n, '2026-11-20')
  const ids = await waitingFill(s.f, s.vrId, n)
  return { ...s, ids }
}

describe('VR morning job: an open Telegram question holds the cycle', () => {
  test('a due cycle with an open question and no waiting fill is held: no cycle, no deposit, the question message', async () => {
    const { f, deps, sent, vrId } = await dueWithWaiting(0, AT)
    await question(f, vrId)
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(f.vr.cycles).toHaveLength(1)
    expect(f.vr.cash.map((m) => m.kind)).toEqual(['open'])
    expect(sent).toEqual([HELD_QUESTION])
    expect(f.notifications).toEqual([expect.objectContaining({ runId: vrId, chatId: 'c1', text: HELD_QUESTION })])
  })

  test('answered, the next run opens the cycle', async () => {
    const { f, deps, sent, vrId } = await dueWithWaiting(0, AT)
    const id = await question(f, vrId)
    await runMorningPipeline(deps)
    expect(await f.repos.captureChoiceRepo.answer(id, 'vr')).toBe(true)
    sent.length = 0
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(f.vr.cycles).toHaveLength(2)
    expect(sent.at(-1)).toContain('VR cycle 2')
  })

  test('a question asked 25 hours ago no longer holds', async () => {
    const { f, deps, vrId } = await dueWithWaiting(0, AT)
    await question(f, vrId, 25)
    await runMorningPipeline(deps)
    expect(f.vr.cycles).toHaveLength(2)
  })

  test('a question asked 23 hours ago still holds', async () => {
    const { f, deps, sent, vrId } = await dueWithWaiting(0, AT)
    await question(f, vrId, 23)
    await runMorningPipeline(deps)
    expect(sent).toEqual([HELD_QUESTION])
    expect(f.vr.cycles).toHaveLength(1)
  })

  test('a question naming another VR run does not hold this one', async () => {
    const { f, deps, vrId } = await dueWithWaiting(0, AT)
    await question(f, vrId + 1)
    await runMorningPipeline(deps)
    expect(f.vr.cycles).toHaveLength(2)
  })

  test('waiting fills and an open question: the waiting-fills message', async () => {
    const { f, deps, sent, vrId } = await dueWithWaiting(2, AT)
    await question(f, vrId)
    await runMorningPipeline(deps)
    expect(sent).toEqual([HELD(2)])
    expect(f.vr.cycles).toHaveLength(1)
  })

  test('mid-cycle with shares and an open question: nothing is sent or changed', async () => {
    const { f, deps, sent, vrId } = await setup({ ...AT, today: () => '2026-12-01' }, { close: { date: '2026-11-30', close: 520_000n } })
    await f.repos.vrCycleRepo.open(cycle1(vrId), null)
    await buy(f, vrId, 100, 500_000n, '2026-11-20')
    await question(f, vrId)
    expect(await runMorningPipeline(deps)).toBe('sent')
    expect(sent).toEqual([])
    expect(f.notifications).toEqual([])
    expect(f.vr.cycles).toHaveLength(1)
  })

  test('shares and no cycle yet, an open question: cycle 1 is not opened', async () => {
    const { f, deps, sent, vrId } = await setup(AT)
    await buy(f, vrId, 100, 500_000n, '2026-12-04')
    await question(f, vrId)
    await runMorningPipeline(deps)
    expect(sent).toEqual([HELD_QUESTION])
    expect(f.vr.cycles).toEqual([])
  })

  test('the question held message in Korean', async () => {
    const { f, deps, sent, vrId } = await dueWithWaiting(0, { ...AT, digestLang: 'ko' })
    await question(f, vrId)
    await runMorningPipeline(deps)
    expect(sent[0]).toBe(t('vr-cycle-held-question', 'ko', { name: 'Q', ticker: 'TQQQ' }))
    expect(sent[0]).toContain('TQQQ')
    expect(sent[0]).not.toContain('{')
  })
})

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
