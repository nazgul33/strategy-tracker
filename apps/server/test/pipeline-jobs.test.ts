import { describe, test, expect } from 'bun:test'
import { startJobs } from '../src/pipeline/wire'
import { setup } from './vr-day-fixture'

describe('startJobs', () => {
  test('registers the morning, reminder, December and evening jobs', async () => {
    const { deps } = await setup({ today: () => '2026-11-26' }, { vr: null })
    const logs: string[] = []
    const jobs = startJobs(deps, (m) => logs.push(m))
    try {
      const patterns = jobs.map((j) => j.getPattern())
      for (const p of ['30 7 * * 1-5', '5 16 * * 1-5', '0 8 1 12 *', '0 17 * * 1-5']) expect(patterns).toContain(p)
      expect(jobs).toHaveLength(4)
      for (const j of jobs) expect(j.options.timezone).toBe('America/New_York')

      const evening = jobs.find((j) => j.getPattern() === '0 17 * * 1-5')!
      expect(evening.nextRun(new Date('2026-11-24T21:00:00Z'))?.toISOString()).toBe('2026-11-24T22:00:00.000Z')
      expect(evening.nextRun(new Date('2026-03-06T23:00:00Z'))?.toISOString()).toBe('2026-03-09T21:00:00.000Z')

      await evening.trigger()
      expect(logs).toContain('evening closes: closed')
    } finally {
      for (const j of jobs) j.stop()
    }
  })
})
