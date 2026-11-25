import { vrBooks } from '@st/strategies/value-rebalancing'
import { renderVrOrders, renderVrStatus } from '@st/telegram/vr'
import type { Lang } from '@st/telegram/i18n'
import type { VrRepos, VrRunRow } from '../domain/vr/repo-types'
import { ladderOf, toEngineFill } from '../domain/vr/view'

// Reads are unlocked, like MR's /status.
async function activeBlocks(repos: VrRepos, build: (run: VrRunRow) => Promise<string | null>): Promise<string[]> {
  const blocks: string[] = []
  for (const run of await repos.vrRunRepo.list()) {
    if (run.status !== 'active') continue
    const block = await build(run)
    if (block !== null) blocks.push(block)
  }
  return blocks
}

async function load(repos: VrRepos, runId: number) {
  const fills = await repos.vrFillRepo.listForRun(runId)
  const moves = await repos.vrCashRepo.listForRun(runId)
  return { fills, books: vrBooks(fills.map(toEngineFill), moves), cycle: await repos.vrCycleRepo.latest(runId) }
}

export function vrStatusBlocks(repos: VrRepos, lang: Lang): Promise<string[]> {
  return activeBlocks(repos, async (run) => {
    const { books, cycle } = await load(repos, run.id)
    return renderVrStatus({
      runId: run.id, ticker: run.ticker, shares: books.shares, poolCents: books.poolCents,
      vCents: cycle?.vCents ?? null, bandMinCents: cycle?.bandMinCents ?? null, bandMaxCents: cycle?.bandMaxCents ?? null,
    }, lang)
  })
}

/** The rungs still open, per run; a run with no cycle, no shares or no open rungs adds nothing. */
export function vrOrdersBlocks(repos: VrRepos, lang: Lang): Promise<string[]> {
  return activeBlocks(repos, async (run) => {
    const { fills, books, cycle } = await load(repos, run.id)
    const { buy, sell } = ladderOf(cycle, books.shares, fills)
    return buy.length === 0 && sell.length === 0 ? null : renderVrOrders({ runId: run.id, ticker: run.ticker, buy, sell }, lang)
  })
}
