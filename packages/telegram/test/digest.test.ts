import { describe, test, expect } from 'bun:test'
import { renderDigest, renderClosed, renderReminder } from '../src/digest'
import { dayInfo } from '@st/calendar'
import type { Run, DayPlan, DayContext } from '@st/core'

const run: Run = { id: 1, name: 'Alpha', ticker: 'AAPL', strategyKey: 'mean-reversion', costPpm: 0, poolCents: 100000, status: 'active' }
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
})
