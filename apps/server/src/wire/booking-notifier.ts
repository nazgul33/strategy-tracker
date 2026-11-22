import { formatUsd } from '@st/core'
import { t } from '@st/telegram/i18n'
import type { Lang } from '@st/telegram/i18n'
import type { BookingNotifier } from '../domain/booking'
import type { SellLeg } from '../domain/sell-match'

export interface BookingNotifierDeps {
  repos: {
    notificationRepo: { insert(n: { runId: number; chatId: string; text: string }): Promise<unknown> }
    runRepo: { get(id: number): Promise<{ ticker: string } | null> }
  }
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
    const run = await deps.repos.runRepo.get(runId)
    return { id: runId, ticker: run?.ticker ?? '?' }
  }

  return {
    siblingCancelled: async (runId, order) => {
      const params = { ...(await runParams(runId)), bucket: order.bucketIdx, leg: t(`leg-${order.kind}`, deps.lang) }
      const text = order.kind === 'market_sell'
        ? t('sibling-cancelled-market', deps.lang, params)
        : t('sibling-cancelled', deps.lang, { ...params, limit: formatUsd(order.limitPrice) })
      await broadcast(runId, text, `sibling-cancel order ${order.id}`)
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
      return broadcast(runId, text, 'sell-attributed')
    },
  }
}
