import { formatUsd } from '@st/core'
import { t } from '@st/telegram/i18n'
import type { Lang } from '@st/telegram/i18n'
import type { BookingNotifier } from '../domain/booking'
import type { SellLeg } from '../domain/sell-match'
import { broadcastNotice } from './broadcast'

export interface BookingNotifierDeps {
  repos: {
    notificationRepo: { insert(n: { runId: number; chatId: string; text: string }): Promise<unknown> }
    runRepo: { get(id: number): Promise<{ ticker: string } | null> }
  }
  allowedChatIds: string[]
  send: (chatId: string, text: string) => Promise<void>
  lang: Lang
}

type Notice = 'sell-attributed' | 'sibling-cancelled'

// FillBookingDeps.notify for the real server: renders the booking notices and hands
// delivery (rows, per-chat sends, the web-only row, failure logging) to broadcastNotice.
export function makeBookingNotifier(deps: BookingNotifierDeps): BookingNotifier {
  const delivery = { allowedChatIds: deps.allowedChatIds, send: deps.send, notificationRepo: deps.repos.notificationRepo }
  const log = (kind: Notice, orderId: number | null) => ({ kind, label: 'booking notice failed:', extra: { orderId } })

  const legText = (leg: SellLeg): string =>
    leg.kind === 'market_sell'
      ? t('sell-attributed-alt-market', deps.lang, { bucket: leg.bucketIdx, leg: t('leg-market_sell', deps.lang) })
      : t('sell-attributed-alt', deps.lang, {
          bucket: leg.bucketIdx,
          leg: t(`leg-${leg.kind}`, deps.lang),
          limit: formatUsd(leg.limitPrice),
          distance: formatUsd(leg.distance),
        })

  async function runParams(runId: number): Promise<{ id: number; ticker: string }> {
    try {
      const run = await deps.repos.runRepo.get(runId)
      return { id: runId, ticker: run?.ticker ?? '?' }
    } catch (e) {
      // The notice may ask the operator to cancel a live broker order: never lose it to a lookup failure.
      console.error('booking notice run lookup failed:', runId, String(e))
      return { id: runId, ticker: '?' }
    }
  }

  return {
    siblingCancelled: async (runId, order) => {
      const params = { ...(await runParams(runId)), bucket: order.bucketIdx, leg: t(`leg-${order.kind}`, deps.lang) }
      const text = order.kind === 'market_sell'
        ? t('sibling-cancelled-market', deps.lang, params)
        : t('sibling-cancelled', deps.lang, { ...params, limit: formatUsd(order.limitPrice) })
      await broadcastNotice(delivery, runId, text, log('sibling-cancelled', order.id))
    },
    sellAttributed: async (runId, attribution) => {
      const text = t('sell-attributed', deps.lang, {
        ...(await runParams(runId)),
        shares: attribution.shares,
        price: formatUsd(attribution.price),
        chosen: legText(attribution.chosen),
        alts: attribution.alternatives.map(legText).join('; '),
        why: t(`sell-attributed-why-${attribution.rule}`, deps.lang, { shares: attribution.shares }),
      })
      return broadcastNotice(delivery, runId, text, log('sell-attributed', null))
    },
  }
}
