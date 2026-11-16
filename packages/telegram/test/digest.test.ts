import { describe, test, expect } from 'bun:test'
import { renderDigest, renderClosed, renderReminder } from '../src/digest'
import { t } from '../src/i18n'
import { dayInfo } from '@st/calendar'
import type { Run, DayPlan, DayContext } from '@st/core'

const run: Run = { id: 1, name: 'Alpha', ticker: 'AAPL', strategyKey: 'mean-reversion', costPpm: 0, buyGapPpm: 0, sellGapPpm: 0, cutLossPpm: 0, poolCents: 100000, status: 'active' }
const ctx: DayContext = { tradeDate: '2026-11-06', lastClose: 1000000n, lastCloseDate: '2026-11-05' }

describe('digest', () => {
  test('en buy line exact', () => {
    const plan: DayPlan = {
      orders: [{ kind: 'buy_loc', bucketIndex: 0, limitPrice: 3402200n, shares: 29 }],
      skips: [],
      notices: [],
    }
    const out = renderDigest(run, plan, ctx, 'en').join('\n')
    expect(out).toContain('Buy  LOC  29 sh  @ 340.22  → bucket 0')
  })
  test('en market sell age exact', () => {
    const plan: DayPlan = {
      orders: [{ kind: 'market_sell', bucketIndex: 1, limitPrice: 0n, shares: 120 }],
      skips: [],
      notices: [],
    }
    const out = renderDigest(run, plan, ctx, 'en', { 1: 21 }).join('\n')
    expect(out).toContain('Market  SELL  120 sh  bucket 1  (age 21 — forced exit)')
  })
  test('sell loc line', () => {
    const plan: DayPlan = {
      orders: [{ kind: 'sell_loc', bucketIndex: 2, limitPrice: 3500000n, shares: 10 }],
      skips: [],
      notices: [],
    }
    const out = renderDigest(run, plan, ctx, 'en').join('\n')
    expect(out).toContain('Sell  LOC  10 sh  @ 350.00  → bucket 2')
  })
  test('unconfirmed notice exact', () => {
    const plan: DayPlan = {
      orders: [],
      skips: [],
      notices: [{ code: 'unconfirmed', params: { count: 3, date: '2026-11-05' } }],
    }
    const out = renderDigest(run, plan, ctx, 'en').join('\n')
    expect(out).toContain('⚠️ 3 unconfirmed orders from 2026-11-05')
  })
  test('skip reason pairs with string bucket param (legacy stored plans)', () => {
    // The old sell-cap producer wrote params.bucket as String(b.index) while
    // skip.bucketIndex is a number; plans persisted by that code store the
    // mismatch, so pairing must compare both sides as strings.
    const plan: DayPlan = {
      orders: [],
      skips: [
        { kind: 'sell_loc', bucketIndex: 1, limitPrice: 0n, shares: 700 },
        { kind: 'sell_loc', bucketIndex: 2, limitPrice: 0n, shares: 100 },
      ],
      notices: [
        { code: 'sell-capped', params: { bucket: '1', price: 164.5 } },
        { code: 'sell-capped', params: { bucket: '2', price: 150.7007 } },
      ],
    }
    const out = renderDigest(run, plan, ctx, 'en').join('\n')
    expect(out).toContain('SKIP  sell_loc  bucket 1  sell capped (price 164.5)')
    expect(out).toContain('SKIP  sell_loc  bucket 2  sell capped (price 150.7007)')
    // The consumed notices must not also render as standalone lines.
    expect(out.split('\n').filter((l) => l.includes('sell capped'))).toHaveLength(2)
  })
  test('ko variant 매수/매도', () => {
    const plan: DayPlan = {
      orders: [
        { kind: 'buy_loc', bucketIndex: 0, limitPrice: 3402200n, shares: 29 },
        { kind: 'market_sell', bucketIndex: 1, limitPrice: 0n, shares: 120 },
      ],
      skips: [],
      notices: [],
    }
    const out = renderDigest(run, plan, ctx, 'ko', { 1: 21 }).join('\n')
    expect(out).toContain('매수')
    expect(out).toContain('매도')
  })
  test('renderClosed holiday', () => {
    expect(renderClosed(dayInfo('2026-11-26'), 'en')).toContain('Thanksgiving')
    expect(renderClosed(dayInfo('2026-11-26'), 'ko')).toContain('추수감사절')
    expect(renderClosed(dayInfo('2026-12-25'), 'ko')).toContain('크리스마스')
  })
  test('renderClosed weekend/normal', () => {
    const s = renderClosed(dayInfo('2026-11-07'), 'en')
    expect(s).toContain('closed')
  })
  test('renderReminder distinct', () => {
    expect(renderReminder('en')).not.toBe(renderReminder('ko'))
  })
  test('chunking forces >1 chunk', () => {
    const orders = Array.from({ length: 300 }, (_, i) => ({ kind: 'buy_loc' as const, bucketIndex: i % 10, limitPrice: BigInt(3000000 + i), shares: 1000 }))
    const plan: DayPlan = { orders, skips: [], notices: [] }
    const out = renderDigest(run, plan, ctx, 'en')
    expect(out.length).toBeGreaterThanOrEqual(2)
    for (const c of out) expect(c.length).toBeLessThanOrEqual(4000)
    const joined = out.join('\n')
    expect(joined).toContain('Buy  LOC  1000 sh  @ 300.00  → bucket 0')
    expect(joined).toContain('Buy  LOC  1000 sh  @ 300.01  → bucket 0')
    expect(joined).toContain('Buy  LOC  1000 sh  @ 300.0299  → bucket 9')
    for (const c of out) {
      for (const line of c.split('\n')) {
        expect(line.startsWith('Buy  LOC') || line.startsWith('Alpha') || line.startsWith('Trade date')).toBe(true)
      }
    }
  })
  test('header appears', () => {
    const plan: DayPlan = { orders: [], skips: [], notices: [] }
    const out = renderDigest(run, plan, ctx, 'en').join('\n')
    expect(out).toContain('Alpha')
    expect(out).toContain('AAPL')
    expect(out).toContain('2026-11-06')
  })
  test('sell loc line shows age when known', () => {
    const plan: DayPlan = {
      orders: [{ kind: 'sell_loc', bucketIndex: 2, limitPrice: 3500000n, shares: 10, ageDays: 21 }],
      skips: [],
      notices: [],
    }
    const out = renderDigest(run, plan, ctx, 'en').join('\n')
    expect(out).toContain('Sell  LOC  10 sh  @ 350.00  → bucket 2  (age 21)')
  })
  test('stamped ageDays wins over the ages argument', () => {
    const plan: DayPlan = {
      orders: [{ kind: 'market_sell', bucketIndex: 1, limitPrice: 0n, shares: 120, ageDays: 21 }],
      skips: [],
      notices: [],
    }
    const out = renderDigest(run, plan, ctx, 'en', { 1: 5 }).join('\n')
    expect(out).toContain('Market  SELL  120 sh  bucket 1  (age 21 — forced exit)')
  })
  test('ko age clauses translated', () => {
    const plan: DayPlan = {
      orders: [
        { kind: 'sell_loc', bucketIndex: 0, limitPrice: 3500000n, shares: 10, ageDays: 21 },
        { kind: 'market_sell', bucketIndex: 1, limitPrice: 0n, shares: 120, ageDays: 120 },
      ],
      skips: [],
      notices: [],
    }
    const out = renderDigest(run, plan, ctx, 'ko').join('\n')
    expect(out).toContain('→ bucket 0  (21일 경과)')
    expect(out).toContain('매도  MARKET  120 sh  bucket 1  (120일 경과 — 강제 청산)')
  })
  test('order-cancelled renders in both languages', () => {
    expect(t('order-cancelled', 'ko', { kind: 'sell_loc', bucket: 2, price: '3.50', reason: t('reason-strategy-change', 'ko') }))
      .toBe('🚫 취소: sell_loc 버킷 2 — 전략 변경 (3.50)')
    expect(t('order-cancelled', 'en', { kind: 'buy_loc', bucket: 0, price: '1.00', reason: t('reason-broker-filled', 'en') }))
      .toBe('🚫 Cancelled: buy_loc bucket 0 — filled elsewhere at broker (1.00)')
  })
})

