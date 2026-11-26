import type { ISODate } from '@st/core'
import type { RawFill } from '@st/ingest'

export type ChoiceAnswer = 'mr' | 'vr' | 'both'
export const CHOICE_TTL_MS = 24 * 60 * 60 * 1000
export interface CaptureChoiceRow {
  id: number; chatId: string; ticker: string; mrRunId: number; vrRunId: number
  fills: RawFill[]                        // every field as read
  image: { base64: string; mime: string } // the identical base64 text that was parked
  readOn: ISODate; createdAt: string; answer: ChoiceAnswer | null
}
export type NewCaptureChoice = Omit<CaptureChoiceRow, 'id' | 'createdAt' | 'answer'>
export interface CaptureChoiceRepo {
  park(c: NewCaptureChoice): Promise<number>
  get(id: number): Promise<CaptureChoiceRow | null>
  /** True only for the call that moved the question from open to answered. */
  answer(id: number, answer: ChoiceAnswer): Promise<boolean>
  /** Rows created before the cutoff, answered or not. */
  deleteOlderThan(cutoff: Date): Promise<number>
}
