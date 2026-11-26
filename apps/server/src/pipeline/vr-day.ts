import type { ISODate } from '@st/calendar'
import {
  VR_CYCLE_DAYS, addDays, buyBudgetCents, buyInstructionShares, buyLot, cycleDue, evalCents, nextScheduledStart, nextV, sellLot, vrBand, vrBooks,
  type VrBooks,
} from '@st/strategies/value-rebalancing'
import { t } from '@st/telegram/i18n'
import { renderVrBuyInstruction, renderVrCycle } from '@st/telegram/vr'
import { CHOICE_TTL_MS } from '../domain/capture-choice'
import { withRunLock } from '../domain/run-lock'
import type { DayRepoSurface } from '../domain/repo-types'
import type { NewVrCashMove, NewVrCycle, VrCycleRow, VrFillRow, VrRunRow } from '../domain/vr/repo-types'
import { ladderOf, toEngineFill } from '../domain/vr/view'
import { fetchClose, type CheckedClose } from './close'
import type { DayDeps } from './day'
import { notifyDay } from './notify'

type Decision =
  | { kind: 'vr-buy'; targetCents: number }
  | { kind: 'vr-cycle'; cycle: VrCycleRow; books: VrBooks; fills: VrFillRow[] }
// Something is due this morning but there is no usable close to act on.
const NEEDS_CLOSE = 'needs-close'
// Something is due, but screenshot fills wait for a decision, so the books are not final.
// `waiting` counts the fills; zero means only an unanswered Telegram question holds the run.
type Held = { kind: 'vr-held'; waiting: number }
type Outcome = Decision | Held | typeof NEEDS_CLOSE | null

/** Walks the active VR runs in ascending id; one run never takes the others down, and neither does a failing list. */
export async function processVrRuns(deps: DayDeps, today: ISODate): Promise<{ completed: number; failed: number }> {
  let runs: VrRunRow[]
  try {
    runs = (await deps.repos.vrRunRepo.list()).filter((r) => r.status === 'active')
  } catch (e) {
    console.error('morning VR run list failed:', String(e))
    await notifyDay(deps, null, t('vr-warn-list-error', deps.digestLang), 'vr-list-error')
    return { completed: 0, failed: 1 }
  }
  let completed = 0
  let failed = 0
  for (const run of runs) {
    if ((await processVrRun(deps, run, today)) === 'completed') completed++
    else failed++
  }
  return { completed, failed }
}

async function processVrRun(deps: DayDeps, listed: VrRunRow, today: ISODate): Promise<'completed' | 'failed'> {
  try {
    const fetched = await fetchClose(deps, listed.ticker, today)
    // Reads and writes only, inside the lock; sends happen outside it (the lock is not reentrant).
    // The run is read again here: a pause or a settings change since the list is honoured.
    const step = await withRunLock(listed.id, async () => {
      const run = await deps.repos.vrRunRepo.get(listed.id)
      if (!run || run.status !== 'active') return null
      return { run, outcome: await decide(deps.repos, run, today, fetched, (deps.now ?? (() => new Date()))()) }
    })
    if (!step) return 'completed'
    const { run, outcome } = step
    if (outcome !== null && typeof outcome === 'object' && outcome.kind === 'vr-held') {
      const text = outcome.waiting > 0
        ? t('vr-cycle-held', deps.digestLang, { name: run.name, ticker: run.ticker, n: outcome.waiting })
        : t('vr-cycle-held-question', deps.digestLang, { name: run.name, ticker: run.ticker })
      await notifyDay(deps, run.id, text, 'vr-held')
      return 'completed'
    }
    if (outcome === NEEDS_CLOSE) {
      await notifyDay(deps, run.id, t('vr-warn-data-error', deps.digestLang, { id: run.id, ticker: run.ticker }), 'data-error')
      return 'failed'
    }
    if (!fetched) console.log('morning VR run: close missing or stale, nothing due:', { runId: run.id, ticker: run.ticker })
    // The buy instruction is sent again on every run of the pipeline that day, as MR re-notifies a planned run.
    if (outcome && fetched) await notifyDay(deps, run.id, render(outcome, run, fetched, deps.digestLang), outcome.kind)
    return 'completed'
  } catch (e) {
    console.error('morning VR run failed:', { runId: listed.id, ticker: listed.ticker }, String(e))
    await notifyDay(deps, listed.id, t('vr-warn-run-error', deps.digestLang, { id: listed.id, ticker: listed.ticker }), 'run-error')
    return 'failed'
  }
}

