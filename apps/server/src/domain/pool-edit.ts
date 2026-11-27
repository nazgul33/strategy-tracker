import type { ISODate, RunState } from '@st/core'
import type { LedgerRepo, RepoSurface, RunRepo } from './repo-types'
import { withRunLock } from './run-lock'

export type PoolBucketRepo = RepoSurface['bucketRepo'] & {
  /** One transaction: the run's pool and its state are both written or neither is. */
  saveStateWithPool(runId: number, state: RunState, poolCents: number): Promise<void>
}

export interface PoolEditDeps {
  repos: {
    runRepo: Pick<RunRepo, 'get' | 'updatePool'>
    bucketRepo: PoolBucketRepo
    ledgerRepo: Pick<LedgerRepo, 'insert'>
    poolEditRepo: { insert(input: { runId: number; poolCents: number }): Promise<void> }
  }
  today: ISODate
}

// Sets a run's pool and moves its stored cash by the same difference, so the books stay
// "pool minus fill history" (plus whatever difference a seed left). The run is read, the
// cash moved and the state saved under the run lock. The pool and the cash are stored
// together or not at all (one transaction); a failure after that can only lose the audit
// rows (the pool-edit row, the ledger row), never money, and a retry sees a zero difference.
export function setRunPool(runId: number, poolCents: number, deps: PoolEditDeps): Promise<{ deltaCents: number } | null> {
  return withRunLock(runId, async () => {
    const { runRepo, bucketRepo, ledgerRepo, poolEditRepo } = deps.repos
    const run = await runRepo.get(runId)
    if (!run) return null
    const state = await bucketRepo.loadState(runId)
    const deltaCents = poolCents - run.poolCents
    if (deltaCents === 0) {
      await runRepo.updatePool(runId, poolCents)
      await poolEditRepo.insert({ runId, poolCents })
      return { deltaCents }
    }
    await bucketRepo.saveStateWithPool(runId, { ...state, cashCents: state.cashCents + deltaCents }, poolCents)
    await poolEditRepo.insert({ runId, poolCents })
    await ledgerRepo.insert({
      runId, kind: 'adjust', amountCents: deltaCents,
      ref: JSON.stringify({ bookedOn: deps.today, reason: 'pool-edit', poolCents }),
    })
    return { deltaCents }
  })
}
