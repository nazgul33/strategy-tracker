import { describe, test, expect, spyOn } from 'bun:test'
import { parseUsd } from '@st/core/money'
import { makeBookingNotifier } from '../src/wire/booking-notifier'
import type { SellAttribution } from '../src/domain/sell-match'

const WHY_PRICE_10 = 'A target fills at or above its limit, a stop at or below its trigger and a market sell at any price, so more than one order fit this price. A target at exactly the fill price wins; otherwise the only order for exactly 10 shares, if there is one; otherwise the order whose price is nearest the fill, a target before a stop at an equal distance, then the lowest bucket.'

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

const text = `ℹ️ Sell 10 sh @ $96.50 was booked to bucket 0 stop ($97.00, $0.50 away). Also possible: bucket 1 target ($92.00, $4.50 away); bucket 2 stop ($102.00, $5.50 away). ${WHY_PRICE_10}`

function harness(allowedChatIds: string[], failFor?: string) {
  const rows: Array<{ runId: number; chatId: string; text: string }> = []
  const sent: Array<{ chatId: string; text: string }> = []
  const notifier = makeBookingNotifier({
    repos: { notificationRepo: { insert: async (n) => { rows.push(n) } } },
    allowedChatIds,
    send: async (chatId, t) => {
      if (chatId === failFor) throw new Error('telegram-down')
      sent.push({ chatId, text: t })
    },
    lang: 'en',
  })
  return { notifier, rows, sent }
}

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
    expect(sent).toEqual([{ chatId: '42', text: `ℹ️ Sell 10 sh @ $99.00 was booked to bucket 5 target ($98.50, $0.50 away). Also possible: bucket 0 target ($97.85, $1.15 away); bucket 3 market sell. ${WHY_PRICE_10}` }])
  })

  test('the closing sentence follows the rule that decided', async () => {
    const { notifier, sent } = harness(['42'])
    await notifier.sellAttributed(7, {
      shares: 10,
      price: parseUsd('50.00'),
      rule: 'market',
      chosen: { orderId: 31, bucketIdx: 2, kind: 'market_sell' },
      alternatives: [{ orderId: 32, bucketIdx: 5, kind: 'market_sell' }],
    })
    expect(sent).toEqual([{ chatId: '42', text: 'ℹ️ Sell 10 sh @ $50.00 was booked to bucket 2 market sell. Also possible: bucket 5 market sell. No target or stop fit this price and no single order is for exactly 10 shares, so the market sell of the lowest bucket wins.' }])
  })

  test('with no allowed chats nothing is recorded or sent', async () => {
    const { notifier, rows, sent } = harness([])
    await notifier.sellAttributed(7, attribution)
    expect(rows).toEqual([])
    expect(sent).toEqual([])
  })

  test('a chat whose send fails does not stop the next chat', async () => {
    const { notifier, rows, sent } = harness(['42', '43'], '42')
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await notifier.sellAttributed(7, attribution)
      expect(sent).toEqual([{ chatId: '43', text }])
      expect(rows).toEqual([{ runId: 7, chatId: '42', text }, { runId: 7, chatId: '43', text }])
      expect(errors).toHaveBeenCalledTimes(1)
    } finally { errors.mockRestore() }
  })
})
