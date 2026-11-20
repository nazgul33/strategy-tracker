import { describe, test, expect, spyOn } from 'bun:test'
import { parseUsd } from '@st/core/money'
import { makeBookingNotifier } from '../src/wire/booking-notifier'
import type { SellAttribution } from '../src/domain/sell-match'

const attribution: SellAttribution = {
  shares: 10,
  price: parseUsd('96.50'),
  chosen: { orderId: 11, bucketIdx: 0, kind: 'stop_sell', limitPrice: parseUsd('97.00'), distance: parseUsd('0.50') },
  alternatives: [
    { orderId: 12, bucketIdx: 1, kind: 'sell_loc', limitPrice: parseUsd('92.00'), distance: parseUsd('4.50') },
    { orderId: 13, bucketIdx: 2, kind: 'stop_sell', limitPrice: parseUsd('102.00'), distance: parseUsd('5.50') },
  ],
}

const text = 'ℹ️ Sell 10 sh @ $96.50 was booked to bucket 0 stop ($97.00, $0.50 away). Also possible: bucket 1 target ($92.00, $4.50 away); bucket 2 stop ($102.00, $5.50 away). A target fills at or above its limit and a stop at or below its trigger, so more than one order fit this price; the order whose price is nearest the fill wins.'

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
