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
    expect(out).toContain('⚠️ Unconfirmed orders from 2026-11-05: 3')
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
  test('sibling-cancelled tells the operator to pull the leg, in both languages', () => {
    const params = (lang: 'en' | 'ko') => ({ id: 7, ticker: 'AAPL', bucket: 3, leg: t('leg-stop_sell', lang), limit: '97.00' })
    expect(t('sibling-cancelled', 'en', params('en')))
      .toBe('⚠️ Run #7 AAPL: cancel bucket 3 stop ($97.00) at your broker — the other leg already filled, so this order is no longer needed.')
    expect(t('sibling-cancelled', 'ko', params('ko')))
      .toBe('⚠️ 런 #7 AAPL: 증권사에서 버킷 3 손절 매도 ($97.00) 주문을 취소하세요 — 반대편 주문이 이미 체결되어 이 주문은 더 이상 필요하지 않습니다.')
  })
  test('sibling-cancelled-market omits the price, in both languages', () => {
    const params = (lang: 'en' | 'ko') => ({ id: 7, ticker: 'AAPL', bucket: 2, leg: t('leg-market_sell', lang) })
    expect(t('sibling-cancelled-market', 'en', params('en')))
      .toBe('⚠️ Run #7 AAPL: cancel bucket 2 market sell at your broker — the other leg already filled, so this order is no longer needed.')
    expect(t('sibling-cancelled-market', 'ko', params('ko')))
      .toBe('⚠️ 런 #7 AAPL: 증권사에서 버킷 2 시장가 매도 주문을 취소하세요 — 반대편 주문이 이미 체결되어 이 주문은 더 이상 필요하지 않습니다.')
  })
  test('the attribution and sibling notices describe one leg in the same words', () => {
    for (const [lang, words] of [['en', 'bucket 1 target ($103.00'], ['ko', '버킷 1 목표가 매도 ($103.00']] as const) {
      const p = { bucket: 1, leg: t('leg-sell_loc', lang), limit: '103.00' }
      expect(t('sell-attributed-alt', lang, { ...p, distance: '6.50' })).toContain(words)
      expect(t('sibling-cancelled', lang, { id: 7, ticker: 'AAPL', ...p })).toContain(words)
    }
  })
  test('sell-attributed names the chosen leg, the alternatives and the deciding rule in both languages', () => {
    const WHY_PRICE = 'More than one order of this type could have filled; the one whose price is nearest the fill price was chosen.'
    const leg = (lang: 'en' | 'ko', bucket: number, kind: string, limit: string, distance: string) =>
      t('sell-attributed-alt', lang, { bucket, leg: t(`leg-${kind}`, lang), limit, distance })
    const render = (lang: 'en' | 'ko') => t('sell-attributed', lang, {
      id: 7, ticker: 'AAPL', shares: 10, price: '96.50', chosen: leg(lang, 0, 'stop_sell', '97.00', '0.50'),
      alts: leg(lang, 9, 'sell_loc', '91.00', '5.50'), why: t('sell-attributed-why-price', lang, { shares: 10 }),
    })
    expect(render('en')).toBe(`ℹ️ Run #7 AAPL: sell 10 sh @ $96.50 was booked to bucket 0 stop ($97.00, $0.50 away). Also possible: bucket 9 target ($91.00, $5.50 away). ${WHY_PRICE}`)
    expect(render('ko')).toBe('ℹ️ 런 #7 AAPL: 매도 10주 @ $96.50 체결을 버킷 0 손절 매도 ($97.00, $0.50 차이)에 기록했습니다. 다른 후보: 버킷 9 목표가 매도 ($91.00, $5.50 차이). 체결된 주문으로 볼 수 있는 이 유형의 주문이 둘 이상입니다. 가격이 체결가에 가장 가까운 주문을 선택했습니다.')
    expect(t('sell-attributed-alt', 'en', { bucket: 9, leg: t('leg-sell_loc', 'en'), limit: '91.00', distance: '5.50' })).toBe('bucket 9 target ($91.00, $5.50 away)')
    expect(t('sell-attributed-alt', 'ko', { bucket: 9, leg: t('leg-sell_loc', 'ko'), limit: '91.00', distance: '5.50' })).toBe('버킷 9 목표가 매도 ($91.00, $5.50 차이)')
    expect(t('sell-attributed-alt-market', 'en', { bucket: 3, leg: t('leg-market_sell', 'en') })).toBe('bucket 3 market sell')
    expect(t('sell-attributed-alt-market', 'ko', { bucket: 3, leg: t('leg-market_sell', 'ko') })).toBe('버킷 3 시장가 매도')
    expect(t('leg-stop_sell', 'en')).toBe('stop')
    const why = (key: string, lang: 'en' | 'ko') => t(`sell-attributed-why-${key}`, lang, { shares: 10 })
    expect(why('order-price', 'en')).toBe('More than one order of this type could have filled; the one whose limit is nearest the order price on the screenshot was chosen.')
    expect(why('ordered-shares', 'en')).toBe('More than one order of this type could have filled; the one placed for the ordered quantity on the screenshot was chosen.')
    expect(why('shares', 'en')).toBe('More than one order of this type could have filled; the bucket holding exactly 10 shares was chosen.')
    expect(why('older', 'en')).toBe('More than one order of this type could have filled and nothing else told them apart; the bucket bought earliest was chosen.')
    expect(why('shares', 'ko')).toBe('체결된 주문으로 볼 수 있는 이 유형의 주문이 둘 이상입니다. 정확히 10주를 보유한 버킷을 선택했습니다.')
    for (const key of ['order-price', 'ordered-shares', 'shares', 'price', 'older']) {
      for (const lang of ['en', 'ko'] as const) expect(why(key, lang)).not.toBe(`sell-attributed-why-${key}`)
      expect(why(key, 'ko')).toMatch(/[가-힣]/)
    }
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
