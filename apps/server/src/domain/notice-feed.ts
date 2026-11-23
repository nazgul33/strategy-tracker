import type { NotificationRepo } from './repo-types'

export const NOTICE_PAGE_DEFAULT = 20
export const NOTICE_PAGE_MAX = 100

/** id and sentAt come from the newest row; chatIds are in ascending row-id order. */
export interface NoticeEntry { id: number; runId: number | null; text: string; sentAt: string; chatIds: string[] }
export interface NoticePage { entries: NoticeEntry[]; nextBefore: number | null }

/**
 * One broadcast writes one row per chat, so adjacent rows with the same run and text and a chat
 * not yet seen in the entry are one message. Rows are read newest first in batches until entry
 * `limit + 1` starts, which proves the last returned entry is complete.
 */
export async function loadNoticePage(repo: Pick<NotificationRepo, 'listBefore'>, before: number | null, limit: number): Promise<NoticePage> {
  const batch = limit * 2 + 1
  const entries: NoticeEntry[] = []
  const lastRowId: number[] = []
  let cursor = before
  for (;;) {
    const rows = await repo.listBefore(cursor, batch)
    for (const row of rows) {
      const cur = entries[entries.length - 1]
      if (cur && cur.runId === row.runId && cur.text === row.text && !cur.chatIds.includes(row.chatId)) {
        cur.chatIds.unshift(row.chatId)
        lastRowId[lastRowId.length - 1] = row.id
        continue
      }
      if (entries.length === limit) return { entries, nextBefore: lastRowId[limit - 1]! }
      entries.push({ id: row.id, runId: row.runId, text: row.text, sentAt: row.sentAt, chatIds: [row.chatId] })
      lastRowId.push(row.id)
    }
    if (rows.length < batch) return { entries, nextBefore: null }
    cursor = rows[rows.length - 1]!.id
  }
}
