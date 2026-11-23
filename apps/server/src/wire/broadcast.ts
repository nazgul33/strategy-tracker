// Notifications rows carry this chat id when no Telegram chat is allowed. The web
// app compares against the literal 'web' (NoticeList) and cannot import this.
export const WEB_ONLY_CHAT_ID = 'web'

// Generic over the run id so a caller whose repo only takes numeric run ids (booking notifier) stays sound.
export interface BroadcastDeps<R extends number | null = number | null> {
  allowedChatIds: string[]
  send: (chatId: string, text: string) => Promise<void>
  notificationRepo: { insert(n: { runId: R; chatId: string; text: string }): Promise<unknown> }
}

export interface NoticeLog {
  kind: string                      // e.g. 'digest', 'closed', 'sell-attributed'
  label?: string                    // console.error prefix, default 'notice failed:'
  extra?: Record<string, unknown>   // merged into the logged object, e.g. { orderId }
}

// A plain string is recorded and sent as is. The object form records `record` once per chat
// and sends every entry of `send` as its own message (a digest longer than one Telegram message).
export type NoticeText = string | { record: string; send: string[] }

// Records one notice in the notifications table and sends it to every allowed chat, in
// that order per chat. With no allowed chat the notice still gets one row (chat id 'web')
// so a web-only operator sees it. Every failure (insert, or each part's send) is logged
// and never hides the rest; this function never rejects.
export async function broadcastNotice<R extends number | null>(
  deps: BroadcastDeps<R>, runId: R, text: NoticeText, log: NoticeLog,
): Promise<void> {
  const { record, send } = typeof text === 'string' ? { record: text, send: [text] } : text
  const fail = (chatId: string, e: unknown, part?: number) =>
    console.error(
      log.label ?? 'notice failed:',
      log.kind,
      { runId, ...log.extra, chatId, ...(part === undefined ? {} : { part }) },
      String(e),
    )
  if (deps.allowedChatIds.length === 0) {
    try {
      await deps.notificationRepo.insert({ runId, chatId: WEB_ONLY_CHAT_ID, text: record })
    } catch (e) {
      fail(WEB_ONLY_CHAT_ID, e)
    }
    return
  }
  for (const chatId of deps.allowedChatIds) {
    try {
      await deps.notificationRepo.insert({ runId, chatId, text: record })
    } catch (e) {
      fail(chatId, e)
    }
    for (const [i, part] of send.entries()) {
      try {
        await deps.send(chatId, part)
      } catch (e) {
        fail(chatId, e, send.length > 1 ? i + 1 : undefined)
      }
    }
  }
}
