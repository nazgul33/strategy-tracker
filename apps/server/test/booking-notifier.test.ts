import { describe, test, expect, spyOn } from 'bun:test'
import { parseUsd } from '@st/core/money'
import { makeBookingNotifier } from '../src/wire/booking-notifier'
import type { Lang } from '@st/telegram/i18n'
import type { OrderRow, SellAttribution } from '../src/domain/sell-match'

const WHY_PRICE = 'More than one order of this type could have filled; the one whose price is nearest the fill price was chosen.'

const attribution: SellAttribution = {
  shares: 10,
  price: parseUsd('96.50'),
  rule: 'price',
  chosen: { orderId: 11, bucketIdx: 0, kind: 'stop_sell', limitPrice: parseUsd('97.00'), distance: parseUsd('0.50') },
  alternatives: [
    { orderId: 12, bucketIdx: 1, kind: 'sell_loc', limitPrice: parseUsd('92.00'), distance: parseUsd('4.50') },
    { orderId: 13, bucketIdx: 2, kind: 'stop_sell', limitPrice: parseUsd('102.00'), distance: parseUsd('5.50') },
  ],
}

const text = `ℹ️ Run #7 AAPL: sell 10 sh @ $96.50 was booked to bucket 1 stop ($97.00, $0.50 away). Also possible: bucket 2 target ($92.00, $4.50 away); bucket 3 stop ($102.00, $5.50 away). ${WHY_PRICE}`

function harness(allowedChatIds: string[], failFor?: string, lang: Lang = 'en') {
  const rows: Array<{ runId: number; chatId: string; text: string }> = []
  const sent: Array<{ chatId: string; text: string }> = []
  const notifier = makeBookingNotifier({
    repos: {
      notificationRepo: { insert: async (n) => { rows.push(n) } },
      runRepo: { get: async (id: number) => (id === 7 ? { ticker: 'AAPL' } : null) },
    },
    allowedChatIds,
    send: async (chatId, t) => {
      if (chatId === failFor) throw new Error('telegram-down')
      sent.push({ chatId, text: t })
    },
    lang,
  })
  return { notifier, rows, sent }
}

const order = (o: Pick<OrderRow, 'kind' | 'bucketIdx' | 'limitPrice'>, runId = 7): OrderRow =>
  ({ id: 12, runId, tradeDate: '2026-11-10', shares: 10, status: 'cancelled', ...o })

describe('booking notifier: siblingCancelled', () => {
  const TAIL = 'at your broker — the other leg already filled, so this order is no longer needed.'

  test('siblingCancelled names the run, ticker and leg in the attribution notice\'s words', async () => {
    const { notifier, sent } = harness(['42'])
    await notifier.siblingCancelled(7, order({ kind: 'sell_loc', bucketIdx: 1, limitPrice: parseUsd('103.00') }))
    expect(sent).toEqual([{ chatId: '42', text: `⚠️ Run #7 AAPL: cancel bucket 2 target ($103.00) ${TAIL}` }])
  })

  test('siblingCancelled renders a stop leg', async () => {
    const { notifier, sent } = harness(['42'])
    await notifier.siblingCancelled(7, order({ kind: 'stop_sell', bucketIdx: 0, limitPrice: parseUsd('97.00') }))
    expect(sent).toEqual([{ chatId: '42', text: `⚠️ Run #7 AAPL: cancel bucket 1 stop ($97.00) ${TAIL}` }])
  })

  test('siblingCancelled names a market leg without a price', async () => {
    const { notifier, sent } = harness(['42'])
    await notifier.siblingCancelled(7, order({ kind: 'market_sell', bucketIdx: 2, limitPrice: 0n }))
    expect(sent).toEqual([{ chatId: '42', text: `⚠️ Run #7 AAPL: cancel bucket 3 market sell ${TAIL}` }])
  })

  test('siblingCancelled renders in ko', async () => {
    const { notifier, sent } = harness(['42'], undefined, 'ko')
    await notifier.siblingCancelled(7, order({ kind: 'sell_loc', bucketIdx: 1, limitPrice: parseUsd('103.00') }))
    expect(sent).toEqual([{ chatId: '42', text: '⚠️ 런 #7 AAPL: 증권사에서 버킷 2 목표가 매도 ($103.00) 주문을 취소하세요 — 반대편 주문이 이미 체결되어 이 주문은 더 이상 필요하지 않습니다.' }])
  })

  test('a run the repo no longer has renders its ticker as ?', async () => {
    const { notifier, rows, sent } = harness(['42'])
    await notifier.siblingCancelled(8, order({ kind: 'sell_loc', bucketIdx: 1, limitPrice: parseUsd('103.00') }, 8))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toStartWith('⚠️ Run #8 ?: cancel bucket 2 target ($103.00)')
    expect(rows).toEqual([{ runId: 8, chatId: '42', text: sent[0]!.text }])
  })

  test('with no allowed chats the sibling notice is recorded for the web', async () => {
    const { notifier, rows, sent } = harness([])
    await notifier.siblingCancelled(7, order({ kind: 'sell_loc', bucketIdx: 1, limitPrice: parseUsd('103.00') }))
    expect(rows).toEqual([{ runId: 7, chatId: 'web', text: `⚠️ Run #7 AAPL: cancel bucket 2 target ($103.00) ${TAIL}` }])
    expect(sent).toEqual([])
  })

  test('a failing sibling send logs the order id as its own field', async () => {
    const { notifier } = harness(['42'], '42')
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await notifier.siblingCancelled(7, order({ kind: 'sell_loc', bucketIdx: 1, limitPrice: parseUsd('103.00') }))
      expect(errors).toHaveBeenCalledTimes(1)
      expect(errors.mock.calls[0]).toEqual(['booking notice failed:', 'sibling-cancelled', { runId: 7, orderId: 12, chatId: '42' }, 'Error: telegram-down'])
    } finally { errors.mockRestore() }
  })
})

