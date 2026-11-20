import { formatUsd } from '@st/core'
import { t } from '@st/telegram/i18n'
import type { Lang } from '@st/telegram/i18n'
import type { BookingNotifier } from '../domain/booking'
import type { SellLeg } from '../domain/sell-match'

export interface BookingNotifierDeps {
  repos: { notificationRepo: { insert(n: { runId: number; chatId: string; text: string }): Promise<unknown> } }
  allowedChatIds: string[]
  send: (chatId: string, text: string) => Promise<void>
  lang: Lang
}

// FillBookingDeps.notify for the real server: one message per allowed chat, recorded
// in the notifications table first (the same order as the manual order-cancel
// route). A chat that fails is logged and must not hide the rest.
export function makeBookingNotifier(deps: BookingNotifierDeps): BookingNotifier {
  async function broadcast(runId: number, text: string, what: string): Promise<void> {
    for (const chatId of deps.allowedChatIds) {
      try {
        await deps.repos.notificationRepo.insert({ runId, chatId, text })
        await deps.send(chatId, text)
      } catch (e) {
        console.error(`${what} message failed:`, runId, chatId, String(e))
      }
    }
  }

  const legParams = (leg: SellLeg) => ({
    bucket: leg.bucketIdx,
    leg: t(`leg-${leg.kind}`, deps.lang),
    limit: formatUsd(leg.limitPrice),
    distance: formatUsd(leg.distance),
  })

  return {
    siblingCancelled: (runId, order) =>
      broadcast(runId, t('sibling-cancelled', deps.lang, { kind: order.kind, bucket: order.bucketIdx, price: formatUsd(order.limitPrice) }), `sibling-cancel order ${order.id}`),
    sellAttributed: (runId, attribution) => {
      const alts = attribution.alternatives.map((a) => t('sell-attributed-alt', deps.lang, legParams(a))).join('; ')
      const text = t('sell-attributed', deps.lang, {
        shares: attribution.shares,
        price: formatUsd(attribution.price),
        ...legParams(attribution.chosen),
        alts,
      })
      return broadcast(runId, text, 'sell-attributed')
    },
  }
}
