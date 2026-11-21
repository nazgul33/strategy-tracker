const SIM_DRAFT_MAX_AGE_DAYS = 7

type BootSweepRepos = {
  simRepo: { sweepDrafts(before: Date): Promise<number> }
  captureImageRepo: { sweepOrphans(): Promise<number[]> }
}

// Housekeeping must never keep the server from booting: each sweep logs its own
// failure and the boot continues. Runs before the bot and HTTP server start, so no
// confirm is mid-flight while the screenshot janitor deletes.
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
}