describe('booking notifier: buyRemoved', () => {
  const TAIL = 'at your broker — the buy it was placed for was deleted, so this order is no longer needed.'

  test('buyRemoved names the run, ticker and leg with its price', async () => {
    const { notifier, sent } = harness(['42'])
    await notifier.buyRemoved(7, order({ kind: 'sell_loc', bucketIdx: 1, limitPrice: parseUsd('103.00') }))
    expect(sent).toEqual([{ chatId: '42', text: `⚠️ Run #7 AAPL: cancel bucket 2 target ($103.00) ${TAIL}` }])
  })

  test('buyRemoved names a market leg without a price', async () => {
    const { notifier, sent } = harness(['42'])
    await notifier.buyRemoved(7, order({ kind: 'market_sell', bucketIdx: 2, limitPrice: 0n }))
    expect(sent).toEqual([{ chatId: '42', text: `⚠️ Run #7 AAPL: cancel bucket 3 market sell ${TAIL}` }])
  })

  test('buyRemoved renders in ko', async () => {
    const { notifier, sent } = harness(['42'], undefined, 'ko')
    await notifier.buyRemoved(7, order({ kind: 'sell_loc', bucketIdx: 1, limitPrice: parseUsd('103.00') }))
    expect(sent).toEqual([{ chatId: '42', text: '⚠️ 런 #7 AAPL: 증권사에서 버킷 2 목표가 매도 ($103.00) 주문을 취소하세요 — 이 주문의 근거였던 매수 체결이 삭제되어 더 이상 필요하지 않습니다.' }])
  })
})

