import { parseUsd, type ISODate } from '@st/core'
import { formatUsd } from '@st/core/money'
import type { RawFill } from '@st/ingest'

/** A re-extracted fill that matches an existing booked/pending fill on everything
 * but price: the same trade with a price discrepancy — never a new row. */
export interface CaptureConflict {
  side: 'buy' | 'sell'
  ticker: string
  shares: number
  extractedPrice: string
  /** Canonical fee from the raw fill; null when the screenshot showed none. */
  extractedFee: string | null
  filledOn: ISODate
  bookedId: number | null
  bookedPrice: string | null
  pendingId: number | null
  pendingPrice: string | null
  /** Set by recordCorrections for booked-fill conflicts; the matcher leaves null. */
  correction: { id: number; status: 'open' | 'dismissed' } | null
}

/** What the dedup pass hands back to ingestCapture: the fills that are genuinely
 * new, plus one conflict per re-detected trade with a price discrepancy. */
export interface CaptureMatch {
  fresh: RawFill[]
  conflicts: CaptureConflict[]
}

// Only the dedup-relevant fields of a booked fill, declared here so this module
// stays independent of booking.ts (which imports the matcher, never the other
// way round). FillRow satisfies it structurally.
interface ExistingFill {
  id: number
  side: 'buy' | 'sell'
  ticker: string
  shares: number
  price: bigint
  filledOn: ISODate
}

// Same for a pending row: real repositories hand back bigint prices, test
// doubles may hand back strings, and canon() settles both spellings.
interface ExistingPending {
  id: number
  runId: number
  side: 'buy' | 'sell'
  ticker: string
  shares: number
  price: bigint | string
  filledOn: ISODate
}

/** The read side the matcher needs from the repository surface: the run's
 * booked fills and all pending rows (pending rows are filtered to the run
 * inside the matcher). */
export interface CaptureTradeReader {
  fillRepo: { listForRun(runId: number): Promise<ExistingFill[]> }
  pendingRepo: { listPending(): Promise<ExistingPending[]> }
}

// Prices arrive as bigint myriadths from the DB and as strings from extraction;
// formatUsd(parseUsd(x)) canonicalizes both spellings ("58.32" === "58.3200").
function canon(price: bigint | string): string {
  return formatUsd(typeof price === 'string' ? parseUsd(price) : price)
}

// Exact-signature dedup key.
function dedupKey(side: string, ticker: string, shares: number, price: bigint | string, filledOn: string): string {
  return `${side}|${ticker}|${shares}|${canon(price)}|${filledOn}`
}

// Same trade ignoring price: a price typo in a manual fill must not fork a
// second row — the discrepancy is reported as a conflict instead.
function looseKey(side: string, ticker: string, shares: number, filledOn: string): string {
  return `${side}|${ticker}|${shares}|${filledOn}`
}

/**
 * Split extracted fills into fresh trades and re-detections of trades already
 * on the books. Called from ingestCapture inside the per-run lock, so the rows
 * it reads cannot move underneath it.
 * Booked fills are loaded before pending rows so a conflict prefers to cite a
 * booked fill over a still-pending row of the same trade.
 */
export async function matchCapturedFills(
  repos: CaptureTradeReader,
  runId: number,
  extracted: readonly RawFill[],
  today: ISODate,
): Promise<CaptureMatch> {
  const remaining = new Map<string, number>()
  const bump = (k: string) => remaining.set(k, (remaining.get(k) ?? 0) + 1)
  // Same-trade-ignoring-price multiset; booked rows first so a conflict
  // prefers to cite a booked fill over a still-pending row.
  type LooseHit = { kind: 'fill' | 'pending'; id: number; price: string }
  const loose = new Map<string, LooseHit[]>()
  const putLoose = (lk: string, hit: LooseHit) => {
    const list = loose.get(lk)
    if (list) list.push(hit)
    else loose.set(lk, [hit])
  }
  for (const b of await repos.fillRepo.listForRun(runId)) {
    bump(dedupKey(b.side, b.ticker, b.shares, b.price, b.filledOn))
    putLoose(looseKey(b.side, b.ticker, b.shares, b.filledOn), { kind: 'fill', id: b.id, price: canon(b.price) })
  }
  for (const p of await repos.pendingRepo.listPending()) {
    if (p.runId !== runId) continue
    bump(dedupKey(p.side, p.ticker, p.shares, p.price, p.filledOn))
    putLoose(looseKey(p.side, p.ticker, p.shares, p.filledOn), { kind: 'pending', id: p.id, price: canon(p.price) })
  }
  // Phase 1: exact signatures are true duplicates and are consumed first —
  // and they consume their loose twin too, so a loose match can never steal
  // a re-send of the same trade. Result is independent of row order.
  const survivors: RawFill[] = []
  for (const f of extracted) {
    const filledOn = f.date ?? today
    const k = dedupKey(f.side, f.ticker, f.shares, f.price, filledOn)
    const n = remaining.get(k) ?? 0
    if (n > 0) {
      remaining.set(k, n - 1)
      const lk = looseKey(f.side, f.ticker, f.shares, filledOn)
      const list = loose.get(lk)
      if (list) {
        // The exact-key hit guarantees this trade's loose entry at the same
        // canonical price is still in the list: every row that counts toward
        // `remaining` also put one there, and each duplicate consumes one of
        // each. So findIndex cannot miss here.
        const same = list.findIndex((h) => h.price === canon(f.price))
        list.splice(same, 1)
        if (list.length === 0) loose.delete(lk)
      }
      continue
    }
    survivors.push(f)
  }
  // Phase 2: what remains and still matches an existing trade on everything
  // but price is a conflict, not a new row; anything else is fresh.
  const fresh: RawFill[] = []
  const conflicts: CaptureConflict[] = []
  for (const f of survivors) {
    const filledOn = f.date ?? today
    const lk = looseKey(f.side, f.ticker, f.shares, filledOn)
    const hit = loose.get(lk)?.shift()
    if (hit) {
      if (loose.get(lk)?.length === 0) loose.delete(lk)
      const base = {
        side: f.side, ticker: f.ticker, shares: f.shares, extractedPrice: canon(f.price),
        extractedFee: f.fee != null ? canon(f.fee) : null, filledOn, correction: null,
      }
      if (hit.kind === 'fill') conflicts.push({ ...base, bookedId: hit.id, bookedPrice: hit.price, pendingId: null, pendingPrice: null })
      else conflicts.push({ ...base, bookedId: null, bookedPrice: null, pendingId: hit.id, pendingPrice: hit.price })
      continue
    }
    fresh.push(f)
  }
  return { fresh, conflicts }
}
