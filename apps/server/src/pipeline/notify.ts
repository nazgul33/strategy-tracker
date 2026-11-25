import { broadcastNotice, type NoticeResult, type NoticeText } from '../wire/broadcast'
import type { DayDeps } from './day'

export function notifyDay(deps: DayDeps, runId: number | null, text: NoticeText, kind: string): Promise<NoticeResult> {
  return broadcastNotice(
    { allowedChatIds: deps.allowedChatIds, send: deps.send, notificationRepo: deps.repos.notificationRepo },
    runId, text, { kind },
  )
}
