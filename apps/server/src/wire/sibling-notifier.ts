import { formatUsd } from '@st/core'
import { t } from '@st/telegram/i18n'
import type { Lang } from '@st/telegram/i18n'
import type { OrderRow } from '../domain/booking'

export interface SiblingNotifierDeps {
  repos: { notificationRepo: { insert(n: { runId: number; chatId: string; text: string }): Promise<unknown> } }
  allowedChatIds: string[]
  send: (chatId: string, text: string) => Promise<void>
  lang: Lang
}

// BookingDeps.notifySiblingCancelled for the real server: one message per allowed
// chat, recorded in the notifications table first (the same order as the manual
// order-cancel route). A chat that fails is logged and must not hide the rest.
export function makeSiblingNotifier(deps: SiblingNotifierDeps): (runId: number, order: OrderRow) => Promise<void> {
  return async (runId, order) => {
    const text = t('sibling-cancelled', deps.lang, { kind: order.kind, bucket: order.bucketIdx, price: formatUsd(order.limitPrice) })
    for (const chatId of deps.allowedChatIds) {
      try {
        await deps.repos.notificationRepo.insert({ runId, chatId, text })
        await deps.send(chatId, text)
      } catch (e) {
        console.error('sibling-cancel message failed:', runId, order.id, chatId, String(e))
      }
    }
  }
}