async function decide(repos: DayRepoSurface, run: VrRunRow, today: ISODate, fetched: CheckedClose | null, now: Date): Promise<Outcome> {
  const fills = await repos.vrFillRepo.listForRun(run.id)
  const moves = await repos.vrCashRepo.listForRun(run.id)
  const latest = await repos.vrCycleRepo.latest(run.id)
  const books = vrBooks(fills.map(toEngineFill), moves)
  const openFillId = fills.reduce((max, f) => Math.max(max, f.id), 0)
  const waiting = await repos.vrPendingRepo.countPending(run.id)
  // A Telegram question left open may still turn into fills dated before this cycle's start, so it holds the run too.
  const asked = await repos.captureChoiceRepo.countOpenForVrRun(run.id, new Date(now.getTime() - CHOICE_TTL_MS))
  const held: Held | null = waiting > 0 || asked > 0 ? { kind: 'vr-held', waiting } : null

  const open = async (cycle: NewVrCycle, deposit: Omit<NewVrCashMove, 'cycleId'> | null): Promise<Decision> => {
    await repos.vrCycleRepo.open(cycle, deposit)
    const row = await repos.vrCycleRepo.latest(run.id)
    if (!row) throw new Error('cycle missing after open')
    return { kind: 'vr-cycle', cycle: row, books, fills }
  }

  // Waiting fills hold every step that acts on the books, before the close is looked at.
  if (!latest) {
    if (held) return held
    if (!fetched) return NEEDS_CLOSE
    if (books.shares <= 0) return { kind: 'vr-buy', targetCents: run.initialVCents }
    const band = vrBand(run.initialVCents, run.bandPpm)
    // Cycle 1 books no deposit, whatever the settings say.
    return open({
      runId: run.id, seq: 1, scheduledStart: today, startDate: today,
      vCents: run.initialVCents, bandMinCents: band.minCents, bandMaxCents: band.maxCents,
      openShares: books.shares, openPoolCents: books.poolCents,
      buyBudgetCents: buyBudgetCents(books.poolCents, run.spendLimitPpm), buyLot: buyLot(books.shares), sellLot: sellLot(books.shares),
      prevClose: null, evalCents: null, poolBeforeCents: null, g: run.g, formula: run.formula, depositCents: 0, vKept: false, openFillId,
    }, null)
  }

  if (latest.startDate >= today) return null
  const due = cycleDue(latest.scheduledStart, today)
  if (!due && books.shares > 0) return null
  if (held) return held
  if (!fetched) return NEEDS_CLOSE
  if (!due) return { kind: 'vr-buy', targetCents: latest.vCents }

  const close = fetched.close
  const evalNow = evalCents(books.shares, close)
  const deposit = run.cycleDepositCents
  const { vCents, kept } = nextV({ vCents: latest.vCents, poolCents: books.poolCents, evalCents: evalNow, settings: run })
  const pool = books.poolCents + deposit
  const band = vrBand(vCents, run.bandPpm)
  return open({
    runId: run.id, seq: latest.seq + 1, scheduledStart: nextScheduledStart(latest.scheduledStart, today), startDate: today,
    vCents, bandMinCents: band.minCents, bandMaxCents: band.maxCents,
    openShares: books.shares, openPoolCents: pool, buyBudgetCents: buyBudgetCents(pool, run.spendLimitPpm),
    buyLot: buyLot(books.shares), sellLot: sellLot(books.shares),
    prevClose: close, evalCents: evalNow, poolBeforeCents: books.poolCents, g: run.g, formula: run.formula, depositCents: deposit, vKept: kept, openFillId,
  }, deposit === 0 ? null : { runId: run.id, kind: deposit > 0 ? 'deposit' : 'withdraw', amountCents: deposit, movedOn: today, note: null })
}

function render(d: Decision, run: VrRunRow, fetched: CheckedClose, lang: DayDeps['digestLang']) {
  if (d.kind === 'vr-buy') {
    return renderVrBuyInstruction({
      runId: run.id, name: run.name, ticker: run.ticker, shares: buyInstructionShares(d.targetCents, fetched.close),
      targetCents: d.targetCents, lastClose: fetched.close, lastCloseDate: fetched.closeDate,
    }, lang)
  }
  const c = d.cycle
  const holds = c.openShares > 0
  const ladder = holds ? ladderOf(c, d.books.shares, d.fills) : { buy: [], sell: [] }
  const chunks = renderVrCycle({
    runId: run.id, name: run.name, ticker: run.ticker, seq: c.seq, startDate: c.startDate, endDate: addDays(c.scheduledStart, VR_CYCLE_DAYS - 1),
    lastClose: fetched.close, lastCloseDate: fetched.closeDate,
    vCents: c.vCents, bandMinCents: c.bandMinCents, bandMaxCents: c.bandMaxCents, shares: c.openShares, poolCents: c.openPoolCents, budgetCents: c.buyBudgetCents,
    depositCents: c.depositCents, vKept: c.vKept, buy: ladder.buy, sell: ladder.sell,
    instruction: holds ? null : { shares: buyInstructionShares(c.vCents, fetched.close), targetCents: c.vCents },
  }, lang)
  return { record: chunks.join('\n'), send: chunks }
}
