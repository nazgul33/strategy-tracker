import type { CaptureChoiceRepo, CaptureChoiceRow, ChoiceAnswer, NewCaptureChoice } from '../src/domain/capture-choice'
import type { Expect, IsNever, ArityMismatches } from './type-assert'

/** In-memory parked questions. `createdAt` comes from `now()`, so a test that moves the clock ages them. */
export function makeChoiceFakes(now: () => Date = () => new Date()) {
  const choices: CaptureChoiceRow[] = []
  let lastId = 0 // only goes up, like AUTO_INCREMENT: a deleted question's id is never handed out again
  const stamp = () => now().toISOString().slice(0, 19).replace('T', ' ') // 'YYYY-MM-DD HH:MM:SS', UTC
  const ms = (createdAt: string) => Date.parse(createdAt.replace(' ', 'T') + 'Z')
  const copy = (c: CaptureChoiceRow): CaptureChoiceRow => ({ ...c, fills: c.fills.map((f) => ({ ...f })), image: { ...c.image } })

  const captureChoiceRepo = {
    async park(c: NewCaptureChoice) {
      const id = Math.max(lastId, ...choices.map((x) => x.id)) + 1 // a test may push rows by hand
      lastId = id
      choices.push(copy({ ...c, id, createdAt: stamp(), answer: null }))
      return id
    },
    async get(id: number) { const c = choices.find((x) => x.id === id); return c ? copy(c) : null },
    async answer(id: number, a: ChoiceAnswer) {
      const c = choices.find((x) => x.id === id)
      if (!c || c.answer !== null) return false
      c.answer = a
      return true
    },
    async deleteOlderThan(cutoff: Date) {
      let n = 0
      for (let i = choices.length - 1; i >= 0; i--) if (ms(choices[i]!.createdAt) < cutoff.getTime()) { choices.splice(i, 1); n++ }
      return n
    },
  } satisfies CaptureChoiceRepo

  return { captureChoiceRepo, choices }
}

type _choice = Expect<IsNever<ArityMismatches<{ captureChoiceRepo: ReturnType<typeof makeChoiceFakes>['captureChoiceRepo'] }, { captureChoiceRepo: CaptureChoiceRepo }>>>
