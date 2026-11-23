import { Cron } from 'croner'
import type { DayDeps } from './day'
import { runDecemberNudge, runMorningPipeline, runReminder } from './day'

export function startJobs(deps: DayDeps, log?: (msg: string) => void): Cron[] {
  const jobs: Cron[] = []

  const morning = new Cron('30 7 * * 1-5', { timezone: 'America/New_York' }, async () => {
    try {
      const res = await runMorningPipeline(deps)
      log?.(`morning pipeline: ${res}`)
    } catch (e) {
      log?.(`morning pipeline error: ${String(e)}`)
    }
  })
  jobs.push(morning)

  const reminder = new Cron('5 16 * * 1-5', { timezone: 'America/New_York' }, async () => {
    try {
      await runReminder(deps)
      log?.('reminder sent')
    } catch (e) {
      log?.(`reminder error: ${String(e)}`)
    }
  })
  jobs.push(reminder)

  const nudge = new Cron('0 8 1 12 *', { timezone: 'America/New_York' }, async () => {
    try {
      await runDecemberNudge(deps)
      log?.('december nudge sent')
    } catch (e) {
      log?.(`december nudge error: ${String(e)}`)
    }
  })
  jobs.push(nudge)

  return jobs
}