describe('digest stop line', () => {
  const planWithStops: DayPlan = {
    orders: [
      { kind: 'sell_loc', bucketIndex: 0, limitPrice: 3500000n, shares: 10 },
      { kind: 'stop_sell', bucketIndex: 0, limitPrice: 2700000n, shares: 10 },
      { kind: 'sell_loc', bucketIndex: 2, limitPrice: 3600000n, shares: 5 },
      { kind: 'stop_sell', bucketIndex: 2, limitPrice: 2800000n, shares: 5 },
    ],
    skips: [],
    notices: [],
  }

  test('stop line follows its bucket sell line (en)', () => {
    const lines = renderDigest(run, planWithStops, ctx, 'en')[0]!.split('\n')
    const sellIdx = lines.findIndex((l) => l.includes('bucket 0') && l.includes('LOC'))
    expect(lines[sellIdx]).toBe('Sell  LOC  10 sh  @ 350.00  → bucket 0')
    expect(lines[sellIdx + 1]).toBe('Sell  STOP  10 sh  trigger 270.00  → bucket 0')
    const sell2 = lines.findIndex((l) => l.includes('bucket 2') && l.includes('LOC'))
    expect(lines[sell2 + 1]).toBe('Sell  STOP  5 sh  trigger 280.00  → bucket 2')
  })
  test('stop line renders in ko', () => {
    const lines = renderDigest(run, planWithStops, ctx, 'ko')[0]!.split('\n')
    expect(lines).toContain('매도  STOP  10 sh  발동가 270.00  → bucket 0')
  })
  test('stop lines stay paired with their sell lines when input order is shuffled', () => {
    const shuffled: DayPlan = { ...planWithStops, orders: [planWithStops.orders[3]!, planWithStops.orders[2]!, planWithStops.orders[1]!, planWithStops.orders[0]!] }
    const lines = renderDigest(run, shuffled, ctx, 'en')[0]!.split('\n').slice(2)
    expect(lines.map((l) => l.split('→ ')[1] + ':' + l.split('  ')[1])).toEqual(['bucket 0:LOC', 'bucket 0:STOP', 'bucket 2:LOC', 'bucket 2:STOP'])
  })
  test('a stop without a sell line is still rendered, and market sells keep their place after', () => {
    const plan: DayPlan = {
      orders: [
        { kind: 'market_sell', bucketIndex: 1, limitPrice: 0n, shares: 7 },
        { kind: 'stop_sell', bucketIndex: 3, limitPrice: 2500000n, shares: 4 },
      ],
      skips: [],
      notices: [],
    }
    const lines = renderDigest(run, plan, ctx, 'en')[0]!.split('\n').slice(2)
    expect(lines).toEqual(['Sell  STOP  4 sh  trigger 250.00  → bucket 3', 'Market  SELL  7 sh  bucket 1'])
  })
  test('cut-loss-immediate notice is rendered from the catalog', () => {
    const plan = { ...planWithStops, notices: [{ code: 'cut-loss-immediate', params: { n: 2 } }] }
    const en = renderDigest(run, plan, ctx, 'en')[0]!.split('\n')
    expect(en.at(-1)).toBe('⚠️ 2 stop trigger(s) already at or above the last close — the stop may fire as soon as it is placed')
    expect(en.join('\n')).not.toContain('cut-loss-immediate')
    const ko = renderDigest(run, plan, ctx, 'ko')[0]!.split('\n')
    expect(ko.at(-1)).toBe('⚠️ 손절 발동가 2건이 이미 최근 종가 이상입니다 — 주문하자마자 체결될 수 있습니다')
  })
})
