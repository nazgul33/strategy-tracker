import type { ISODate } from '@st/core'
import { DEFAULT_VR_SETTINGS, type VrFormula, type VrSettings } from '@st/strategies/value-rebalancing'
import type { RunStatus } from '../repo-types'
import { isValidCostPpm } from '../ppm'
import { withRunLock } from '../run-lock'
import type { NewVrRun, VrRepos, VrRunRepo, VrRunRow } from './repo-types'
import { buildVrDetail, buildVrSummary, lastCloseOf, type VrRunDetail, type VrRunSummary } from './view'

export class VrBadInput extends Error {
  constructor(readonly field: string) {
    super(`invalid ${field}`)
  }
}

export const INT32_MAX = 2_147_483_647
const MAX_NAME = 128
const MAX_TICKER = 16

/** An integer the INT columns hold; anything wider would answer 500 at the database. */
export const isInt32 = (x: unknown): x is number => Number.isInteger(x) && Math.abs(x as number) <= INT32_MAX

function intIn(field: string, v: unknown, min: number, max: number): number {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new VrBadInput(field)
  return v as number
}

const present = (v: unknown) => v !== undefined

/** Create applies defaults for absent fields; a settings update (`withDefaults` false) requires all five. */
export function parseVrSettings(body: any, withDefaults: boolean): VrSettings {
  const pick = (k: keyof VrSettings) => (present(body?.[k]) || !withDefaults ? body?.[k] : DEFAULT_VR_SETTINGS[k])
  const g = intIn('g', pick('g'), 1, 1000)
  const formula = pick('formula')
  if (formula !== 'basic' && formula !== 'skill') throw new VrBadInput('formula')
  return {
    g,
    formula: formula as VrFormula,
    bandPpm: intIn('bandPpm', pick('bandPpm'), 1, 999_999),
    spendLimitPpm: intIn('spendLimitPpm', pick('spendLimitPpm'), 0, 1_000_000),
    cycleDepositCents: intIn('cycleDepositCents', pick('cycleDepositCents'), -INT32_MAX, INT32_MAX),
  }
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

export function parseVrCreate(body: any, defaultCostPpm: number, today: ISODate): NewVrRun {
  if (!nonEmpty(body?.name) || body.name.length > MAX_NAME) throw new VrBadInput('name')
  if (!nonEmpty(body?.ticker) || body.ticker.length > MAX_TICKER) throw new VrBadInput('ticker')
  const cashCents = intIn('cashCents', body?.cashCents, 1, INT32_MAX)
  const initialStockCents = intIn('initialStockCents', present(body?.initialStockCents) ? body.initialStockCents : Math.floor(cashCents / 2), 1, cashCents)
  const settings = parseVrSettings(body, true)
  const costPpm = present(body?.costPpm) ? body.costPpm : defaultCostPpm
  if (!isValidCostPpm(costPpm)) throw new VrBadInput('costPpm')
  return { ...settings, ticker: body.ticker, name: body.name, costPpm, initialVCents: initialStockCents, openingCashCents: cashCents, openedOn: today }
}

export function createVrRun(repo: Pick<VrRunRepo, 'create'>, input: NewVrRun): Promise<number> {
  return repo.create(input)
}

export async function setVrStatus(
  repo: Pick<VrRunRepo, 'get' | 'updateStatus'>, id: number, status: RunStatus, transitions: Record<RunStatus, RunStatus[]>,
): Promise<'ok' | 'not-found' | 'invalid-transition'> {
  return withRunLock(id, async () => {
    const run = await repo.get(id)
    if (!run) return 'not-found'
    if (!(transitions[run.status] ?? []).includes(status)) return 'invalid-transition'
    await repo.updateStatus(id, status)
    return 'ok'
  })
}

/** False when the run does not exist. */
export function updateVrSettings(repo: Pick<VrRunRepo, 'get' | 'updateSettings'>, id: number, s: VrSettings): Promise<boolean> {
  return withRunLock(id, async () => {
    if (!(await repo.get(id))) return false
    await repo.updateSettings(id, s)
    return true
  })
}

export interface VrReadDeps {
  repos: Pick<VrRepos, 'vrRunRepo' | 'vrCycleRepo' | 'vrFillRepo' | 'vrCashRepo'> & {
    priceHistoryRepo: { listForTicker(ticker: string): Promise<{ tradeDate: string; close: bigint }[]> }
  }
  today: ISODate
}

async function loadParts(run: VrRunRow, deps: VrReadDeps) {
  const r = deps.repos
  const [fills, moves, cycle, closes] = await Promise.all([
    r.vrFillRepo.listForRun(run.id), r.vrCashRepo.listForRun(run.id), r.vrCycleRepo.latest(run.id), r.priceHistoryRepo.listForTicker(run.ticker),
  ])
  return { run, fills, moves, cycle, lastClose: lastCloseOf(closes) }
}

export async function loadVrDetail(run: VrRunRow, deps: VrReadDeps): Promise<VrRunDetail> {
  return buildVrDetail({ ...(await loadParts(run, deps)), today: deps.today })
}

export async function loadVrSummaries(deps: VrReadDeps): Promise<VrRunSummary[]> {
  const runs = await deps.repos.vrRunRepo.list()
  return Promise.all(runs.map(async (run) => buildVrSummary(await loadParts(run, deps))))
}
