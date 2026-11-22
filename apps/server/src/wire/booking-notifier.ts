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

// Notifications rows carry this chat id when no Telegram chat is allowed. The web
// app compares against the literal 'web' (NoticeList) and cannot import this.
export const WEB_ONLY_CHAT_ID = 'web'

type Notice = 'sell-attributed' | 'sibling-cancelled'

// FillBookingDeps.notify for the real server: one message per allowed chat, recorded
// in the notifications table first (the same order as the manual order-cancel
// route). A run with no allowed chat still gets its row (chat id 'web'), so a
// web-only operator sees the notice in the Notifications tab. A chat that fails is
// logged and must not hide the rest.
export function makeBookingNotifier(deps: BookingNotifierDeps): BookingNotifier {
  async function broadcast(runId: number, text: string, notice: Notice, orderId: number | null): Promise<void> {
    const fail = (chatId: string, e: unknown) =>
      console.error('booking notice failed:', notice, { runId, orderId, chatId }, String(e))
    if (deps.allowedChatIds.length === 0) {
      try {
        await deps.repos.notificationRepo.insert({ runId, chatId: WEB_ONLY_CHAT_ID, text })
      } catch (e) {
        fail(WEB_ONLY_CHAT_ID, e)
      }
      return
    }
    for (const chatId of deps.allowedChatIds) {
      try {
        await deps.repos.notificationRepo.insert({ runId, chatId, text })
        await deps.send(chatId, text)
      } catch (e) {
        fail(chatId, e)
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
      await broadcast(runId, text, 'sibling-cancelled', order.id)
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
      return broadcast(runId, text, 'sell-attributed', null)
    },
  }
}
