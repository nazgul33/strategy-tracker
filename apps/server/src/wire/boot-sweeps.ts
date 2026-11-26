import { CHOICE_TTL_MS } from '../domain/capture-choice'
import { refreezeKept, type UnfrozenPendingRow, type VisionReviewInsert } from '../domain/vision-review'

const SIM_DRAFT_MAX_AGE_DAYS = 7

type BootSweepRepos = {
  simRepo: { sweepDrafts(before: Date): Promise<number> }
  captureImageRepo: { sweepOrphans(): Promise<number[]> }
  visionReviewRepo: { listUnfrozenKept(): Promise<UnfrozenPendingRow[]>; insertIgnore(row: VisionReviewInsert): Promise<void> }
  captureChoiceRepo: { deleteOlderThan(cutoff: Date): Promise<number> }
}

// Housekeeping must never keep the server from booting: each step logs its own
// failure and the boot continues. Runs before the bot and HTTP server start, so no
// confirm is mid-flight while the screenshot janitor deletes. Four steps: stale sim
// drafts, orphaned screenshots, the rebuild (refreezeKept) of the review record
// of a kept screenshot whose confirm or reject crashed before the freeze, then
// strategy questions parked longer than their 24 hours.
export async function runBootSweeps(repos: BootSweepRepos, now: Date): Promise<void> {
  try {
    const swept = await repos.simRepo.sweepDrafts(new Date(now.getTime() - SIM_DRAFT_MAX_AGE_DAYS * 86_400_000))
    console.log(`[main] swept ${swept} stale sim draft(s) older than ${SIM_DRAFT_MAX_AGE_DAYS} days`)
  } catch (e) {
    console.error('[main] sim draft sweep failed (continuing):', e)
  }
  try {
    const ids = await repos.captureImageRepo.sweepOrphans()
    if (ids.length) console.log(`[main] swept orphaned screenshots/review rows for capture ids: ${ids.join(', ')}`)
  } catch (e) {
    console.error('[main] screenshot sweep failed (continuing):', e)
  }
  try {
    const ids = await refreezeKept(repos)
    if (ids.length) console.log(`[main] rebuilt review records for pending fill ids: ${ids.join(', ')}`)
  } catch (e) {
    console.error('[main] review record rebuild failed (continuing):', e)
  }
  try {
    const n = await repos.captureChoiceRepo.deleteOlderThan(new Date(now.getTime() - CHOICE_TTL_MS))
    if (n) console.log(`[main] deleted ${n} expired screenshot question(s)`)
  } catch (e) {
    console.error('[main] expired question sweep failed (continuing):', e)
  }
}
