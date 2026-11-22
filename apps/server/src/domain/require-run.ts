import type { RunRepo, RunRow } from './repo-types'

export async function requireRun(repos: { runRepo: Pick<RunRepo, 'get'> }, runId: number): Promise<RunRow> {
  const run = await repos.runRepo.get(runId)
  if (!run) throw new Error('run-not-found')
  return run
}