describe('booking notifier: sellAttributed', () => {
  test('sellAttributed renders every alternative, joined with "; ", and records a row per chat', async () => {
    const { notifier, rows, sent } = harness(['42', '43'])
    await notifier.sellAttributed(7, attribution)
    expect(rows).toEqual([{ runId: 7, chatId: '42', text }, { runId: 7, chatId: '43', text }])
    expect(sent).toEqual([{ chatId: '42', text }, { chatId: '43', text }])
  })

  test('a market-sell alternative renders without a limit or distance', async () => {
    const { notifier, sent } = harness(['42'])
    await notifier.sellAttributed(7, {
      shares: 10,
      price: parseUsd('99.00'),
      rule: 'price',
      chosen: { orderId: 21, bucketIdx: 5, kind: 'sell_loc', limitPrice: parseUsd('98.50'), distance: parseUsd('0.50') },
      alternatives: [
        { orderId: 22, bucketIdx: 0, kind: 'sell_loc', limitPrice: parseUsd('97.85'), distance: parseUsd('1.15') },
        { orderId: 23, bucketIdx: 3, kind: 'market_sell' },
      ],
    })
    expect(sent).toEqual([{ chatId: '42', text: `ℹ️ Run #7 AAPL: sell 10 sh @ $99.00 was booked to bucket 6 target ($98.50, $0.50 away). Also possible: bucket 1 target ($97.85, $1.15 away); bucket 4 market sell. ${WHY_PRICE}` }])
  })

  test('the closing sentence follows the rule that decided', async () => {
    const { notifier, sent } = harness(['42'])
    await notifier.sellAttributed(7, {
      shares: 10,
      price: parseUsd('50.00'),
      rule: 'shares',
      chosen: { orderId: 31, bucketIdx: 2, kind: 'market_sell' },
      alternatives: [{ orderId: 32, bucketIdx: 5, kind: 'market_sell' }],
    })
    expect(sent).toEqual([{ chatId: '42', text: 'ℹ️ Run #7 AAPL: sell 10 sh @ $50.00 was booked to bucket 3 market sell. Also possible: bucket 6 market sell. More than one order of this type could have filled; the bucket holding exactly 10 shares was chosen.' }])
  })

  test('with no allowed chats one row is recorded for the web and nothing is sent', async () => {
    const { notifier, rows, sent } = harness([])
    await notifier.sellAttributed(7, attribution)
    expect(rows).toEqual([{ runId: 7, chatId: 'web', text }])
    expect(sent).toEqual([])
  })

  test('a failing web-only insert is logged, not thrown', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const notifier = makeBookingNotifier({
        repos: {
          notificationRepo: { insert: async () => { throw new Error('db-down') } },
          runRepo: { get: async () => ({ ticker: 'AAPL' }) },
        },
        allowedChatIds: [],
        send: async () => {},
        lang: 'en',
      })
      await notifier.sellAttributed(7, attribution)
      expect(errors).toHaveBeenCalledTimes(1)
      expect(errors.mock.calls[0]).toEqual(['booking notice failed:', 'sell-attributed', { runId: 7, orderId: null, chatId: 'web' }, 'Error: db-down'])
    } finally { errors.mockRestore() }
  })

  test('a failing run lookup falls back to ? and the notice is still recorded and sent', async () => {
    const rows: Array<{ runId: number; chatId: string; text: string }> = []
    const sent: Array<{ chatId: string; text: string }> = []
    const notifier = makeBookingNotifier({
      repos: {
        notificationRepo: { insert: async (n) => { rows.push(n) } },
        runRepo: { get: async () => { throw new Error('lookup-down') } },
      },
      allowedChatIds: ['42'],
      send: async (chatId, t) => { sent.push({ chatId, text: t }) },
      lang: 'en',
    })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await notifier.siblingCancelled(7, order({ kind: 'sell_loc', bucketIdx: 1, limitPrice: parseUsd('103.00') }))
      await notifier.sellAttributed(7, attribution)
      expect(errors.mock.calls).toEqual([
        ['booking notice run lookup failed:', 7, 'Error: lookup-down'],
        ['booking notice run lookup failed:', 7, 'Error: lookup-down'],
      ])
      expect(sent).toHaveLength(2)
      expect(sent[0]!.text).toStartWith('⚠️ Run #7 ?: cancel bucket 2 target ($103.00)')
      expect(sent[1]!.text).toStartWith('ℹ️ Run #7 ?: sell 10 sh @ $96.50')
      expect(rows).toEqual([{ runId: 7, chatId: '42', text: sent[0]!.text }, { runId: 7, chatId: '42', text: sent[1]!.text }])
    } finally { errors.mockRestore() }
  })

  test('a failing run lookup falls back to ? in ko too', async () => {
    const sent: Array<{ chatId: string; text: string }> = []
    const notifier = makeBookingNotifier({
      repos: {
        notificationRepo: { insert: async () => {} },
        runRepo: { get: async () => { throw new Error('lookup-down') } },
      },
      allowedChatIds: ['42'],
      send: async (chatId, t) => { sent.push({ chatId, text: t }) },
      lang: 'ko',
    })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await notifier.siblingCancelled(7, order({ kind: 'sell_loc', bucketIdx: 1, limitPrice: parseUsd('103.00') }))
      await notifier.sellAttributed(7, attribution)
      expect(sent).toHaveLength(2)
      expect(sent[0]!.text).toStartWith('⚠️ 런 #7 ?: 증권사에서 버킷 2 목표가 매도 ($103.00)')
      expect(sent[1]!.text).toStartWith('ℹ️ 런 #7 ?: 매도 10주 @ $96.50')
    } finally { errors.mockRestore() }
  })

  test('a chat whose insert fails still gets the message', async () => {
    const sent: string[] = []
    const notifier = makeBookingNotifier({
      repos: {
        notificationRepo: { insert: async (n) => { if (n.chatId === '42') throw new Error('db-down') } },
        runRepo: { get: async () => ({ ticker: 'AAPL' }) },
      },
      allowedChatIds: ['42', '43'],
      send: async (chatId) => { sent.push(chatId) },
      lang: 'en',
    })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await notifier.sellAttributed(7, attribution)
      expect(sent).toEqual(['42', '43'])
      expect(errors.mock.calls).toEqual([['booking notice failed:', 'sell-attributed', { runId: 7, orderId: null, chatId: '42' }, 'Error: db-down']])
    } finally { errors.mockRestore() }
  })

  test('a chat whose send fails does not stop the next chat', async () => {
    const { notifier, rows, sent } = harness(['42', '43'], '42')
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await notifier.sellAttributed(7, attribution)
      expect(sent).toEqual([{ chatId: '43', text }])
      expect(rows).toEqual([{ runId: 7, chatId: '42', text }, { runId: 7, chatId: '43', text }])
      expect(errors).toHaveBeenCalledTimes(1)
      expect(errors.mock.calls[0]).toEqual(['booking notice failed:', 'sell-attributed', { runId: 7, orderId: null, chatId: '42' }, 'Error: telegram-down'])
    } finally { errors.mockRestore() }
  })
})
