import type { ISODate } from '@st/core'
import type { LedgerRepo, RepoSurface, RunRepo } from './repo-types'
import { withRunLock } from './run-lock'

export interface PoolEditDeps {
  repos: {
    runRepo: Pick<RunRepo, 'get' | 'updatePool'>
    bucketRepo: RepoSurface['bucketRepo']
    ledgerRepo: Pick<LedgerRepo, 'insert'>
    poolEditRepo: { insert(input: { runId: number; poolCents: number }): Promise<void> }
  }
  today: ISODate
}

// Sets a run's pool and moves its stored cash by the same difference, so the books stay
// "pool minus fill history" (plus whatever difference a seed left). The run is read, the
// cash moved and the state saved under the run lock; the pool is written first, so a
// failure part-way can leave the cash short of the new pool but never counts the funds twice.
export function setRunPool(runId: number, poolCents: number, deps: PoolEditDeps): Promise<{ deltaCents: number } | null> {
  return withRunLock(runId, async () => {
    const { runRepo, bucketRepo, ledgerRepo, poolEditRepo } = deps.repos
    const run = await runRepo.get(runId)
    if (!run) return null
    const state = await bucketRepo.loadState(runId)
    const deltaCents = poolCents - run.poolCents
    await runRepo.updatePool(runId, poolCents)
    await poolEditRepo.insert({ runId, poolCents })
    if (deltaCents !== 0) {
      await bucketRepo.saveState(runId, { ...state, cashCents: state.cashCents + deltaCents })
      await ledgerRepo.insert({
        runId, kind: 'adjust', amountCents: deltaCents,
        ref: JSON.stringify({ bookedOn: deps.today, reason: 'pool-edit', poolCents }),
      })
    }
    return { deltaCents }
  })
}
