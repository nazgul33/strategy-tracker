import { Cron } from 'croner'
import type { DayDeps } from './day'
import { runEveningCloses } from './evening-closes'
import { runDecemberNudge, runMorningPipeline, runReminder } from './day'

const sentLine = (what: string, failed: number) =>
  failed === 0 ? `${what} sent` : `${what} sent with ${failed} failure(s)`

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
      const { failed } = await runReminder(deps)
      log?.(sentLine('reminder', failed))
    } catch (e) {
      log?.(`reminder error: ${String(e)}`)
    }
  })
  jobs.push(reminder)

  const evening = new Cron('0 17-19 * * 1-5', { timezone: 'America/New_York' }, async () => {
    try {
      const res = await runEveningCloses(deps)
      log?.(typeof res === 'string' ? `evening closes: ${res}` : `evening closes: ${res.stored} stored, ${res.behind} behind`)
    } catch (e) {
      log?.(`evening closes error: ${String(e)}`)
    }
  })
  jobs.push(evening)

  const nudge = new Cron('0 8 1 12 *', { timezone: 'America/New_York' }, async () => {
    try {
      const { failed } = await runDecemberNudge(deps)
      log?.(sentLine('december nudge', failed))
    } catch (e) {
      log?.(`december nudge error: ${String(e)}`)
    }
  })
  jobs.push(nudge)

  return jobs
}
