import { eq, and, isNull, lt, sql } from 'drizzle-orm'
import type { RawFill } from '@st/ingest'
import * as s from './schema'
import type { Db } from './db-type'
import type { CaptureChoiceRepo, CaptureChoiceRow } from '../domain/capture-choice'

const toRow = (r: typeof s.captureChoices.$inferSelect): CaptureChoiceRow => ({
  id: r.id, chatId: r.chatId, ticker: r.ticker, mrRunId: r.mrRunId, vrRunId: r.vrRunId,
  fills: JSON.parse(r.fillsJson) as RawFill[], image: { base64: r.imageBase64, mime: r.imageMime },
  readOn: r.readOn, createdAt: r.createdAt, answer: r.answer,
})

export function getCaptureChoiceRepos(db: Db) {
  const captureChoiceRepo = {
    async park(c) {
      const [res] = await db.insert(s.captureChoices).values({
        chatId: c.chatId, ticker: c.ticker, mrRunId: c.mrRunId, vrRunId: c.vrRunId, fillsJson: JSON.stringify(c.fills),
        imageBase64: c.image.base64, imageMime: c.image.mime, readOn: c.readOn,
      })
      return res.insertId
    },
    async get(id) {
      const rows = await db.select().from(s.captureChoices).where(eq(s.captureChoices.id, id)).limit(1)
      return rows[0] ? toRow(rows[0]) : null
    },
    // The guard sits in the WHERE clause, so two presses racing on one question cannot both match.
    async answer(id, answer) {
      const [res] = await db.update(s.captureChoices).set({ answer, answeredAt: sql`now()` })
        .where(and(eq(s.captureChoices.id, id), isNull(s.captureChoices.answer)))
      return res.affectedRows === 1
    },
    // FROM_UNIXTIME is in the session zone, like the TIMESTAMP column it is compared with.
    async deleteOlderThan(cutoff) {
      const [res] = await db.delete(s.captureChoices)
        .where(lt(s.captureChoices.createdAt, sql`FROM_UNIXTIME(${Math.floor(cutoff.getTime() / 1000)})`))
      return res.affectedRows
    },
  } satisfies CaptureChoiceRepo
  return { captureChoiceRepo }
}
